import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { scriptedModel } from "@hobai/agent/testing";
import {
  createOnboarding,
  createTaskWithRun,
  DbEnvironmentStore,
  ensureUser,
  findOnboarding,
  recordInstallation,
  runEvents,
  runs,
  upsertProject,
  type Db,
} from "@hobai/db";
import { testDatabaseOrSkip } from "@hobai/db/testing";
import { DockerSandbox } from "@hobai/sandbox";
import { dockerSandboxOrSkip } from "@hobai/sandbox/testing";
import { WORK_QUEUE, type RunEvent } from "@hobai/shared";
import { Queue, QueueEvents } from "bullmq";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { startConsumer } from "./consumer.js";
import { createEventWriter, dbEventRows } from "./events/event-writer.js";
import { handleOnboardProject } from "./handlers/onboard-project.js";
import { handleRunTask } from "./handlers/run-task.js";
import { createAnswerRouter } from "./onboardings/answer-router.js";
import { fakeGithubApp } from "./testing/fake-github-app.js";
import { testRedisOrSkip } from "./testing/test-redis.js";

const database = await testDatabaseOrSkip("worker end to end");
const redis = await testRedisOrSkip("worker end to end");
const probe = await dockerSandboxOrSkip("worker end to end");
await probe?.destroy();

describe.skipIf(!database || !redis || !probe)(
  "worker end to end: queue → handlers → Docker → Postgres and Redis",
  () => {
    const db = database?.db as Db;
    const { prefix, connect } = redis!;
    const queue = new Queue(WORK_QUEUE, { connection: connect(), prefix });
    const queueEvents = new QueueEvents(WORK_QUEUE, {
      connection: connect(),
      prefix,
    });
    const sandboxIds: string[] = [];
    const published = new Map<string, unknown[]>();

    afterAll(async () => {
      await queue.close();
      await queueEvents.close();
      await redis?.close();
      await database?.drop();
    });

    it("onboards a public repository, then runs a task on it", async () => {
      const listener = connect();
      listener.on("pmessage", (_pattern, channel, message) => {
        published.set(channel, [
          ...(published.get(channel) ?? []),
          JSON.parse(message),
        ]);
      });
      await listener.psubscribe("run:*", "onboarding:*");

      const onboardingModel = scriptedModel([
        {
          toolCalls: [
            {
              toolName: "finish_setup",
              input: {
                steps: [],
                checks: [],
                notes: ["A README only; nothing to install or check."],
              },
            },
          ],
        },
      ]);
      const runModel = scriptedModel([
        {
          toolCalls: [
            {
              toolName: "finish_task",
              input: { summary: "Looked around; nothing to change." },
            },
          ],
        },
      ]);
      const deps = {
        db,
        // octocat/Hello-World is public, and GitHub rejects any credentials that aren't valid.
        github: fakeGithubApp("").github,
        events: createEventWriter({
          store: dbEventRows(db),
          publisher: connect(),
        }),
        log: () => {},
        answers: createAnswerRouter(),
        answerTimeoutMs: 60_000,
        createSandbox: async () => {
          const sandbox = await DockerSandbox.create();
          sandboxIds.push(sandbox.id);
          return sandbox;
        },
      };
      const consumer = await startConsumer({
        connection: connect(),
        subscriber: connect(),
        answers: deps.answers,
        concurrency: 2,
        log: () => {},
        prefix,
        handlers: {
          "run-task": (data, signal) =>
            handleRunTask({ ...deps, model: runModel.resolved }, data, signal),
          "onboard-project": (data, signal) =>
            handleOnboardProject(
              { ...deps, model: onboardingModel.resolved },
              data,
              signal,
            ),
          reap: async () => {},
        },
      });

      try {
        const installerId = randomUUID();
        const installationId = randomInt(1, 2 ** 31);
        await ensureUser(db, {
          id: installerId,
          name: "Ada",
          email: `${installerId}@example.com`,
        });
        const installation = await recordInstallation(db, {
          installationId,
          accountLogin: "octocat",
          accountType: "user",
          installedByUserId: installerId,
        });
        const project = await upsertProject(db, {
          userId: installerId,
          installationId: installation.id,
          repoGithubId: 1296269,
          repoOwner: "octocat",
          repoName: "Hello-World",
          defaultBranch: "master",
        });
        const { onboarding: setup } = await createOnboarding(db, {
          projectId: project.id,
          userId: installerId,
        });
        const onboarding = await queue.add(
          "onboard-project",
          { onboardingId: setup.id },
          { jobId: setup.id },
        );
        await onboarding.waitUntilFinished(queueEvents);

        const environment = await new DbEnvironmentStore(db).load(project.id);
        expect(environment).toMatchObject({
          version: 1,
          source: "ai",
          config: { steps: [], checks: [] },
        });
        expect(published.get(`onboarding:${setup.id}`)?.at(-1)).toMatchObject({
          type: "done",
          status: "succeeded",
          version: 1,
        });
        expect(await findOnboarding(db, setup.id)).toMatchObject({
          status: "succeeded",
        });

        const { run } = await createTaskWithRun(db, {
          task: {
            projectId: project.id,
            createdByUserId: installerId,
            title: "Look around the repository",
            baseBranch: "master",
          },
          run: { trigger: "initial", model: "scripted" },
          message: {
            authorUserId: installerId,
            content: "Look around the repository",
          },
        });
        const job = await queue.add(
          "run-task",
          { runId: run.id },
          { jobId: run.id },
        );
        await job.waitUntilFinished(queueEvents);

        const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
        expect(row).toMatchObject({
          status: "succeeded",
          environmentId: environment!.id,
          summary: "Looked around; nothing to change.",
          startedAt: expect.any(Date),
          finishedAt: expect.any(Date),
        });
        expect(row!.sandboxId).toMatch(/^cg-/);

        const stored = await db
          .select()
          .from(runEvents)
          .where(eq(runEvents.runId, run.id))
          .orderBy(asc(runEvents.seq));
        expect(stored.map((e) => e.seq)).toEqual(stored.map((_, i) => i + 1));
        expect(stored.at(-1)).toMatchObject({
          type: "done",
          payload: { status: "succeeded" },
        });

        const live = (published.get(`run:${run.id}`) ?? []) as RunEvent[];
        expect(
          live.filter((e) => e.seq !== undefined).map((e) => e.seq),
        ).toEqual(stored.map((e) => e.seq));
        expect(live.at(-1)).toMatchObject({
          type: "done",
          status: "succeeded",
        });
      } finally {
        await consumer.close();
      }

      expect(sandboxIds.length).toBeGreaterThanOrEqual(3);
      const left = execFileSync(
        "docker",
        [
          "ps",
          "-aq",
          ...sandboxIds.flatMap((id) => ["--filter", `name=^${id}$`]),
        ],
        { encoding: "utf8" },
      );
      expect(left.trim()).toBe("");
    }, 300_000);
  },
);
