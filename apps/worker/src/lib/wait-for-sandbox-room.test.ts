import {
  SandboxBusyError,
  SandboxCreateError,
  type Sandbox,
} from "@hobai/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Log } from "./log.js";
import type { SandboxFactory } from "./sandbox-factory.js";
import { waitForSandboxRoom } from "./wait-for-sandbox-room.js";

const sandbox = { id: "sbx-1" } as Sandbox;
const busy = () => new SandboxBusyError("E2B has no room for another sandbox");

function factory(answers: (Sandbox | Error)[]) {
  let calls = 0;
  const create: SandboxFactory = async () => {
    const answer = answers[Math.min(calls++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { create, calls: () => calls };
}

function logged() {
  const lines: string[] = [];
  const log: Log = (_level, message) => lines.push(message);
  return { log, lines };
}

const options = (log: Log) => ({
  log,
  waitForMs: 120_000,
  firstRetryMs: 5_000,
  random: () => 0,
});

describe("waitForSandboxRoom", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits while the provider is full, then returns the sandbox", async () => {
    const { create, calls } = factory([busy(), busy(), sandbox]);
    const { log, lines } = logged();
    const created = waitForSandboxRoom(create, options(log))({ kind: "run" });
    await vi.advanceTimersByTimeAsync(5_000 + 10_000);
    await expect(created).resolves.toBe(sandbox);
    expect(calls()).toBe(3);
    expect(lines).toEqual([
      "No sandbox room; waiting",
      "Got a sandbox after waiting for room",
    ]);
  });

  it("gives up after its time with a message for the user", async () => {
    const { create, calls } = factory([busy()]);
    const { log, lines } = logged();
    const created = waitForSandboxRoom(create, options(log))({ kind: "run" });
    const failed = expect(created).rejects.toThrow(
      "All sandboxes were busy for 2 minutes; try again shortly.",
    );
    // 5 + 10 + 20 + 40 seconds waited; the next 60 would pass the two minutes.
    await vi.advanceTimersByTimeAsync(75_000);
    await failed;
    await expect(created).rejects.toBeInstanceOf(SandboxBusyError);
    expect(calls()).toBe(5);
    expect(lines.at(-1)).toBe("Gave up waiting for sandbox room");
  });

  it("stops waiting when the work is stopped", async () => {
    const { create, calls } = factory([busy()]);
    const stop = new AbortController();
    const created = waitForSandboxRoom(create, options(logged().log))(
      { kind: "run" },
      stop.signal,
    );
    const failed = expect(created).rejects.toBeInstanceOf(SandboxBusyError);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(calls()).toBe(1);
  });

  it("fails at once on any other error", async () => {
    const { create, calls } = factory([new SandboxCreateError("bad template")]);
    const created = waitForSandboxRoom(
      create,
      options(logged().log),
    )({
      kind: "run",
    });
    await expect(created).rejects.toThrow("bad template");
    expect(calls()).toBe(1);
  });
});
