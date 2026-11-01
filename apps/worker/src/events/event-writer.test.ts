import { describe, expect, it } from "vitest";
import {
  createEventWriter,
  isRetryable,
  type EventRows,
  type WrittenEvent,
} from "./event-writer.js";

const at = new Date("2026-11-01T10:00:00Z");
const stored = (runId: string, seq: number): WrittenEvent => ({
  store: {
    table: "run",
    row: { runId, seq, type: "stage_changed", createdAt: at },
  },
  channel: `run:${runId}`,
  message: `${runId}#${seq}`,
});
const live = (runId: string, message: string): WrittenEvent => ({
  channel: `run:${runId}`,
  message,
});

const pgError = (code: string) =>
  new Error("Failed query", {
    cause: Object.assign(new Error("pg"), { code }),
  });

function fakes(
  storeFails: (rows: EventRows, call: number) => Error | null = () => null,
) {
  const log: string[] = [];
  let calls = 0;
  const store = async (rows: EventRows) => {
    const error = storeFails(rows, calls++);
    if (error) throw error;
    log.push(`store ${rows.run.map((r) => `${r.runId}#${r.seq}`).join(",")}`);
  };
  const publisher = {
    async publish(_channel: string, message: string) {
      log.push(`publish ${message}`);
      return 1;
    },
  };
  const writer = createEventWriter(
    { store, publisher },
    { writeMs: 5, firstRetryMs: 1, retryForMs: 30 },
  );
  return { writer, log, calls: () => calls };
}

describe("event writer", () => {
  it("stores every run's waiting events in one write, then publishes them in order", async () => {
    const { writer, log } = fakes();

    await Promise.all([
      writer.add(stored("a", 1)),
      writer.add(stored("b", 1)),
      writer.add(live("a", "a text")),
      writer.add(stored("a", 2)),
    ]);

    expect(log).toEqual([
      "store a#1,b#1,a#2",
      "publish a#1",
      "publish b#1",
      "publish a text",
      "publish a#2",
    ]);
  });

  it("retries a write that got no answer, publishing only once it's stored", async () => {
    const { writer, log, calls } = fakes((_rows, call) =>
      call < 2 ? new Error("timeout exceeded when trying to connect") : null,
    );

    await writer.add(stored("a", 1));

    expect(calls()).toBe(3);
    expect(log).toEqual(["store a#1", "publish a#1"]);
  });

  it("gives up after its retry time, failing only that write's stored events", async () => {
    let down = true;
    const { writer, log } = fakes(() =>
      down ? new Error("connection lost") : null,
    );

    const lost = writer.add(stored("a", 1));
    const text = writer.add(live("a", "a text"));
    await expect(lost).rejects.toThrow("connection lost");
    await text;
    down = false;
    await writer.add(stored("a", 2));

    expect(log).toEqual(["publish a text", "store a#2", "publish a#2"]);
  });

  it("fails only the row Postgres refuses, without retrying", async () => {
    const { writer, log } = fakes((rows) =>
      rows.run.some((r) => r.runId === "gone") ? pgError("23503") : null,
    );

    const results = await Promise.allSettled([
      writer.add(stored("a", 1)),
      writer.add(stored("gone", 1)),
      writer.add(stored("b", 1)),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(log).toEqual([
      "store a#1",
      "store b#1",
      "publish a#1",
      "publish b#1",
    ]);
  });

  it("writes what's waiting when it closes", async () => {
    const { writer, log } = fakes();

    const written = writer.add(stored("a", 1));
    await writer.close();

    expect(log).toEqual(["store a#1", "publish a#1"]);
    await written;
  });
});

describe("isRetryable", () => {
  it.each([
    [new Error("timeout exceeded when trying to connect"), true],
    [pgError("08006"), true],
    [pgError("53300"), true],
    [pgError("57P01"), true],
    [pgError("40001"), true],
    [pgError("23503"), false],
    [pgError("22P02"), false],
  ])("%s → %s", (error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});
