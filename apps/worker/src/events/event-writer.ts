import {
  insertOnboardingEvents,
  insertRunEvents,
  type Db,
  type NewOnboardingEvent,
  type NewRunEvent,
} from "@hobai/db";

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
export type EventWriter = {
  /** Resolves once the event is stored (when it's stored at all) and published. */
  add(event: WrittenEvent): Promise<void>;
  /** Writes what's waiting. */
  close(): Promise<void>;
};

/** How long events are gathered before they're written together. */
export const EVENT_WRITE_MS = 50;
const RETRY_FOR_MS = 60_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 5_000;
// 5 columns a row keeps one INSERT far under Postgres's 65,535 parameters.
const MAX_BATCH = 1_000;

export const dbEventRows =
  (db: Db) =>
  async ({ run, onboarding }: EventRows) => {
    await Promise.all([
      insertRunEvents(db, run),
      insertOnboardingEvents(db, onboarding),
    ]);
  };

// Errors from Postgres carry a SQLSTATE; drizzle wraps them, so it's on the cause.
function sqlState(error: unknown): string | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

// No SQLSTATE means the query never got an answer (no free connection, connection lost).
// Otherwise retry only what passes: connection (08), resources (53), shutdown (57), conflicts (40).
export function isRetryable(error: unknown) {
  const state = sqlState(error);
  return state === undefined || /^(08|53|57|40)/.test(state);
}

type Waiting = WrittenEvent & {
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

export function createEventWriter(
  deps: {
    store: (rows: EventRows) => Promise<void>;
    publisher: Publisher;
  },
  options: {
    writeMs?: number;
    retryForMs?: number;
    firstRetryMs?: number;
  } = {},
): EventWriter {
  const writeMs = options.writeMs ?? EVENT_WRITE_MS;
  const retryForMs = options.retryForMs ?? RETRY_FOR_MS;
  const firstRetryMs = options.firstRetryMs ?? FIRST_RETRY_MS;
  const waiting: Waiting[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;

  /** The error it gave up on, or null once stored. */
  async function storeWithRetry(rows: EventRows): Promise<unknown> {
    const started = Date.now();
    for (
      let wait = firstRetryMs;
      ;
      wait = Math.min(wait * 2, LONGEST_RETRY_MS)
    ) {
      try {
        await deps.store(rows);
        return null;
      } catch (error) {
        if (!isRetryable(error) || Date.now() - started + wait > retryForMs)
          return error;
        await sleep(wait);
      }
    }
  }

  // Which events couldn't be stored, and why. A row Postgres refuses (e.g. its run was
  // deleted) fails the whole INSERT, so then each row is tried alone and only it fails.
  async function store(batch: Waiting[]) {
    const failed = new Map<Waiting, unknown>();
    const stored = batch.filter((event) => event.store);
    if (stored.length === 0) return failed;
    const error = await storeWithRetry(rowsOf(stored));
    if (error === null) return failed;
    if (isRetryable(error)) {
      for (const event of stored) failed.set(event, error);
      return failed;
    }
    for (const event of stored) {
      const alone = await storeWithRetry(rowsOf([event]));
      if (alone !== null) failed.set(event, alone);
    }
    return failed;
  }

  async function writeAll() {
    while (waiting.length > 0) {
      const batch = waiting.splice(0, MAX_BATCH);
      const failed = await store(batch);
      // One connection sends them in order, so each channel gets its events in order.
      await Promise.all(
        batch.map(async (event) => {
          if (failed.has(event)) return event.reject(failed.get(event));
          try {
            await deps.publisher.publish(event.channel, event.message);
            event.resolve();
          } catch (error) {
            event.reject(error);
          }
        }),
      );
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
        waiting.push({ ...event, resolve, reject });
        if (!writing && !timer) timer = setTimeout(start, writeMs);
      });
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
