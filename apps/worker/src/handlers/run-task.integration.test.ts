import { createHash } from "node:crypto";
import { scriptedModel, type ScriptedStep } from "@hobai/agent/testing";
import {
  DbEnvironmentStore,
  getInstallationById,
  markInstallationUninstalled,
  tasks,
  getRunDiff,
  runEvents,
  runs,
  messages,
  type Db,
} from "@hobai/db";
import { insertRun, testDatabaseOrSkip } from "@hobai/db/testing";
import type { SandboxLabels } from "@hobai/sandbox";
import { FakeSandbox } from "@hobai/sandbox/testing";
import type { EnvironmentConfig, RunEvent } from "@hobai/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { LockLostError } from "../lib/lock-lost.js";
import { SHORT_NAME } from "@hobai/shared/brand";
import {
  createEventWriter,
  dbEventRows,
  type Publisher,
} from "../events/event-writer.js";
import {
  FAKE_COMMIT_SHA,
  FAKE_REPO_TOKEN,
  FAKE_TREE_SHA,
  fakeGithubApp,
  githubDeliveryApi,
} from "../testing/fake-github-app.js";
import { handleRunTask, type RunTaskDeps } from "./run-task.js";

const database = await testDatabaseOrSkip("run-task handler");

const environment = (cwd = "."): EnvironmentConfig => ({
  version: 1,
  steps: [{ name: "install", cwd, command: "npm ci" }],
  checks: [{ name: "test", cwd, command: "npm run test" }],
  meta: { source: "detected", createdAt: "", decisions: [] },
});

const finish: ScriptedStep = {
  toolCalls: [
    { toolName: "finish_task", input: { summary: "Added GET /health." } },
  ],
};

const PATCH =
  "diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md\n+# Contributing\n";
const CONTRIBUTING = Buffer.from("# Contributing\n");
const CONTRIBUTING_SHA = createHash("sha1")
  .update(`blob ${CONTRIBUTING.length}\0`)
  .update(CONTRIBUTING)
  .digest("hex");

function fakeSandbox(options: { failOn?: string; changed?: boolean } = {}) {
  const sandbox = new FakeSandbox({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "src/app.js": "export const a = 1;\n",
  });
  sandbox.execHandler = (command) => {
    if (options.failOn && command.includes(options.failOn))
      return { exitCode: 128, stderr: "repository not found" };
    if (command.includes("git rev-parse HEAD")) return { stdout: "base123\n" };
    if (options.changed && command.includes("git diff --cached --numstat"))
      return { stdout: "1\t0\tCONTRIBUTING.md\n" };
    if (options.changed && command.includes("git diff --cached --no-color"))
      return { stdout: PATCH };
    if (command.includes("git write-tree"))
      return { stdout: `${FAKE_TREE_SHA}\n` };
    if (command.startsWith("git rev-parse --verify"))
      return { stdout: "base000\n" };
    if (options.changed && command.startsWith("git diff-tree"))
      return {
        stdout: `:000000 100644 ${"0".repeat(40)} ${CONTRIBUTING_SHA} A\0CONTRIBUTING.md\0`,
      };
    if (command.includes("--batch-check"))
      return { stdout: `${CONTRIBUTING_SHA} ${CONTRIBUTING.length}\n` };
    if (command.startsWith(`git cat-file blob ${CONTRIBUTING_SHA}`))
      return { stdout: CONTRIBUTING.toString("base64") };
    return {};
  };
  return sandbox;
}

describe.skipIf(!database)("run-task handler against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  async function setUp(
    options: {
      environment?: EnvironmentConfig;
      message?: string;
      github?: ReturnType<typeof fakeGithubApp>;
    } = {},
  ) {
    const { project, task, run } = await insertRun(db);
    if (options.environment) {
      await new DbEnvironmentStore(db).save(
        project.id,
        options.environment,
        "detected",
      );
    }
    if (options.message) {
      await db.insert(messages).values({
        taskId: task.id,
        runId: run.id,
        role: "user",
        content: options.message,
      });
    }
    const published: RunEvent[] = [];
    const publisher: Publisher = {
      async publish(_channel, message) {
        published.push(JSON.parse(message) as RunEvent);
        return 1;
      },
    };
    const logs: string[] = [];
    let sandboxes = 0;
    const labels: SandboxLabels[] = [];
    const github = options.github ?? fakeGithubApp();
    const depsFor = (
      script: ScriptedStep[],
      sandbox = fakeSandbox(),
      titleScript?: ScriptedStep[],
    ) => {
      const { model, resolved } = scriptedModel(script);
      const value: RunTaskDeps = {
        db,
        events: createEventWriter({ store: dbEventRows(db), publisher }),
        log: (_level, message) => logs.push(message),
        model: resolved,
        createSandbox: async (l) => {
          sandboxes += 1;
          labels.push(l);
          return sandbox;
        },
        github: github.github,
        frontendUrl: "http://localhost:3000",
        ...(titleScript && {
          titleModel: scriptedModel(titleScript).resolved,
        }),
      };
      return { deps: value, model };
    };
    return {
      project,
      run,
      published,
      logs,
      depsFor,
      sandboxes: () => sandboxes,
      labels,
      githubRequests: github.requests,
      githubCalls: github.calls,
    };
  }

  const row = async (runId: string) =>
    (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  const stored = (runId: string) =>
    db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));

  it("clones with a read-only token for the project's repository", async () => {
    const { project, run, depsFor, githubRequests } = await setUp({
      environment: environment(),
    });
    const sandbox = fakeSandbox();

    await handleRunTask(depsFor([finish], sandbox).deps, { runId: run.id });

    const installation = await getInstallationById(db, project.installationId);
    expect(githubRequests).toEqual([
      {
        installationId: installation!.installationId,
        repoId: project.repoGithubId,
        permissions: { contents: "read" },
      },
    ]);
    const clone = sandbox.execCalls.find((c) =>
      c.command.startsWith("git clone"),
    );
    expect(clone!.command).not.toContain(FAKE_REPO_TOKEN);
    expect(clone!.options.env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${FAKE_REPO_TOKEN}`).toString("base64")}`,
    );
  });

  it("fails with github_access, before any sandbox, when the App was uninstalled", async () => {
    const { project, run, depsFor, sandboxes } = await setUp({
      environment: environment(),
    });
    const installation = await getInstallationById(db, project.installationId);
    await markInstallationUninstalled(db, installation!.installationId);

    expect(
      await handleRunTask(depsFor([finish]).deps, { runId: run.id }),
    ).toBeNull();

    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "github_access",
      errorMessage: expect.stringContaining("no longer installed"),
    });
    expect(sandboxes()).toBe(0);
  });

  it("runs a run with the project's environment and records everything", async () => {
    const { project, run, published, depsFor, labels, logs } = await setUp({
      environment: environment(),
      message: "Add a GET /health endpoint",
    });
    const { deps, model } = depsFor([finish]);

    const result = await handleRunTask(deps, { runId: run.id });

    expect(result?.status).toBe("succeeded");
    expect(labels).toEqual([{ kind: "run", runId: run.id }]);
    expect(logs).toContain("Run finished");
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain(
      "Add a GET /health endpoint",
    );
    const active = await new DbEnvironmentStore(db).load(project.id);
    expect(await row(run.id)).toMatchObject({
      status: "succeeded",
      environmentId: active!.id,
      sandboxId: "fake-sandbox",
      stage: "verify",
      summary: "Added GET /health.",
      finishedAt: expect.any(Date),
    });

    const events = await stored(run.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]).toMatchObject({
      type: "stage_changed",
      payload: { stage: "prepare" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      payload: { status: "succeeded" },
    });
    expect(events.find((e) => e.type === "checks_completed")).toMatchObject({
      payload: { checks: expect.any(Array) },
    });
    expect(published.at(-1)).toMatchObject({
      type: "done",
      seq: events.length,
    });
  });

  it("saves the run's changes, and nothing when there are none", async () => {
    const changed = await setUp({ environment: environment() });
    await handleRunTask(
      changed.depsFor([finish], fakeSandbox({ changed: true })).deps,
      { runId: changed.run.id },
    );
    const unchanged = await setUp({ environment: environment() });
    await handleRunTask(unchanged.depsFor([finish]).deps, {
      runId: unchanged.run.id,
    });

    expect(await getRunDiff(db, changed.run.id)).toMatchObject({
      patch: PATCH,
      files: [{ path: "CONTRIBUTING.md", added: 1, removed: 0 }],
      truncated: false,
    });
    expect(await getRunDiff(db, unchanged.run.id)).toBeNull();
  });

  const taskRow = async (taskId: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;

  it("delivers changes as a commit on a new branch and opens a pull request", async () => {
    const { project, run, depsFor, githubRequests, githubCalls } = await setUp({
      environment: environment(),
    });

    const result = await handleRunTask(
      depsFor([finish], fakeSandbox({ changed: true })).deps,
      { runId: run.id },
    );

    expect(result?.delivery).toEqual({
      branchName: `${SHORT_NAME}/add-a-health-endpoint-${run.taskId.slice(0, 4)}`,
      sha: FAKE_COMMIT_SHA,
    });
    expect(githubRequests.at(-1)).toMatchObject({
      repoId: project.repoGithubId,
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(githubCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/app/git/blobs",
      "GET /repos/acme/app/git/commits/base000",
      "POST /repos/acme/app/git/trees",
      "POST /repos/acme/app/git/commits",
      "POST /repos/acme/app/git/refs",
      "POST /repos/acme/app/pulls",
    ]);
    expect(githubCalls.at(-1)!.body).toMatchObject({
      title: "Add a /health endpoint",
      head: result!.delivery!.branchName,
      base: "main",
      draft: false,
      body: expect.stringContaining("Added GET /health."),
    });
    expect(githubCalls.at(-1)!.body).toMatchObject({
      body: expect.stringContaining(
        `[View the task](http://localhost:3000/tasks/${run.taskId})`,
      ),
    });

    expect(await taskRow(run.taskId)).toMatchObject({
      branchName: result!.delivery!.branchName,
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      prDraft: false,
      status: "pr_open",
    });
    expect(await row(run.id)).toMatchObject({
      status: "succeeded",
      stage: "deliver",
      commitSha: FAKE_COMMIT_SHA,
    });
    const events = (await stored(run.id)).map((e) => e.type);
    expect(events.slice(-4)).toEqual([
      "branch_created",
      "git_push",
      "pr_opened",
      "done",
    ]);
  });

  describe("the task's title", () => {
    const titled: ScriptedStep[] = [
      {
        text: "Add a health check route",
        usage: { inputTokens: 50, outputTokens: 6 },
      },
    ];

    it("is written on the first run, and names the branch", async () => {
      const { run, depsFor, published } = await setUp({
        environment: environment(),
        message: "can you add a health check route to the api please",
      });

      const result = await handleRunTask(
        depsFor([finish], fakeSandbox({ changed: true }), titled).deps,
        { runId: run.id },
      );

      expect(await taskRow(run.taskId)).toMatchObject({
        title: "Add a health check route",
        branchName: `${SHORT_NAME}/add-a-health-check-route-${run.taskId.slice(0, 4)}`,
      });
      expect(result?.delivery?.branchName).toBe(
        `${SHORT_NAME}/add-a-health-check-route-${run.taskId.slice(0, 4)}`,
      );
      expect(
        (await stored(run.id)).find((e) => e.type === "task_titled"),
      ).toMatchObject({ payload: { title: "Add a health check route" } });
      expect(published).toContainEqual(
        expect.objectContaining({
          type: "task_titled",
          title: "Add a health check route",
        }),
      );
      // The title's call counts towards the run, with the agent's.
      const counted = await row(run.id);
      expect(counted.inputTokens).toBe(100 + 50);
      expect(counted.outputTokens).toBe(20 + 6);
    });

    it("stays the first line when no title comes back", async () => {
      const { run, depsFor } = await setUp({ environment: environment() });
      const before = (await taskRow(run.taskId)).title;

      await handleRunTask(
        depsFor([finish], fakeSandbox({ changed: true }), [
          { error: new Error("rate limited") },
          { error: new Error("rate limited") },
        ]).deps,
        { runId: run.id },
      );

      expect((await taskRow(run.taskId)).title).toBe(before);
      expect((await stored(run.id)).map((e) => e.type)).not.toContain(
        "task_titled",
      );
    });

    it("isn't written again on a later run", async () => {
      const { run, depsFor } = await setUp({ environment: environment() });
      await db
        .update(runs)
        .set({ trigger: "follow_up" })
        .where(eq(runs.id, run.id));
      const before = (await taskRow(run.taskId)).title;

      await handleRunTask(depsFor([finish], fakeSandbox(), titled).deps, {
        runId: run.id,
      });

      expect((await taskRow(run.taskId)).title).toBe(before);
    });
  });

  it("titles the commit and pull request with the agent's title", async () => {
    const { run, depsFor, githubCalls } = await setUp({
      environment: environment(),
    });
    const titled: ScriptedStep = {
      toolCalls: [
        {
          toolName: "finish_task",
          input: { title: "Add a GET /health route", summary: "Added it." },
        },
      ],
    };

    await handleRunTask(
      depsFor([titled], fakeSandbox({ changed: true })).deps,
      { runId: run.id },
    );

    const body = (path: string) =>
      githubCalls.find((c) => c.path.endsWith(path))!.body;
    expect(body("/git/commits")).toMatchObject({
      message: "Add a GET /health route\n\nAdded it.",
    });
    expect(body("/pulls")).toMatchObject({ title: "Add a GET /health route" });
  });

  it("opens a draft when checks fail, or a marked ready one where drafts aren't available", async () => {
    const draft = await setUp({ environment: environment() });
    await handleRunTask(
      draft.depsFor(
        [finish],
        fakeSandbox({ changed: true, failOn: "npm run test" }),
      ).deps,
      { runId: draft.run.id },
    );
    const noDrafts = await setUp({
      environment: environment(),
      github: fakeGithubApp(
        FAKE_REPO_TOKEN,
        githubDeliveryApi({ draftUnavailable: true }),
      ),
    });
    await handleRunTask(
      noDrafts.depsFor(
        [finish],
        fakeSandbox({ changed: true, failOn: "npm run test" }),
      ).deps,
      { runId: noDrafts.run.id },
    );

    expect(draft.githubCalls.at(-1)!.body).toMatchObject({ draft: true });
    expect(await taskRow(draft.run.taskId)).toMatchObject({ prDraft: true });
    expect(await taskRow(noDrafts.run.taskId)).toMatchObject({
      prDraft: false,
    });
    const [refused, ready] = noDrafts.githubCalls.slice(-2);
    expect(refused!.body).toMatchObject({ draft: true });
    expect(ready!.body).not.toHaveProperty("draft");
    expect(ready!.body).toMatchObject({
      body: expect.stringContaining("draft pull requests aren't available"),
    });
    const opened = (await stored(noDrafts.run.id)).find(
      (e) => e.type === "pr_opened",
    );
    expect(opened?.payload).toMatchObject({ draft: false });
  });

  it("fails with deliver_failed and keeps the changes when GitHub's tree doesn't match", async () => {
    const api = githubDeliveryApi();
    const { run, depsFor } = await setUp({
      environment: environment(),
      github: fakeGithubApp(FAKE_REPO_TOKEN, (call) =>
        call.path.endsWith("/git/trees")
          ? { status: 201, body: { sha: "9".repeat(40) } }
          : api(call),
      ),
    });

    const result = await handleRunTask(
      depsFor([finish], fakeSandbox({ changed: true })).deps,
      { runId: run.id },
    );

    expect(result).toMatchObject({ status: "failed", failedStage: "deliver" });
    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "deliver_failed",
      errorMessage: expect.stringContaining("GitHub built a different tree"),
      commitSha: null,
    });
    expect(await taskRow(run.taskId)).toMatchObject({
      branchName: null,
      status: "open",
    });
    expect(await getRunDiff(db, run.id)).not.toBeNull();
  });

  it("uses the task title when the run has no message", async () => {
    const { run, depsFor } = await setUp({ environment: environment() });
    const { deps, model } = depsFor([finish]);
    await handleRunTask(deps, { runId: run.id });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain(
      "Add a /health endpoint",
    );
  });

  it("fails a run whose project hasn't been set up, without a sandbox", async () => {
    const { run, depsFor, sandboxes } = await setUp();
    expect(
      await handleRunTask(depsFor([finish]).deps, { runId: run.id }),
    ).toBeNull();
    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "no_environment",
      errorMessage:
        "acme/app hasn't been set up yet; onboard the project first.",
    });
    expect(sandboxes()).toBe(0);
  });

  it("skips a run that isn't queued", async () => {
    const { run, depsFor, logs, sandboxes } = await setUp({
      environment: environment(),
    });
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, run.id));
    expect(
      await handleRunTask(depsFor([finish]).deps, { runId: run.id }),
    ).toBeNull();
    expect(logs).toEqual(["Skipping a run that isn't queued"]);
    expect(sandboxes()).toBe(0);
    expect(await row(run.id)).toMatchObject({
      status: "running",
      startedAt: null,
    });
  });

  describe("when stopped", () => {
    const keptSandbox = () => {
      const sandbox = fakeSandbox();
      let destroyed = 0;
      sandbox.destroy = async () => void (destroyed += 1);
      return { sandbox, destroyed: () => destroyed };
    };

    it("ends as cancelled when you press Stop", async () => {
      const { run, depsFor, published } = await setUp({
        environment: environment(),
      });
      const { sandbox, destroyed } = keptSandbox();
      const stop = new AbortController();
      stop.abort();

      const result = await handleRunTask(
        depsFor([finish], sandbox).deps,
        { runId: run.id },
        stop.signal,
      );

      expect(result?.status).toBe("cancelled");
      expect((await row(run.id)).status).toBe("cancelled");
      expect(published.at(-1)).toMatchObject({
        type: "done",
        status: "cancelled",
      });
      expect(destroyed()).toBe(1);
    });

    it("records nothing and keeps the sandbox for the reaper when its queue lock was lost", async () => {
      const { run, depsFor, published, logs, githubCalls } = await setUp({
        environment: environment(),
      });
      const { sandbox, destroyed } = keptSandbox();
      const lost = new AbortController();
      lost.abort(new LockLostError());

      const result = await handleRunTask(
        depsFor([finish], sandbox).deps,
        { runId: run.id },
        lost.signal,
      );

      expect(result).toBeNull();
      expect((await row(run.id)).status).toBe("running");
      expect(published.map((e) => e.type)).not.toContain("done");
      expect((await stored(run.id)).map((e) => e.type)).not.toContain("done");
      expect(destroyed()).toBe(0);
      expect(githubCalls).toEqual([]);
      expect(logs).toContain("Stopped a run whose queue lock was lost");
    });
  });

  it("records a failed checkout with an error and a done event", async () => {
    const { run, depsFor } = await setUp({ environment: environment() });
    const result = await handleRunTask(
      depsFor([finish], fakeSandbox({ failOn: "git clone" })).deps,
      { runId: run.id },
    );

    expect(result?.status).toBe("failed");
    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_failed",
    });
    const types = (await stored(run.id)).map((e) => [e.type, e.payload]);
    expect(types.slice(-2)).toEqual([
      [
        "error",
        {
          code: "checkout_failed",
          message: "git clone failed: repository not found",
        },
      ],
      ["done", { status: "failed" }],
    ]);
  });

  it("marks the environment when setup reports a problem", async () => {
    const { project, run, depsFor } = await setUp({
      environment: environment("api"),
    });
    await handleRunTask(depsFor([finish]).deps, { runId: run.id });
    expect(
      (await new DbEnvironmentStore(db).load(project.id))!.health,
    ).toMatchObject({
      status: "needs_attention",
      reasons: [
        "The repository root has its own package.json but isn't covered by the environment.",
      ],
    });
  });

  it("refuses a run that doesn't exist", async () => {
    const { depsFor } = await setUp();
    await expect(
      handleRunTask(depsFor([finish]).deps, {
        runId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow("doesn't exist");
  });
});
