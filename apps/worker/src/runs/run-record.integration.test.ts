import {
  DbEnvironmentStore,
  runDiffs,
  runs,
  projectEnvironments,
  type Db,
} from "@hobai/db";
import { insertRun, testDatabaseOrSkip } from "@hobai/db/testing";
import type { RunResult } from "@hobai/runner";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createRunRecord,
  RunStateError,
  type RunRecordOptions,
} from "./run-record.js";

const database = await testDatabaseOrSkip("run record");

type AgentResult = NonNullable<RunResult["agent"]>;
const agent = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  status: "succeeded",
  title: "Add GET /health",
  summary: "Added GET /health.",
  steps: 9,
  durationMs: 60_000,
  model: "test:scripted",
  usage: {
    inputTokens: 12_000,
    cachedInputTokens: 8_000,
    outputTokens: 900,
    costUsd: 0.00412,
  },
  compactions: 0,
  messages: [],
  ...overrides,
});

describe.skipIf(!database)("run record against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  const row = async (runId: string) =>
    (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;

  async function newRun(options: Partial<RunRecordOptions> = {}) {
    const { project, run } = await insertRun(db);
    await new DbEnvironmentStore(db).save(
      project.id,
      {
        version: 1,
        steps: [],
        checks: [],
        meta: { source: "detected", createdAt: "", decisions: [] },
      },
      "detected",
    );
    const environment = await db.query.projectEnvironments.findFirst({
      where: eq(projectEnvironments.projectId, project.id),
    });
    return {
      run,
      record: createRunRecord(db, run.id, { log: () => {}, ...options }),
      environmentId: environment!.id,
    };
  }

  async function startedRun(options: Partial<RunRecordOptions> = {}) {
    const created = await newRun(options);
    await created.record.start(created.environmentId);
    return created;
  }

  it("starts a queued run once, with the environment version it replays", async () => {
    const { run, record, environmentId } = await newRun();
    await record.start(environmentId);
    expect(await row(run.id)).toMatchObject({
      status: "running",
      environmentId,
      startedAt: expect.any(Date),
    });
    await expect(record.start(environmentId)).rejects.toThrow(RunStateError);
  });

  it("records the stage and sandbox in the order they happen", async () => {
    const { run, record } = await newRun();
    record.observe({
      type: "stage_changed",
      runId: run.id,
      ts: "",
      stage: "prepare",
    });
    record.observe({
      type: "sandbox_created",
      runId: run.id,
      ts: "",
      sandboxId: "sb-1",
    });
    record.observe({
      type: "tool_start",
      runId: run.id,
      ts: "",
      toolCallId: "1",
      toolName: "bash",
    });
    record.observe({
      type: "stage_changed",
      runId: run.id,
      ts: "",
      stage: "agent",
    });
    await record.flush();
    expect(await row(run.id)).toMatchObject({
      stage: "agent",
      sandboxId: "sb-1",
    });
  });

  describe("when its progress can't be saved at once", () => {
    const noAnswer = () => new Error("timeout exceeded when trying to connect");
    const stage = (s: "setup" | "agent") => ({
      type: "stage_changed" as const,
      runId: "r",
      ts: "2026-11-02T10:00:00.000Z",
      stage: s,
    });

    it("retries it until it's saved", async () => {
      let calls = 0;
      const { run, record } = await startedRun({
        firstRetryMs: 1,
        updateProgress: async (progress) => {
          calls += 1;
          if (calls < 3) throw noAnswer();
          await db.update(runs).set(progress).where(eq(runs.id, run.id));
        },
      });

      record.observe(stage("agent"));
      await record.flush();

      expect(calls).toBe(3);
      expect((await row(run.id)).stage).toBe("agent");
    });

    it("logs one that keeps failing and still records the run's result", async () => {
      const logs: { message: string; data?: Record<string, unknown> }[] = [];
      const { run, record } = await startedRun({
        firstRetryMs: 1,
        retryForMs: 10,
        log: (_level, message, data) => logs.push({ message, data }),
        updateProgress: async () => {
          throw new Error("Failed query: update runs", { cause: noAnswer() });
        },
      });

      record.observe(stage("setup"));
      await expect(record.flush()).resolves.toBeUndefined();
      expect(await record.finish({ status: "succeeded", durationMs: 1 })).toBe(
        true,
      );

      expect((await row(run.id)).status).toBe("succeeded");
      expect(logs).toEqual([
        {
          message: "A run's progress wasn't saved",
          data: {
            runId: run.id,
            progress: { stage: "setup" },
            error:
              "Failed query: update runs; caused by: timeout exceeded when trying to connect",
          },
        },
      ]);
    });

    it("gives up at once on an error that won't pass", async () => {
      let calls = 0;
      const { record } = await startedRun({
        firstRetryMs: 1,
        updateProgress: async () => {
          calls += 1;
          throw Object.assign(new Error("invalid input"), { code: "22P02" });
        },
      });

      record.observe(stage("agent"));
      await record.flush();

      expect(calls).toBe(1);
    });
  });

  it("finishes with the summary, usage, cost and check outcome", async () => {
    const { run, record } = await startedRun();
    const recorded = await record.finish({
      status: "succeeded",
      agent: agent(),
      verify: { checks: [], passed: true, fixed: 1, regressions: 0 },
      durationMs: 70_000,
    });

    expect(recorded).toBe(true);
    expect(await row(run.id)).toMatchObject({
      status: "succeeded",
      summary: "Added GET /health.",
      inputTokens: 12_000,
      outputTokens: 900,
      steps: 9,
      costUsd: "0.0041",
      checksPassed: true,
      errorCode: null,
      errorMessage: null,
      finishedAt: expect.any(Date),
    });
  });

  const endings: [string, RunResult, Record<string, unknown>][] = [
    [
      "a failed stage",
      {
        status: "failed",
        failedStage: "checkout",
        error: "git clone failed: not found",
        durationMs: 1,
      },
      {
        status: "failed",
        errorCode: "checkout_failed",
        errorMessage: "git clone failed: not found",
        checksPassed: null,
      },
    ],
    [
      "a failed agent",
      {
        status: "failed",
        agent: agent({ status: "failed", error: "Model request failed: 500" }),
        durationMs: 1,
      },
      {
        status: "failed",
        errorCode: "agent_failed",
        errorMessage: "Model request failed: 500",
      },
    ],
    [
      "a limit",
      {
        status: "incomplete",
        agent: agent({ status: "incomplete", limitReached: "steps" }),
        durationMs: 1,
      },
      {
        status: "incomplete",
        errorCode: "steps_limit",
        errorMessage: "Stopped at the steps limit.",
      },
    ],
    [
      "a cancel",
      { status: "cancelled", durationMs: 1 },
      { status: "cancelled", errorCode: null },
    ],
  ];

  it.each(endings)("finishes after %s", async (_name, result, expected) => {
    const { run, record } = await startedRun();
    expect(await record.finish(result)).toBe(true);
    expect(await row(run.id)).toMatchObject(expected);
  });

  it("doesn't overwrite a run that was ended elsewhere", async () => {
    const { run, record } = await startedRun();
    await db
      .update(runs)
      .set({ status: "failed", errorCode: "stalled" })
      .where(eq(runs.id, run.id));

    expect(await record.finish({ status: "succeeded", durationMs: 1 })).toBe(
      false,
    );
    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "stalled",
    });
  });

  it("fails a run before it ran, with a reason", async () => {
    const { run, record } = await newRun();
    expect(
      await record.fail({
        code: "no_environment",
        message: "Set the project up first.",
      }),
    ).toBe(true);
    expect(await row(run.id)).toMatchObject({
      status: "failed",
      errorCode: "no_environment",
      errorMessage: "Set the project up first.",
      finishedAt: expect.any(Date),
    });
    expect(await record.fail({ code: "again", message: "x" })).toBe(false);
  });

  it("saves the run's changes, keeping only the latest", async () => {
    const { run, record } = await newRun();
    const diff = (path: string) => ({
      patch: `diff --git a/${path} b/${path}\n`,
      files: [{ path, added: 3, removed: null }],
      truncated: false,
    });

    await record.saveDiff(diff("a.md"));
    await record.saveDiff(diff("b.md"));

    expect(
      await db.select().from(runDiffs).where(eq(runDiffs.runId, run.id)),
    ).toEqual([
      {
        runId: run.id,
        ...diff("b.md"),
        createdAt: expect.any(Date),
      },
    ]);
  });
});
