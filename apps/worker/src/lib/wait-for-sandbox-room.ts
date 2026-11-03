import { SandboxBusyError } from "@hobai/sandbox";
import type { Log } from "./log.js";
import type { SandboxFactory } from "./sandbox-factory.js";

export type WaitOptions = {
  log: Log;
  /** Default SANDBOX_WAIT_MS. */
  waitForMs?: number;
  /** Default 5 seconds; doubles up to LONGEST_RETRY_MS. */
  firstRetryMs?: number;
  random?: () => number;
};

/**
 * How long a run or setup waits for the provider to have room. It counts toward the run's time
 * limit, so a run still ends within the hour a deploy waits for work in progress.
 */
export const SANDBOX_WAIT_MS = 10 * 60_000;
const LONGEST_RETRY_MS = 60_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Retries a sandbox the provider refused for room (quota, rate limit), instead of failing the work. */
export function waitForSandboxRoom(
  create: SandboxFactory,
  {
    log,
    waitForMs = SANDBOX_WAIT_MS,
    firstRetryMs = 5_000,
    random = Math.random,
  }: WaitOptions,
): SandboxFactory {
  return async (labels, signal) => {
    const started = Date.now();
    let attempts = 0;
    for (
      let wait = firstRetryMs;
      ;
      wait = Math.min(wait * 2, LONGEST_RETRY_MS)
    ) {
      attempts += 1;
      try {
        const sandbox = await create(labels, signal);
        if (attempts > 1) {
          log("warn", "Got a sandbox after waiting for room", {
            ...labels,
            attempts,
            waitedMs: Date.now() - started,
          });
        }
        return sandbox;
      } catch (error) {
        if (!(error instanceof SandboxBusyError) || signal?.aborted)
          throw error;
        // Up to a quarter less, so work refused together doesn't retry together.
        const delay = wait * (1 - random() / 4);
        if (Date.now() - started + delay > waitForMs) {
          log("warn", "Gave up waiting for sandbox room", {
            ...labels,
            attempts,
            waitedMs: Date.now() - started,
            error: error.message,
          });
          throw new SandboxBusyError(
            `All sandboxes were busy for ${Math.round(waitForMs / 60_000)} minutes; try again shortly.`,
            { cause: error },
          );
        }
        if (attempts === 1) {
          log("warn", "No sandbox room; waiting", {
            ...labels,
            error: error.message,
          });
        }
        await sleep(delay, signal);
        if (signal?.aborted) throw error;
      }
    }
  };
}
