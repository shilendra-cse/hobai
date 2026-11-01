import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../client.js";
import { runEvents } from "../../schema/index.js";
import { insertRun, testDatabaseOrSkip } from "../../testing/index.js";
import {
  findRunEventsAfter,
  getLastRunEventSeq,
  insertRunEvent,
  insertRunEvents,
} from "./run-events-queries.js";

const database = await testDatabaseOrSkip("run events queries");

describe.skipIf(!database)("run events queries against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  it("inserts numbered events, and refuses a number twice", async () => {
    const { run } = await insertRun(db);
    const at = new Date("2026-10-21T10:00:00Z");

    await insertRunEvent(db, {
      runId: run.id,
      seq: 1,
      type: "stage_changed",
      payload: { stage: "prepare" },
      createdAt: at,
    });

    expect(
      await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, run.id))
        .orderBy(asc(runEvents.seq)),
    ).toEqual([
      {
        runId: run.id,
        seq: 1,
        type: "stage_changed",
        payload: { stage: "prepare" },
        createdAt: at,
      },
    ]);
    await expect(
      insertRunEvent(db, { runId: run.id, seq: 1, type: "done" }),
    ).rejects.toThrow();
  });

  it("inserts many runs' events at once, leaving a number already stored as it is", async () => {
    const { run } = await insertRun(db);
    const { run: other } = await insertRun(db);
    await insertRunEvent(db, {
      runId: run.id,
      seq: 1,
      type: "stage_changed",
      payload: { stage: "prepare" },
    });

    await insertRunEvents(db, [
      { runId: run.id, seq: 1, type: "stage_changed", payload: { stage: "x" } },
      { runId: run.id, seq: 2, type: "done" },
      { runId: other.id, seq: 1, type: "done" },
    ]);
    await insertRunEvents(db, []);

    const stored = await db
      .select({
        runId: runEvents.runId,
        seq: runEvents.seq,
        payload: runEvents.payload,
      })
      .from(runEvents)
      .where(inArray(runEvents.runId, [run.id, other.id]))
      .orderBy(asc(runEvents.runId), asc(runEvents.seq));
    expect(stored).toHaveLength(3);
    expect(stored).toContainEqual({
      runId: run.id,
      seq: 1,
      payload: { stage: "prepare" },
    });
  });

  it("tells the last stored event number, 0 without events", async () => {
    const { run } = await insertRun(db);
    expect(await getLastRunEventSeq(db, run.id)).toBe(0);

    await insertRunEvent(db, { runId: run.id, seq: 1, type: "stage_changed" });
    await insertRunEvent(db, { runId: run.id, seq: 2, type: "done" });

    expect(await getLastRunEventSeq(db, run.id)).toBe(2);
  });

  it("finds a run's events after a number, in order, a page at a time", async () => {
    const { run } = await insertRun(db);
    const { run: other } = await insertRun(db);
    for (const seq of [3, 1, 2, 4]) {
      await insertRunEvent(db, {
        runId: run.id,
        seq,
        type: "stage_changed",
        payload: { seq },
      });
    }
    await insertRunEvent(db, { runId: other.id, seq: 2, type: "done" });

    const seqs = async (after: number, limit: number) =>
      (await findRunEventsAfter(db, run.id, after, limit)).map((e) => e.seq);

    expect(await seqs(0, 10)).toEqual([1, 2, 3, 4]);
    expect(await seqs(1, 2)).toEqual([2, 3]);
    expect(await seqs(4, 10)).toEqual([]);
  });
});
