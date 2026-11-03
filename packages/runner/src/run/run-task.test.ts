import { scriptedModel } from "@hobai/agent/testing";
import { SandboxBusyError } from "@hobai/sandbox";
import { FakeSandbox } from "@hobai/sandbox/testing";
import type { EnvironmentConfig, RunEvent } from "@hobai/shared";
import { describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "../stages/deliver/index.js";
import { runTask, type RunTaskOptions } from "./run-task.js";

const repo = {
  "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  "package-lock.json": "{}",
  "src/app.js": "export const a = 1;\n",
};

function fakeSandbox(failOn?: string) {
  const sandbox = new FakeSandbox(repo);
  let destroyed = 0;
  sandbox.destroy = async () => {
    destroyed += 1;
  };
  sandbox.execHandler = (command) => {
    if (failOn && command.includes(failOn))
      return { exitCode: 1, stderr: "boom" };
    if (command.includes("git rev-parse HEAD")) return { stdout: "base123\n" };
    if (command.includes("--numstat")) return { stdout: "1\t1\tsrc/app.js\n" };
    if (command.includes("--no-color"))
      return { stdout: "diff --git a/src/app.js\n" };
    if (command.startsWith("git write-tree")) return { stdout: "tree123\n" };
    if (command.startsWith("git rev-parse --verify"))
      return { stdout: "parent123\n" };
    if (command.startsWith("git diff-tree"))
      return {
        stdout: `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0src/app.js\0`,
      };
    return {};
  };
  return { sandbox, destroyed: () => destroyed };
}

function options(
  sandbox: FakeSandbox,
  overrides: Partial<RunTaskOptions> = {},
): RunTaskOptions {
  const { resolved } = scriptedModel([
    { toolCalls: [{ toolName: "read_file", input: { path: "src/app.js" } }] },
    {
      toolCalls: [
        {
          toolName: "edit_file",
          input: { path: "src/app.js", oldString: "a = 1", newString: "a = 2" },
        },
      ],
    },
    {
      toolCalls: [
        { toolName: "finish_task", input: { summary: "Set a to 2." } },
      ],
    },
  ]);
  return {
    runId: "run-1",
    task: "Set a to 2",
    source: { type: "git", url: "https://github.com/acme/app.git" },
    model: resolved,
    createSandbox: async () => sandbox,
    ...overrides,
  };
}

describe("runTask", () => {
  it("runs every stage in order and returns the full result", async () => {
    const { sandbox, destroyed } = fakeSandbox();
    const events: RunEvent[] = [];
    const result = await runTask(
      options(sandbox, { emit: (event) => events.push(event) }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      sandboxId: "fake-sandbox",
      checkout: { description: "https://github.com/acme/app.git" },
      setup: {
        steps: [{ name: "install", command: "npm ci", status: "ok" }],
        baseline: [{ name: "test", status: "passing" }],
        health: "ok",
      },
      agent: { status: "succeeded", summary: "Set a to 2." },
      verify: {
        checks: [{ name: "test", comparison: "passing" }],
        passed: true,
        regressions: 0,
      },
      diff: { files: [{ path: "src/app.js", added: 1, removed: 1 }] },
    });
    expect(sandbox.files.get("/workspace/src/app.js")).toBe(
      "export const a = 2;\n",
    );
    expect(
      events
        .filter((e) => e.type === "stage_changed")
        .map((e) => (e as { stage: string }).stage),
    ).toEqual(["prepare", "checkout", "setup", "agent", "verify"]);
    expect(events.map((e) => e.type)).toContain("sandbox_created");
    expect(destroyed()).toBe(1);
  });

  it("reports a failed checkout and still destroys the sandbox", async () => {
    const { sandbox, destroyed } = fakeSandbox("git clone");
    const result = await runTask(options(sandbox));
    expect(result).toMatchObject({
      status: "failed",
      failedStage: "checkout",
      error: "git clone failed: boom",
    });
    expect(result.agent).toBeUndefined();
    expect(destroyed()).toBe(1);
  });

  it("runs the after-checkout hook before setup, and fails at checkout when it throws", async () => {
    const { sandbox } = fakeSandbox();
    const order: string[] = [];
    const ok = await runTask(
      options(sandbox, {
        afterCheckout: async (box) => {
          order.push(`hook:${box.id}`);
          await box.exec("git apply plant-bug.patch");
        },
      }),
    );
    expect(ok.status).toBe("succeeded");
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(order).toEqual(["hook:fake-sandbox"]);
    expect(commands.indexOf("git apply plant-bug.patch")).toBeLessThan(
      commands.findIndex((c) => c.includes("npm ci")),
    );

    const failed = await runTask(
      options(fakeSandbox().sandbox, {
        afterCheckout: async () => {
          throw new Error("patch does not apply");
        },
      }),
    );
    expect(failed).toMatchObject({
      status: "failed",
      failedStage: "checkout",
      error: "patch does not apply",
    });
  });

  it("reports when the sandbox can't be created", async () => {
    const result = await runTask(
      options(new FakeSandbox(), {
        createSandbox: async () => {
          throw new Error("Docker is not running");
        },
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      failedStage: "sandbox",
      error: "Docker is not running",
    });
  });

  it("marks a run the provider had no sandbox room for", async () => {
    const result = await runTask(
      options(new FakeSandbox(), {
        createSandbox: async () => {
          throw new SandboxBusyError("All sandboxes were busy");
        },
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      failedStage: "sandbox",
      sandboxBusy: true,
    });
  });

  it("is cancelled when stopped while waiting for a sandbox", async () => {
    const controller = new AbortController();
    const result = await runTask(
      options(new FakeSandbox(), {
        signal: controller.signal,
        createSandbox: async () => {
          controller.abort();
          throw new SandboxBusyError("All sandboxes were busy");
        },
      }),
    );
    expect(result.status).toBe("cancelled");
  });

  it("stops before any work when already cancelled, and keeps the sandbox on request", async () => {
    const { sandbox, destroyed } = fakeSandbox();
    const controller = new AbortController();
    controller.abort();
    const result = await runTask(
      options(sandbox, { signal: controller.signal, keepSandbox: true }),
    );
    expect(result.status).toBe("cancelled");
    expect(sandbox.execCalls).toHaveLength(0);
    expect(destroyed()).toBe(0);
  });

  it("asks whether to keep the sandbox when the run ends", async () => {
    for (const keep of [true, false]) {
      const { sandbox, destroyed } = fakeSandbox();
      const controller = new AbortController();
      controller.abort();
      await runTask(
        options(sandbox, {
          signal: controller.signal,
          keepSandbox: () => keep,
        }),
      );
      expect(destroyed()).toBe(keep ? 0 : 1);
    }
  });

  it("reports failing checks without changing the agent's status", async () => {
    const { sandbox } = fakeSandbox("npm run test");
    const result = await runTask(options(sandbox));
    expect(result).toMatchObject({
      status: "succeeded",
      verify: {
        checks: [{ name: "test", comparison: "still-failing" }],
        passed: false,
        regressions: 0,
      },
    });
  });

  it("reports the checks after the agent's work as an event", async () => {
    const { sandbox } = fakeSandbox("npm run test");
    const events: RunEvent[] = [];
    await runTask(options(sandbox, { emit: (event) => events.push(event) }));

    const completed = events.find((e) => e.type === "checks_completed");
    expect(completed).toEqual({
      type: "checks_completed",
      runId: expect.any(String),
      ts: expect.any(String),
      passed: false,
      checks: [
        {
          name: "test",
          cwd: ".",
          command: "npm run test",
          status: "failing",
          comparison: "still-failing",
        },
      ],
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf("checks_completed")).toBeGreaterThan(
      types.lastIndexOf("stage_changed"),
    );
  });

  it("reports a regression the agent introduced", async () => {
    const { sandbox } = fakeSandbox();
    const base = sandbox.execHandler;
    sandbox.execHandler = (command, opts) =>
      command.includes("npm run test") &&
      sandbox.files.get("/workspace/src/app.js")?.includes("a = 2")
        ? { exitCode: 1, stdout: "expected 1, got 2" }
        : base(command, opts);
    const result = await runTask(options(sandbox));
    expect(result.verify).toMatchObject({
      checks: [
        {
          name: "test",
          comparison: "regressed",
          outputTail: "expected 1, got 2",
        },
      ],
      passed: false,
      regressions: 1,
    });
  });

  it("replays a given environment config", async () => {
    const { sandbox } = fakeSandbox();
    const result = await runTask(
      options(sandbox, {
        environment: {
          version: 1,
          steps: [{ name: "install", cwd: ".", command: "pnpm install" }],
          checks: [{ name: "lint", cwd: ".", command: "pnpm lint" }],
          meta: { source: "user", createdAt: "", decisions: [] },
        },
      }),
    );
    expect(result.setup).toMatchObject({
      steps: [{ command: "pnpm install", status: "ok" }],
      checks: [{ name: "lint", command: "pnpm lint" }],
      config: { meta: { source: "user" } },
    });
  });

  describe("time limit", () => {
    const environment: EnvironmentConfig = {
      version: 1,
      steps: [
        { name: "install", cwd: ".", command: "slow install" },
        { name: "build", cwd: ".", command: "pnpm build" },
      ],
      checks: [
        { name: "lint", cwd: ".", command: "pnpm lint" },
        { name: "test", cwd: ".", command: "pnpm test" },
      ],
      meta: { source: "user", createdAt: "", decisions: [] },
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const delivered = { branchName: "hobai/1-set-a", sha: "c0ffee" };

    it("fails the run when setup passes the limit, starting nothing after", async () => {
      const { sandbox, destroyed } = fakeSandbox();
      const handle = sandbox.execHandler;
      sandbox.execHandler = async (command, opts) => {
        if (command.includes("slow install")) await sleep(80);
        return handle(command, opts);
      };

      const result = await runTask(
        options(sandbox, { environment, maxDurationMs: 20 }),
      );

      expect(result).toMatchObject({
        status: "failed",
        failedStage: "setup",
        timeLimitReached: true,
        error: expect.stringContaining("took longer than"),
      });
      expect(result.agent).toBeUndefined();
      const commands = sandbox.execCalls.map((c) => c.command);
      expect(commands.some((c) => c.includes("pnpm build"))).toBe(false);
      expect(destroyed()).toBe(1);
    });

    it("keeps the agent's work as a draft when the checks after it pass the limit", async () => {
      const { sandbox } = fakeSandbox();
      const handle = sandbox.execHandler;
      sandbox.execHandler = async (command, opts) => {
        if (command.includes("slow install")) return handle("", opts);
        if (command.includes("logs/verify-") && command.includes("pnpm lint")) {
          await sleep(400);
        }
        return handle(command, opts);
      };
      const deliver = vi.fn(async () => delivered);

      const result = await runTask(
        options(sandbox, { environment, deliver, maxDurationMs: 250 }),
      );

      expect(result).toMatchObject({
        status: "incomplete",
        timeLimitReached: true,
        agent: { status: "succeeded" },
        verify: {
          checks: [{ name: "lint" }],
          notRun: [{ name: "test" }],
          passed: null,
        },
        delivery: delivered,
      });
      expect(deliver).toHaveBeenCalledOnce();
    });
  });

  it("collects the diff before verify runs the checks again", async () => {
    const { sandbox } = fakeSandbox();
    await runTask(options(sandbox));
    const commands = sandbox.execCalls.map((c) => c.command);
    const diff = commands.findIndex((c) => c.includes("--numstat"));
    const verify = commands.findIndex((c) => c.includes("logs/verify-"));
    expect(diff).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(diff);
  });

  describe("delivery", () => {
    const delivered = { branchName: "hobai/1-set-a", sha: "c0ffee" };

    it("hands the changes over after verify, before the sandbox goes", async () => {
      const { sandbox, destroyed } = fakeSandbox();
      const events: RunEvent[] = [];
      const deliver = vi.fn(async (changes: ChangeSet) => {
        expect(destroyed()).toBe(0);
        expect(changes).toMatchObject({
          parent: "parent123",
          writes: [{ path: "src/app.js", mode: "100644", sha: "b".repeat(40) }],
          deletions: [],
        });
        return delivered;
      });

      const result = await runTask(
        options(sandbox, { deliver, emit: (event) => events.push(event) }),
      );

      expect(deliver).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "succeeded",
        delivery: delivered,
      });
      expect(
        events
          .filter((e) => e.type === "stage_changed")
          .map((e) => (e as { stage: string }).stage)
          .slice(-2),
      ).toEqual(["verify", "deliver"]);
      const commands = sandbox.execCalls.map((c) => c.command);
      expect(commands.indexOf("git write-tree")).toBeLessThan(
        commands.findIndex((c) => c.includes("logs/verify-")),
      );
    });

    it("delivers nothing without changes, or when the agent didn't finish its work", async () => {
      const deliver = vi.fn(async () => delivered);

      const { sandbox } = fakeSandbox();
      const base = sandbox.execHandler;
      sandbox.execHandler = (command, opts) =>
        command.includes("--numstat") ? {} : base(command, opts);
      const unchanged = await runTask(options(sandbox, { deliver }));

      const failing = await runTask(
        options(fakeSandbox().sandbox, {
          deliver,
          model: scriptedModel([
            { error: new Error("The model provider is down") },
          ]).resolved,
        }),
      );

      expect(unchanged.status).toBe("succeeded");
      expect(unchanged.delivery).toBeUndefined();
      expect(failing.delivery).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
    });

    it("fails the run at deliver when the delivery fails", async () => {
      const { sandbox, destroyed } = fakeSandbox();
      const result = await runTask(
        options(sandbox, {
          deliver: async () => {
            throw new Error("GitHub said no");
          },
        }),
      );
      expect(result).toMatchObject({
        status: "failed",
        failedStage: "deliver",
        error: "GitHub said no",
        agent: { status: "succeeded" },
      });
      expect(destroyed()).toBe(1);
    });
  });
});
