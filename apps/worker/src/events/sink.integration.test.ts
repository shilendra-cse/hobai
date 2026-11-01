import { randomUUID } from "node:crypto";
import { runEvents, type Db } from "@hobai/db";
import { insertRun, testDatabaseOrSkip } from "@hobai/db/testing";
import type { RunEvent, RunStage } from "@hobai/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createEventSink, runEventTarget, type Publisher } from "./sink.js";

const database = await testDatabaseOrSkip("event sink");

function recordingPublisher(failOn?: (message: string) => boolean) {
  const messages: { channel: string; event: RunEvent }[] = [];
  const publisher: Publisher = {
    async publish(channel, message) {
      if (failOn?.(message)) throw new Error("redis down");
      messages.push({ channel, event: JSON.parse(message) as RunEvent });
      return 1;
    },
  };
  return { publisher, messages };
}

const ts = "2026-10-20T10:00:00.000Z";
const stage = (runId: string, stage: RunStage): RunEvent => ({
  type: "stage_changed",
  runId,
  ts,
  stage,
});

describe.skipIf(!database)("event sink against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  const storedEvents = (runId: string) =>
    db
      .select({
        seq: runEvents.seq,
        type: runEvents.type,
        payload: runEvents.payload,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));

  it("stores events numbered in order and publishes each with its number", async () => {
    const { run } = await insertRun(db);
    const { publisher, messages } = recordingPublisher();
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id));

    sink.emit(stage(run.id, "setup"));
    sink.emit({
      type: "sandbox_created",
      runId: run.id,
      ts,
      sandboxId: "sb-1",
    });
    sink.emit(stage(run.id, "agent"));
    await sink.flush();

    expect(await storedEvents(run.id)).toEqual([
      {
        seq: 1,
        type: "stage_changed",
        payload: { stage: "setup" },
        createdAt: new Date(ts),
      },
      {
        seq: 2,
        type: "sandbox_created",
        payload: { sandboxId: "sb-1" },
        createdAt: new Date(ts),
      },
      {
        seq: 3,
        type: "stage_changed",
        payload: { stage: "agent" },
        createdAt: new Date(ts),
      },
    ]);
    expect(messages.map((m) => [m.channel, m.event.seq, m.event.type])).toEqual(
      [
        [`run:${run.id}`, 1, "stage_changed"],
        [`run:${run.id}`, 2, "sandbox_created"],
        [`run:${run.id}`, 3, "stage_changed"],
      ],
    );
  });

  it("hides GitHub tokens before storing or publishing an event", async () => {
    const { run } = await insertRun(db);
    const { publisher, messages } = recordingPublisher();
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id));
    const token = "ghs_faketoken0123456789abcdefghij";

    sink.emit({
      type: "tool_end",
      runId: run.id,
      ts,
      toolCallId: "call-1",
      toolName: "bash",
      output: `origin https://x-access-token:${token}@github.com/acme/app.git`,
    });
    await sink.flush();

    const stored = JSON.stringify(await storedEvents(run.id));
    const published = JSON.stringify(messages);
    expect(stored).not.toContain(token);
    expect(published).not.toContain(token);
    expect(stored).toContain("x-access-token:ghs_***@github.com");
  });

  it("only publishes text and step progress, without using a number", async () => {
    const { run } = await insertRun(db);
    const { publisher, messages } = recordingPublisher();
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id));

    sink.emit({ type: "text_delta", runId: run.id, ts, delta: "Reading" });
    sink.emit({
      type: "agent_step",
      runId: run.id,
      ts,
      steps: 1,
      costUsd: 0.001,
    });
    sink.emit(stage(run.id, "verify"));
    await sink.flush();

    expect((await storedEvents(run.id)).map((e) => [e.seq, e.type])).toEqual([
      [1, "stage_changed"],
    ]);
    expect(messages.map((m) => [m.event.type, m.event.seq])).toEqual([
      ["text_delta", undefined],
      ["agent_step", undefined],
      ["stage_changed", 1],
    ]);
  });

  it("sends the text streamed within an interval as one event, before the next event", async () => {
    const { run } = await insertRun(db);
    const { publisher, messages } = recordingPublisher();
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id));
    const later = "2026-10-20T10:00:00.050Z";

    sink.emit({ type: "text_delta", runId: run.id, ts, delta: "Reading" });
    sink.emit({ type: "text_delta", runId: run.id, ts: later, delta: " the" });
    sink.emit({ type: "text_delta", runId: run.id, ts: later, delta: " file" });
    sink.emit({
      type: "tool_start",
      runId: run.id,
      ts: later,
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "src/date.ts" },
    });
    sink.emit({ type: "text_delta", runId: run.id, ts: later, delta: "Done" });
    await sink.flush();

    expect(
      messages.map(({ event }) =>
        event.type === "text_delta"
          ? [event.type, event.delta, event.ts]
          : [event.type],
      ),
    ).toEqual([
      ["text_delta", "Reading the file", ts],
      ["tool_start"],
      ["text_delta", "Done", later],
    ]);
  });

  it("sends gathered text when its interval ends", async () => {
    const { run } = await insertRun(db);
    const { publisher, messages } = recordingPublisher();
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id), 0, {
      textBatchMs: 10,
    });

    sink.emit({ type: "text_delta", runId: run.id, ts, delta: "Reading" });
    sink.emit({ type: "text_delta", runId: run.id, ts, delta: " the file" });

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.event).toMatchObject({
      type: "text_delta",
      runId: run.id,
      delta: "Reading the file",
    });
  });

  it("keeps the order of many quick events", async () => {
    const { run } = await insertRun(db);
    const sink = createEventSink(
      { publisher: recordingPublisher().publisher },
      runEventTarget(db, run.id),
    );
    for (let i = 0; i < 40; i++) {
      sink.emit({
        type: "sandbox_created",
        runId: run.id,
        ts,
        sandboxId: `sb-${i}`,
      });
    }
    await sink.flush();

    const stored = await storedEvents(run.id);
    expect(stored.map((e) => e.payload.sandboxId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `sb-${i}`),
    );
    expect(stored.map((e) => e.seq)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });

  it("reports a failed write on flush and keeps going without gaps", async () => {
    const { run } = await insertRun(db);
    const { publisher } = recordingPublisher((message) =>
      message.includes("sb-broken"),
    );
    const sink = createEventSink({ publisher }, runEventTarget(db, run.id));

    sink.emit({
      type: "sandbox_created",
      runId: run.id,
      ts,
      sandboxId: "sb-broken",
    });
    sink.emit(stage(run.id, "setup"));
    await expect(sink.flush()).rejects.toThrow("redis down");
    expect((await storedEvents(run.id)).map((e) => [e.seq, e.type])).toEqual([
      [1, "sandbox_created"],
      [2, "stage_changed"],
    ]);

    const missing = createEventSink(
      { publisher },
      runEventTarget(db, randomUUID()),
    );
    missing.emit(stage(randomUUID(), "setup"));
    await expect(missing.flush()).rejects.toThrow();
  });
});
