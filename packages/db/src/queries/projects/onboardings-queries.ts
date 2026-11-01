import { and, asc, desc, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { Db } from "../../client.js";
import { onboardingEvents } from "../../schema/projects/onboarding-events-schema.js";
import { onboardings } from "../../schema/projects/onboardings-schema.js";
import { projectEnvironments } from "../../schema/projects/project-environments-schema.js";
import { projects } from "../../schema/projects/projects-schema.js";

export type Onboarding = typeof onboardings.$inferSelect;
type Status = Onboarding["status"];

export const ACTIVE_ONBOARDING: Status[] = ["queued", "running", "waiting"];

export type OnboardingOutcome = Pick<Onboarding, "status"> &
  Partial<
    Pick<
      Onboarding,
      | "errorCode"
      | "errorMessage"
      | "environmentId"
      | "inputTokens"
      | "outputTokens"
      | "costUsd"
    >
  >;

async function findActiveOnboarding(db: Db, projectId: string) {
  const [row] = await db
    .select()
    .from(onboardings)
    .where(
      and(
        eq(onboardings.projectId, projectId),
        inArray(onboardings.status, ACTIVE_ONBOARDING),
      ),
    );
  return row ?? null;
}

/** A new queued setup, or the one already active (`created: false`). */
export async function createOnboarding(
  db: Db,
  values: { projectId: string; userId: string },
) {
  // Two tries: the active setup can end between a refused insert and the read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [created] = await db
      .insert(onboardings)
      .values({ projectId: values.projectId, createdByUserId: values.userId })
      .onConflictDoNothing()
      .returning();
    if (created) return { onboarding: created, created: true };
    const active = await findActiveOnboarding(db, values.projectId);
    if (active) return { onboarding: active, created: false };
  }
  throw new Error(`Couldn't start a setup for project ${values.projectId}.`);
}

export async function findOnboarding(db: Db, onboardingId: string) {
  const [row] = await db
    .select()
    .from(onboardings)
    .where(eq(onboardings.id, onboardingId));
  return row ?? null;
}

export async function findLatestOnboarding(db: Db, projectId: string) {
  const [row] = await db
    .select()
    .from(onboardings)
    .where(eq(onboardings.projectId, projectId))
    .orderBy(desc(onboardings.queuedAt))
    .limit(1);
  return row ?? null;
}

/** The latest setup of one of the user's projects, with the version it saved. */
export async function findUserOnboarding(
  db: Db,
  userId: string,
  projectId: string,
) {
  const [row] = await db
    .select({
      onboarding: onboardings,
      environmentVersion: projectEnvironments.version,
    })
    .from(onboardings)
    .innerJoin(projects, eq(onboardings.projectId, projects.id))
    .leftJoin(
      projectEnvironments,
      eq(onboardings.environmentId, projectEnvironments.id),
    )
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .orderBy(desc(onboardings.queuedAt))
    .limit(1);
  return row
    ? { ...row.onboarding, environmentVersion: row.environmentVersion }
    : null;
}

export type UserOnboarding = NonNullable<
  Awaited<ReturnType<typeof findUserOnboarding>>
>;

/** The stored `question_asked` event of one question, or null. */
export async function findOnboardingQuestion(
  db: Db,
  onboardingId: string,
  questionId: string,
) {
  const [row] = await db
    .select({ payload: onboardingEvents.payload })
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.onboardingId, onboardingId),
        eq(onboardingEvents.type, "question_asked"),
        sql`${onboardingEvents.payload}->>'questionId' = ${questionId}`,
      ),
    )
    .limit(1);
  return row?.payload ?? null;
}

/** False when the setup isn't queued (e.g. it was cancelled first). */
export async function markOnboardingStarted(db: Db, onboardingId: string) {
  const started = await db
    .update(onboardings)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(eq(onboardings.id, onboardingId), eq(onboardings.status, "queued")),
    )
    .returning({ id: onboardings.id });
  return started.length > 0;
}

export async function markOnboardingWaiting(
  db: Db,
  onboardingId: string,
  questionId: string,
) {
  await db
    .update(onboardings)
    .set({ status: "waiting", openQuestionId: questionId })
    .where(
      and(eq(onboardings.id, onboardingId), eq(onboardings.status, "running")),
    );
}

export async function markOnboardingResumed(db: Db, onboardingId: string) {
  await db
    .update(onboardings)
    .set({ status: "running", openQuestionId: null })
    .where(
      and(eq(onboardings.id, onboardingId), eq(onboardings.status, "waiting")),
    );
}

/** False when the setup had already ended. */
export async function markOnboardingEnded(
  db: Db,
  onboardingId: string,
  outcome: OnboardingOutcome,
) {
  const ended = await db
    .update(onboardings)
    .set({ ...outcome, openQuestionId: null, finishedAt: new Date() })
    .where(
      and(
        eq(onboardings.id, onboardingId),
        inArray(onboardings.status, ACTIVE_ONBOARDING),
      ),
    )
    .returning({ id: onboardings.id });
  return ended.length > 0;
}

/** Cancels only a setup the worker hasn't picked up; false otherwise. */
export async function cancelQueuedOnboarding(db: Db, onboardingId: string) {
  const cancelled = await db
    .update(onboardings)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(
      and(eq(onboardings.id, onboardingId), eq(onboardings.status, "queued")),
    )
    .returning({ id: onboardings.id });
  return cancelled.length > 0;
}

export async function listUnfinishedOnboardings(db: Db) {
  return db
    .select({
      id: onboardings.id,
      projectId: onboardings.projectId,
      status: onboardings.status,
      queuedAt: onboardings.queuedAt,
    })
    .from(onboardings)
    .where(inArray(onboardings.status, ACTIVE_ONBOARDING));
}

export type NewOnboardingEvent = typeof onboardingEvents.$inferInsert;

export async function insertOnboardingEvent(db: Db, event: NewOnboardingEvent) {
  await db.insert(onboardingEvents).values(event);
}

/** A row already stored (same setup and number) is left as it is, so a write can be retried. */
export async function insertOnboardingEvents(
  db: Db,
  events: NewOnboardingEvent[],
) {
  if (events.length === 0) return;
  await db.insert(onboardingEvents).values(events).onConflictDoNothing();
}

export async function getLastOnboardingEventSeq(db: Db, onboardingId: string) {
  const [row] = await db
    .select({ seq: max(onboardingEvents.seq) })
    .from(onboardingEvents)
    .where(eq(onboardingEvents.onboardingId, onboardingId));
  return row?.seq ?? 0;
}

export async function findOnboardingEventsAfter(
  db: Db,
  onboardingId: string,
  afterSeq: number,
  limit: number,
) {
  return db
    .select()
    .from(onboardingEvents)
    .where(
      and(
        eq(onboardingEvents.onboardingId, onboardingId),
        gt(onboardingEvents.seq, afterSeq),
      ),
    )
    .orderBy(asc(onboardingEvents.seq))
    .limit(limit);
}
