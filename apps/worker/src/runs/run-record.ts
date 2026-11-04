import {
  markRunEnded,
  type RunOutcome,
  markRunStarted,
  saveRunDiff,
  updateRunProgress,
  type Db,
} from "@hobai/db";
import type { UsageSnapshot } from "@hobai/agent";
import type { Diff, RunResult } from "@hobai/runner";
import type { RunEvent } from "@hobai/shared";
import { describeError } from "../lib/describe-error.js";
import type { Log } from "../lib/log.js";
import { END_RETRY_MS, tryWithRetries, withRetries } from "../lib/retry.js";
import { createSerialQueue } from "../lib/serial-queue.js";

export class RunStateError extends Error {}

export type RunFailure = { code: string; message: string };

export type RunRecord = {
  start(environmentId: string): Promise<void>;
  /** Records the run's stage and sandbox as they change; one that can't be saved is logged, never fails the run. */
  observe(event: RunEvent): void;
  /** Model calls made outside the agent (e.g. the task's title), counted with the agent's. */
  addUsage(usage: UsageSnapshot): void;
  flush(): Promise<void>;
  /** False when the run was already ended elsewhere (e.g. by the reaper). */
  finish(result: RunResult): Promise<boolean>;
  fail(failure: RunFailure): Promise<boolean>;
  saveDiff(diff: Diff): Promise<void>;
};

type AgentResult = NonNullable<RunResult["agent"]>;

export function runFailure(result: RunResult): RunFailure | null {
  const agent: AgentResult | undefined = result.agent;
  if (result.timeLimitReached) {
    return {
      code: "time_limit",
      message:
        result.error ??
        "Some checks didn't run: the run reached its time limit.",
    };
  }
  if (result.sandboxBusy) {
    return {
      code: "sandbox_busy",
      message: result.error ?? "No sandbox was free.",
    };
  }
  if (result.status === "failed") {
    return {
      code: `${result.failedStage ?? "agent"}_failed`,
      message: result.error ?? agent?.error ?? "The run failed.",
    };
  }
  if (result.status === "incomplete" && agent?.limitReached) {
    return {
      code: `${agent.limitReached}_limit`,
      message: agent.error ?? `Stopped at the ${agent.limitReached} limit.`,
    };
  }
  return null;
}

type Progress = Parameters<typeof updateRunProgress>[2];
type EndedFrom = Parameters<typeof markRunEnded>[3];

export type RunRecordOptions = {
  log: Log;
  updateProgress?: (progress: Progress) => Promise<void>;
  markEnded?: (outcome: RunOutcome, from: EndedFrom) => Promise<boolean>;
  retryForMs?: number;
  endRetryForMs?: number;
  firstRetryMs?: number;
};

// Long enough for a worker that's seconds behind, or a short database blip.
const PROGRESS_RETRY_MS = 30_000;

export function createRunRecord(
  db: Db,
  runId: string,
  options: RunRecordOptions,
): RunRecord {
  const updates = createSerialQueue();
  const updateProgress =
    options.updateProgress ??
    ((progress: Progress) => updateRunProgress(db, runId, progress));
  // The stage is shown while the run works and the sandbox lets the reaper keep a lost run's
  // work, so they're retried; one still failing isn't worth failing the run for.
  const saveProgress = (progress: Progress) =>
    updates.add(async () => {
      const error = await tryWithRetries(() => updateProgress(progress), {
        retryForMs: options.retryForMs ?? PROGRESS_RETRY_MS,
        firstRetryMs: options.firstRetryMs ?? 250,
      });
      if (error !== null) {
        options.log("warn", "A run's progress wasn't saved", {
          runId,
          progress,
          error: describeError(error),
        });
      }
    });
  const write =
    options.markEnded ??
    ((outcome: RunOutcome, from: EndedFrom) =>
      markRunEnded(db, runId, outcome, from));
  // Its result unsaved, a finished run would be ended by the reaper as if its worker had died.
  const markEnded = (outcome: RunOutcome, from: EndedFrom) =>
    withRetries(() => write(outcome, from), {
      retryForMs: options.endRetryForMs ?? END_RETRY_MS,
      firstRetryMs: options.firstRetryMs ?? 250,
    });
  const extra = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  return {
    async start(environmentId) {
      if (!(await markRunStarted(db, runId, environmentId))) {
        throw new RunStateError(`Run ${runId} isn't queued.`);
      }
    },

    observe(event) {
      if (event.type === "stage_changed") {
        saveProgress({ stage: event.stage });
      } else if (event.type === "sandbox_created") {
        saveProgress({ sandboxId: event.sandboxId });
      }
    },

    addUsage(usage) {
      extra.inputTokens += usage.inputTokens;
      extra.outputTokens += usage.outputTokens;
      extra.costUsd += usage.costUsd;
    },

    flush: () => updates.drain(),

    finish(result) {
      const agent = result.agent;
      const failure = runFailure(result);
      return markEnded(
        {
          status: result.status,
          summary: agent?.summary ?? null,
          inputTokens: (agent?.usage.inputTokens ?? 0) + extra.inputTokens,
          outputTokens: (agent?.usage.outputTokens ?? 0) + extra.outputTokens,
          steps: agent?.steps ?? 0,
          costUsd: ((agent?.usage.costUsd ?? 0) + extra.costUsd).toFixed(4),
          checksPassed: result.verify?.passed ?? null,
          commitSha: result.delivery?.sha ?? null,
          errorCode: failure?.code ?? null,
          errorMessage: failure?.message ?? null,
        },
        ["running"],
      );
    },

    saveDiff: ({ patch, files, truncated }) =>
      saveRunDiff(db, runId, { patch, files, truncated }),

    fail(failure) {
      return markEnded(
        {
          status: "failed",
          errorCode: failure.code,
          errorMessage: failure.message,
        },
        ["queued", "running"],
      );
    },
  };
}
