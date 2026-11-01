import {
  fakeOpenAIModel,
  startFakeOpenAI,
  type FakeOpenAI,
} from "@hobai/agent/testing";
import { runTask } from "@hobai/runner";
import type { RunEvent } from "@hobai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { LOAD_ENVIRONMENT, LoadSandbox } from "./load-sandbox.js";
import {
  commandCost,
  costedCommand,
  fileContent,
  repoFile,
  repoFileSize,
} from "./markers.js";
import {
  loadReply,
  loadTask,
  LONG_SHARE,
  plannedSteps,
  planStep,
  PROFILES,
  profileFor,
  type ProfileName,
} from "./profiles.js";

const plan = (runKey: string, name: ProfileName) => {
  const profile = PROFILES[name];
  return Array.from({ length: plannedSteps(runKey, profile) + 1 }, (_, step) =>
    planStep(runKey, profile, step),
  );
};

describe("load markers", () => {
  it("reads back a command's cost", () => {
    const command = costedCommand("pnpm test", {
      ms: 4_200,
      outputChars: 18_000,
      exitCode: 1,
    });

    expect(commandCost(command)).toEqual({
      ms: 4_200,
      outputChars: 18_000,
      exitCode: 1,
    });
    expect(commandCost("pnpm test")).toBeNull();
  });

  it("gives repository files the size in their name", () => {
    const file = `/workspace/${repoFile(3, 12_000)}`;

    expect(repoFileSize(file)).toBe(12_000);
    expect(fileContent(12_000).length).toBeGreaterThanOrEqual(11_000);
  });
});

describe("load profiles", () => {
  it("plans the same run for the same key", () => {
    expect(plan("run-a", "typical")).toEqual(plan("run-a", "typical"));
    expect(plan("run-a", "typical")).not.toEqual(plan("run-b", "typical"));
  });

  it("ends every run with finish_task, within the profile's steps", () => {
    for (const name of ["typical", "long"] as const) {
      const steps = plan(`run-${name}`, name);
      const [min, max] = PROFILES[name].steps;

      expect(steps.at(-1)?.toolCall?.name).toBe("finish_task");
      expect(steps.length - 1).toBeGreaterThanOrEqual(min);
      expect(steps.length - 1).toBeLessThanOrEqual(max);
    }
  });

  it("only edits files read earlier in the run", () => {
    const steps = plan("run-edits", "long");
    const read = new Set<unknown>();
    let edits = 0;
    for (const step of steps) {
      const call = step.toolCall!;
      const path =
        call.input && typeof call.input === "object" && "path" in call.input
          ? call.input.path
          : undefined;
      if (call.name === "read_file") read.add(path);
      if (call.name === "edit_file") {
        edits += 1;
        expect(read).toContain(path);
      }
    }
    expect(edits).toBeGreaterThan(0);
  });

  it("makes about a fifth of mixed runs long", () => {
    const keys = Array.from({ length: 2_000 }, (_, i) => `run-${i}`);
    const long = keys.filter(
      (key) => profileFor(key, "mixed").name === "long",
    ).length;

    expect(long / keys.length).toBeGreaterThan(LONG_SHARE - 0.05);
    expect(long / keys.length).toBeLessThan(LONG_SHARE + 0.05);
  });
});

describe("load sandbox", () => {
  it("takes the time a command's marker says, scaled", async () => {
    const sandbox = new LoadSandbox({ timeScale: 0.01 });
    const started = Date.now();
    const result = await sandbox.exec(
      costedCommand("pnpm test", { ms: 3_000, outputChars: 500 }),
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(result.stdout).toHaveLength(500);
  });
});

describe("a load run", () => {
  let fake: FakeOpenAI | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function loadRun(runKey: string, name: ProfileName) {
    fake = await startFakeOpenAI({
      reply: loadReply(name, 0),
      cachedInputShare: 0.9,
    });
    const events: RunEvent[] = [];
    const result = await runTask({
      runId: runKey,
      task: loadTask(runKey),
      source: { type: "git", url: "https://github.com/acme/load.git" },
      model: fakeOpenAIModel(fake),
      environment: LOAD_ENVIRONMENT,
      createSandbox: async () => new LoadSandbox({ timeScale: 0 }),
      emit: (event) => events.push(event),
    });
    return { result, events };
  }

  it("goes through every stage and makes the planned tool calls", async () => {
    const { result, events } = await loadRun("run-typical", "typical");
    const planned = plan("run-typical", "typical");

    expect(result).toMatchObject({
      status: "succeeded",
      setup: { health: "ok" },
      agent: { status: "succeeded", steps: planned.length },
      verify: { passed: true },
    });
    expect(
      events.flatMap((e) => (e.type === "tool_end" ? [e.toolName] : [])),
    ).toEqual(planned.map((step) => step.toolCall!.name));
  });

  it("compacts a long run's conversation and still finishes", async () => {
    const { result } = await loadRun("run-long", "long");

    expect(result).toMatchObject({
      status: "succeeded",
      agent: { status: "succeeded" },
    });
    expect(result.agent?.compactions).toBeGreaterThan(0);
  });
});
