import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOpenAI } from "@ai-sdk/openai";
import { DEFAULT_AGENT_MODEL } from "@hobai/shared";
import { z } from "zod";
import { findModelSpec } from "../../model/catalog.js";
import type { ResolvedModel } from "../../model/resolve-model.js";

const RECORDING = path.join(import.meta.dirname, "recorded", "step-1.sse");
const CHARS_PER_TOKEN = 4;
// Tokens due within this window go out in one write, so the fake isn't the bottleneck under load.
const WRITE_WINDOW_MS = 50;
// OpenAI pads each delta with random characters so every chunk is about this long.
const PADDED_DELTA_CHARS = 16;

export type FakeOpenAIRequest = {
  model: string;
  input: unknown[];
  tools: unknown[];
  /** How many tool results the conversation has: 0 on the first step. */
  step: number;
};

export type FakeOpenAIReply = {
  text?: string;
  toolCall?: { name: string; input: unknown };
  /** This step's wait before its first event, instead of the server's. */
  firstTokenMs?: number;
};

export type FakeOpenAIOptions = {
  reply: (request: FakeOpenAIRequest) => FakeOpenAIReply;
  /** 0 sends everything at once. */
  tokensPerSecond?: number;
  /** Time before the first event, like the model reading the prompt. */
  firstTokenMs?: number;
  /** Share of input tokens reported as cached after the first step, as prompt caching does. */
  cachedInputShare?: number;
};

export type FakeOpenAI = {
  /** For `createOpenAI({ baseURL })` or `OPENAI_BASE_URL`. */
  url: string;
  close(): Promise<void>;
};

type Json = Record<string, unknown>;
type Pace = { tokensPerSecond: number; firstTokenMs: number };
type Chunk = { text: string; token: boolean };

const jsonObject = z.record(z.string(), z.unknown());
const requestSchema = z.object({
  model: z.string(),
  input: z.array(z.unknown()),
  tools: z.array(z.unknown()).default([]),
});
const recordedEvent = z.looseObject({
  type: z.string(),
  item: z.looseObject({ type: z.string() }).optional(),
});

function loadTemplates() {
  const byKind = new Map<string, Json>();
  for (const block of readFileSync(RECORDING, "utf8").split("\n\n")) {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    if (!data) continue;
    const event = recordedEvent.parse(JSON.parse(data.slice("data: ".length)));
    const kind = event.item ? `${event.type}:${event.item.type}` : event.type;
    if (!byKind.has(kind)) byKind.set(kind, event);
  }
  return (kind: string) => {
    const template = byKind.get(kind);
    if (!template) throw new Error(`The recording has no "${kind}" event.`);
    return template;
  };
}

const field = (object: Json, key: string) => jsonObject.parse(object[key]);
const id = (prefix: string) => `${prefix}_${randomBytes(25).toString("hex")}`;
const padding = (delta: string) =>
  randomBytes(PADDED_DELTA_CHARS)
    .toString("base64url")
    .slice(0, Math.max(1, PADDED_DELTA_CHARS - delta.length));

/** Splits text roughly the way a tokenizer does: words with their leading space, punctuation apart. */
export function toTokens(text: string): string[] {
  return (
    text.match(/\s*[\p{L}\p{N}_]{1,8}|\s*[^\p{L}\p{N}_\s]{1,3}|\s+/gu) ?? []
  );
}

function buildResponse(
  template: ReturnType<typeof loadTemplates>,
  request: FakeOpenAIRequest,
  reply: FakeOpenAIReply,
  inputChars: number,
  cachedInputShare: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let sequence = 0;
  const emit = (event: Json, token = false) => {
    const body = { ...event, sequence_number: sequence++ };
    chunks.push({
      text: `event: ${String(event.type)}\ndata: ${JSON.stringify(body)}\n\n`,
      token,
    });
  };

  const responseId = id("resp");
  const created = template("response.created");
  const response = {
    ...field(created, "response"),
    id: responseId,
    created_at: Math.floor(Date.now() / 1000),
    model: request.model,
    tools: request.tools,
  };
  emit({ ...created, response });
  emit({ ...template("response.in_progress"), response });

  const output: Json[] = [];
  let outputTokens = 0;
  const addItem = (kind: string, item: Json, final: Json) => {
    const outputIndex = output.length;
    emit({
      ...template(`response.output_item.added:${kind}`),
      item,
      output_index: outputIndex,
    });
    return {
      outputIndex,
      done: () => {
        output.push(final);
        emit({
          ...template(`response.output_item.done:${kind}`),
          item: final,
          output_index: outputIndex,
        });
      },
    };
  };

  const reasoningAdded = field(
    template("response.output_item.added:reasoning"),
    "item",
  );
  const reasoningDone = field(
    template("response.output_item.done:reasoning"),
    "item",
  );
  const reasoningId = id("rs");
  addItem(
    "reasoning",
    { ...reasoningAdded, id: reasoningId },
    { ...reasoningDone, id: reasoningId },
  ).done();

  if (reply.text) {
    const messageId = id("msg");
    const message = field(
      template("response.output_item.added:message"),
      "item",
    );
    const content = [
      { type: "output_text", annotations: [], logprobs: [], text: reply.text },
    ];
    const item = addItem(
      "message",
      { ...message, id: messageId },
      {
        ...message,
        id: messageId,
        status: "completed",
        content,
      },
    );
    const at = {
      item_id: messageId,
      output_index: item.outputIndex,
      content_index: 0,
    };
    const part = { type: "output_text", annotations: [], logprobs: [] };
    emit({
      ...template("response.content_part.added"),
      ...at,
      part: { ...part, text: "" },
    });
    for (const delta of toTokens(reply.text)) {
      outputTokens += 1;
      emit(
        {
          ...template("response.output_text.delta"),
          ...at,
          delta,
          obfuscation: padding(delta),
        },
        true,
      );
    }
    emit({ ...template("response.output_text.done"), ...at, text: reply.text });
    emit({
      ...template("response.content_part.done"),
      ...at,
      part: { ...part, text: reply.text },
    });
    item.done();
  }

  if (reply.toolCall) {
    const callId = id("fc");
    const call = field(
      template("response.output_item.added:function_call"),
      "item",
    );
    const started = {
      ...call,
      id: callId,
      call_id: `call_${randomBytes(12).toString("base64url")}`,
      name: reply.toolCall.name,
      arguments: "",
    };
    const args = JSON.stringify(reply.toolCall.input);
    const item = addItem("function_call", started, {
      ...started,
      status: "completed",
      arguments: args,
    });
    const at = { item_id: callId, output_index: item.outputIndex };
    for (const delta of toTokens(args)) {
      outputTokens += 1;
      emit(
        {
          ...template("response.function_call_arguments.delta"),
          ...at,
          delta,
          obfuscation: padding(delta),
        },
        true,
      );
    }
    emit({
      ...template("response.function_call_arguments.done"),
      ...at,
      arguments: args,
    });
    item.done();
  }

  const completed = template("response.completed");
  const recordedResponse = field(completed, "response");
  const usage = field(recordedResponse, "usage");
  const reasoningTokens = field(
    usage,
    "output_tokens_details",
  ).reasoning_tokens;
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const cachedTokens =
    request.step > 0 ? Math.floor(inputTokens * cachedInputShare) : 0;
  const totalOutput = outputTokens + Number(reasoningTokens ?? 0);
  emit({
    ...completed,
    response: {
      ...recordedResponse,
      ...response,
      status: "completed",
      completed_at: Math.floor(Date.now() / 1000),
      output,
      usage: {
        ...usage,
        input_tokens: inputTokens,
        input_tokens_details: {
          ...field(usage, "input_tokens_details"),
          cached_tokens: cachedTokens,
        },
        output_tokens: totalOutput,
        total_tokens: inputTokens + totalOutput,
      },
    },
  });
  return chunks;
}

async function readBody(req: IncomingMessage) {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString("utf8");
}

async function send(
  res: ServerResponse,
  chunks: Chunk[],
  { tokensPerSecond, firstTokenMs }: Pace,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  if (firstTokenMs > 0) await sleep(firstTokenMs);

  const start = Date.now();
  let sent = 0;
  let pending = "";
  for (const chunk of chunks) {
    if (res.destroyed) return;
    if (chunk.token && tokensPerSecond > 0) {
      const wait = start + (sent * 1000) / tokensPerSecond - Date.now();
      if (wait > WRITE_WINDOW_MS) {
        res.write(pending);
        pending = "";
        await sleep(wait);
      }
      sent += 1;
    }
    pending += chunk.text;
  }
  res.end(pending);
}

function sendError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "fake_openai_error" } }));
}

/**
 * A local stand-in for OpenAI's Responses API, streaming in the format of a recorded response,
 * so the real `@ai-sdk/openai` provider runs end to end without a paid call.
 */
export async function startFakeOpenAI(
  options: FakeOpenAIOptions,
): Promise<FakeOpenAI> {
  const template = loadTemplates();
  const pace = {
    tokensPerSecond: options.tokensPerSecond ?? 0,
    firstTokenMs: options.firstTokenMs ?? 0,
  };
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      sendError(res, 404, `No route for ${req.method} ${req.url}.`);
      return;
    }
    void (async () => {
      const body = await readBody(req);
      const parsed = requestSchema.parse(JSON.parse(body));
      const step = parsed.input.filter(
        (item) =>
          jsonObject.safeParse(item).data?.type === "function_call_output",
      ).length;
      const request = { ...parsed, step };
      const reply = options.reply(request);
      await send(
        res,
        buildResponse(
          template,
          request,
          reply,
          body.length,
          options.cachedInputShare ?? 0,
        ),
        { ...pace, firstTokenMs: reply.firstTokenMs ?? pace.firstTokenMs },
      );
    })().catch((error: unknown) => {
      if (res.headersSent) res.destroy();
      else
        sendError(
          res,
          500,
          error instanceof Error ? error.message : String(error),
        );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The fake OpenAI server isn't listening on a port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** A catalog model through the real OpenAI provider, sending its requests to a fake server. */
export function fakeOpenAIModel(
  fake: FakeOpenAI,
  id: string = DEFAULT_AGENT_MODEL,
): ResolvedModel {
  const spec = findModelSpec(id);
  if (!spec) throw new Error(`Model "${id}" isn't in the model catalog.`);
  const provider = createOpenAI({ baseURL: fake.url, apiKey: "fake-key" });
  return { spec, languageModel: provider(id.replace(/^openai:/, "")) };
}
