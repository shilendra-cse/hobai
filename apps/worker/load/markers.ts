// The fake model's tool calls carry how long their work takes and how much it outputs, so the
// load sandbox can answer them without sharing any state with the fake OpenAI server.

export type CommandCost = {
  ms: number;
  outputChars: number;
  exitCode?: number;
};

const COMMAND = /# load ms=(\d+) out=(\d+)(?: exit=(\d+))?/;
const REPO_FILE = /\/file-\d+-(\d+)\.ts$/;
const SEARCH = /loadMatches(\d+)/;

export function costedCommand(command: string, cost: CommandCost) {
  const exit = cost.exitCode ? ` exit=${cost.exitCode}` : "";
  return `${command} # load ms=${cost.ms} out=${cost.outputChars}${exit}`;
}

export function commandCost(command: string): CommandCost | null {
  const match = COMMAND.exec(command);
  if (!match) return null;
  return {
    ms: Number(match[1]),
    outputChars: Number(match[2]),
    exitCode: Number(match[3] ?? 0),
  };
}

/** A file that exists in every load sandbox, with the given size. */
export const repoFile = (index: number, bytes: number) =>
  `src/load/file-${index}-${bytes}.ts`;

export function repoFileSize(path: string): number | null {
  const match = REPO_FILE.exec(path);
  return match ? Number(match[1]) : null;
}

export const searchPattern = (matches: number) => `loadMatches${matches}`;

export function searchMatches(command: string): number | null {
  const match = SEARCH.exec(command);
  return match ? Number(match[1]) : null;
}

/** The line of a repository file that an edit can replace; files have at least this many. */
export const MIN_FILE_LINES = 20;
const LINE_CHARS = 32;

export const fileLine = (line: number) =>
  `export const value${String(line).padStart(4, "0")} = ${line};`;

export function fileContent(bytes: number) {
  const lines = Math.max(MIN_FILE_LINES, Math.ceil(bytes / LINE_CHARS));
  return Array.from({ length: lines }, (_, i) => fileLine(i + 1)).join("\n");
}

export function commandOutput(chars: number) {
  const line = "  ✓ load test case passes in 3 ms\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}
