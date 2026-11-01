import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../client.js";
import { DbEnvironmentStore } from "../projects/environments-queries.js";
import { insertRun, testDatabaseOrSkip } from "../../testing/index.js";
import { saveRunDiff } from "./run-diffs-queries.js";
import {
  findUserRun,
  getRunWithProject,
  listEndedRuns,
  listUnfinishedRuns,
  markRunEnded,
  markRunStarted,
  updateRunProgress,
} from "./runs-queries.js";

const database = await testDatabaseOrSkip("runs queries");

describe.skipIf(!database)("runs queries against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  async function runWithEnvironment() {
    const { project, run } = await insertRun(db);
    const environment = await new DbEnvironmentStore(db).save(
      project.id,
      {
        version: 1,
        steps: [],
        checks: [],
        meta: { source: "detected", createdAt: "", decisions: [] },
      },
      "detected",
    );
    return { project, run, environmentId: environment.id };
  }

  it("loads a run with its task and project", async () => {
    const { project, task, run } = await insertRun(db);

    expect(await getRunWithProject(db, run.id)).toMatchObject({
      id: run.id,
      task: { id: task.id, project: { id: project.id } },
    });
    expect(await getRunWithProject(db, randomUUID())).toBeNull();
  });

  it("starts a run only while it's queued", async () => {
    const { run, environmentId } = await runWithEnvironment();

    expect(await markRunStarted(db, run.id, environmentId)).toBe(true);
    expect(await markRunStarted(db, run.id, environmentId)).toBe(false);
    expect(await getRunWithProject(db, run.id)).toMatchObject({
      status: "running",
      environmentId,
      startedAt: expect.any(Date),
    });
  });

  it("records the stage and the sandbox", async () => {
    const { run } = await insertRun(db);

    await updateRunProgress(db, run.id, { stage: "setup" });
    await updateRunProgress(db, run.id, { sandboxId: "cg-1" });

    expect(await getRunWithProject(db, run.id)).toMatchObject({
      stage: "setup",
      sandboxId: "cg-1",
    });
  });

  it("ends a run only from the given statuses", async () => {
    const { run } = await insertRun(db);
    const outcome = {
      status: "failed" as const,
      errorCode: "worker_lost",
      errorMessage: "The worker stopped.",
    };

    expect(await markRunEnded(db, run.id, outcome, ["running"])).toBe(false);
    expect(await markRunEnded(db, run.id, outcome, ["queued"])).toBe(true);
    expect(await getRunWithProject(db, run.id)).toMatchObject({
      ...outcome,
      finishedAt: expect.any(Date),
    });
  });

  it("lists the runs that haven't ended", async () => {
    const queued = (await insertRun(db)).run;
    const running = (await insertRun(db, { status: "running" })).run;
    const done = (await insertRun(db, { status: "succeeded" })).run;

    const ids = (await listUnfinishedRuns(db)).map((r) => r.id);

    expect(ids).toEqual(expect.arrayContaining([queued.id, running.id]));
    expect(ids).not.toContain(done.id);
  });

  it("lists which of the given runs have ended", async () => {
    const queued = (await insertRun(db)).run;
    const ended = (await insertRun(db)).run;
    const other = (await insertRun(db)).run;
    await markRunEnded(db, ended.id, { status: "succeeded" }, ["queued"]);
    await markRunEnded(db, other.id, { status: "failed" }, ["queued"]);

    expect(await listEndedRuns(db, [queued.id, ended.id])).toEqual([
      { id: ended.id, status: "succeeded", finishedAt: expect.any(Date) },
    ]);
    expect(await listEndedRuns(db, [])).toEqual([]);
  });

  it("gets a run with its changed files, only for the owner of its project", async () => {
    const { project, run } = await insertRun(db);
    await saveRunDiff(db, run.id, {
      patch: "diff --git a/a.ts b/a.ts",
      files: [{ path: "a.ts", added: 2, removed: 1 }],
      truncated: false,
    });

    expect(await findUserRun(db, project.userId, run.id)).toMatchObject({
      id: run.id,
      diff: {
        files: [{ path: "a.ts", added: 2, removed: 1 }],
        truncated: false,
      },
    });
    expect(await findUserRun(db, randomUUID(), run.id)).toBeNull();
  });
});
