import {
  getLastRunEventSeq,
  listUnfinishedRuns,
  markRunEnded,
  saveRunDiff,
  type Db,
} from "@hobai/db";
import { collectDiff, findBaseline } from "@hobai/runner";
import { parkSandbox } from "@hobai/sandbox";
import type { Queue } from "bullmq";
import type { EventWriter } from "../events/event-writer.js";
import { createEventSink, runEventTarget } from "../events/sink.js";
import type { Log } from "../lib/log.js";
import type { SandboxConnector } from "../lib/sandbox-factory.js";
import { describeError } from "../lib/describe-error.js";

// Covers the gap between inserting a run and queueing it, and a short Redis outage.
export const QUEUED_GRACE_MS = 15 * 60_000;

/** Queue states in which work will still be picked up. */
export const PENDING = new Set([
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
  "active",
]);

const REASONS = {
  worker_lost: "The worker running it stopped before the run finished.",
  lost_in_queue: "It was queued but never started, and its queue item is gone.",
};

export type LostRun = {
  runId: string;
  status: "queued" | "running";
  code: keyof typeof REASONS;
  sandboxId: string | null;
};

export type LostRunsDeps = {
  db: Db;
  queue: Pick<Queue, "getJobState">;
  events: EventWriter;
  log: Log;
  connectSandbox: SandboxConnector;
};

// A queue item only stays active while a live worker holds its lock.
export async function findLostRuns(
  db: Db,
  queue: LostRunsDeps["queue"],
  now = Date.now(),
): Promise<LostRun[]> {
  const lost: LostRun[] = [];
  for (const run of await listUnfinishedRuns(db)) {
    const state = await queue.getJobState(run.id);
    if (run.status === "running" && state !== "active") {
      lost.push({
        runId: run.id,
        status: "running",
        code: "worker_lost",
        sandboxId: run.sandboxId,
      });
    } else if (
      run.status === "queued" &&
      !PENDING.has(state) &&
      now - run.queuedAt.getTime() > QUEUED_GRACE_MS
    ) {
      lost.push({
        runId: run.id,
        status: "queued",
        code: "lost_in_queue",
        sandboxId: null,
      });
    }
  }
  return lost;
}

async function keepWork(
  deps: LostRunsDeps,
  runId: string,
  sandboxId: string,
): Promise<void> {
  const sandbox = await deps.connectSandbox(sandboxId);
  if (!sandbox) {
    deps.log("info", "A lost run's sandbox is already gone", { runId });
    return;
  }
  try {
    const baseline = await findBaseline(sandbox);
    const diff = baseline ? await collectDiff(sandbox, baseline) : null;
    if (diff && diff.files.length > 0) {
      await saveRunDiff(deps.db, runId, diff);
    }
    deps.log("info", "Kept a lost run's work", {
      runId,
      files: diff?.files.length ?? 0,
    });
  } finally {
    await parkSandbox(sandbox);
  }
}

export async function failLostRuns(deps: LostRunsDeps): Promise<LostRun[]> {
  const failed: LostRun[] = [];
  for (const lost of await findLostRuns(deps.db, deps.queue)) {
    const { runId, code } = lost;
    const message = REASONS[code];
    const ended = await markRunEnded(
      deps.db,
      runId,
      { status: "failed", errorCode: code, errorMessage: message },
      [lost.status],
    );
    if (!ended) continue;

    if (lost.sandboxId) {
      try {
        await keepWork(deps, runId, lost.sandboxId);
      } catch (error) {
        deps.log("warn", "A lost run's work couldn't be kept", {
          runId,
          error: describeError(error),
        });
      }
    }

    const sink = createEventSink(
      deps,
      runEventTarget(runId),
      await getLastRunEventSeq(deps.db, runId),
    );
    const ts = new Date().toISOString();
    sink.emit({ type: "error", runId, ts, code, message });
    sink.emit({ type: "done", runId, ts, status: "failed" });
    try {
      await sink.flush();
    } catch (error) {
      deps.log("warn", "A lost run's events weren't saved or published", {
        runId,
        error: describeError(error),
      });
    }
    deps.log("warn", "Failed a lost run", { runId, code });
    failed.push(lost);
  }
  return failed;
}
