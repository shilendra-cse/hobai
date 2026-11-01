import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../../client.js";
import { projects } from "../../schema/projects/projects-schema.js";
import { runs } from "../../schema/runs/runs-schema.js";
import { tasks } from "../../schema/tasks/tasks-schema.js";

type Run = typeof runs.$inferSelect;

export type RunProgress = Partial<Pick<Run, "stage" | "sandboxId">>;

export type RunOutcome = Pick<Run, "status"> &
  Partial<
    Pick<
      Run,
      | "summary"
      | "inputTokens"
      | "outputTokens"
      | "steps"
      | "costUsd"
      | "checksPassed"
      | "commitSha"
      | "errorCode"
      | "errorMessage"
    >
  >;

export async function getRunWithProject(db: Db, runId: string) {
  return (
    (await db.query.runs.findFirst({
      where: eq(runs.id, runId),
      with: { task: { with: { project: true } } },
    })) ?? null
  );
}

/** False when the run isn't queued. */
export async function markRunStarted(
  db: Db,
  runId: string,
  environmentId: string,
) {
  const started = await db
    .update(runs)
    .set({ status: "running", startedAt: new Date(), environmentId })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")))
    .returning({ id: runs.id });
  return started.length > 0;
}

export async function updateRunProgress(
  db: Db,
  runId: string,
  progress: RunProgress,
) {
  await db.update(runs).set(progress).where(eq(runs.id, runId));
}

/** False when the run's status isn't one of `from` (e.g. it was already ended). */
export async function markRunEnded(
  db: Db,
  runId: string,
  outcome: RunOutcome,
  from: Run["status"][],
) {
  const ended = await db
    .update(runs)
    .set({ ...outcome, finishedAt: new Date() })
    .where(and(eq(runs.id, runId), inArray(runs.status, from)))
    .returning({ id: runs.id });
  return ended.length > 0;
}

export async function listUnfinishedRuns(db: Db) {
  return db
    .select({
      id: runs.id,
      status: runs.status,
      queuedAt: runs.queuedAt,
      sandboxId: runs.sandboxId,
    })
    .from(runs)
    .where(inArray(runs.status, ["queued", "running"]));
}

export async function listEndedRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({ id: runs.id, status: runs.status, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(inArray(runs.id, runIds), isNotNull(runs.finishedAt)));
}

export async function findUserRun(db: Db, userId: string, runId: string) {
  const ownedTaskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(projects.userId, userId));
  return (
    (await db.query.runs.findFirst({
      where: and(eq(runs.id, runId), inArray(runs.taskId, ownedTaskIds)),
      with: { diff: { columns: { files: true, truncated: true } } },
    })) ?? null
  );
}

export type UserRun = NonNullable<Awaited<ReturnType<typeof findUserRun>>>;
