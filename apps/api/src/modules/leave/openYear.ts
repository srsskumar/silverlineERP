/**
 * The bulk leave-balance year-open action (R5-008), factored out so the
 * manual admin endpoint and the automatic 1-January scheduled job (owner
 * decision, 2026-09-24, item (b)) call exactly the same logic -- one
 * implementation of "what does opening a year mean", not two that could
 * quietly drift apart.
 */
import type { Pool } from "pg";
import { writeAudit } from "../../common/audit.js";
import { orgTodaySql } from "../../common/orgTime.js";

/**
 * The organisation's current calendar year, in its own timezone --
 * `organizations.settings->>'timezone'` (default Asia/Kolkata), the same
 * source D-006/D-013 read via `orgTodaySql`/`orgZoneSql`.
 */
export async function currentOrgYear(db: Pick<Pool, "query">, orgId: string): Promise<number> {
  const res = await db.query(
    `SELECT EXTRACT(YEAR FROM ${orgTodaySql("$1")})::int AS year`,
    [orgId],
  );
  return Number((res.rows[0] as { year: number }).year);
}

interface Pair {
  employee_id: string;
  leave_type_id: string;
  annual_entitlement: string | number;
  balance_id: string | null;
  opening_balance: string | number | null;
  credits: string | number | null;
  consumed: string | number | null;
  adjustments: string | number | null;
}

interface Classified {
  toCreate: Pair[];
  toFill: Pair[];
  toSkip: Pair[];
  total: number;
}

/**
 * Every (active employee) x (balance-requiring leave type) pair in scope
 * for `year`, classified into:
 *   - toCreate: no row for this year yet.
 *   - toFill: a row exists, every ledger term is 0, and there is no
 *     `leave.balance.upsert` audit entry for it -- self-healed empty by a
 *     leave request whose share of this year came to zero days under the
 *     sandwich rule (D-012), not an admin's deliberate 0.
 *   - toSkip: a real balance, or a manually-set one (even a manual 0).
 */
async function classify(
  db: Pick<Pool, "query">,
  orgId: string,
  year: number,
  employeeIds?: string[],
  leaveTypeIds?: string[],
): Promise<Classified> {
  const values: unknown[] = [orgId, year];
  let empFilter = "";
  if (employeeIds?.length) {
    values.push(employeeIds);
    empFilter = ` AND e.id = ANY($${values.length}::uuid[])`;
  }
  let typeFilter = "";
  if (leaveTypeIds?.length) {
    values.push(leaveTypeIds);
    typeFilter = ` AND t.id = ANY($${values.length}::uuid[])`;
  }

  const pairsRes = await db.query(
    `SELECT e.id AS employee_id, t.id AS leave_type_id, t.annual_entitlement,
            b.id AS balance_id, b.opening_balance, b.credits, b.consumed, b.adjustments
     FROM employees e
     CROSS JOIN leave_types t
     LEFT JOIN leave_balances b
       ON b.employee_id = e.id AND b.leave_type_id = t.id AND b.period_year = $2
     WHERE e.org_id = $1 AND e.status = 'ACTIVE'
       AND t.org_id = $1 AND t.active = true AND t.requires_balance = true
       ${empFilter}${typeFilter}`,
    values,
  );
  const rows = pairsRes.rows as Pair[];

  const isEmptyRow = (r: Pair): boolean =>
    r.balance_id !== null &&
    Number(r.opening_balance) === 0 &&
    Number(r.credits) === 0 &&
    Number(r.consumed) === 0 &&
    Number(r.adjustments) === 0;

  const toCreate = rows.filter((r) => r.balance_id === null);
  const emptyRows = rows.filter(isEmptyRow);
  let manuallyTouched = new Set<string>();
  if (emptyRows.length) {
    const auditRes = await db.query(
      `SELECT DISTINCT entity_id FROM audit_events
       WHERE entity_type = 'leave_balance' AND action = 'leave.balance.upsert'
         AND entity_id = ANY($1::uuid[])`,
      [emptyRows.map((r) => r.balance_id as string)],
    );
    manuallyTouched = new Set(
      (auditRes.rows as Array<{ entity_id: string }>).map((r) => r.entity_id),
    );
  }
  const toFill = emptyRows.filter((r) => !manuallyTouched.has(r.balance_id as string));
  const toFillIds = new Set(toFill.map((r) => r.balance_id));
  const toSkip = rows.filter((r) => r.balance_id !== null && !toFillIds.has(r.balance_id));
  return { toCreate, toFill, toSkip, total: rows.length };
}

export interface OpenYearPreview {
  year: number;
  created: number;
  filled: number;
  skipped: number;
  total: number;
  dry_run: true;
}

/** The counts a real run would produce, without writing anything. */
export async function previewOpenYear(
  db: Pick<Pool, "query">,
  orgId: string,
  year: number,
  employeeIds?: string[],
  leaveTypeIds?: string[],
): Promise<OpenYearPreview> {
  const c = await classify(db, orgId, year, employeeIds, leaveTypeIds);
  return {
    year,
    created: c.toCreate.length,
    filled: c.toFill.length,
    skipped: c.toSkip.length,
    total: c.total,
    dry_run: true,
  };
}

export interface OpenYearParams {
  orgId: string;
  year: number;
  employeeIds?: string[];
  leaveTypeIds?: string[];
  /** null for the scheduled job -- audited with no human actor. */
  actorId: string | null;
  impersonatorId?: string | null;
  actorIp?: string | null;
  actorUserAgent?: string | null;
  requestId?: string | null;
  triggeredBy: "manual" | "scheduled_job";
}

export interface OpenYearOutcome {
  year: number;
  created: number;
  filled: number;
  skipped: number;
  total: number;
  dry_run: false;
}

/** Owner decision (2026-09-24): carry-forward is out of scope -- every row
 * opens at the leave type's plain annual_entitlement, nothing brought over
 * from the year before. Unused balance simply lapses. */
export async function runOpenYear(
  db: Pick<Pool, "query">,
  params: OpenYearParams,
): Promise<OpenYearOutcome> {
  const c = await classify(db, params.orgId, params.year, params.employeeIds, params.leaveTypeIds);

  let created = 0;
  for (const r of c.toCreate) {
    const ins = await db.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, period_year, opening_balance)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       ON CONFLICT (employee_id, leave_type_id, period_year) DO NOTHING
       RETURNING id`,
      [r.employee_id, r.leave_type_id, params.year, r.annual_entitlement],
    );
    if ((ins.rowCount ?? 0) > 0) created += 1;
  }

  let filled = 0;
  for (const r of c.toFill) {
    // Re-checked in the WHERE, not just the SELECT above: still empty right
    // now, under this same transaction.
    const upd = await db.query(
      `UPDATE leave_balances SET opening_balance = $2, updated_at = NOW()
       WHERE id = $1::uuid AND opening_balance = 0 AND credits = 0
         AND consumed = 0 AND adjustments = 0`,
      [r.balance_id, r.annual_entitlement],
    );
    if ((upd.rowCount ?? 0) > 0) {
      filled += 1;
      await writeAudit(db, {
        orgId: params.orgId,
        actorId: params.actorId,
        impersonatorId: params.impersonatorId ?? null,
        actorIp: params.actorIp ?? null,
        actorUserAgent: params.actorUserAgent ?? null,
        action: "leave.balance.open_year_fill",
        entityType: "leave_balance",
        entityId: r.balance_id,
        afterState: {
          opening_balance: Number(r.annual_entitlement),
          year: params.year,
          triggered_by: params.triggeredBy,
        },
        requestId: params.requestId ?? null,
      });
    }
  }

  const skipped = c.total - created - filled;
  const body: OpenYearOutcome = {
    year: params.year,
    created,
    filled,
    skipped,
    total: c.total,
    dry_run: false,
  };
  await writeAudit(db, {
    orgId: params.orgId,
    actorId: params.actorId,
    impersonatorId: params.impersonatorId ?? null,
    actorIp: params.actorIp ?? null,
    actorUserAgent: params.actorUserAgent ?? null,
    action: "leave.balance.open_year",
    entityType: "leave_balance",
    entityId: null,
    afterState: { ...body, triggered_by: params.triggeredBy },
    requestId: params.requestId ?? null,
  });
  return body;
}
