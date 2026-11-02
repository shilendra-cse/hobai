import {
  createToolContext,
  DEFAULT_LIMITS,
  runAgent,
  type AgentLimits,
  type Emit,
  type ResolvedModel,
} from "@hobai/agent";
import { DockerSandbox, type Sandbox } from "@hobai/sandbox";
import type { EnvironmentConfig, RunStage } from "@hobai/shared";
import { collectDiff } from "../stages/changes/index.js";
import { checkoutRepo, type RepoSource } from "../stages/checkout/index.js";
import { listChanges, snapshotChanges } from "../stages/deliver/index.js";
import { runSetup } from "../stages/setup/index.js";
import { runVerify } from "../stages/verify/index.js";
import type { Deliver, RunResult, RunStageName } from "./run-result.js";

export type RunTaskOptions = {
  runId: string;
  task: string;
  source: RepoSource;
  model: ResolvedModel;
  limits?: Partial<AgentLimits>;
  environment?: EnvironmentConfig;
  /** Run every check before the agent (default true). */
  baselineChecks?: boolean;
  emit?: Emit;
  signal?: AbortSignal;
  /** A function is asked when the run ends, e.g. to keep it only when the run was stopped a certain way. */
  keepSandbox?: boolean | (() => boolean);
  createSandbox?: () => Promise<Sandbox>;
  /** Runs right after checkout, before setup (e.g. evals pin a commit or plant a bug). */
  afterCheckout?: (sandbox: Sandbox) => Promise<void>;
  /** Called for a succeeded or incomplete run with changes, while the sandbox is still there. */
  deliver?: Deliver;
  /** Default RUN_TIME_LIMIT_MS. */
  maxDurationMs?: number;
};

/**
 * A whole run, from sandbox to pull request. Commands can't be interrupted, so the limit is
 * checked before each one starts: a run ends by RUN_TIME_LIMIT_MS plus one command (10 minutes
 * at most) and delivery, inside the hour a deploy waits for work in progress.
 */
export const RUN_TIME_LIMIT_MS = 45 * 60_000;

const timeLimitMessage = (ms: number) =>
  `This run took longer than ${Math.round(ms / 60_000)} minutes and was stopped.`;

const EVENT_STAGE: Record<RunStageName, RunStage> = {
  sandbox: "prepare",
  checkout: "checkout",
  setup: "setup",
  agent: "agent",
  verify: "verify",
  deliver: "deliver",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runTask(options: RunTaskOptions): Promise<RunResult> {
  const { runId, signal } = options;
  const emit: Emit = options.emit ?? (() => {});
  const startedAt = Date.now();
  const maxDurationMs = options.maxDurationMs ?? RUN_TIME_LIMIT_MS;
  const timeLimit = new AbortController();
  const timer = setTimeout(() => timeLimit.abort(), maxDurationMs);
  const timeLeft = () => startedAt + maxDurationMs - Date.now();
  const result: Omit<RunResult, "status" | "durationMs"> = {};
  const finish = (status: RunResult["status"]): RunResult => ({
    status,
    ...result,
    durationMs: Date.now() - startedAt,
  });

  let stage = "sandbox" as RunStageName;
  const enter = (next: RunStageName) => {
    stage = next;
    emit({
      type: "stage_changed",
      runId,
      ts: new Date().toISOString(),
      stage: EVENT_STAGE[next],
    });
  };

  // Before the agent there's nothing to keep, so reaching the limit fails the run.
  const timedOut = (): RunResult => ({
    ...finish("failed"),
    failedStage: stage,
    error: timeLimitMessage(maxDurationMs),
    timeLimitReached: true,
  });

  enter("sandbox");
  let sandbox: Sandbox;
  try {
    sandbox = await (options.createSandbox ?? (() => DockerSandbox.create()))();
  } catch (error) {
    clearTimeout(timer);
    return {
      ...finish("failed"),
      failedStage: "sandbox",
      error: errorMessage(error),
    };
  }
  result.sandboxId = sandbox.id;
  emit({
    type: "sandbox_created",
    runId,
    ts: new Date().toISOString(),
    sandboxId: sandbox.id,
  });

  try {
    if (signal?.aborted) return finish("cancelled");

    enter("checkout");
    result.checkout = await checkoutRepo(sandbox, options.source);
    await options.afterCheckout?.(sandbox);
    if (signal?.aborted) return finish("cancelled");
    if (timeLimit.signal.aborted) return timedOut();

    enter("setup");
    const { setup, gitBase } = await runSetup(sandbox, {
      runId,
      emit,
      environment: options.environment,
      baselineChecks: options.baselineChecks ?? true,
      signal: timeLimit.signal,
    });
    result.setup = setup;
    if (signal?.aborted) return finish("cancelled");
    if (timeLimit.signal.aborted) return timedOut();

    enter("agent");
    const maxWallTimeMs =
      options.limits?.maxWallTimeMs ?? DEFAULT_LIMITS.maxWallTimeMs;
    const agent = await runAgent({
      runId,
      task: options.task,
      ctx: createToolContext(sandbox, setup.checks),
      model: options.model,
      // The agent stops at whichever comes first, so its own time limit keeps its work (incomplete).
      limits: {
        ...options.limits,
        maxWallTimeMs: Math.min(maxWallTimeMs, timeLeft()),
      },
      setup,
      emit,
      signal,
    });
    result.agent = agent;
    if (agent.status === "cancelled") return finish("cancelled");

    enter("verify");
    // Before the checks run again, so files they write stay out of the diff.
    result.diff = await collectDiff(sandbox, gitBase);
    const snapshot = options.deliver ? await snapshotChanges(sandbox) : null;
    result.verify = await runVerify(
      sandbox,
      setup.checks,
      setup.baseline,
      timeLimit.signal,
    );
    emit({
      type: "checks_completed",
      runId,
      ts: new Date().toISOString(),
      passed: result.verify.passed,
      checks: result.verify.checks.map(
        ({ name, cwd, command, status, comparison }) => ({
          name,
          cwd,
          command,
          status,
          comparison,
        }),
      ),
    });

    const deliverable =
      agent.status === "succeeded" || agent.status === "incomplete";
    if (
      options.deliver &&
      snapshot &&
      deliverable &&
      result.diff.files.length > 0
    ) {
      if (signal?.aborted) return finish("cancelled");
      enter("deliver");
      const changes = await listChanges(sandbox, gitBase, snapshot);
      result.delivery = await options.deliver(changes, {
        agent,
        verify: result.verify,
        diff: result.diff,
      });
    }

    // The checks that didn't run leave the result unknown, so the work is delivered as a draft.
    if (result.verify.notRun && agent.status === "succeeded") {
      return { ...finish("incomplete"), timeLimitReached: true };
    }
    return finish(agent.status);
  } catch (error) {
    if (timeLimit.signal.aborted && stage === "setup") return timedOut();
    // An agent failure (e.g. the sandbox disappeared) already has its own status.
    if (stage === "verify" && result.agent?.status === "failed") {
      return finish("failed");
    }
    return {
      ...finish("failed"),
      failedStage: stage,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
    const keep =
      typeof options.keepSandbox === "function"
        ? options.keepSandbox()
        : options.keepSandbox;
    if (!keep) await sandbox.destroy().catch(() => {});
  }
}
