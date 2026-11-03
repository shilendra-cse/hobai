import {
  DaytonaAuthenticationError,
  DaytonaError,
  DaytonaFileNotFoundError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaRateLimitError,
} from "@daytonaio/sdk";
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
import {
  DaytonaSandbox,
  type DaytonaClient,
  type RemoteSandbox,
} from "./daytona-sandbox.js";

type Run = (
  command: string,
  call: { cwd?: string; env: Record<string, string> },
) => { stdout?: string; stderr?: string; exitCode?: number } | Error;

/** Answers like a real Daytona sandbox running the exec wrapper (see exec-script.test.ts). */
function fakeRemote(run: Run = () => ({})) {
  const calls: {
    script: string;
    cwd?: string;
    env: Record<string, string>;
    timeout?: number;
  }[] = [];
  const files = new Map<string, Buffer>();
  const lifecycle: string[] = [];
  let deletes = 0;
  const remote: RemoteSandbox = {
    id: "dt-1",
    state: "started",
    process: {
      async executeCommand(script, cwd, env = {}, timeout) {
        calls.push({ script, cwd, env, timeout });
        const answer = run(env.CG_CMD!, { cwd, env });
        if (answer instanceof Error) throw answer;
        const marker = /printf '\\n(\S+) %d/.exec(script)![1];
        const { stdout = "", stderr = "", exitCode = 0 } = answer;
        return {
          exitCode: 0,
          result: `${stdout}\n${marker} ${exitCode}\n${stderr}`,
        };
      },
    },
    fs: {
      async downloadFile(path) {
        const file = files.get(path);
        if (!file)
          throw new DaytonaFileNotFoundError(`file not found: ${path}`, 404);
        return file;
      },
      async uploadFile(file, path) {
        files.set(path, file);
      },
    },
    async start() {
      lifecycle.push("start");
    },
    async stop() {
      lifecycle.push("stop");
    },
    async delete() {
      deletes += 1;
      if (deletes > 1) throw new DaytonaNotFoundError("Sandbox not found", 404);
    },
  };
  return { remote, calls, files, lifecycle, deletes: () => deletes };
}

const notFound = async (): Promise<RemoteSandbox> => {
  throw new DaytonaNotFoundError("Sandbox not found", 404);
};

async function sandboxWith(run?: Run) {
  const fake = fakeRemote(run);
  const created: Parameters<DaytonaClient["create"]>[] = [];
  const client: DaytonaClient = {
    async create(...args) {
      created.push(args);
      return fake.remote;
    },
    get: notFound,
  };
  const sandbox = await DaytonaSandbox.create({
    client,
    labels: { runId: "r1" },
  });
  return { sandbox, created, ...fake };
}

describe("DaytonaSandbox.create", () => {
  it("creates a sandbox from the base snapshot that stops when idle and is deleted after its retention", async () => {
    const { sandbox, created } = await sandboxWith();

    expect(sandbox.id).toBe("dt-1");
    expect(created).toEqual([
      [
        {
          snapshot: `${SHORT_NAME}-base`,
          labels: { [SHORT_NAME]: "1", runId: "r1" },
          autoStopInterval: 30,
          autoDeleteInterval: 4 * 60,
          ttlMinutes: 120 + 30 + 4 * 60,
        },
        { timeout: 180 },
      ],
    ]);
  });

  it("keeps a stopped sandbox for the retention it's given", async () => {
    const fake = fakeRemote();
    const created: Parameters<DaytonaClient["create"]>[] = [];
    await DaytonaSandbox.create({
      client: {
        create: async (...args) => (created.push(args), fake.remote),
        get: notFound,
      },
      retentionHours: 2,
    });
    expect(created[0]![0]).toMatchObject({
      autoDeleteInterval: 120,
      ttlMinutes: 120 + 30 + 120,
    });
  });

  it.each([
    [new DaytonaAuthenticationError("bad key", 401), SandboxUnavailableError],
    [new DaytonaError("no capacity", 503), SandboxCreateError],
    [
      new DaytonaForbiddenError(
        "Total CPU limit exceeded. Maximum allowed: 10",
        403,
      ),
      SandboxBusyError,
    ],
    [new DaytonaRateLimitError("Too many requests", 429), SandboxBusyError],
  ])("maps %s", async (error, expected) => {
    const client: DaytonaClient = {
      create: async () => {
        throw error;
      },
      get: notFound,
    };
    await expect(DaytonaSandbox.create({ client })).rejects.toBeInstanceOf(
      expected,
    );
  });
});

describe("DaytonaSandbox.exec", () => {
  it("returns stdout, stderr and the exit code separately", async () => {
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

  it("passes the command and env through the environment, in the workspace", async () => {
    const { sandbox, calls } = await sandboxWith();

    await sandbox.exec(`echo "$HOME" 'quoted'`, {
      cwd: "client",
      env: { CI: "1" },
      timeoutMs: 30_000,
    });
    await sandbox.exec("pwd");

    expect(calls[0]).toMatchObject({
      cwd: "/workspace/client",
      env: { CI: "1", CG_CMD: `echo "$HOME" 'quoted'` },
      timeout: 30 + 5 + 15,
    });
    expect(calls[0]!.script).toContain("timeout -k 5s 30s");
    expect(calls[0]!.script).not.toContain("quoted");
    expect(calls[1]!.cwd).toBe("/workspace");
  });

  it("caps the timeout at ten minutes", async () => {
    const { sandbox, calls } = await sandboxWith();
    await sandbox.exec("sleep 1", { timeoutMs: 60 * 60_000 });
    expect(calls[0]!.script).toContain("timeout -k 5s 600s");
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
      () =>
        new DaytonaProcessExecutionTimeoutError(
          "command execution timeout",
          408,
        ),
    );
    expect(await sandbox.exec("sleep 999")).toMatchObject({
      exitCode: -1,
      timedOut: true,
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

  it("returns the raw output when the wrapper itself fails", async () => {
    const fake = fakeRemote();
    fake.remote.process.executeCommand = async () => ({
      exitCode: 127,
      result: "zsh: command not found: mktemp\n",
    });
    const sandbox = await DaytonaSandbox.create({
      client: { create: async () => fake.remote, get: notFound },
    });

    expect(await sandbox.exec("ls")).toMatchObject({
      exitCode: 127,
      stdout: "",
      stderr: "zsh: command not found: mktemp\n",
    });
  });
});

describe("DaytonaSandbox files", () => {
  it("writes and reads files relative to the workspace", async () => {
    const { sandbox, files } = await sandboxWith();

    await sandbox.writeFile("src/app.ts", "export {};\n");

    expect(files.get("/workspace/src/app.ts")?.toString()).toBe("export {};\n");
    expect(await sandbox.readFile("/workspace/src/app.ts")).toBe(
      "export {};\n",
    );
  });

  it("throws a file error for a missing file", async () => {
    const { sandbox } = await sandboxWith();
    await expect(sandbox.readFile("nope.txt")).rejects.toBeInstanceOf(
      SandboxFileError,
    );
  });

  it("refuses files over the read limit instead of truncating them", async () => {
    const { sandbox, files } = await sandboxWith();
    files.set("/workspace/huge.bin", Buffer.alloc(MAX_READ_FILE_BYTES + 1));
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
    expect(calls[0]!.env.CG_CMD).toBe(
      "'find' '/workspace' '-mindepth' '1' '-maxdepth' '1' '(' '-name' 'node_modules' '-o' '-name' '.git' ')' '-prune' '-o' '-printf' '%y\t%s\t%p\n'",
    );
  });
});

describe("DaytonaSandbox lifetime", () => {
  it("treats a sandbox Daytona no longer has as gone", async () => {
    const { sandbox, calls } = await sandboxWith(
      () => new DaytonaNotFoundError("sandbox not found", 404),
    );

    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxGoneError);
    expect(calls).toHaveLength(1);
  });

  it("deletes once, and doesn't mind a sandbox that's already gone", async () => {
    const { sandbox, deletes } = await sandboxWith();

    await sandbox.destroy();
    await sandbox.destroy();

    expect(deletes()).toBe(1);
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(SandboxGoneError);
  });
});

describe("DaytonaSandbox.connect", () => {
  const clientFor = (remote: RemoteSandbox): DaytonaClient => ({
    create: async () => remote,
    get: async (id) => (id === remote.id ? remote : notFound()),
  });

  it("reconnects to a running sandbox", async () => {
    const fake = fakeRemote(() => ({ stdout: "ok\n" }));
    const sandbox = await DaytonaSandbox.connect("dt-1", {
      client: clientFor(fake.remote),
    });

    expect(sandbox?.id).toBe("dt-1");
    expect((await sandbox!.exec("echo ok")).stdout).toBe("ok\n");
    expect(fake.lifecycle).toEqual([]);
  });

  it("starts a stopped sandbox before using it", async () => {
    const fake = fakeRemote();
    fake.remote.state = "stopped";
    await DaytonaSandbox.connect("dt-1", { client: clientFor(fake.remote) });
    expect(fake.lifecycle).toEqual(["start"]);
  });

  it.each([["missing"], ["destroying"]])(
    "returns null for a sandbox that is %s",
    async (state) => {
      const fake = fakeRemote();
      fake.remote.state = state;
      const id = state === "missing" ? "dt-unknown" : "dt-1";
      expect(
        await DaytonaSandbox.connect(id, { client: clientFor(fake.remote) }),
      ).toBeNull();
    },
  );

  it("stops a sandbox without deleting it", async () => {
    const { sandbox, lifecycle, deletes } = await sandboxWith();
    await sandbox.stop();
    expect(lifecycle).toEqual(["stop"]);
    expect(deletes()).toBe(0);
  });
});
