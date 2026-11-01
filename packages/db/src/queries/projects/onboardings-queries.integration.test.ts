import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../client.js";
import { projects } from "../../schema/projects/projects-schema.js";
import { insertProject, testDatabaseOrSkip } from "../../testing/index.js";
import { DbEnvironmentStore } from "./environments-queries.js";
import {
  cancelQueuedOnboarding,
  findLatestOnboarding,
  findOnboarding,
  findOnboardingEventsAfter,
  findOnboardingQuestion,
  findUserOnboarding,
  getLastOnboardingEventSeq,
  insertOnboardingEvent,
  insertOnboardingEvents,
  listUnfinishedOnboardings,
  markOnboardingEnded,
  markOnboardingResumed,
  markOnboardingStarted,
  markOnboardingWaiting,
  createOnboarding,
} from "./onboardings-queries.js";

const database = await testDatabaseOrSkip("onboardings queries");

describe.skipIf(!database)("onboardings queries against Postgres", () => {
  const db = database?.db as Db;
  afterAll(() => database?.drop());

  async function started() {
    const project = await insertProject(db);
    const { onboarding } = await createOnboarding(db, {
      projectId: project.id,
      userId: project.userId,
    });
    return { project, onboarding };
  }

  it("starts one setup per project at a time", async () => {
    const { project, onboarding } = await started();
    expect(onboarding).toMatchObject({
      projectId: project.id,
      createdByUserId: project.userId,
      status: "queued",
    });

    const again = await createOnboarding(db, {
      projectId: project.id,
      userId: project.userId,
    });
    expect(again).toEqual({ onboarding, created: false });
  });

  it("allows a new setup once the last one ended", async () => {
    const { project, onboarding } = await started();
    await markOnboardingEnded(db, onboarding.id, { status: "failed" });

    const next = await createOnboarding(db, {
      projectId: project.id,
      userId: project.userId,
    });
    expect(next.created).toBe(true);
    expect(next.onboarding.id).not.toBe(onboarding.id);
    expect(await findLatestOnboarding(db, project.id)).toMatchObject({
      id: next.onboarding.id,
    });
  });

  it("follows a setup from start to a saved environment", async () => {
    const { project, onboarding } = await started();

    expect(await markOnboardingStarted(db, onboarding.id)).toBe(true);
    expect(await markOnboardingStarted(db, onboarding.id)).toBe(false);

    await markOnboardingWaiting(db, onboarding.id, "q1");
    expect(await findOnboarding(db, onboarding.id)).toMatchObject({
      status: "waiting",
      openQuestionId: "q1",
    });
    await markOnboardingResumed(db, onboarding.id);
    expect(await findOnboarding(db, onboarding.id)).toMatchObject({
      status: "running",
      openQuestionId: null,
    });

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
    expect(
      await markOnboardingEnded(db, onboarding.id, {
        status: "succeeded",
        environmentId: environment.id,
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: "0.0123",
      }),
    ).toBe(true);
    const ended = await findOnboarding(db, onboarding.id);
    expect(ended).toMatchObject({
      status: "succeeded",
      environmentId: environment.id,
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: "0.0123",
    });
    expect(ended?.startedAt).toBeInstanceOf(Date);
    expect(ended?.finishedAt).toBeInstanceOf(Date);
    expect(
      await markOnboardingEnded(db, onboarding.id, { status: "failed" }),
    ).toBe(false);
  });

  it("cancels only a setup that hasn't started", async () => {
    const queued = await started();
    expect(await cancelQueuedOnboarding(db, queued.onboarding.id)).toBe(true);
    expect(await findOnboarding(db, queued.onboarding.id)).toMatchObject({
      status: "cancelled",
    });

    const running = await started();
    await markOnboardingStarted(db, running.onboarding.id);
    expect(await cancelQueuedOnboarding(db, running.onboarding.id)).toBe(false);
  });

  it("lists setups still in progress", async () => {
    const { onboarding } = await started();
    const ids = (await listUnfinishedOnboardings(db)).map((o) => o.id);
    expect(ids).toContain(onboarding.id);

    await markOnboardingEnded(db, onboarding.id, { status: "cancelled" });
    expect(
      (await listUnfinishedOnboardings(db)).map((o) => o.id),
    ).not.toContain(onboarding.id);
  });

  it("finds a setup only for its project's owner", async () => {
    const { project, onboarding } = await started();

    expect(
      await findUserOnboarding(db, project.userId, project.id),
    ).toMatchObject({ id: onboarding.id, environmentVersion: null });
    expect(await findUserOnboarding(db, randomUUID(), project.id)).toBeNull();
  });

  it("keeps events in order and refuses a repeated seq", async () => {
    const { onboarding } = await started();
    expect(await getLastOnboardingEventSeq(db, onboarding.id)).toBe(0);

    for (const seq of [1, 2, 3]) {
      await insertOnboardingEvent(db, {
        onboardingId: onboarding.id,
        seq,
        type: "info",
        payload: { message: `step ${seq}` },
      });
    }
    expect(await getLastOnboardingEventSeq(db, onboarding.id)).toBe(3);
    expect(
      (await findOnboardingEventsAfter(db, onboarding.id, 1, 10)).map(
        (event) => event.seq,
      ),
    ).toEqual([2, 3]);
    await expect(
      insertOnboardingEvent(db, {
        onboardingId: onboarding.id,
        seq: 2,
        type: "info",
      }),
    ).rejects.toThrow();
  });

  it("inserts many events at once, leaving a number already stored as it is", async () => {
    const { onboarding } = await started();
    await insertOnboardingEvent(db, {
      onboardingId: onboarding.id,
      seq: 1,
      type: "info",
      payload: { message: "first" },
    });

    await insertOnboardingEvents(db, [
      {
        onboardingId: onboarding.id,
        seq: 1,
        type: "info",
        payload: { message: "again" },
      },
      { onboardingId: onboarding.id, seq: 2, type: "done" },
    ]);
    await insertOnboardingEvents(db, []);

    expect(
      (await findOnboardingEventsAfter(db, onboarding.id, 0, 10)).map((e) => [
        e.seq,
        e.payload,
      ]),
    ).toEqual([
      [1, { message: "first" }],
      [2, {}],
    ]);
  });

  it("goes away with its project", async () => {
    const { project, onboarding } = await started();
    await insertOnboardingEvent(db, {
      onboardingId: onboarding.id,
      seq: 1,
      type: "info",
    });

    await db.delete(projects).where(eq(projects.id, project.id));

    expect(await findOnboarding(db, onboarding.id)).toBeNull();
    expect(await findOnboardingEventsAfter(db, onboarding.id, 0, 10)).toEqual(
      [],
    );
  });

  it("gives the latest setup the version it saved", async () => {
    const { project, onboarding } = await started();
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
    await markOnboardingEnded(db, onboarding.id, {
      status: "succeeded",
      environmentId: environment.id,
    });

    expect(
      await findUserOnboarding(db, project.userId, project.id),
    ).toMatchObject({ id: onboarding.id, environmentVersion: 1 });
  });

  it("finds a stored question by its id", async () => {
    const { onboarding } = await started();
    const question = {
      questionId: "q-1",
      question: "Backend tests need PostgreSQL. What should I do?",
      options: [{ label: "Skip them" }, { label: "Keep them" }],
      allowOther: true,
    };
    await insertOnboardingEvent(db, {
      onboardingId: onboarding.id,
      seq: 1,
      type: "question_asked",
      payload: question,
    });

    expect(await findOnboardingQuestion(db, onboarding.id, "q-1")).toEqual(
      question,
    );
    expect(await findOnboardingQuestion(db, onboarding.id, "q-2")).toBeNull();
  });
});
