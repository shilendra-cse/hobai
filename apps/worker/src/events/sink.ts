import {
  onboardingChannel,
  runChannel,
  type OnboardingEventBody,
  type RunEvent,
} from "@hobai/shared";
import { redactGithubTokensIn } from "../lib/redact.js";
import type { EventWriter, StoredEvent, WrittenEvent } from "./event-writer.js";

const LIVE_ONLY: ReadonlySet<string> = new Set(["agent_step"]);

/** How long the agent's streamed text is gathered before it's sent as one `text_delta`. */
export const TEXT_BATCH_MS = 100;

type StoredRow = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/** Where one run's or one setup's events are stored and published. */
export type EventTarget = {
  channel: string;
  /** How the event names what it belongs to, e.g. `{ runId }`. */
  owner: Record<string, string>;
  stored(row: StoredRow): StoredEvent;
};

export const runEventTarget = (runId: string): EventTarget => ({
  channel: runChannel(runId),
  owner: { runId },
  stored: (row) => ({ table: "run", row: { runId, ...row } }),
});

export const onboardingEventTarget = (onboardingId: string): EventTarget => ({
  channel: onboardingChannel(onboardingId),
  owner: { onboardingId },
  stored: (row) => ({ table: "onboarding", row: { onboardingId, ...row } }),
});

/** Anything with a type and a time; the runner's events carry their run's id, which is replaced by the target's. */
type SinkEvent = (RunEvent | OnboardingEventBody) & { runId?: string };

export type EventSink<E extends SinkEvent = RunEvent> = {
  emit(event: E): void;
  /** Waits for every event so far; rejects with the first write that failed. */
  flush(): Promise<void>;
};

// The worker is the only writer of a run's or a setup's events, so it can number them itself.
export function createEventSink<E extends SinkEvent = RunEvent>(
  deps: { events: EventWriter },
  target: EventTarget,
  /** The last event number already stored, when adding to existing events. */
  lastSeq = 0,
  options: { textBatchMs?: number } = {},
): EventSink<E> {
  let seq = lastSeq;
  const textBatchMs = options.textBatchMs ?? TEXT_BATCH_MS;
  let text: { ts: string; delta: string } | null = null;
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;

  const write = (event: Omit<WrittenEvent, "channel">) => {
    const written: Promise<void> = deps.events
      .add({ ...event, channel: target.channel })
      .catch((error: unknown) => {
        failure ??= { error };
      })
      .finally(() => inFlight.delete(written));
    inFlight.add(written);
  };

  // Text is never stored and only shown live, so it isn't checked for GitHub tokens: one
  // would arrive split across many deltas anyway.
  const sendText = () => {
    clearTimeout(textTimer);
    textTimer = undefined;
    if (!text) return;
    write({
      message: JSON.stringify({
        type: "text_delta",
        ts: text.ts,
        delta: text.delta,
        ...target.owner,
      }),
    });
    text = null;
  };

  return {
    emit: (unredacted) => {
      if (unredacted.type === "text_delta") {
        const { delta } = unredacted as E & { delta: string };
        if (text) {
          text.delta += delta;
        } else {
          text = { ts: unredacted.ts, delta };
          textTimer = setTimeout(sendText, textBatchMs);
        }
        return;
      }
      // Text gathered so far goes first, so events keep their order.
      sendText();

      const event = redactGithubTokensIn(unredacted);
      const {
        type,
        ts,
        runId: _runId,
        seq: _seq,
        ...payload
      } = event as E & { seq?: number };
      const message = { type, ts, ...payload, ...target.owner };
      if (LIVE_ONLY.has(type)) {
        write({ message: JSON.stringify(message) });
        return;
      }
      // Numbered now, so the writer keeps the order; a row it gives up on leaves a gap.
      seq += 1;
      write({
        store: target.stored({ seq, type, payload, createdAt: new Date(ts) }),
        message: JSON.stringify({ ...message, seq }),
      });
    },
    flush: async () => {
      sendText();
      await Promise.all(inFlight);
      if (failure) throw failure.error;
    },
  };
}
