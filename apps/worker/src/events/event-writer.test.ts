import { describe, expect, it, vi } from "vitest";
import {
  createEventWriter,
  type EventRows,
  type WrittenEvent,
} from "./event-writer.js";
import { isRetryable } from "../lib/retry.js";

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

describe("event writer under load", () => {
  const publisher = (log: string[]) => ({
    async publish(_channel: string, message: string) {
      log.push(message);
      return 1;
    },
  });

  it("finds the rows Postgres refuses by halving, failing only them", async () => {
    let inserts = 0;
    const store = async (rows: EventRows) => {
      inserts += 1;
      if (rows.run.some((r) => r.runId === "gone")) throw pgError("23503");
    };
    const writer = createEventWriter(
      { store, publisher: publisher([]) },
      { writeMs: 1 },
    );
    const events = Array.from({ length: 1_000 }, (_, i) =>
      stored(i === 100 || i === 700 ? "gone" : "a", i),
    );

    const results = await Promise.allSettled(events.map((e) => writer.add(e)));

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(inserts).toBeLessThan(45);
    expect(writer.stats().failed).toBe(2);
  });

  it("writes a whole backlog in one round, in INSERTs of up to 1,000 rows, in order", async () => {
    const sizes: number[] = [];
    const sent: string[] = [];
    const writer = createEventWriter(
      {
        store: async (rows) => void sizes.push(rows.run.length),
        publisher: publisher(sent),
      },
      { writeMs: 1 },
    );
    const events = Array.from({ length: 5_000 }, (_, i) => stored("a", i));

    await Promise.all(events.map((e) => writer.add(e)));

    expect(sizes).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(sent).toEqual(events.map((e) => e.message));
  });

  it("stores the next round while this one publishes, keeping the order", async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const writer = createEventWriter(
      {
        store: async (rows) =>
          void log.push(`store ${rows.run.map((r) => r.seq).join(",")}`),
        publisher: {
          async publish(_channel, message) {
            if (message === "a#1") await slow;
            log.push(`publish ${message}`);
            return 1;
          },
        },
      },
      { writeMs: 1 },
    );

    const first = writer.add(stored("a", 1));
    await vi.waitFor(() => expect(log).toEqual(["store 1"]));
    const second = writer.add(stored("a", 2));
    await vi.waitFor(() => expect(log).toEqual(["store 1", "store 2"]));
    release();
    await Promise.all([first, second]);

    expect(log).toEqual(["store 1", "store 2", "publish a#1", "publish a#2"]);
  });

  it("drops live events that waited too long, never stored ones", async () => {
    const sent: string[] = [];
    const writer = createEventWriter(
      {
        store: () => new Promise((r) => setTimeout(r, 40)),
        publisher: publisher(sent),
      },
      { writeMs: 1, staleLiveMs: 20 },
    );

    await Promise.all([
      writer.add(live("a", "old text")),
      writer.add(stored("a", 1)),
    ]);

    expect(sent).toEqual(["a#1"]);
    expect(writer.stats()).toMatchObject({ dropped: 1, waiting: 0 });
  });

  it("tells how far behind it is, counting a round still being stored", async () => {
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    let storing = false;
    const writer = createEventWriter(
      {
        store: async () => {
          storing = true;
          await stuck;
        },
        publisher: publisher([]),
      },
      { writeMs: 1 },
    );

    const written = writer.add(stored("a", 1));
    await vi.waitFor(() => expect(storing).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(writer.stats().waiting).toBe(1);
    expect(writer.stats().oldestWaitMs).toBeGreaterThanOrEqual(20);
    release();
    await written;
    expect(writer.stats()).toMatchObject({ waiting: 0, oldestWaitMs: 0 });
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
