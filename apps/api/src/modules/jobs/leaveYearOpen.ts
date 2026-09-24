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
 * Date gate (fix round 2, item 2, controller ruling): runs for year Y only
 * while the org-timezone date is between 1 and 31 January of Y, inclusive.
 * Round 1 reasoned the gate was implicit in "current year only ever becomes
 * Y once the calendar reaches 1 January of Y" -- true, but incomplete: it
 * said nothing about *when this code first runs*. Deploying in September
 * makes 2026 the org's "current year" immediately, and without an explicit
 * window this job would open 2026 for every org on its very first tick
 * after deploy, months early, for any org nobody had opened it for by hand.
 * Outside 1-31 January it is a deliberate no-op; a mid-year org, or one
 * created outside that window, is the manual button's job, not this one's.
 * `leave_year_open_runs` (org_id, year) still does the *within-window*
 * idempotency -- opened once in that January, not once per worker tick for
 * the rest of it.
 */
import type { Pool } from "pg";
import { orgTodaySql } from "../../common/orgTime.js";
import { runOpenYear } from "../leave/openYear.js";

export interface LeaveYearOpenResult {
  orgsOpened: number;
}

export interface OrgYearMonth {
  year: number;
  month: number;
}

/** The organisation's current (year, month), in its own timezone. */
async function currentOrgYearMonth(
  db: Pick<Pool, "query">,
  orgId: string,
): Promise<OrgYearMonth> {
  const res = await db.query(
    `SELECT EXTRACT(YEAR FROM ${orgTodaySql("$1")})::int AS year,
            EXTRACT(MONTH FROM ${orgTodaySql("$1")})::int AS month`,
    [orgId],
  );
  const row = res.rows[0] as { year: number; month: number };
  return { year: Number(row.year), month: Number(row.month) };
}

export interface RunLeaveYearOpenOptions {
  /**
   * Test-only override for "what is this org's current (year, month)":
   * production never passes this and gets the real org-timezone clock via
   * `currentOrgYearMonth`. The date gate below cannot otherwise be tested
   * outside whatever month the suite happens to run in -- there is no way
   * to fake Postgres's own `now()` from a test.
   */
  resolveOrgDate?: (db: Pick<Pool, "query">, orgId: string) => Promise<OrgYearMonth>;
}

export async function runLeaveYearOpen(
  pool: Pool,
  opts: RunLeaveYearOpenOptions = {},
): Promise<LeaveYearOpenResult> {
  const resolveOrgDate = opts.resolveOrgDate ?? currentOrgYearMonth;
  const orgs = await pool.query("SELECT id FROM organizations WHERE status = 'ACTIVE'");
  let orgsOpened = 0;
  for (const o of orgs.rows as Array<{ id: string }>) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { year, month } = await resolveOrgDate(db, o.id);
      // The date gate: outside January, do nothing at all for this org.
      if (month !== 1) {
        await db.query("COMMIT");
        continue;
      }
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
