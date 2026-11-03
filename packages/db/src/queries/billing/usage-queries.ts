import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sum,
} from "drizzle-orm";
import type { Db, DbOrTx } from "../../client.js";
import { onboardings } from "../../schema/projects/onboardings-schema.js";
import { runs } from "../../schema/runs/runs-schema.js";
import { tasks } from "../../schema/tasks/tasks-schema.js";
import type { Cycle } from "./cycle.js";

/** Runs that failed through hobai's fault, not the user's or the agent's: they don't count. */
export const PLATFORM_FAILURE_CODES = [
  "queue_unavailable",
  "worker_error",
  "worker_lost",
  "stalled",
  "checkout_failed",
  "sandbox_failed",
  "sandbox_busy",
];

/** The user's task runs in the cycle that count toward their plan's limit. */
export async function countCycleRuns(db: DbOrTx, userId: string, cycle: Cycle) {
  const [row] = await db
    .select({ value: count() })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(tasks.createdByUserId, userId),
        gte(runs.queuedAt, cycle.start),
        lt(runs.queuedAt, cycle.end),
        or(
          ne(runs.status, "failed"),
          isNull(runs.errorCode),
          notInArray(runs.errorCode, PLATFORM_FAILURE_CODES),
        ),
      ),
    );
  return row?.value ?? 0;
}

/** The user's task runs that are queued or running. */
export async function countActiveRuns(db: DbOrTx, userId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(tasks.createdByUserId, userId),
        inArray(runs.status, ["queued", "running"]),
      ),
    );
  return row?.value ?? 0;
}

/** Model cost in USD of every run and setup queued since the start of today (UTC), for all users. */
export async function spendToday(db: Db, now = new Date()) {
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const [[fromRuns], [fromSetups]] = await Promise.all([
    db
      .select({ value: sum(runs.costUsd) })
      .from(runs)
      .where(gte(runs.queuedAt, since)),
    db
      .select({ value: sum(onboardings.costUsd) })
      .from(onboardings)
      .where(gte(onboardings.queuedAt, since)),
  ]);
  return Number(fromRuns?.value ?? 0) + Number(fromSetups?.value ?? 0);
}
