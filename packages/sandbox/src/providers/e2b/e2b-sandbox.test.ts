import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  RateLimitError,
  SandboxError as E2BError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
} from "e2b";
import { describe, expect, it } from "vitest";
import { SHORT_NAME } from "@hobai/shared/brand";
import {
  SandboxBusyError,
  SandboxCreateError,
  SandboxFileError,
  SandboxGoneError,
  SandboxUnavailableError,
} from "../../core/errors.js";
import { MAX_READ_FILE_BYTES } from "../../core/limits.js";
import { shellQuote } from "../../lib/shell-quote.js";
import {
  E2BSandbox,
  type E2BClient,
  type RemoteSandbox,
} from "./e2b-sandbox.js";

// Errors as the real E2B API threw them when probed (SDK 2.62).
const killed = () =>
  new SandboxNotRunningError(
    "[unavailable] The sandbox was not found: The sandbox was killed or reached its timeout.",
  );
const notFound = (id: string) =>
  new SandboxNotFoundError(`Paused sandbox ${id} not found`);

type Run = (
  command: string,
  call: { cwd: string; envs?: Record<string, string> },
) => { stdout?: string; stderr?: string; exitCode?: number } | Error;

/** Answers like a real E2B sandbox: a non-zero exit throws CommandExitError. */
function fakeRemote(run: Run = () => ({})) {
  const calls: {
    command: string;
    cwd: string;
    envs?: Record<string, string>;
    timeoutMs: number;
  }[] = [];
  const files = new Map<string, Uint8Array>();
  let kills = 0;
  const remote: RemoteSandbox = {
    sandboxId: "e2b-1",
    commands: {
      async run(command, options) {
        calls.push({ command, ...options });
        const answer = run(command, options);
        if (answer instanceof Error) throw answer;
        const { stdout = "", stderr = "", exitCode = 0 } = answer;
        if (exitCode !== 0) {
          throw new CommandExitError({
            exitCode,
            stdout,
            stderr,
            error: `exit status ${exitCode}`,
          });
        }
        return { exitCode, stdout, stderr };
      },
    },
    files: {
      async read(path) {
        const file = files.get(path);
        if (!file) throw new FileNotFoundError(`path '${path}' does not exist`);
        return file;
      },
      async write(path, data) {
        files.set(path, Buffer.from(data));
      },
    },
    async kill() {
      kills += 1;
      return kills === 1;
    },
  };
  return { remote, calls, files, kills: () => kills };
}

async function sandboxWith(run?: Run) {
  const fake = fakeRemote(run);
  const created: Parameters<E2BClient["create"]>[] = [];
  const client: E2BClient = {
    async create(...args) {
      created.push(args);
      return fake.remote;
    },
    connect: async (id) => {
      throw notFound(id);
    },
  };
  const sandbox = await E2BSandbox.create({
    client,
    apiKey: "e2b_test",
    labels: { runId: "r1" },
  });
  return { sandbox, created, ...fake };
}

describe("E2BSandbox.create", () => {
  it("creates a labelled sandbox from the base template that ends after an hour", async () => {
    const { sandbox, created } = await sandboxWith();

    expect(sandbox.id).toBe("e2b-1");
    expect(created).toEqual([
      [
        `${SHORT_NAME}-base`,
        {
          apiKey: "e2b_test",
          metadata: { [SHORT_NAME]: "1", runId: "r1" },
          envs: { CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
          timeoutMs: 60 * 60_000,
          requestTimeoutMs: 180_000,
        },
      ],
    ]);
  });

  it.each([
    [
      new AuthenticationError("Unauthorized, please check your credentials."),
      SandboxUnavailableError,
    ],
    [
      new RateLimitError(
        "Rate limit exceeded, please try again later - You have reached the maximum number of concurrent E2B sandboxes",
      ),
      SandboxBusyError,
    ],
    [
      new E2BError("400: Timeout cannot be greater than 1 hours"),
      SandboxCreateError,
    ],
    [
      new E2BError(`404: template '${SHORT_NAME}-base' not found`),
      SandboxCreateError,
    ],
  ])("maps %s", async (error, expected) => {
    const client: E2BClient = {
      create: async () => {
        throw error;
      },
      connect: async (id) => {
        throw notFound(id);
      },
    };
    await expect(E2BSandbox.create({ client })).rejects.toBeInstanceOf(
      expected,
    );
  });
});

describe("E2BSandbox.exec", () => {
  it("returns stdout, stderr and a non-zero exit code as a result", async () => {
    const { sandbox } = await sandboxWith(() => ({
      stdout: "out\n",
      stderr: "warning\n",
      exitCode: 2,
    }));

    expect(await sandbox.exec("npm test")).toEqual({
      exitCode: 2,
      stdout: "out\n",
      stderr: "warning\n",
      timedOut: false,
      truncated: false,
    });
  });

  it("runs the command quoted under timeout, in the workspace, with its env", async () => {
    const { sandbox, calls } = await sandboxWith();

    await sandbox.exec(`echo "$HOME" 'quoted'`, {
      cwd: "client",
      env: { FOO: "1" },
      timeoutMs: 30_000,
    });
    await sandbox.exec("pwd");

    expect(calls[0]).toEqual({
      command: `timeout -k 5s 30s bash -lc 'echo "$HOME" '\\''quoted'\\'''`,
      cwd: "/workspace/client",
      envs: { FOO: "1" },
      timeoutMs: (30 + 5) * 1000 + 15_000,
    });
    expect(calls[1]!.cwd).toBe("/workspace");
  });

  it("caps the timeout at ten minutes", async () => {
    const { sandbox, calls } = await sandboxWith();
    await sandbox.exec("sleep 1", { timeoutMs: 60 * 60_000 });
    expect(calls[0]!.command).toContain("timeout -k 5s 600s");
  });

  it("reports exit code 124 as timed out", async () => {
    const { sandbox } = await sandboxWith(() => ({ exitCode: 124 }));
    expect(await sandbox.exec("sleep 999")).toMatchObject({
      exitCode: 124,
      timedOut: true,
    });
  });

  it("reports the SDK's own timeout as timed out", async () => {
    const { sandbox } = await sandboxWith(
      () => new TimeoutError("[deadline_exceeded] the operation timed out"),
    );
    expect(await sandbox.exec("sleep 999")).toMatchObject({
      exitCode: -1,
      timedOut: true,
    });
  });

  it("returns a missing working directory as a failed command", async () => {
    const { sandbox } = await sandboxWith(
      () =>
        new InvalidArgumentError(
          "[invalid_argument] cwd '/workspace/nope' does not exist",
        ),
    );
    expect(await sandbox.exec("ls", { cwd: "nope" })).toMatchObject({
      exitCode: 1,
      stderr: "[invalid_argument] cwd '/workspace/nope' does not exist",
      timedOut: false,
    });
  });

  it("keeps the start and end of very large output", async () => {
    const { sandbox } = await sandboxWith(() => ({
      stdout: `start${"a".repeat(3_000_000)}end`,
    }));
    const result = await sandbox.exec("cat big.log");

    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith("start")).toBe(true);
    expect(result.stdout.endsWith("end")).toBe(true);
    expect(result.stdout.length).toBeLessThan(1_100_000);
  });

  it("doesn't take an unreachable sandbox for a timed-out command", async () => {
    const { sandbox } = await sandboxWith(
      () => new SandboxUnreachableError("sandbox unreachable"),
    );
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(
      SandboxUnreachableError,
    );
  });
});

describe("E2BSandbox files", () => {
  it("writes and reads files relative to the workspace", async () => {
    const { sandbox, files } = await sandboxWith();

    await sandbox.writeFile("src/app.ts", "export const é = 1;\n");

    expect(Buffer.from(files.get("/workspace/src/app.ts")!).toString()).toBe(
      "export const é = 1;\n",
    );
    expect(await sandbox.readFile("/workspace/src/app.ts")).toBe(
      "export const é = 1;\n",
    );
  });

  it("throws a file error for a missing file", async () => {
    const { sandbox } = await sandboxWith();
    await expect(sandbox.readFile("nope.txt")).rejects.toBeInstanceOf(
      SandboxFileError,
    );
  });

  it("throws a file error for a directory", async () => {
    const { sandbox, remote } = await sandboxWith();
    remote.files.read = async () => {
      throw new InvalidArgumentError("path '/workspace/src' is a directory");
    };
    await expect(sandbox.readFile("src")).rejects.toBeInstanceOf(
      SandboxFileError,
    );
  });

  it("refuses files over the read limit instead of truncating them", async () => {
    const { sandbox, files } = await sandboxWith();
    files.set("/workspace/huge.bin", new Uint8Array(MAX_READ_FILE_BYTES + 1));
    await expect(sandbox.readFile("huge.bin")).rejects.toThrow("larger than");
  });

  it("lists files with find, like the Docker sandbox", async () => {
    const { sandbox, calls } = await sandboxWith(() => ({
      stdout: "f\t12\t/workspace/b.ts\nd\t4096\t/workspace/a\n",
    }));

    expect(await sandbox.listFiles(".", { maxDepth: 1 })).toEqual([
      { path: "/workspace/a", isDirectory: true, size: 0 },
      { path: "/workspace/b.ts", isDirectory: false, size: 12 },
    ]);
    const find =
      "'find' '/workspace' '-mindepth' '1' '-maxdepth' '1' '(' '-name' 'node_modules' '-o' '-name' '.git' ')' '-prune' '-o' '-printf' '%y\t%s\t%p\n'";
    expect(calls[0]!.command).toBe(
      `timeout -k 5s 120s bash -lc ${shellQuote(find)}`,
    );
  });
});

describe("E2BSandbox lifetime", () => {
  it("treats a sandbox E2B has killed as gone", async () => {
    const { sandbox, calls } = await sandboxWith(killed);

    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(sandbox.readFile("a.ts")).rejects.toBeInstanceOf(
      SandboxGoneError,
    );
    expect(calls).toHaveLength(1);
  });

  it("kills once, and doesn't mind a sandbox that's already gone", async () => {
    const { sandbox, kills } = await sandboxWith();

    await sandbox.destroy();
    await sandbox.destroy();

    expect(kills()).toBe(1);
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxGoneError);
  });
});

describe("E2BSandbox.connect", () => {
  const clientFor = (remote: RemoteSandbox): E2BClient => ({
    create: async () => remote,
    connect: async (id) => {
      if (id !== remote.sandboxId) throw notFound(id);
      return remote;
    },
  });

  it("reconnects to a running sandbox", async () => {
    const fake = fakeRemote(() => ({ stdout: "ok\n" }));
    const sandbox = await E2BSandbox.connect("e2b-1", {
      client: clientFor(fake.remote),
    });

    expect(sandbox?.id).toBe("e2b-1");
    expect((await sandbox!.exec("echo ok")).stdout).toBe("ok\n");
  });

  it("returns null for a sandbox that no longer exists", async () => {
    const fake = fakeRemote();
    expect(
      await E2BSandbox.connect("e2b-gone", { client: clientFor(fake.remote) }),
    ).toBeNull();
  });
});
