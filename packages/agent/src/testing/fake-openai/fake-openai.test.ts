import { FakeSandbox } from "@hobai/sandbox/testing";
import type { RunEvent } from "@hobai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../../task-agent/run-agent.js";
import { createToolContext } from "../../tools/core/context.js";
import {
  fakeOpenAIModel,
  startFakeOpenAI,
  toTokens,
  type FakeOpenAI,
  type FakeOpenAIOptions,
  type FakeOpenAIRequest,
} from "./fake-openai.js";

const twoSteps: FakeOpenAIOptions["reply"] = ({ step }) =>
  step === 0
    ? {
        text: "I'll read the app first.",
        toolCall: { name: "read_file", input: { path: "src/app.ts" } },
      }
    : {
        text: "Nothing to change.",
        toolCall: {
          name: "finish_task",
          input: { summary: "The app is fine as it is." },
        },
      };

let fake: FakeOpenAI | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function runThroughFake(options: FakeOpenAIOptions) {
  const requests: FakeOpenAIRequest[] = [];
  fake = await startFakeOpenAI({
    ...options,
    reply: (request) => {
      requests.push(request);
      return options.reply(request);
    },
  });
  const model = fakeOpenAIModel(fake);
  const events: RunEvent[] = [];
  const result = await runAgent({
    runId: "run-1",
    task: "Check the app",
    ctx: createToolContext(new FakeSandbox({ "src/app.ts": "const a = 1;\n" })),
    model,
    emit: (event) => events.push(event),
  });
  return { result, events, requests };
}

describe("fake OpenAI server", () => {
  it("runs the task agent end to end through the real OpenAI provider", async () => {
    const { result, events, requests } = await runThroughFake({
      reply: twoSteps,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      summary: "The app is fine as it is.",
      steps: 2,
    });
    expect(requests.map((r) => r.step)).toEqual([0, 1]);
    expect(
      events.filter((e) => e.type === "tool_end").map((e) => e.toolName),
    ).toEqual(["read_file", "finish_task"]);
  });

  it("streams text one token per delta, as OpenAI does", async () => {
    const { events } = await runThroughFake({ reply: twoSteps });
    const deltas = events.flatMap((e) =>
      e.type === "text_delta" ? [e.delta] : [],
    );

    expect(deltas).toEqual([
      ...toTokens("I'll read the app first."),
      ...toTokens("Nothing to change."),
    ]);
  });

  it("sends the tool's result back on the next step", async () => {
    const { requests } = await runThroughFake({ reply: twoSteps });

    expect(JSON.stringify(requests[1]!.input)).toContain("const a = 1;");
  });

  it("reports usage the provider can read", async () => {
    const { result } = await runThroughFake({ reply: twoSteps });

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("reports a share of later steps' input as cached", async () => {
    const uncached = await runThroughFake({ reply: twoSteps });
    const cached = await runThroughFake({
      reply: twoSteps,
      cachedInputShare: 0.9,
    });

    expect(uncached.result.usage.cachedInputTokens).toBe(0);
    expect(cached.result.usage.cachedInputTokens).toBeGreaterThan(0);
    expect(cached.result.usage.cachedInputTokens).toBeLessThan(
      cached.result.usage.inputTokens,
    );
  });

  it("waits a step's own time before its first event", async () => {
    const started = Date.now();
    await runThroughFake({
      reply: () => ({
        firstTokenMs: 150,
        toolCall: { name: "finish_task", input: { summary: "Done." } },
      }),
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it("paces tokens at the given speed", async () => {
    const text = "word ".repeat(40).trim();
    const started = Date.now();
    await runThroughFake({
      tokensPerSecond: 200,
      reply: () => ({
        text,
        toolCall: { name: "finish_task", input: { summary: "Done." } },
      }),
    });

    // 40 text tokens plus the arguments' few, at 200 a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});
