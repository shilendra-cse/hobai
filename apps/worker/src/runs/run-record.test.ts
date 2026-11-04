import type { Db, RunOutcome } from "@hobai/db";
import type { RunResult } from "@hobai/runner";
import { describe, expect, it } from "vitest";
import { createRunRecord, runFailure } from "./run-record.js";

const noAnswer = () => new Error("timeout exceeded when trying to connect");
const refused = () => Object.assign(new Error("refused"), { code: "23503" });
const succeeded: RunResult = { status: "succeeded", durationMs: 1 };

/** A record whose final write fails with `errors` first, then saves. */
function recordWith(errors: Error[], endRetryForMs = 1_000) {
  const writes: RunOutcome[] = [];
  const record = createRunRecord({} as Db, "run-1", {
    log: () => {},
    markEnded: async (outcome) => {
      writes.push(outcome);
      const error = errors.shift();
      if (error) throw error;
      return true;
    },
    endRetryForMs,
    firstRetryMs: 1,
  });
  return { record, writes };
}

describe("runFailure", () => {
  it("names a run the provider had no sandbox room for", () => {
    expect(
      runFailure({
        status: "failed",
        failedStage: "sandbox",
        error: "All sandboxes were busy for 10 minutes; try again shortly.",
        sandboxBusy: true,
        durationMs: 600_000,
      }),
    ).toEqual({
      code: "sandbox_busy",
      message: "All sandboxes were busy for 10 minutes; try again shortly.",
    });
  });

  it("names any other failure by its stage", () => {
    expect(
      runFailure({
        status: "failed",
        failedStage: "sandbox",
        error: "bad template",
        durationMs: 1,
      }),
    ).toEqual({ code: "sandbox_failed", message: "bad template" });
  });
});

describe("the run's final write", () => {
  it("is retried until the result is saved", async () => {
    const { record, writes } = recordWith([noAnswer(), noAnswer()]);
    await expect(record.finish(succeeded)).resolves.toBe(true);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({ status: "succeeded" });
  });

  it("is retried for a failure too", async () => {
    const { record, writes } = recordWith([noAnswer()]);
    await expect(
      record.fail({ code: "github_access", message: "App removed" }),
    ).resolves.toBe(true);
    expect(writes).toHaveLength(2);
  });

  it("stops at once on an error that won't pass", async () => {
    const { record, writes } = recordWith([refused()]);
    await expect(record.finish(succeeded)).rejects.toMatchObject({
      code: "23503",
    });
    expect(writes).toHaveLength(1);
  });

  it("throws once its time is up", async () => {
    const errors = Array.from({ length: 100 }, noAnswer);
    const { record } = recordWith(errors, 10);
    await expect(record.finish(succeeded)).rejects.toThrow("timeout exceeded");
  });
});
