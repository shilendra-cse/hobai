import {
  ANSWER_CHANNEL,
  CANCEL_CHANNEL,
  WORK_QUEUE,
  type OnboardingAnswer,
} from "@hobai/shared";
import { Queue, QueueEvents, type Job } from "bullmq";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { startConsumer, type Consumer, type Handlers } from "./consumer.js";
import { LockLostError } from "./lib/lock-lost.js";
import { createAnswerRouter } from "./onboardings/answer-router.js";
import { testRedisOrSkip } from "./testing/test-redis.js";

const redis = await testRedisOrSkip("consumer");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const idle: Handlers = {
  "run-task": async () => {},
  "onboard-project": async () => {},
  reap: async () => {},
};

describe.skipIf(!redis)("consumer against Redis", () => {
  const { prefix, connect } = redis!;
  const queue = new Queue(WORK_QUEUE, { connection: connect(), prefix });
  const events = new QueueEvents(WORK_QUEUE, {
    connection: connect(),
    prefix,
  });
  const consumers: Consumer[] = [];
  const logs: { level: string; message: string }[] = [];

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.close()));
    logs.length = 0;
  });
  afterAll(async () => {
    await queue.close();
    await events.close();
    await redis?.close();
  });

  const answers = createAnswerRouter();

  async function start(handlers: Partial<Handlers>, lockDurationMs?: number) {
    const consumer = await startConsumer({
      connection: connect(),
      subscriber: connect(),
      handlers: { ...idle, ...handlers },
      answers,
      concurrency: 2,
      log: (level, message) => logs.push({ level, message }),
      prefix,
      lockDurationMs,
    });
    consumers.push(consumer);
    return consumer;
  }

  const finished = (job: Job) => job.waitUntilFinished(events);

  it("hands each kind of work to its handler", async () => {
    const received: unknown[] = [];
    await start({
      "run-task": async (data) => void received.push(data),
      "onboard-project": async (data) => void received.push(data),
      reap: async (data) => void received.push(data),
    });

    await finished(await queue.add("run-task", { runId: "run-1" }));
    await finished(
      await queue.add("onboard-project", { onboardingId: "setup-1" }),
    );
    await finished(await queue.add("reap", {}));

    expect(received).toEqual([
      { runId: "run-1" },
      { onboardingId: "setup-1" },
      {},
    ]);
    expect(logs.map((l) => l.message)).toEqual([
      "Work started",
      "Work finished",
      "Work started",
      "Work finished",
      "Work started",
      "Work finished",
    ]);
  });

  it("fails work of an unknown kind and keeps going", async () => {
    await start({});

    await expect(finished(await queue.add("paint-house", {}))).rejects.toThrow(
      'Unknown work kind "paint-house".',
    );
    await finished(await queue.add("run-task", { runId: "run-2" }));
  });

  it("fails work whose handler throws, logs it and keeps going", async () => {
    await start({
      "run-task": async ({ runId }) => {
        if (runId === "bad") throw new Error("sandbox exploded");
      },
    });

    await expect(
      finished(await queue.add("run-task", { runId: "bad" })),
    ).rejects.toThrow("sandbox exploded");
    await finished(await queue.add("run-task", { runId: "good" }));
    expect(logs).toContainEqual({ level: "error", message: "Work failed" });
  });

  it("finishes the work in progress when closed, while another worker takes new work", async () => {
    let signal: AbortSignal | undefined;
    const started = deferred();
    const release = deferred();
    const old = await start({
      "run-task": async (_data, s) => {
        signal = s;
        started.resolve();
        await release.promise;
      },
    });
    const running = await queue.add("run-task", { runId: "run-long" });
    await started.promise;

    let closed = false;
    const closing = old.close().then(() => (closed = true));
    const taken: unknown[] = [];
    await start({ "run-task": async (data) => void taken.push(data) });
    await finished(await queue.add("run-task", { runId: "run-new" }));

    expect(taken).toEqual([{ runId: "run-new" }]);
    expect(closed).toBe(false);
    release.resolve();
    await finished(running);
    await closing;
    expect(signal?.aborted).toBe(false);
    expect(await running.getState()).toBe("completed");
  });

  it("aborts only the run named in a cancel message", async () => {
    const signals = new Map<string, AbortSignal>();
    const bothStarted = { a: deferred(), b: deferred() };
    const releaseB = deferred();
    await start({
      "run-task": async ({ runId }, signal) => {
        signals.set(runId, signal);
        if (runId === "run-a") {
          bothStarted.a.resolve();
          await new Promise((r) => signal.addEventListener("abort", r));
        } else {
          bothStarted.b.resolve();
          await releaseB.promise;
        }
      },
    });

    const a = await queue.add("run-task", { runId: "run-a" });
    const b = await queue.add("run-task", { runId: "run-b" });
    await Promise.all([bothStarted.a.promise, bothStarted.b.promise]);
    await connect().publish(CANCEL_CHANNEL, "run-a");
    await finished(a);

    expect(signals.get("run-a")?.aborted).toBe(true);
    expect(signals.get("run-b")?.aborted).toBe(false);
    releaseB.resolve();
    await finished(b);
  });

  it("stops a setup named in a cancel message", async () => {
    const started = deferred();
    let stopped: AbortSignal | undefined;
    await start({
      "onboard-project": async (_data, signal) => {
        stopped = signal;
        started.resolve();
        await new Promise((r) => signal.addEventListener("abort", r));
      },
    });

    const job = await queue.add("onboard-project", { onboardingId: "setup-2" });
    await started.promise;
    await connect().publish(CANCEL_CHANNEL, "setup-2");
    await finished(job);

    expect(stopped?.aborted).toBe(true);
  });

  it("hands an answer to the setup waiting for it", async () => {
    const received = deferred();
    const got: [string, OnboardingAnswer][] = [];
    const stopReceiving = answers.register("setup-3", (questionId, answer) => {
      got.push([questionId, answer]);
      received.resolve();
    });
    await start({});

    await connect().publish(ANSWER_CHANNEL, "not json");
    await connect().publish(
      ANSWER_CHANNEL,
      JSON.stringify({
        onboardingId: "setup-3",
        questionId: "q-1",
        answer: { option: 1 },
      }),
    );
    await received.promise;
    stopReceiving();

    expect(got).toEqual([["q-1", { option: 1 }]]);
    expect(logs).toContainEqual({
      level: "warn",
      message: "Ignored an answer that couldn't be read",
    });
  });

  it("stops work whose queue lock was lost, telling it why", async () => {
    const started = deferred();
    let reason: unknown;
    // Locks are renewed every half of their duration, so it fails half a second after the lock goes.
    await start(
      {
        "run-task": (_data, signal) =>
          new Promise<void>((resolve) => {
            started.resolve();
            signal.addEventListener("abort", () => {
              reason = signal.reason;
              resolve();
            });
          }),
      },
      1_000,
    );

    const job = await queue.add(
      "run-task",
      { runId: "lost" },
      { jobId: "lost" },
    );
    await started.promise;
    await connect().del(`${prefix}:${WORK_QUEUE}:lost:lock`);

    await vi.waitFor(() => expect(reason).toBeInstanceOf(LockLostError), {
      timeout: 5_000,
    });
    expect(logs).toContainEqual({
      level: "warn",
      message: "Stopping work whose queue lock was lost",
    });
    await job.remove().catch(() => {});
  });

  it("waits for work in progress when closing", async () => {
    const started = deferred();
    const release = deferred();
    const consumer = await start({
      "run-task": async () => {
        started.resolve();
        await release.promise;
      },
    });
    const job = await queue.add("run-task", { runId: "run-3" });
    await started.promise;

    let closed = false;
    const closing = consumer.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(false);

    release.resolve();
    await closing;
    await finished(job);
    consumers.splice(consumers.indexOf(consumer), 1);
  });
});
