import type { Pool } from "pg";
import type { NotificationType } from "@silverline/shared";

export interface NotifyInput {
  orgId: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
}

/** The subset of Pool and PoolClient this needs; a client has `release`. */
type Queryable = Pick<Pool, "query"> & { release?: unknown };

/**
 * Best-effort notification insert for the S5 stored-only inbox.
 *
 * Must never fail the triggering operation, so failures are swallowed
 * (logged) by design.
 *
 * Swallowing is not enough inside a transaction, and most callers pass the
 * business transaction's own client. When a statement fails there, Postgres
 * marks the whole transaction aborted: the catch below hides the error, the
 * route carries on and answers 200, and its COMMIT quietly becomes a
 * ROLLBACK -- the assignment, the approval, whatever the notification was
 * about, gone, with a success on the screen. So on a client the insert runs
 * under a savepoint, and a failure rolls back to it: the notification is
 * lost, which is what best-effort means, and nothing else is.
 */
export async function emitNotification(
  db: Queryable,
  n: NotifyInput,
): Promise<void> {
  // A pool hands each query to whichever connection is free, so a savepoint
  // there would guard nothing; and a pool query is its own transaction, so
  // a failure cannot abort anybody else's.
  const onClient = typeof db.release === "function";
  let saved = false;
  if (onClient) {
    try {
      await db.query("SAVEPOINT sl_emit_notification");
      saved = true;
    } catch {
      // Not in a transaction block: the insert below is then its own
      // statement, and its failure touches nothing else.
    }
  }
  try {
    await db.query(
      `INSERT INTO notifications
         (org_id, recipient_id, type, title, body, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        n.orgId,
        n.recipientId,
        n.type,
        n.title,
        n.body,
        n.entityType ?? null,
        n.entityId ?? null,
      ],
    );
    if (saved) await db.query("RELEASE SAVEPOINT sl_emit_notification");
  } catch (err) {
    if (saved) {
      // Undo the failed insert and nothing before it, so the transaction is
      // usable again and the caller's COMMIT commits.
      await db.query("ROLLBACK TO SAVEPOINT sl_emit_notification");
      await db.query("RELEASE SAVEPOINT sl_emit_notification");
    }
    console.error(
      `Notification insert failed (${n.type}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
