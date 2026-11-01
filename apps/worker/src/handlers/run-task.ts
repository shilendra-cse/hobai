import { titleTask, type ResolvedModel } from "@hobai/agent";
import {
  DbEnvironmentStore,
  getLatestUserMessage,
  getRunWithProject,
  setTaskTitle,
  type Db,
} from "@hobai/db";
import { runTask, type RunResult, type RunTaskOptions } from "@hobai/runner";
import type { GithubApp } from "@hobai/github";
import type { RunEvent, QueuedWork } from "@hobai/shared";
import type { EventWriter } from "../events/event-writer.js";
import {
  createEventSink,
  runEventTarget,
  type EventSink,
} from "../events/sink.js";
import {
  createRunRecord,
  runFailure,
  RunStateError,
  type RunRecord,
} from "../runs/run-record.js";
import { deliverToGithub } from "../delivery/deliver.js";
import { GithubAccessError, repoReadToken } from "../github/repo-token.js";
import type { Log } from "../lib/log.js";
import type { SandboxFactory } from "../lib/sandbox-factory.js";

export type RunTaskDeps = {
  db: Db;
  events: EventWriter;
  log: Log;
  createSandbox: SandboxFactory;
  github: Pick<GithubApp, "repoToken" | "repoClient">;
  frontendUrl?: string;
  /** Writes the task's short title on its first run; without it, the task keeps its first line. */
  titleModel?: ResolvedModel;
} & Pick<RunTaskOptions, "model" | "limits">;

async function loadRun(db: Db, runId: string) {
  const run = await getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} doesn't exist.`);
  const message = await getLatestUserMessage(db, runId);
  return { ...run, instruction: message?.content ?? run.task.title };
}

type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function nameTask(
  deps: Pick<RunTaskDeps, "db" | "log"> & { titleModel: ResolvedModel },
  run: LoadedRun,
  {
    emit,
    record,
    signal,
  }: {
    emit: (event: RunEvent) => void;
    record: RunRecord;
    signal?: AbortSignal;
  },
) {
  const { title, usage } = await titleTask(deps.titleModel, run.instruction, {
    signal,
  });
  record.addUsage(usage);
  if (!title) return;
  try {
    await setTaskTitle(deps.db, run.task.id, title);
  } catch (error) {
    deps.log("warn", "The task's title wasn't saved", {
      runId: run.id,
      error: String(error),
    });
    return;
  }
  // Delivery reads it from here for the branch name.
  run.task.title = title;
  emit({
    type: "task_titled",
    runId: run.id,
    ts: new Date().toISOString(),
    title,
  });
}

async function endRun(
  deps: Pick<RunTaskDeps, "log">,
  run: {
    id: string;
    emit: (event: RunEvent) => void;
    record: RunRecord;
    sink: EventSink;
  },
  result: RunResult,
) {
  const ts = new Date().toISOString();
  const failure = runFailure(result);
  if (result.status === "failed" && failure) {
    run.emit({ type: "error", runId: run.id, ts, ...failure });
  }
  run.emit({ type: "done", runId: run.id, ts, status: result.status });

  await run.record.flush();
  if (result.diff && result.diff.files.length > 0) {
    try {
      await run.record.saveDiff(result.diff);
    } catch (error) {
      deps.log("warn", "The run's changes weren't saved", {
        runId: run.id,
        error: String(error),
      });
    }
  }
  try {
    await run.sink.flush();
  } catch (error) {
    deps.log("warn", "Some run events weren't saved or published", {
      runId: run.id,
      error: String(error),
    });
  }
  if (!(await run.record.finish(result))) {
    deps.log(
      "warn",
      "The run was ended elsewhere; its result wasn't recorded",
      {
        runId: run.id,
        status: result.status,
      },
    );
  }
}

export async function handleRunTask(
  deps: RunTaskDeps,
  { runId }: QueuedWork["run-task"],
  signal?: AbortSignal,
): Promise<RunResult | null> {
  const { db } = deps;
  const run = await loadRun(db, runId);
  const { project } = run.task;
  const record = createRunRecord(db, runId);
  const environments = new DbEnvironmentStore(db);

  const environment = await environments.load(project.id);
  if (!environment) {
    await record.fail({
      code: "no_environment",
      message: `${project.repoOwner}/${project.repoName} hasn't been set up yet; onboard the project first.`,
    });
    return null;
  }
  let token: string;
  try {
    token = await repoReadToken(deps, project);
  } catch (error) {
    if (!(error instanceof GithubAccessError)) throw error;
    await record.fail({ code: "github_access", message: error.message });
    return null;
  }
  try {
    await record.start(environment.id);
  } catch (error) {
    if (!(error instanceof RunStateError)) throw error;
    deps.log("warn", "Skipping a run that isn't queued", { runId });
    return null;
  }

  const sink = createEventSink(deps, runEventTarget(runId));
  const emit = (event: RunEvent) => {
    sink.emit(event);
    record.observe(event);
  };

  // Written while the sandbox is prepared; delivery waits for it, for the branch name.
  const { titleModel } = deps;
  const titling =
    titleModel && run.trigger === "initial"
      ? nameTask({ ...deps, titleModel }, run, { emit, record, signal })
      : Promise.resolve();
  const deliver = deliverToGithub(deps, {
    runId,
    task: run.task,
    project,
    emit,
  });

  let result: RunResult;
  try {
    result = await runTask({
      runId,
      task: run.instruction,
      source: {
        type: "git",
        url: `https://github.com/${project.repoOwner}/${project.repoName}.git`,
        ref: run.task.baseBranch,
        token,
      },
      model: deps.model,
      limits: deps.limits,
      environment: environment.config,
      createSandbox: () => deps.createSandbox({ kind: "run", runId }),
      emit,
      signal,
      deliver: async (changes, ran) => {
        await titling;
        return deliver(changes, ran);
      },
    });
  } catch (error) {
    await record.fail({
      code: "worker_error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await titling;
  await endRun(deps, { id: runId, emit, record, sink }, result);
  if (result.setup?.health === "needs_attention") {
    await environments.markHealth(
      project.id,
      "needs_attention",
      result.setup.healthReasons,
    );
  }
  deps.log("info", "Run finished", {
    runId,
    status: result.status,
    steps: result.agent?.steps ?? 0,
    costUsd: result.agent?.usage.costUsd ?? 0,
  });
  return result;
}
