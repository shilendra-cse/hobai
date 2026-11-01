// Records what OpenAI streams back for two agent steps (text, then a tool call; then finish),
// through the same provider the worker uses. The fake OpenAI server for load tests replays its format.
// Self-contained (no relative imports), so Node runs it without a build step.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { hasToolCall, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const MODEL = process.env.AGENT_MODEL?.replace(/^openai:/, "") ?? "gpt-6-luna";
const OUT_DIR = path.join(
  import.meta.dirname,
  "..",
  "testing",
  "fake-openai",
  "recorded",
);

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set (read from apps/worker/.env).");
  process.exit(1);
}

let call = 0;
const writes: Promise<void>[] = [];

// Saves each request body and the raw SSE response while the provider reads it as usual.
const recordingFetch: typeof fetch = async (input, init) => {
  call += 1;
  const name = `step-${call}`;
  if (typeof init?.body === "string") {
    const body = JSON.stringify(JSON.parse(init.body), null, 2);
    writes.push(writeFile(path.join(OUT_DIR, `${name}.request.json`), body));
  }
  const response = await fetch(input, init);
  if (!response.body) return response;
  const [forProvider, forFile] = response.body.tee();
  writes.push(
    new Response(forFile)
      .text()
      .then((text) => writeFile(path.join(OUT_DIR, `${name}.sse`), text)),
  );
  return new Response(forProvider, response);
};

await mkdir(OUT_DIR, { recursive: true });
const openai = createOpenAI({ fetch: recordingFetch });

const result = streamText({
  model: openai(MODEL),
  system:
    "You are a coding agent working in a repository. Before each tool call, say in one short sentence what you are about to do.",
  prompt:
    "Read README.md, then call finish_task with a one-sentence summary of what the repository is.",
  tools: {
    read_file: tool({
      description: "Read a file from the repository.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: file }) =>
        `${file} (3 lines)\n1  # Demo\n2  \n3  A small demo repository for testing.`,
    }),
    finish_task: tool({
      description: "Finish the task with a summary.",
      inputSchema: z.object({ summary: z.string() }),
    }),
  },
  stopWhen: [hasToolCall("finish_task"), stepCountIs(4)],
});

for await (const _part of result.fullStream) {
  // Drained so the provider reads every response to the end.
}
await Promise.all(writes);

const steps = await result.steps;
console.log(`Recorded ${call} responses from ${MODEL} into ${OUT_DIR}`);
for (const [i, step] of steps.entries()) {
  const tools = step.toolCalls.map((c) => c.toolName).join(", ") || "none";
  console.log(
    `  step ${i + 1}: ${step.text.length} characters of text, tool calls: ${tools}`,
  );
}
