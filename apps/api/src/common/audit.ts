import type { Pool } from "pg";

export interface AuditWrite {
  orgId: string | null;
  actorId: string | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
}

/** Audit failure aborts the caller; pass the mutation transaction for atomicity. */
export async function writeAudit(pool: Pick<Pool, "query">, entry: AuditWrite): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_events
         (org_id, actor_id, actor_ip, actor_user_agent, action, entity_type,
          entity_id, before_state, after_state, reason, request_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.orgId,
        entry.actorId,
        entry.actorIp ?? null,
        entry.actorUserAgent ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
        entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
        entry.reason ?? null,
        entry.requestId ?? null,
        entry.idempotencyKey ?? null,
      ],
    );
  } catch (err) {
    // eslint justification: audit is append-only telemetry; throwing would
    // turn a logging outage into a full API outage.
    throw err;
  }
}
