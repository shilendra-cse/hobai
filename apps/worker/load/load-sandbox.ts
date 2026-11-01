import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  WORKSPACE_DIR,
  type ExecResult,
  type FileEntry,
  type ListFilesOptions,
} from "@hobai/sandbox";
import { FakeSandbox } from "@hobai/sandbox/testing";
import type { EnvironmentConfig } from "@hobai/shared";
import {
  commandCost,
  commandOutput,
  costedCommand,
  fileContent,
  repoFileSize,
  searchMatches,
} from "./markers.js";

export type LoadSandboxOptions = {
  /** Multiplies every delay: 1 is real time, 0 none. */
  timeScale: number;
};

// Each call to a remote sandbox is an HTTP round trip before any work happens.
const CALL_MS = 150;
const CLONE_MS = 3_000;
const SHA = "a".repeat(40);
const TREE = "b".repeat(40);

/** Steps and checks for the load project; their commands carry their cost, like the model's. */
export const LOAD_ENVIRONMENT: EnvironmentConfig = {
  version: 1,
  steps: [
    {
      name: "install",
      cwd: ".",
      command: costedCommand("pnpm install --frozen-lockfile", {
        ms: 20_000,
        outputChars: 3_000,
      }),
    },
  ],
  checks: [
    {
      name: "lint",
      cwd: ".",
      command: costedCommand("pnpm lint", { ms: 8_000, outputChars: 800 }),
    },
    {
      name: "test",
      cwd: ".",
      command: costedCommand("pnpm test", { ms: 15_000, outputChars: 2_500 }),
    },
  ],
  meta: {
    source: "user",
    createdAt: "2026-11-01T00:00:00.000Z",
    decisions: [],
  },
};

const REPOSITORY = {
  "package.json": JSON.stringify({
    name: "load-repo",
    scripts: { lint: "eslint .", test: "vitest run" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "README.md": "# Load repository\n\nA repository the load harness works in.\n",
};

function gitAnswer(command: string): Partial<ExecResult> | null {
  if (command.includes("git rev-parse") || command.includes("git log -1")) {
    return { stdout: `${SHA}\n` };
  }
  if (command.includes("git write-tree")) return { stdout: `${TREE}\n` };
  // No changes, so the run delivers nothing: GitHub isn't part of the load.
  if (command.includes("git diff")) return { stdout: "" };
  if (command.includes("git ")) return {};
  return null;
}

/**
 * A sandbox that behaves like a remote one under load: every call waits, commands take the time
 * their marker says and print that much output, and repository files have the size in their name.
 */
export class LoadSandbox extends FakeSandbox {
  constructor(private readonly options: LoadSandboxOptions) {
    super(REPOSITORY);
    this.execHandler = (command) => this.answer(command);
  }

  private wait(ms: number) {
    const scaled = ms * this.options.timeScale;
    return scaled > 0 ? sleep(scaled) : Promise.resolve();
  }

  private async answer(command: string): Promise<Partial<ExecResult>> {
    await this.wait(CALL_MS);
    const cost = commandCost(command);
    if (cost) {
      await this.wait(cost.ms);
      return {
        exitCode: cost.exitCode ?? 0,
        stdout: commandOutput(cost.outputChars),
      };
    }
    if (command.includes("git clone")) {
      await this.wait(CLONE_MS);
      return {};
    }
    const matches = searchMatches(command);
    if (matches !== null) {
      if (matches === 0) return { exitCode: 1 };
      const lines = Array.from(
        { length: matches },
        (_, i) =>
          `/workspace/src/load/file-${i}.ts:${i + 1}:  loadMatch(${i});`,
      );
      return { stdout: lines.join("\n") };
    }
    if (command.startsWith("wc -c")) return { stdout: "30000\n" };
    return gitAnswer(command) ?? {};
  }

  override async readFile(file: string): Promise<string> {
    await this.wait(CALL_MS);
    const size = repoFileSize(file);
    const written = this.files.has(path.posix.resolve(WORKSPACE_DIR, file));
    if (size !== null && !written) return fileContent(size);
    return super.readFile(file);
  }

  override async writeFile(file: string, content: string): Promise<void> {
    await this.wait(CALL_MS);
    return super.writeFile(file, content);
  }

  override async listFiles(
    dir: string,
    options?: ListFilesOptions,
  ): Promise<FileEntry[]> {
    await this.wait(CALL_MS);
    return super.listFiles(dir, options);
  }
}
