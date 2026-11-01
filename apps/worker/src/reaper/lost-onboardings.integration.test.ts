import {
  findOnboarding,
  insertOnboardingEvent,
  markOnboardingStarted,
  markOnboardingWaiting,
  onboardings,
  createOnboarding,
  type Db,
} from "@hobai/db";
import { insertProject, testDatabaseOrSkip } from "@hobai/db/testing";
import { WORK_QUEUE, type OnboardingEvent } from "@hobai/shared";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createEventWriter,
  dbEventRows,
  type Publisher,
} from "../events/event-writer.js";
import { testRedisOrSkip } from "../testing/test-redis.js";
import { failLostOnboardings } from "./lost-onboardings.js";
import { QUEUED_GRACE_MS } from "./lost-runs.js";

const database = await testDatabaseOrSkip("lost setups");
const redis = await testRedisOrSkip("lost setups");

describe.skipIf(!database || !redis)(
  "lost setups against Postgres and Redis",
  () => {
    const db = database?.db as Db;
    const { prefix, connect } = redis!;
    const queue = new Queue(WORK_QUEUE, { connection: connect(), prefix });
    const published: { channel: string; event: OnboardingEvent }[] = [];
    const publisher: Publisher = {
      async publish(channel, message) {
        published.push({
          channel,
          event: JSON.parse(message) as OnboardingEvent,
        });
        return 1;
      },
    };
    const deps = {
      db,
      queue,
      events: createEventWriter({ store: dbEventRows(db), publisher }),
      log: () => {},
    };

    afterAll(async () => {
      await queue.close();
      await redis?.close();
      await database?.drop();
    });

    async function setup() {
      const project = await insertProject(db);
      const { onboarding } = await createOnboarding(db, {
        projectId: project.id,
        userId: project.userId,
      });
      return onboarding.id;
    }

    it("fails a setup that no worker holds, after its last event", async () => {
      const onboardingId = await setup();
      await markOnboardingStarted(db, onboardingId);
      await markOnboardingWaiting(db, onboardingId, "q1");
      await insertOnboardingEvent(db, { onboardingId, seq: 1, type: "info" });

      const failed = await failLostOnboardings(deps);

      expect(failed).toContainEqual({ onboardingId, code: "worker_lost" });
      expect(await findOnboarding(db, onboardingId)).toMatchObject({
        status: "failed",
        errorCode: "worker_lost",
        openQuestionId: null,
      });
      expect(
        published
          .filter((p) => p.channel === `onboarding:${onboardingId}`)
          .map((p) => p.event),
      ).toMatchObject([
        { type: "error", seq: 2, code: "worker_lost", onboardingId },
        { type: "done", seq: 3, status: "failed", onboardingId },
      ]);
    });

    it("leaves a setup whose worker is alive", async () => {
      const onboardingId = await setup();
      await markOnboardingStarted(db, onboardingId);
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
        await queue.add(
          "onboard-project",
          { onboardingId },
          { jobId: onboardingId },
        );
        await holding;

        const failed = await failLostOnboardings(deps);

        expect(failed.map((l) => l.onboardingId)).not.toContain(onboardingId);
        expect((await findOnboarding(db, onboardingId))?.status).toBe(
          "running",
        );
      } finally {
        release?.();
        await worker.close();
      }
    });

    it("fails a setup queued long ago whose queue item is gone, but not a recent one", async () => {
      const old = await setup();
      await db
        .update(onboardings)
        .set({ queuedAt: new Date(Date.now() - QUEUED_GRACE_MS - 60_000) })
        .where(eq(onboardings.id, old));
      const recent = await setup();

      const failed = await failLostOnboardings(deps);

      expect(failed).toContainEqual({
        onboardingId: old,
        code: "lost_in_queue",
      });
      expect(failed.map((l) => l.onboardingId)).not.toContain(recent);
      expect((await findOnboarding(db, recent))?.status).toBe("queued");
    });
  },
);
