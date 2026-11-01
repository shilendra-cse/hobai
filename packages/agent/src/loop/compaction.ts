import type { ModelMessage } from "ai";

const CHARS_PER_TOKEN = 4;

export type CompactorOptions = {
  contextWindow: number;
  fixedChars: number;
  triggerRatio?: number;
  targetRatio?: number;
  keepRecentSteps?: number;
  minRecentSteps?: number;
};

export function estimateTokens(messages: ModelMessage[], fixedChars = 0) {
  return Math.ceil(
    (JSON.stringify(messages).length + fixedChars) / CHARS_PER_TOKEN,
  );
}

function describeCall(toolName: string, input: unknown) {
  const args = (input ?? {}) as Record<string, unknown>;
  const detail =
    typeof args.path === "string" && toolName !== "search"
      ? args.path
      : typeof args.pattern === "string"
        ? JSON.stringify(args.pattern)
        : typeof args.command === "string"
          ? `\`${args.command.length > 80 ? `${args.command.slice(0, 80)}…` : args.command}\``
          : "";
  return detail ? `${toolName} ${detail}` : toolName;
}

type ToolCalls = Map<string, { toolName: string; input: unknown }>;

function collectCalls(message: ModelMessage, calls: ToolCalls) {
  if (message.role !== "assistant" || typeof message.content === "string") {
    return;
  }
  for (const part of message.content) {
    if (part.type === "tool-call") {
      calls.set(part.toolCallId, {
        toolName: part.toolName,
        input: part.input,
      });
    }
  }
}

function compactMessage(message: ModelMessage, calls: ToolCalls): ModelMessage {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const call = calls.get(part.toolCallId);
      const what = call
        ? describeCall(call.toolName, call.input)
        : part.toolName;
      const size = JSON.stringify(part.output).length;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `[Output of ${what} removed to save context (${size} characters). Run the tool again if you need it.]`,
        },
      };
    }),
  };
}

export function compactBefore(
  messages: ModelMessage[],
  upTo: number,
): ModelMessage[] {
  if (upTo <= 0) return messages;
  const calls: ToolCalls = new Map();
  for (const message of messages) collectCalls(message, calls);
  return messages.map((message, index) =>
    index < upTo ? compactMessage(message, calls) : message,
  );
}

// The length of JSON.stringify(messages), from the lengths of its messages: they're joined by
// commas between brackets.
const arrayChars = (count: number, sum: number) =>
  sum + 2 + Math.max(0, count - 1);

// Compacts rarely and in one batch, and keeps the cut-off (watermark) fixed in between, so the prompt prefix stays identical and cacheable.
// The conversation only grows at its end, so each message is measured, and compacted, once:
// a step costs the messages it added, not the whole conversation.
export class Compactor {
  private watermark = 0;
  private count = 0;
  private readonly trigger: number;
  private readonly target: number;
  private readonly keepRecent: number;
  private readonly minRecent: number;
  private readonly calls: ToolCalls = new Map();
  /** The view's messages before the watermark (all of them, if it's past the end). */
  private compacted: ModelMessage[] = [];
  /** Each message's JSON length as sent: compacted before the watermark. */
  private lengths: number[] = [];
  private totalChars = 0;

  constructor(private readonly options: CompactorOptions) {
    this.trigger = options.contextWindow * (options.triggerRatio ?? 0.6);
    this.target = options.contextWindow * (options.targetRatio ?? 0.4);
    this.keepRecent = options.keepRecentSteps ?? 10;
    this.minRecent = options.minRecentSteps ?? 3;
  }

  get compactions() {
    return this.count;
  }

  apply(messages: ModelMessage[]): ModelMessage[] {
    this.measure(messages);
    const view = this.view(messages);
    if (this.tokens(messages.length, this.totalChars) <= this.trigger) {
      return view;
    }

    const stepStarts = messages.flatMap((m, i) =>
      m.role === "assistant" ? [i] : [],
    );
    const candidates = new Map<
      number,
      { message: ModelMessage; chars: number }
    >();
    const compactedAt = (index: number) => {
      let entry = candidates.get(index);
      if (!entry) {
        const message = compactMessage(messages[index]!, this.calls);
        entry = { message, chars: JSON.stringify(message).length };
        candidates.set(index, entry);
      }
      return entry;
    };
    let next = this.watermark;
    for (let keep = this.keepRecent; keep >= this.minRecent; keep--) {
      if (stepStarts.length <= keep) continue;
      const candidate = stepStarts[stepStarts.length - keep]!;
      if (candidate <= this.watermark) continue;
      next = candidate;
      let chars = this.totalChars;
      for (let i = this.watermark; i < candidate; i++) {
        chars += compactedAt(i).chars - this.lengths[i]!;
      }
      if (this.tokens(messages.length, chars) <= this.target) break;
    }

    if (next === this.watermark) return view;
    for (let i = this.watermark; i < next; i++) {
      const { message, chars } = compactedAt(i);
      this.compacted.push(message);
      this.totalChars += chars - this.lengths[i]!;
      this.lengths[i] = chars;
    }
    this.watermark = next;
    this.count += 1;
    return this.view(messages);
  }

  private tokens(count: number, chars: number) {
    return Math.ceil(
      (arrayChars(count, chars) + this.options.fixedChars) / CHARS_PER_TOKEN,
    );
  }

  private view(messages: ModelMessage[]) {
    if (this.watermark === 0) return messages;
    return [...this.compacted, ...messages.slice(this.compacted.length)];
  }

  // Measures the messages added since the last call. A conversation that got shorter isn't
  // the one measured, so then it starts over, keeping the watermark.
  private measure(messages: ModelMessage[]) {
    if (messages.length < this.lengths.length) {
      this.calls.clear();
      this.compacted = [];
      this.lengths = [];
      this.totalChars = 0;
    }
    const from = this.lengths.length;
    for (let i = from; i < messages.length; i++) {
      collectCalls(messages[i]!, this.calls);
    }
    for (let i = from; i < messages.length; i++) {
      let sent = messages[i]!;
      if (i < this.watermark) {
        sent = compactMessage(sent, this.calls);
        this.compacted.push(sent);
      }
      const chars = JSON.stringify(sent).length;
      this.lengths.push(chars);
      this.totalChars += chars;
    }
  }
}
