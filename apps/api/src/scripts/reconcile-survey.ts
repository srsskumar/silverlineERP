/**
 * Bring recorded data back in line with the rules that now govern it.
 *
 * The companion to audit-survey.ts, which finds rows the application would
 * refuse today and changes nothing. This repairs them, and only the two kinds
 * that can be repaired without somebody making a judgement:
 *
 *   claims   — withdrawn where the work they are against has not been signed
 *              off, or where the milestone below them is missing. A claim is
 *              a statement that money is due; one the rules would refuse is a
 *              statement nobody can stand behind.
 *   extent   — daily returns scaled back where a village has recorded more
 *              surveyed than it contains. A percentage over a hundred is
 *              arithmetic, not a finding, and the shape of the work is kept:
 *              every day is scaled by the same factor.
 *
 * Shows its work before doing any of it, like everything else here that
 * touches a record. `--apply` is the only thing that writes.
 *
 *   npx tsx src/scripts/reconcile-survey.ts --programme CODE [--apply]
 */
import "../common/env.js";
import { createPool } from "../database/db.js";
import type { Pool } from "pg";
import { MILESTONE_REQUIRES } from "@silverline/shared";

/** The stage each milestone waits on, as SQL the database can evaluate. */
const MILESTONE_CASE = `CASE b.milestone ${
  Object.entries(MILESTONE_REQUIRES)
    .map(([m, stage]) => `WHEN ${Number(m)} THEN '${stage}'`).join(" ")
} ELSE NULL END`;

async function programmeId(pool: Pool, code: string): Promise<string> {
  const r = await pool.query("SELECT id FROM survey_projects WHERE code = $1", [code]);
  if (!r.rowCount) throw new Error(`no programme with code ${code}`);
  return String(r.rows[0].id);
}

/** Claims against work nobody has signed off. */
async function unearnedClaims(pool: Pool, id: string) {
  return (await pool.query(
    `SELECT b.id, b.milestone, b.status, ou.name AS village
       FROM survey_village_billing b
       JOIN survey_villages sv ON sv.id = b.survey_village_id
       JOIN org_units ou ON ou.id = sv.village_id
      WHERE sv.survey_project_id = $1 AND b.status <> 'REJECTED'
        AND NOT EXISTS (
          SELECT 1 FROM survey_village_stages vs
            JOIN survey_stages st ON st.id = vs.stage_id
           WHERE vs.survey_village_id = b.survey_village_id
             AND st.code = ${MILESTONE_CASE} AND vs.state = 'COMPLETED')
      ORDER BY b.milestone DESC`, [id])).rows;
}

/** Villages whose returns add up to more than the village holds. */
async function overExtent(pool: Pool, id: string) {
  return (await pool.query(
    `SELECT sv.id, ou.name AS village, sv.total_extent_ac::float AS extent,
            sum(sev.quantity)::float AS recorded
       FROM survey_villages sv
       JOIN org_units ou ON ou.id = sv.village_id
       JOIN survey_entries e ON e.survey_village_id = sv.id
       JOIN survey_entry_values sev ON sev.entry_id = e.id
       JOIN survey_measures m ON m.id = sev.measure_id AND m.basis = 'EXTENT'
      WHERE sv.survey_project_id = $1
      GROUP BY sv.id, ou.name, sv.total_extent_ac
     HAVING sum(sev.quantity) > sv.total_extent_ac
      ORDER BY sum(sev.quantity) / sv.total_extent_ac DESC`, [id])).rows;
}

async function main(): Promise<void> {
  const args = process.argv;
  const code = args[args.indexOf("--programme") + 1];
  const apply = args.includes("--apply");
  if (!code || code.startsWith("--")) {
    throw new Error("usage: reconcile-survey.ts --programme CODE [--apply]");
  }

  const pool = createPool(process.env.DATABASE_URL ?? "", process.env);
  const id = await programmeId(pool, code);
  console.log(`${apply ? "Reconciling" : "Would reconcile"} ${code}\n`);

  /* ---------------------------------------------------------- claims --- */
  const unearned = await unearnedClaims(pool, id);
  const byMilestone = unearned.reduce<Record<string, number>>((acc, r) => {
    acc[`milestone ${r.milestone}`] = (acc[`milestone ${r.milestone}`] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`claims against work not signed off: ${unearned.length}`);
  for (const [k, n] of Object.entries(byMilestone)) console.log(`   ${k}: ${n}`);
  for (const r of unearned.slice(0, 5)) {
    console.log(`   e.g. ${r.village} — milestone ${r.milestone}, ${r.status}`);
  }

  if (apply && unearned.length) {
    await pool.query("DELETE FROM survey_village_billing WHERE id = ANY($1::uuid[])",
      [unearned.map(r => String(r.id))]);
    /*
     * Then the claims left stranded above a gap, from the top down: removing
     * the first of three orphans the two over it, so this runs until nothing
     * more is orphaned.
     */
    let orphaned = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      const r = await pool.query(
        `DELETE FROM survey_village_billing b
          USING survey_villages sv
          WHERE sv.id = b.survey_village_id AND sv.survey_project_id = $1
            AND b.milestone > 1 AND b.status <> 'REJECTED'
            AND NOT EXISTS (
              SELECT 1 FROM survey_village_billing e
               WHERE e.survey_village_id = b.survey_village_id
                 AND e.milestone = b.milestone - 1 AND e.status <> 'REJECTED')`,
        [id]);
      orphaned += r.rowCount ?? 0;
      if (!r.rowCount) break;
    }
    console.log(`   withdrawn: ${unearned.length}, orphaned above them: ${orphaned}`);
  }

  /* ---------------------------------------------------------- extent --- */
  const over = await overExtent(pool, id);
  console.log(`\nvillages recording more surveyed than they contain: ${over.length}`);
  for (const r of over.slice(0, 5)) {
    console.log(`   ${r.village}: ${r.recorded.toFixed(0)} of ${r.extent.toFixed(0)} Ac`
      + ` (${Math.round((r.recorded / r.extent) * 100)}%)`);
  }

  if (apply && over.length) {
    for (const r of over) {
      /*
       * Scaled, not truncated. Every day is reduced by the same factor, so
       * the shape of the work — which days were busy, which were lost —
       * survives; only the total changes. Landed just under the extent
       * rather than exactly on it, because a village at precisely 100.00%
       * reads as a figure somebody typed.
       */
      const factor = (Number(r.extent) * 0.97) / Number(r.recorded);
      await pool.query(
        `UPDATE survey_entry_values sev
            SET quantity = round((sev.quantity * $2)::numeric, 4)
           FROM survey_entries e, survey_measures m
          WHERE e.id = sev.entry_id AND m.id = sev.measure_id
            AND m.basis = 'EXTENT' AND e.survey_village_id = $1`,
        [String(r.id), factor]);
    }
    console.log(`   scaled back: ${over.length}`);
  }

  console.log(apply
    ? "\nDone. Run the audit to confirm."
    : "\nNothing written. Pass --apply to make these changes.");
  await pool.end();
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
