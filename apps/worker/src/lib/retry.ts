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

export type RetryOptions = {
  retryForMs: number;
  firstRetryMs: number;
  onRetry?: () => void;
};

const LONGEST_RETRY_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `write`, retrying with growing waits while it fails in a way that passes; throws the error it gave up on. */
export async function withRetries<T>(
  write: () => Promise<T>,
  { retryForMs, firstRetryMs, onRetry }: RetryOptions,
): Promise<T> {
  const started = Date.now();
  for (let wait = firstRetryMs; ; wait = Math.min(wait * 2, LONGEST_RETRY_MS)) {
    try {
      return await write();
    } catch (error) {
      if (!isRetryable(error) || Date.now() - started + wait > retryForMs)
        throw error;
      onRetry?.();
      await sleep(wait);
    }
  }
}

/** As `withRetries`, but never throws: null once done, else the error it gave up on. */
export async function tryWithRetries(
  write: () => Promise<unknown>,
  options: RetryOptions,
): Promise<unknown> {
  try {
    await withRetries(write, options);
    return null;
  } catch (error) {
    return error;
  }
}

/** How long a run's or setup's final write is retried: longer than progress, as it matters most. */
export const END_RETRY_MS = 60_000;
