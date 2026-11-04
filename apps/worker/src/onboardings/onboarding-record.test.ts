import type { Db, OnboardingOutcome } from "@hobai/db";
import { describe, expect, it } from "vitest";
import { createOnboardingRecord } from "./onboarding-record.js";

const noAnswer = () => new Error("timeout exceeded when trying to connect");

function recordWith(errors: Error[]) {
  const writes: OnboardingOutcome[] = [];
  const record = createOnboardingRecord({} as Db, "onboarding-1", {
    markEnded: async (outcome) => {
      writes.push(outcome);
      const error = errors.shift();
      if (error) throw error;
      return true;
    },
    endRetryForMs: 1_000,
    firstRetryMs: 1,
  });
  return { record, writes };
}

describe("the setup's final write", () => {
  it("is retried until the outcome is saved", async () => {
    const { record, writes } = recordWith([noAnswer(), noAnswer()]);
    await expect(
      record.finish({
        status: "cancelled",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: "0.0000",
      }),
    ).resolves.toBe(true);
    expect(writes).toHaveLength(3);
  });

  it("is retried for a failure too", async () => {
    const { record, writes } = recordWith([noAnswer()]);
    await expect(
      record.fail({ code: "github_access", message: "App removed" }),
    ).resolves.toBe(true);
    expect(writes.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "github_access",
    });
  });
});
