import { resolveModel, type ResolvedModel } from "@hobai/agent";
import { createDb, pingDatabase } from "@hobai/db";
import { createGithubApp, type GithubApp } from "@hobai/github";
import {
  connectSandbox,
  createSandbox,
  type SandboxLabels,
} from "@hobai/sandbox";
import { WORK_QUEUE } from "@hobai/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { SHORT_NAME } from "@hobai/shared/brand";
import type { WorkerConfig } from "./config.js";
import { startConsumer } from "./consumer.js";
import { handleOnboardProject } from "./handlers/onboard-project.js";
import { handleRunTask } from "./handlers/run-task.js";
import type { Log } from "./lib/log.js";
import type { SandboxFactory } from "./lib/sandbox-factory.js";
import { createAnswerRouter } from "./onboardings/answer-router.js";
import { handleReap } from "./reaper/reap.js";
import { scheduleReaper } from "./reaper/schedule.js";

/** Stand-ins for the model, GitHub and the sandbox, for the end-to-end test and the load harness. */
export type WorkerOverrides = {
  taskModel?: ResolvedModel;
  setupModel?: ResolvedModel;
  titleModel?: ResolvedModel;
  github?: Pick<GithubApp, "repoToken" | "repoClient">;
  createSandbox?: SandboxFactory;
};

export type RunningWorker = {
  /** Throws when Postgres or Redis can't be reached. */
  check(): Promise<void>;
  /** The database pool's connections, and queries waiting for one. */
  poolStats(): { total: number; idle: number; waiting: number };
  /** Stops taking new work, waits for the work in progress, then closes the connections. */
  stop(): Promise<void>;
};

export async function startWorker(
  config: WorkerConfig,
  log: Log,
  overrides: WorkerOverrides = {},
): Promise<RunningWorker> {
  const { db, pool } = createDb(config.databaseUrl);
  // Without a listener, an idle connection dropping (e.g. Postgres restarting) crashes the process.
  pool.on("error", (error) =>
    log("error", "Database connection error", { error: error.message }),
  );

  const connect = (name: string) => {
    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      connectionName: `${SHORT_NAME}-worker-${name}`,
    });
    redis.on("error", (error) =>
      log("error", "Redis connection error", { name, error: error.message }),
    );
    return redis;
  };
  const redis = {
    queue: connect("queue"),
    publisher: connect("publisher"),
    subscriber: connect("subscriber"),
    scheduler: connect("scheduler"),
  };
  const queue = new Queue(WORK_QUEUE, { connection: redis.scheduler });

  const model = (override: ResolvedModel | undefined) =>
    override ?? resolveModel(config.model);
  const deps = {
    db,
    publisher: redis.publisher,
    log,
    model: model(overrides.taskModel),
    titleModel: model(overrides.titleModel),
    createSandbox:
      overrides.createSandbox ??
      ((labels: SandboxLabels) => createSandbox({ ...config.sandbox, labels })),
    github: overrides.github ?? createGithubApp(config.github),
    answers: createAnswerRouter(),
    answerTimeoutMs: config.answerTimeoutMs,
    frontendUrl: config.frontendUrl,
  };
  const consumer = await startConsumer({
    connection: redis.queue,
    subscriber: redis.subscriber,
    answers: deps.answers,
    concurrency: config.concurrency,
    log,
    handlers: {
      "run-task": (data, signal) => handleRunTask(deps, data, signal),
      "onboard-project": (data, signal) =>
        handleOnboardProject(
          { ...deps, model: model(overrides.setupModel) },
          data,
          signal,
        ),
      reap: () =>
        handleReap({
          ...deps,
          queue,
          connectSandbox: (id) => connectSandbox({ ...config.sandbox, id }),
        }),
    },
  });
  await scheduleReaper(queue, config.reaperIntervalMs);

  return {
    async check() {
      await pingDatabase(db);
      await redis.queue.ping();
    },
    poolStats: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }),
    async stop() {
      await consumer.close();
      await queue.close();
      await Promise.all(Object.values(redis).map((r) => r.quit()));
      await pool.end();
    },
  };
}
