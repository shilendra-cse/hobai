import {
  getRunDiff,
  getRunWithProject,
  insertRunEvent,
  type Db,
} from "@hobai/db";
import { insertRun, testDatabaseOrSkip } from "@hobai/db/testing";
import { FakeSandbox } from "@hobai/sandbox/testing";
import { WORK_QUEUE, type RunEvent } from "@hobai/shared";
import { Queue, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEventWriter,
  dbEventRows,
  type Publisher,
} from "../events/event-writer.js";
import { testRedisOrSkip } from "../testing/test-redis.js";
import { failLostRuns, QUEUED_GRACE_MS } from "./lost-runs.js";

const database = await testDatabaseOrSkip("lost runs");
const redis = await testRedisOrSkip("lost runs");

describe.skipIf(!database || !redis)(
  "lost runs against Postgres and Redis",
  () => {
    const db = database?.db as Db;
    const { prefix, connect } = redis!;
    const queue = new Queue(WORK_QUEUE, { connection: connect(), prefix });
    const published: { channel: string; event: RunEvent }[] = [];
    const publisher: Publisher = {
      async publish(channel, message) {
        published.push({ channel, event: JSON.parse(message) as RunEvent });
        return 1;
      },
    };
    const deps = {
      db,
      queue,
      events: createEventWriter({ store: dbEventRows(db), publisher }),
      log: () => {},
      connectSandbox: async () => null,
    };
    const longAgo = () => new Date(Date.now() - QUEUED_GRACE_MS - 60_000);

    afterAll(async () => {
      await queue.close();
      await redis?.close();
      await database?.drop();
    });

    const row = async (runId: string) => (await getRunWithProject(db, runId))!;

    it("fails a running run that no worker holds, after its last event", async () => {
      const { run } = await insertRun(db, { status: "running" });
      await insertRunEvent(db, {
        runId: run.id,
        seq: 1,
        type: "stage_changed",
      });

      const failed = await failLostRuns(deps);

      expect(failed).toContainEqual({
        runId: run.id,
        status: "running",
        code: "worker_lost",
        sandboxId: null,
      });
      expect(await row(run.id)).toMatchObject({
        status: "failed",
        errorCode: "worker_lost",
        finishedAt: expect.any(Date),
      });
      const events = published.filter((p) => p.channel === `run:${run.id}`);
      expect(events.map((p) => p.event)).toMatchObject([
        { type: "error", seq: 2, code: "worker_lost" },
        { type: "done", seq: 3, status: "failed" },
      ]);
    });

    it("leaves a running run whose worker is alive", async () => {
      const { run } = await insertRun(db, { status: "running" });
      let started!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((r) => (started = r));
      const worker = new Worker(
        WORK_QUEUE,
        () => {
          started();
          return new Promise<void>((r) => (release = r));
        },
        { connection: connect(), prefix },
      );
      try {
        await queue.add("run-task", { runId: run.id }, { jobId: run.id });
        await holding;

        const failed = await failLostRuns(deps);

        expect(failed.map((l) => l.runId)).not.toContain(run.id);
        expect((await row(run.id)).status).toBe("running");
      } finally {
        release?.();
        await worker.close();
      }
    });

    it("fails a run queued long ago whose queue item is gone, but not a recent one", async () => {
      const old = (await insertRun(db, { queuedAt: longAgo() })).run;
      const recent = (await insertRun(db)).run;

      const failed = await failLostRuns(deps);

      expect(failed).toContainEqual({
        runId: old.id,
        status: "queued",
        code: "lost_in_queue",
        sandboxId: null,
      });
      expect((await row(old.id)).status).toBe("failed");
      expect((await row(recent.id)).status).toBe("queued");
    });

    it("leaves a run queued long ago whose item is still waiting", async () => {
      await queue.pause();
      const { run } = await insertRun(db, { queuedAt: longAgo() });
      await queue.add("run-task", { runId: run.id }, { jobId: run.id });

      const failed = await failLostRuns(deps);

      expect(failed.map((l) => l.runId)).not.toContain(run.id);
      expect((await row(run.id)).status).toBe("queued");
      await queue.resume();
    });

    const PATCH = "diff --git a/notes.md b/notes.md\n+half done\n";

    function sandboxWithWork(options: { baseline: boolean }) {
      const sandbox = new FakeSandbox();
      let destroyed = false;
      sandbox.destroy = async () => {
        destroyed = true;
      };
      sandbox.execHandler = (command) => {
        if (command.includes("git log"))
          return { stdout: options.baseline ? "base123\n" : "" };
        if (command.includes("--numstat"))
          return { stdout: "1\t0\tnotes.md\n" };
        if (command.includes("git diff")) return { stdout: PATCH };
        return {};
      };
      return { sandbox, destroyed: () => destroyed };
    }

    it("keeps a lost run's work: saves its diff, then parks its sandbox", async () => {
      const { run } = await insertRun(db, {
        status: "running",
        sandboxId: "cg-lost",
      });
      const { sandbox, destroyed } = sandboxWithWork({ baseline: true });
      const connected: string[] = [];

      await failLostRuns({
        ...deps,
        connectSandbox: async (id) => {
          connected.push(id);
          return sandbox;
        },
      });

      expect(connected).toEqual(["cg-lost"]);
      expect(await getRunDiff(db, run.id)).toMatchObject({
        patch: PATCH,
        files: [{ path: "notes.md", added: 1, removed: 0 }],
      });
      expect(destroyed()).toBe(true);
      expect((await row(run.id)).status).toBe("failed");
    });

    it("saves nothing when the run died before the agent started, but still parks the sandbox", async () => {
      const { run } = await insertRun(db, {
        status: "running",
        sandboxId: "cg-early",
      });
      const { sandbox, destroyed } = sandboxWithWork({ baseline: false });

      await failLostRuns({ ...deps, connectSandbox: async () => sandbox });

      expect(await getRunDiff(db, run.id)).toBeNull();
      expect(destroyed()).toBe(true);
    });

    it("still fails the run when its sandbox is gone", async () => {
      const { run } = await insertRun(db, {
        status: "running",
        sandboxId: "cg-gone",
      });

      await failLostRuns(deps);

      expect((await row(run.id)).status).toBe("failed");
      expect(await getRunDiff(db, run.id)).toBeNull();
    });
  },
);
