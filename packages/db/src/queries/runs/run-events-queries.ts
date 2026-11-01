import { and, asc, eq, gt, max } from "drizzle-orm";
import type { Db } from "../../client.js";
import { runEvents } from "../../schema/runs/run-events-schema.js";

export type NewRunEvent = typeof runEvents.$inferInsert;

export async function insertRunEvent(db: Db, event: NewRunEvent) {
  await db.insert(runEvents).values(event);
}

/** A row already stored (same run and number) is left as it is, so a write can be retried. */
export async function insertRunEvents(db: Db, events: NewRunEvent[]) {
  if (events.length === 0) return;
  await db.insert(runEvents).values(events).onConflictDoNothing();
}

export async function getLastRunEventSeq(db: Db, runId: string) {
  const [row] = await db
    .select({ seq: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  return row?.seq ?? 0;
}

export async function findRunEventsAfter(
  db: Db,
  runId: string,
  afterSeq: number,
  limit: number,
) {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
}
