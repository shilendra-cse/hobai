import { randomUUID } from "node:crypto";
import {
  createTaskWithRun,
  findRunEventsAfter,
  listEndedRuns,
  type Db,
} from "@hobai/db";
import { DEFAULT_AGENT_MODEL, WORK_QUEUE } from "@hobai/shared";
import { QueueEvents, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { startChild } from "./children.js";
import { Histogram } from "./histogram.js";
import type { ProcessSample, WorkerSample } from "./messages.js";
import { loadTask } from "./profiles.js";

// A worker this far behind is stalled: its queue locks (2 minutes) would soon run out.
const STALLED_LOOP_MS = 30_000;
const MAX_EVENTS_PER_RUN = 100_000;
// A run ended in Postgres this long ago without a `done` heard has lost it. A `done` that still
// comes (the reaper ends a run before sending it) clears that.
const DONE_GRACE_MS = 10_000;
const ENDED_CHECK_SECONDS = 30;

export type LevelOptions = {
  runs: number;
  rampMs: number;
  timeoutMs: number;
  db: Db;
  queue: Queue;
  /** A new connection to the load's Redis; the level closes the ones it opens. */
  connect: () => Redis;
  project: { id: string; userId: string; defaultBranch: string };
  workerEnv: Record<string, string>;
  workerExecArgv: string[];
  fakeSample: () => ProcessSample | null;
  onSample: (sample: LevelSample) => void;
};

export type StopReason =
  "finished" | "worker exited" | "event loop stalled" | "timed out";

export type LevelSample = {
  second: number;
  queued: number;
  active: number;
  done: number;
  eventsPerSecond: number;
  lagMs: { p50: number; p99: number; max: number };
  worker: WorkerSample | null;
  fake: ProcessSample | null;
};

export type LevelResult = {
  runs: number;
  stopReason: StopReason;
  durationS: number;
  statuses: Record<string, number>;
  runDurationS: { p50: number; p99: number; max: number };
  samples: LevelSample[];
  events: { total: number; lagMs: { p50: number; p99: number; max: number } };
  /** Stored events that never reached a subscriber. */
  unpublished: number;
  /** Runs ended in Postgres whose `done` was never published. */
  doneLost: number;
  warnings: Record<string, number>;
};

const runEvent = z.looseObject({
  type: z.string(),
  ts: z.string(),
  runId: z.string(),
  seq: z.number().optional(),
  status: z.string().optional(),
});

const logLine = z.looseObject({ level: z.number(), msg: z.string() });
const WARN = 40;

type Tracked = {
  queuedAt: number;
  startedAt?: number;
  doneAt?: number;
  status?: string;
  doneLost?: boolean;
  published: number;
};

async function createRuns(options: LevelOptions) {
  const ids: string[] = [];
  for (let i = 0; i < options.runs; i++) {
    // The fake OpenAI server plans each run from the key in its task; it needn't be the run's id.
    const task = loadTask(randomUUID());
    const { run } = await createTaskWithRun(options.db, {
      task: {
        projectId: options.project.id,
        createdByUserId: options.project.userId,
        title: task,
        baseBranch: options.project.defaultBranch,
      },
      run: { trigger: "initial", model: DEFAULT_AGENT_MODEL },
      message: { authorUserId: options.project.userId, content: task },
    });
    ids.push(run.id);
  }
  return ids;
}

export async function runLevel(options: LevelOptions): Promise<LevelResult> {
  const tracked = new Map<string, Tracked>();
  const lag = new Histogram();
  const secondLag = new Histogram();
  let secondEvents = 0;
  let workerSample: WorkerSample | null = null;
  const warnings: Record<string, number> = {};

  const onEvent = (_pattern: string, _channel: string, message: string) => {
    const parsed = runEvent.safeParse(safeJson(message));
    if (!parsed.success) return;
    const event = parsed.data;
    const run = tracked.get(event.runId);
    if (!run) return;
    const now = Date.now();
    const ms = now - Date.parse(event.ts);
    lag.add(ms);
    secondLag.add(ms);
    secondEvents += 1;
    run.startedAt ??= now;
    if (event.seq !== undefined) run.published += 1;
    if (event.type === "done") {
      run.doneAt = now;
      run.status = event.status ?? "unknown";
      run.doneLost = false;
    }
  };
  const subscriber = options.connect();
  subscriber.on("pmessage", onEvent);
  await subscriber.psubscribe("run:*");
  // A run whose work fails before it emits anything never sends done.
  const queueEvents = new QueueEvents(WORK_QUEUE, {
    connection: options.connect(),
  });
  queueEvents.on("failed", ({ jobId }) => {
    const run = tracked.get(jobId);
    if (run && run.doneAt === undefined) {
      run.doneAt = Date.now();
      run.status = "work failed";
    }
  });
  await queueEvents.waitUntilReady();

  const worker = startChild("worker-process.ts", {
    env: options.workerEnv,
    execArgv: options.workerExecArgv,
    onMessage: (message) => {
      if (message.type === "worker-sample") workerSample = message.sample;
    },
    onOutput: (line) => {
      const parsed = logLine.safeParse(safeJson(line));
      if (parsed.success && parsed.data.level >= WARN) {
        warnings[parsed.data.msg] = (warnings[parsed.data.msg] ?? 0) + 1;
      }
    },
  });
  await worker.ready;
  let workerExited = false;
  void worker.exited.then(() => {
    workerExited = true;
  });

  const ids = await createRuns(options);
  const started = Date.now();
  const timers = ids.map((runId, i) =>
    setTimeout(
      () => {
        tracked.set(runId, { queuedAt: Date.now(), published: 0 });
        void options.queue.add("run-task", { runId }, { jobId: runId });
      },
      (i * options.rampMs) / ids.length,
    ),
  );

  // Without this a level whose `done` events were lost would only stop at its timeout.
  const markEnded = async (graceMs: number) => {
    const waiting = [...tracked].filter(([, run]) => run.doneAt === undefined);
    const ended = await listEndedRuns(
      options.db,
      waiting.map(([runId]) => runId),
    );
    for (const { id, status, finishedAt } of ended) {
      const run = tracked.get(id);
      if (!run || run.doneAt !== undefined || !finishedAt) continue;
      if (Date.now() - finishedAt.getTime() < graceMs) continue;
      run.doneAt = finishedAt.getTime();
      run.status = status;
      run.doneLost = true;
    }
  };
  let checkingEnded = false;

  const samples: LevelSample[] = [];
  const stopReason = await new Promise<StopReason>((resolve) => {
    const tick = setInterval(() => {
      const runs = [...tracked.values()];
      const done = runs.filter((r) => r.doneAt !== undefined).length;
      const sample: LevelSample = {
        second: Math.round((Date.now() - started) / 1000),
        queued: runs.length,
        active: runs.filter(
          (r) => r.startedAt !== undefined && r.doneAt === undefined,
        ).length,
        done,
        eventsPerSecond: secondEvents,
        lagMs: {
          p50: secondLag.percentile(50),
          p99: secondLag.percentile(99),
          max: secondLag.max,
        },
        worker: workerSample,
        fake: options.fakeSample(),
      };
      secondEvents = 0;
      secondLag.reset();
      samples.push(sample);
      if (sample.second % ENDED_CHECK_SECONDS === 0 && !checkingEnded) {
        checkingEnded = true;
        // A failed check is tried again on the next one.
        void markEnded(DONE_GRACE_MS)
          .catch(() => {})
          .finally(() => {
            checkingEnded = false;
          });
      }
      options.onSample(sample);

      const stop = (reason: StopReason) => {
        clearInterval(tick);
        resolve(reason);
      };
      if (done === ids.length) stop("finished");
      else if (workerExited) stop("worker exited");
      else if ((workerSample?.loopDelayMs.max ?? 0) > STALLED_LOOP_MS)
        stop("event loop stalled");
      else if (Date.now() - started > options.timeoutMs) stop("timed out");
    }, 1_000);
  });

  for (const timer of timers) clearTimeout(timer);
  // Runs still going would make a graceful stop wait for them.
  await worker.stop({ force: stopReason !== "finished" });
  await queueEvents.close();
  await subscriber.quit();
  await options.queue.obliterate({ force: true });
  // The worker is gone, so no `done` is still on its way.
  await markEnded(0);

  let unpublished = 0;
  for (const [runId, run] of tracked) {
    const stored = await findRunEventsAfter(
      options.db,
      runId,
      0,
      MAX_EVENTS_PER_RUN,
    );
    unpublished += Math.max(0, stored.length - run.published);
  }

  const doneLost = [...tracked.values()].filter((run) => run.doneLost).length;
  const runDurations = new Histogram();
  const statuses: Record<string, number> = {};
  for (const runId of ids) {
    const run = tracked.get(runId);
    const status = run?.status ?? (run ? "unfinished" : "not queued");
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (run?.doneAt !== undefined)
      runDurations.add((run.doneAt - run.queuedAt) / 1000);
  }

  return {
    runs: ids.length,
    stopReason,
    durationS: Math.round((Date.now() - started) / 1000),
    statuses,
    runDurationS: {
      p50: runDurations.percentile(50),
      p99: runDurations.percentile(99),
      max: runDurations.max,
    },
    samples,
    events: {
      total: lag.count,
      lagMs: { p50: lag.percentile(50), p99: lag.percentile(99), max: lag.max },
    },
    unpublished,
    doneLost,
    warnings,
  };
}

// Log lines and events are JSON; anything else is passed over.
function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
