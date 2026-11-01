import type { FakeOpenAIReply, FakeOpenAIRequest } from "@hobai/agent/testing";
import {
  costedCommand,
  fileContent,
  fileLine,
  MIN_FILE_LINES,
  repoFile,
  searchPattern,
} from "./markers.js";

type Range = readonly [min: number, max: number];
type Sized = { usual: Range; large: Range; largeShare: number };

export type ProfileName = "typical" | "long";
export type ProfileMix = ProfileName | "mixed";

const TOOL_NAMES = [
  "read_file",
  "list_files",
  "search",
  "bash",
  "edit_file",
  "write_file",
  "run_checks",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

export type Profile = {
  name: ProfileName;
  /** Tool calls before finish_task. */
  steps: Range;
  /** What the agent says before each tool call. */
  words: Range;
  /** The model's wait before its first token. */
  thinkMs: Range;
  tools: Record<ToolName, number>;
  readBytes: Sized;
  bashMs: Range;
  bashOutput: Sized;
  searchMatches: Range;
  editChars: Range;
  writeBytes: Range;
};

const TOOL_WEIGHTS: Record<ToolName, number> = {
  read_file: 35,
  search: 15,
  list_files: 5,
  bash: 15,
  edit_file: 15,
  write_file: 5,
  run_checks: 10,
};

export const PROFILES: Record<ProfileName, Profile> = {
  typical: {
    name: "typical",
    steps: [25, 50],
    words: [8, 40],
    thinkMs: [800, 3_000],
    tools: TOOL_WEIGHTS,
    readBytes: {
      usual: [1_000, 12_000],
      large: [20_000, 56_000],
      largeShare: 0.1,
    },
    bashMs: [500, 15_000],
    bashOutput: {
      usual: [200, 6_000],
      large: [8_000, 28_000],
      largeShare: 0.1,
    },
    searchMatches: [0, 40],
    editChars: [100, 1_500],
    writeBytes: [1_000, 8_000],
  },
  long: {
    name: "long",
    steps: [100, 145],
    words: [8, 40],
    thinkMs: [800, 3_000],
    tools: TOOL_WEIGHTS,
    readBytes: {
      usual: [2_000, 16_000],
      large: [20_000, 56_000],
      largeShare: 0.25,
    },
    bashMs: [500, 30_000],
    bashOutput: {
      usual: [500, 8_000],
      large: [10_000, 40_000],
      largeShare: 0.25,
    },
    searchMatches: [0, 80],
    editChars: [200, 3_000],
    writeBytes: [3_000, 20_000],
  },
};

/** Share of runs that are long in the mixed profile. */
export const LONG_SHARE = 0.2;

const WORDS = [
  "checking",
  "the",
  "next",
  "part",
  "of",
  "code",
  "before",
  "changing",
  "it",
  "so",
  "tests",
  "keep",
  "passing",
  "and",
  "reading",
  "how",
  "this",
  "module",
  "works",
];

// mulberry32, seeded from the string: the same key always plans the same run.
function random(key: string) {
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++) {
    seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = ReturnType<typeof random>;

const between = (rng: Random, [min, max]: Range) =>
  Math.floor(min + rng() * (max - min + 1));
const sized = (rng: Random, size: Sized) =>
  between(rng, rng() < size.largeShare ? size.large : size.usual);

function pickTool(rng: Random, weights: Record<ToolName, number>): ToolName {
  const total = TOOL_NAMES.reduce((sum, name) => sum + weights[name], 0);
  let roll = rng() * total;
  for (const name of TOOL_NAMES) {
    roll -= weights[name];
    if (roll < 0) return name;
  }
  return TOOL_NAMES[0];
}

function sentence(rng: Random, words: number) {
  const text = Array.from(
    { length: words },
    () => WORDS[between(rng, [0, WORDS.length - 1])],
  ).join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export const loadTask = (runKey: string) =>
  `Load test run ${runKey}: work through the repository.`;

const RUN_KEY = /Load test run (\S+):/;

/** The run a request belongs to, from the task in its first user message. */
export function runKeyOf(request: FakeOpenAIRequest): string | null {
  for (const item of request.input) {
    const match = RUN_KEY.exec(JSON.stringify(item));
    if (match) return match[1]!;
  }
  return null;
}

export function profileFor(runKey: string, mix: ProfileMix): Profile {
  if (mix !== "mixed") return PROFILES[mix];
  return random(`${runKey}:profile`)() < LONG_SHARE
    ? PROFILES.long
    : PROFILES.typical;
}

export const plannedSteps = (runKey: string, profile: Profile) =>
  between(random(`${runKey}:steps`), profile.steps);

// Separate seeds per decision, so an edit can find an earlier read without planning every step.
const toolAt = (runKey: string, profile: Profile, step: number) =>
  pickTool(random(`${runKey}:${step}:tool`), profile.tools);
const readPath = (runKey: string, profile: Profile, step: number) =>
  repoFile(step, sized(random(`${runKey}:${step}:read`), profile.readBytes));

/** The edit tool only changes files the agent has read, so edits go to the last file read. */
function lastRead(runKey: string, profile: Profile, step: number) {
  for (let earlier = step - 1; earlier >= 0; earlier--) {
    if (toolAt(runKey, profile, earlier) === "read_file") {
      return readPath(runKey, profile, earlier);
    }
  }
  return null;
}

function toolCall(
  runKey: string,
  profile: Profile,
  step: number,
): NonNullable<FakeOpenAIReply["toolCall"]> {
  const rng = random(`${runKey}:${step}:input`);
  const tool = toolAt(runKey, profile, step);
  const read = () => ({
    name: "read_file",
    input: { path: readPath(runKey, profile, step) },
  });
  switch (tool) {
    case "read_file":
      return read();
    case "list_files":
      return { name: tool, input: { path: "src", depth: 2 } };
    case "search":
      return {
        name: tool,
        input: { pattern: searchPattern(between(rng, profile.searchMatches)) },
      };
    case "bash":
      return {
        name: tool,
        input: {
          command: costedCommand("pnpm vitest run src/load", {
            ms: between(rng, profile.bashMs),
            outputChars: sized(rng, profile.bashOutput),
          }),
        },
      };
    case "edit_file": {
      const path = lastRead(runKey, profile, step);
      if (!path) return read();
      return {
        name: tool,
        input: {
          path,
          oldString: fileLine((step % MIN_FILE_LINES) + 1),
          newString: fileContent(between(rng, profile.editChars)),
        },
      };
    }
    case "write_file":
      return {
        name: tool,
        input: {
          path: `src/load/new-${step}.ts`,
          content: fileContent(between(rng, profile.writeBytes)),
        },
      };
    case "run_checks":
      return { name: tool, input: {} };
  }
}

/** What the model does at one step of a run: talk, then call a tool; finish_task at the end. */
export function planStep(
  runKey: string,
  profile: Profile,
  step: number,
): FakeOpenAIReply {
  const rng = random(`${runKey}:${step}:talk`);
  const text = sentence(rng, between(rng, profile.words));
  const firstTokenMs = between(rng, profile.thinkMs);
  if (step >= plannedSteps(runKey, profile)) {
    return {
      text,
      firstTokenMs,
      toolCall: {
        name: "finish_task",
        input: { summary: `Load run ${runKey} finished.` },
      },
    };
  }
  return { text, firstTokenMs, toolCall: toolCall(runKey, profile, step) };
}

/** The fake OpenAI server's reply for load runs: each request is planned from its run's key. */
export const loadReply =
  (mix: ProfileMix, timeScale: number) =>
  (request: FakeOpenAIRequest): FakeOpenAIReply => {
    const runKey = runKeyOf(request);
    if (!runKey) throw new Error("The request isn't from a load test run.");
    const step = planStep(runKey, profileFor(runKey, mix), request.step);
    return { ...step, firstTokenMs: (step.firstTokenMs ?? 0) * timeScale };
  };
