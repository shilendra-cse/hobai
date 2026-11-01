import { scriptedModel } from "@hobai/agent/testing";
import { DbEnvironmentStore, runs, type Db } from "@hobai/db";
import { insertRun, testDatabaseOrSkip } from "@hobai/db/testing";
import { FakeSandbox } from "@hobai/sandbox/testing";
import { createEventWriter, dbEventRows } from "../events/event-writer.js";
import { fakeGithubApp } from "../testing/fake-github-app.js";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@hobai/runner", () => ({
  runTask: vi.fn(async () => {
    throw new Error("runner bug");
  }),
}));

const { handleRunTask } = await import("./run-task.js");
const database = await testDatabaseOrSkip("run-task handler crash");

describe.skipIf(!database)("run-task handler when runTask throws", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  it("fails the run with the error and passes it on", async () => {
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

    await expect(
      handleRunTask(
        {
          db,
          events: createEventWriter({
            store: dbEventRows(db),
            publisher: { publish: async () => 1 },
          }),
          log: () => {},
          model: scriptedModel([]).resolved,
          createSandbox: async () => new FakeSandbox(),
          github: fakeGithubApp().github,
        },
        { runId: run.id },
      ),
    ).rejects.toThrow("runner bug");

    const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(row).toMatchObject({
      status: "failed",
      errorCode: "worker_error",
      errorMessage: "runner bug",
      finishedAt: expect.any(Date),
    });
  });
});
