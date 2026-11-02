import {
  insertOnboardingEvents,
  insertRunEvents,
  type Db,
  type NewOnboardingEvent,
  type NewRunEvent,
} from "@hobai/db";

import { isRetryable, tryWithRetries } from "../lib/retry.js";

export type Publisher = {
  publish(channel: string, message: string): Promise<unknown>;
};

export type StoredEvent =
  | { table: "run"; row: NewRunEvent }
  | { table: "onboarding"; row: NewOnboardingEvent };

export type EventRows = {
  run: NewRunEvent[];
  onboarding: NewOnboardingEvent[];
};

export type WrittenEvent = {
  /** Absent for events that are only published. */
  store?: StoredEvent;
  channel: string;
  message: string;
};

/** One per process: stores the events of every run and setup together, then publishes them. */
export type EventWriterStats = {
  /** Events not yet published (waiting, or in a round being stored). */
  waiting: number;
  /** How long the oldest of them has waited. */
  oldestWaitMs: number;
  /** How long the last round took, from storing to the last publish. */
  lastRoundMs: number;
  /** Totals since the start. */
  retries: number;
  failed: number;
  dropped: number;
};

/** One per process: stores the events of every run and setup together, then publishes them. */
export type EventWriter = {
  /** Resolves once the event is stored (when it's stored at all) and published, or dropped as stale. */
  add(event: WrittenEvent): Promise<void>;
  stats(): EventWriterStats;
  /** Writes what's waiting. */
  close(): Promise<void>;
};

/** How long events are gathered before they're written together. */
export const EVENT_WRITE_MS = 50;
const RETRY_FOR_MS = 60_000;
const FIRST_RETRY_MS = 250;
// 5 columns a row keeps one INSERT far under Postgres's 65,535 parameters.
const MAX_ROWS = 1_000;
// Of the pool's 20 connections, so other queries still get theirs.
const PARALLEL_INSERTS = 3;
// Text and step progress are only shown live, and the next one replaces them; ones this old
// are dropped rather than sent, so a backlog clears faster.
const STALE_LIVE_MS = 5_000;

export const dbEventRows =
  (db: Db) =>
  async ({ run, onboarding }: EventRows) => {
    await Promise.all([
      insertRunEvents(db, run),
      insertOnboardingEvents(db, onboarding),
    ]);
  };

type Waiting = WrittenEvent & {
  addedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowsOf(events: Waiting[]): EventRows {
  const rows: EventRows = { run: [], onboarding: [] };
  for (const { store } of events) {
    if (store?.table === "run") rows.run.push(store.row);
    else if (store?.table === "onboarding") rows.onboarding.push(store.row);
  }
  return rows;
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export function createEventWriter(
  deps: {
    store: (rows: EventRows) => Promise<void>;
    publisher: Publisher;
  },
  options: {
    writeMs?: number;
    retryForMs?: number;
    firstRetryMs?: number;
    staleLiveMs?: number;
  } = {},
): EventWriter {
  const writeMs = options.writeMs ?? EVENT_WRITE_MS;
  const retryForMs = options.retryForMs ?? RETRY_FOR_MS;
  const firstRetryMs = options.firstRetryMs ?? FIRST_RETRY_MS;
  const staleLiveMs = options.staleLiveMs ?? STALE_LIVE_MS;
  let waiting: Waiting[] = [];
  // Rounds taken but not yet published: still behind, for the stats.
  const inRounds = new Set<Waiting[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  const totals = { lastRoundMs: 0, retries: 0, failed: 0, dropped: 0 };

  /** The error it gave up on, or null once stored. */
  const storeWithRetry = (rows: EventRows) =>
    tryWithRetries(() => deps.store(rows), {
      retryForMs,
      firstRetryMs,
      onRetry: () => (totals.retries += 1),
    });

  // A row Postgres refuses (e.g. its run was deleted) fails the whole INSERT; halving the
  // events until it's alone finds it in a few INSERTs, and only it fails.
  async function storeEvents(events: Waiting[], failed: Map<Waiting, unknown>) {
    const error = await storeWithRetry(rowsOf(events));
    if (error === null) return;
    if (isRetryable(error) || events.length === 1) {
      for (const event of events) failed.set(event, error);
      return;
    }
    const half = Math.ceil(events.length / 2);
    await storeEvents(events.slice(0, half), failed);
    await storeEvents(events.slice(half), failed);
  }

  /** Which events couldn't be stored, and why. */
  async function store(batch: Waiting[]) {
    const failed = new Map<Waiting, unknown>();
    const groups = chunks(
      chunks(
        batch.filter((event) => event.store),
        MAX_ROWS,
      ),
      PARALLEL_INSERTS,
    );
    for (const group of groups) {
      await Promise.all(group.map((events) => storeEvents(events, failed)));
    }
    totals.failed += failed.size;
    return failed;
  }

  // One connection sends them in order, so each channel gets its events in order. The round
  // leaves the stats before its events are settled, so a settled event is never counted behind.
  async function publish(batch: Waiting[], failed: Map<Waiting, unknown>) {
    const now = Date.now();
    const outcomes = await Promise.all(
      batch.map(async (event): Promise<{ error: unknown } | null> => {
        if (failed.has(event)) return { error: failed.get(event) };
        if (!event.store && now - event.addedAt > staleLiveMs) {
          totals.dropped += 1;
          return null;
        }
        try {
          await deps.publisher.publish(event.channel, event.message);
          return null;
        } catch (error) {
          return { error };
        }
      }),
    );
    inRounds.delete(batch);
    batch.forEach((event, i) => {
      const outcome = outcomes[i];
      if (outcome) event.reject(outcome.error);
      else event.resolve();
    });
  }

  // Each round takes everything waiting. While a round publishes, the next one gathers and
  // stores; its publishing waits for this round's, so order holds.
  async function writeAll() {
    let published: Promise<void> = Promise.resolve();
    let publishing = false;
    for (;;) {
      if (waiting.length === 0) {
        if (!publishing) return;
        await Promise.race([published, sleep(writeMs)]);
        continue;
      }
      const batch = waiting;
      waiting = [];
      inRounds.add(batch);
      const started = Date.now();
      const failed = await store(batch);
      await published;
      publishing = true;
      published = publish(batch, failed).then(() => {
        totals.lastRoundMs = Date.now() - started;
        publishing = false;
      });
    }
  }

  function start() {
    timer = undefined;
    writing = writeAll().finally(() => {
      writing = undefined;
      if (waiting.length > 0) timer = setTimeout(start, writeMs);
    });
  }

  return {
    add(event) {
      return new Promise((resolve, reject) => {
        waiting.push({ ...event, addedAt: Date.now(), resolve, reject });
        if (!writing && !timer) timer = setTimeout(start, writeMs);
      });
    },
    stats: () => {
      const behind = [...inRounds, waiting].filter((b) => b.length > 0);
      const oldest = Math.min(...behind.map((b) => b[0]!.addedAt));
      return {
        waiting: behind.reduce((sum, b) => sum + b.length, 0),
        oldestWaitMs: behind.length ? Date.now() - oldest : 0,
        ...totals,
      };
    },
    async close() {
      while (writing || timer) {
        if (timer) {
          clearTimeout(timer);
          start();
        }
        await writing;
      }
    },
  };
}
