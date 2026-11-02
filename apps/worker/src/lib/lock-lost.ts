/**
 * Why work is stopped when the queue gave its lock away (the worker fell too far behind to
 * renew it): the queue has failed the job, and the reaper ends the run or setup as it does
 * for a worker that died. The handler records nothing and keeps the sandbox for it.
 */
export class LockLostError extends Error {
  constructor() {
    super("The queue gave this work's lock away; the reaper ends it.");
    this.name = "LockLostError";
  }
}

export const lockLost = (signal?: AbortSignal) =>
  signal?.reason instanceof LockLostError;
