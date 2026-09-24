/**
 * Automatic leave-balance year-open (owner decision, 2026-09-24, item (b)).
 *
 * The manual "Open <year> balances" button and the December banner
 * (apps/api/src/modules/leave/openYear.ts, wired into
 * apps/web/components/LeaveBalancesPanel.tsx) are a prompt for a human to
 * act. This is the safety net for the org that never gets clicked: once an
 * organisation's own calendar rolls into a new year (its
 * `organizations.settings->>'timezone'`, default Asia/Kolkata -- the same
 * source D-006/D-013 read), that year's leave balances open themselves,
 * calling the exact same `runOpenYear` the button does -- idempotent
 * (ON CONFLICT DO NOTHING on the leave_balances natural key), lapse-only
 * (no carry-forward), and audited, here with no human actor (`actorId:
 * null`) and `triggered_by: 'scheduled_job'` in the audit trail.
 *
 * The date gate is implicit, not a separate check: "the organisation's
 * current year" only ever becomes a new value Y once its calendar actually
 * reaches 1 January of Y, by definition of what "current year" means (see
 * `currentOrgYear`). `leave_year_open_runs` (org_id, year) then keeps this
 * from re-running for a pair it has already opened -- once per org per
 * year, not once per five-second worker tick for the rest of that year.
 */
import type { Pool } from "pg";
import { currentOrgYear, runOpenYear } from "../leave/openYear.js";

export interface LeaveYearOpenResult {
  orgsOpened: number;
}

export async function runLeaveYearOpen(pool: Pool): Promise<LeaveYearOpenResult> {
  const orgs = await pool.query("SELECT id FROM organizations WHERE status = 'ACTIVE'");
  let orgsOpened = 0;
  for (const o of orgs.rows as Array<{ id: string }>) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const year = await currentOrgYear(db, o.id);
      const already = await db.query(
        "SELECT 1 FROM leave_year_open_runs WHERE org_id = $1 AND year = $2",
        [o.id, year],
      );
      if ((already.rowCount ?? 0) > 0) {
        await db.query("COMMIT");
        continue;
      }
      const outcome = await runOpenYear(db, {
        orgId: o.id,
        year,
        actorId: null,
        triggeredBy: "scheduled_job",
      });
      await db.query(
        `INSERT INTO leave_year_open_runs (org_id, year, created, filled, skipped, total)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, year) DO NOTHING`,
        [o.id, year, outcome.created, outcome.filled, outcome.skipped, outcome.total],
      );
      await db.query("COMMIT");
      orgsOpened += 1;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      console.error(
        `Leave year open for org ${o.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      db.release();
    }
  }
  return { orgsOpened };
}
