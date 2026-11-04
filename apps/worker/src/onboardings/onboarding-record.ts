import {
  markOnboardingEnded,
  markOnboardingResumed,
  markOnboardingStarted,
  markOnboardingWaiting,
  type Db,
  type OnboardingOutcome,
} from "@hobai/db";
import type { OnboardingResult } from "@hobai/runner";
import type { OnboardingEndStatus } from "@hobai/shared";
import { END_RETRY_MS, withRetries } from "../lib/retry.js";

export type OnboardingFailure = { code: string; message: string };

export type EndedOnboarding = OnboardingOutcome & {
  status: OnboardingEndStatus;
};

/** How a finished setup is recorded; `savedEnvironmentId` is set when it saved a version. */
export function onboardingOutcome(
  result: OnboardingResult,
  savedEnvironmentId: string | null,
): EndedOnboarding {
  const usage = result.agent?.usage;
  const spent = {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: (usage?.costUsd ?? 0).toFixed(4),
  };
  if (result.status === "approved" && savedEnvironmentId) {
    return { status: "succeeded", environmentId: savedEnvironmentId, ...spent };
  }
  if (result.status === "cancelled") return { status: "cancelled", ...spent };
  // Setup saves on its own, so nothing is discarded today; if it ever is, it's recorded rather than lost.
  const code = result.status === "discarded" ? "discarded" : "setup_failed";
  return {
    status: "failed",
    errorCode: code,
    errorMessage: result.error ?? "Setup didn't finish.",
    ...spent,
  };
}

export type OnboardingRecord = ReturnType<typeof createOnboardingRecord>;

export type OnboardingRecordOptions = {
  markEnded?: (outcome: OnboardingOutcome) => Promise<boolean>;
  endRetryForMs?: number;
  firstRetryMs?: number;
};

export function createOnboardingRecord(
  db: Db,
  onboardingId: string,
  options: OnboardingRecordOptions = {},
) {
  const write =
    options.markEnded ??
    ((outcome: OnboardingOutcome) =>
      markOnboardingEnded(db, onboardingId, outcome));
  const markEnded = (outcome: OnboardingOutcome) =>
    withRetries(() => write(outcome), {
      retryForMs: options.endRetryForMs ?? END_RETRY_MS,
      firstRetryMs: options.firstRetryMs ?? 250,
    });
  return {
    /** False when the setup isn't queued any more (e.g. it was cancelled first). */
    start: () => markOnboardingStarted(db, onboardingId),
    waiting: (questionId: string) =>
      markOnboardingWaiting(db, onboardingId, questionId),
    resumed: () => markOnboardingResumed(db, onboardingId),
    finish: (outcome: EndedOnboarding) => markEnded(outcome),
    fail: (failure: OnboardingFailure) =>
      markEnded({
        status: "failed",
        errorCode: failure.code,
        errorMessage: failure.message,
      }),
  };
}
