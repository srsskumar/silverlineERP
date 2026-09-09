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

/**
 * Best-effort notification insert for the S5 stored-only inbox.
 * Must never fail the triggering operation, so failures are swallowed
 * (logged) by design — same rationale as writeAudit.
 */
export async function emitNotification(
  pool: Pool,
  n: NotifyInput,
): Promise<void> {
  try {
    await pool.query(
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
  } catch (err) {
    console.error("Notification insert failed");
  }
}
