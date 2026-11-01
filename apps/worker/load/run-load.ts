// How many runs one worker holds: queues levels of runs against a real worker process, with a
// fake OpenAI server and sandbox, and records what the worker uses. See docs/knowledge/worker-capacity.md.
import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DbEnvironmentStore,
  ensureUser,
  recordInstallation,
  upsertProject,
  type Db,
} from "@hobai/db";
import { testDatabaseOrSkip } from "@hobai/db/testing";
import { WORK_QUEUE } from "@hobai/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { startChild } from "./children.js";
import { startLatencyProxy } from "./latency-proxy.js";
import { runLevel } from "./level.js";
import { toLoadEnv, type LoadEnv } from "./load-env.js";
import { LOAD_ENVIRONMENT } from "./load-sandbox.js";
import type { ProcessSample } from "./messages.js";
import {
  createResults,
  summarize,
  summaryTable,
  type LevelSummary,
} from "./results.js";

// Its own Redis database, so the development worker never takes the load's work.
const REDIS_DB = 15;

const argsSchema = z.object({
  runs: z
    .string()
    .default("100,250,500,1000")
    .transform((value) => value.split(",").map(Number))
    .pipe(z.array(z.number().int().positive()).min(1)),
  profile: z.enum(["typical", "long", "mixed"]).default("mixed"),
  "time-scale": z.coerce.number().min(0).default(1),
  "tokens-per-second": z.coerce.number().positive().default(70),
  "db-latency-ms": z.coerce.number().min(0).default(7),
  "ramp-seconds": z.coerce.number().min(0).default(30),
  "level-timeout-minutes": z.coerce.number().positive().default(50),
  "max-heap-mb": z.coerce.number().int().positive().optional(),
  label: z.string().default("local"),
});

function readArgs() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      Object.keys(argsSchema.shape).map(
        (name) => [name, { type: "string" }] as const,
      ),
    ),
  });
  return argsSchema.parse(values);
}

async function seedProject(db: Db) {
  const userId = randomUUID();
  await ensureUser(db, {
    id: userId,
    name: "Load",
    email: `${userId}@example.com`,
  });
  const installation = await recordInstallation(db, {
    installationId: randomInt(1, 2 ** 31),
    accountLogin: "load",
    accountType: "organization",
    installedByUserId: userId,
  });
  const project = await upsertProject(db, {
    userId,
    installationId: installation.id,
    repoGithubId: randomInt(1, 2 ** 31),
    repoOwner: "load",
    repoName: "repo",
    defaultBranch: "main",
  });
  await new DbEnvironmentStore(db).save(project.id, LOAD_ENVIRONMENT, "user");
  return { id: project.id, userId, defaultBranch: "main" };
}

async function loadRedis() {
  const url = new URL(process.env.LOAD_REDIS_URL ?? "redis://localhost:6380");
  url.pathname = `/${REDIS_DB}`;
  const connections: Redis[] = [];
  const connect = () => {
    const redis = new Redis(url.toString(), { maxRetriesPerRequest: null });
    connections.push(redis);
    return redis;
  };
  const admin = connect();
  const foreign = (await admin.keys("*")).filter(
    (key) => !key.startsWith("bull:"),
  );
  if (foreign.length > 0) {
    throw new Error(
      `Redis database ${REDIS_DB} holds keys that aren't the load's (${foreign.slice(0, 3).join(", ")}…).`,
    );
  }
  await admin.flushdb();
  return {
    url: url.toString(),
    connect,
    async close() {
      await admin.flushdb();
      await Promise.all(connections.map((c) => c.quit().catch(() => {})));
    },
  };
}

async function main() {
  const args = readArgs();
  const settings: LoadEnv = {
    LOAD_PROFILE: args.profile,
    LOAD_TIME_SCALE: args["time-scale"],
    LOAD_TOKENS_PER_SECOND: args["tokens-per-second"],
  };
  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const results = createResults(
    path.join(import.meta.dirname, "results", `${stamp}-${args.label}`),
  );

  const database = await testDatabaseOrSkip("load");
  if (!database)
    throw new Error("The load needs Postgres: start it with docker-compose.");
  const redis = await loadRedis();
  const dbUrl = new URL(database.url);
  const proxy = await startLatencyProxy({
    target: { host: dbUrl.hostname, port: Number(dbUrl.port || 5432) },
    delayMs: args["db-latency-ms"] / 2,
  });
  const proxiedDb = new URL(database.url);
  proxiedDb.hostname = "127.0.0.1";
  proxiedDb.port = String(proxy.port);

  let fakeSample: ProcessSample | null = null;
  const fake = startChild("fake-openai-process.ts", {
    env: { PATH: process.env.PATH ?? "", ...toLoadEnv(settings) },
    onMessage: (message) => {
      if (message.type === "fake-sample") fakeSample = message.sample;
    },
  });
  const queue = new Queue(WORK_QUEUE, { connection: redis.connect() });
  let interrupted = false;
  process.once("SIGINT", () => {
    interrupted = true;
  });

  const summaries: LevelSummary[] = [];
  try {
    const fakeUrl = await fake.ready;
    if (!fakeUrl)
      throw new Error("The fake OpenAI server didn't send its url.");
    const project = await seedProject(database.db);

    for (const runs of args.runs) {
      if (interrupted) break;
      console.log(`\n${runs} runs: starting`);
      const result = await runLevel({
        runs,
        rampMs: args["ramp-seconds"] * 1000,
        timeoutMs: args["level-timeout-minutes"] * 60_000,
        db: database.db,
        queue,
        connect: redis.connect,
        project,
        workerEnv: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          DATABASE_URL: proxiedDb.toString(),
          REDIS_URL: redis.url,
          OPENAI_API_KEY: "fake-load-key",
          OPENAI_BASE_URL: fakeUrl,
          GITHUB_APP_ID: "1",
          GITHUB_APP_PRIVATE_KEY: "fake-load-key",
          WORKER_CONCURRENCY: String(runs),
          ...toLoadEnv(settings),
        },
        workerExecArgv: args["max-heap-mb"]
          ? [`--max-old-space-size=${args["max-heap-mb"]}`]
          : [],
        fakeSample: () => fakeSample,
        onSample: (sample) => {
          results.sample(runs, sample);
          if (sample.second % 10 === 0) {
            const w = sample.worker;
            console.log(
              `  ${sample.second}s  active ${sample.active}  done ${sample.done}/${runs}` +
                (w
                  ? `  heap ${w.heapUsedMb} MB  cpu ${w.cpuPercent}%  loop p99 ${w.loopDelayMs.p99} ms`
                  : ""),
            );
          }
        },
      });
      summaries.push(summarize(result));
      results.write(args, summaries);
      console.log(
        `${runs} runs: ${result.stopReason} after ${result.durationS} s`,
      );
      if (result.stopReason !== "finished") break;
    }
  } finally {
    await queue.close();
    await fake.stop();
    await proxy.close();
    await redis.close();
    await database.drop();
  }

  console.log(`\n${summaryTable(summaries)}\n\nResults: ${results.dir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
