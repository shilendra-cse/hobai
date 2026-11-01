import {
  getLastOnboardingEventSeq,
  listUnfinishedOnboardings,
  markOnboardingEnded,
} from "@hobai/db";
import type { OnboardingEventBody } from "@hobai/shared";
import { createEventSink, onboardingEventTarget } from "../events/sink.js";
import { PENDING, QUEUED_GRACE_MS, type LostRunsDeps } from "./lost-runs.js";

const REASONS = {
  worker_lost: "The worker setting it up stopped before setup finished.",
  lost_in_queue: "It was queued but never started, and its queue item is gone.",
};

export type LostOnboarding = {
  onboardingId: string;
  code: keyof typeof REASONS;
};

export type LostOnboardingsDeps = Omit<LostRunsDeps, "connectSandbox">;

// A setup still in progress blocks the next one for its project, so one whose worker is gone has to be ended.
export async function findLostOnboardings(
  deps: Pick<LostOnboardingsDeps, "db" | "queue">,
  now = Date.now(),
): Promise<LostOnboarding[]> {
  const lost: LostOnboarding[] = [];
  for (const setup of await listUnfinishedOnboardings(deps.db)) {
    const state = await deps.queue.getJobState(setup.id);
    if (setup.status !== "queued" && state !== "active") {
      lost.push({ onboardingId: setup.id, code: "worker_lost" });
    } else if (
      setup.status === "queued" &&
      !PENDING.has(state) &&
      now - setup.queuedAt.getTime() > QUEUED_GRACE_MS
    ) {
      lost.push({ onboardingId: setup.id, code: "lost_in_queue" });
    }
  }
  return lost;
}

export async function failLostOnboardings(
  deps: LostOnboardingsDeps,
): Promise<LostOnboarding[]> {
  const failed: LostOnboarding[] = [];
  for (const lost of await findLostOnboardings(deps)) {
    const { onboardingId, code } = lost;
    const message = REASONS[code];
    const ended = await markOnboardingEnded(deps.db, onboardingId, {
      status: "failed",
      errorCode: code,
      errorMessage: message,
    });
    if (!ended) continue;

    const sink = createEventSink<OnboardingEventBody>(
      deps,
      onboardingEventTarget(onboardingId),
      await getLastOnboardingEventSeq(deps.db, onboardingId),
    );
    const ts = new Date().toISOString();
    sink.emit({ type: "error", ts, code, message });
    sink.emit({ type: "done", ts, status: "failed", error: message });
    try {
      await sink.flush();
    } catch (error) {
      deps.log("warn", "A lost setup's events weren't saved or published", {
        onboardingId,
        error: String(error),
      });
    }
    deps.log("warn", "Failed a lost setup", { onboardingId, code });
    failed.push(lost);
  }
  return failed;
}
