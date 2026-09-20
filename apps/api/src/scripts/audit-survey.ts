/**
 * Does the data obey the rules the application enforces?
 *
 * Every rule in this module is enforced at the point of writing — a claim is
 * refused, a stage cannot start, a date is rejected. None of that says
 * anything about rows already there. Rules get tightened (§078 moved the
 * third claim from submitted to accepted), data gets loaded by import, and
 * stages get corrected afterwards; each of those can leave rows behind that
 * the routes would refuse today.
 *
 * So this asks the question the routes cannot: given what is written down,
 * what could not be written now? It changes nothing. Some of what it finds
 * is deliberate — a village started without its control point is a real gap
 * the dashboard exists to show — so each finding says whether it is a fault
 * or a fact.
 *
 *   DATABASE_URL=<url> npx tsx src/scripts/audit-survey.ts [--programme CODE]
 */
import "../common/env.js";
import { createPool } from "../database/db.js";
import { MILESTONE_REQUIRES } from "@silverline/shared";

type Severity = "FAULT" | "WATCH";

interface Check {
  label: string;
  severity: Severity;
  /** What it means, and what to do, for somebody who did not write this. */
  note: string;
  sql: string;
}

/** Restricts every check to one programme when asked. */
function scope(code: string | null): string {
  return code
    ? `AND sv.survey_project_id = (SELECT id FROM survey_projects WHERE code = '${
      code.replace(/'/g, "''")}')`
    : "";
}

function checks(code: string | null): Check[] {
  const s = scope(code);
  const milestones = Object.entries(MILESTONE_REQUIRES).map(([m, stage]) => ({
    label: `claims at milestone ${m} against work ${stage} has not signed off`,
    severity: "FAULT" as Severity,
    note: "The contract pays on the acceptance, not the completion. A claim "
      + "like this would be refused today and is one the department returns.",
    sql: `SELECT count(*)::int AS n
            FROM survey_village_billing b
            JOIN survey_villages sv ON sv.id = b.survey_village_id
           WHERE b.milestone = ${Number(m)} AND b.status <> 'REJECTED' ${s}
             AND NOT EXISTS (
               SELECT 1 FROM survey_village_stages vs
                 JOIN survey_stages st ON st.id = vs.stage_id
                WHERE vs.survey_village_id = b.survey_village_id
                  AND st.code = '${stage}' AND vs.state = 'COMPLETED')`,
  }));

  return [
    ...milestones,
    {
      label: "a later claim standing without the earlier one",
      severity: "FAULT",
      note: "Milestones are a sequence. A second claim with no first is a "
        + "claim the department cannot reconcile against its own file.",
      sql: `SELECT count(*)::int AS n
              FROM survey_village_billing b
              JOIN survey_villages sv ON sv.id = b.survey_village_id
             WHERE b.status <> 'REJECTED' AND b.milestone > 1 ${s}
               AND NOT EXISTS (
                 SELECT 1 FROM survey_village_billing e
                  WHERE e.survey_village_id = b.survey_village_id
                    AND e.milestone = b.milestone - 1 AND e.status <> 'REJECTED')`,
    },
    {
      label: "stages begun before the stage they wait on finished",
      severity: "FAULT",
      note: "The pipeline is a sequence and the routes enforce it. Rows like "
        + "this come from a correction made after the fact.",
      sql: `SELECT count(*)::int AS n
              FROM survey_village_stages vs
              JOIN survey_villages sv ON sv.id = vs.survey_village_id
              JOIN survey_stages st ON st.id = vs.stage_id AND st.active
              JOIN survey_stages p ON p.id = st.requires_stage_id
             WHERE vs.state <> 'NOT_STARTED' ${s}
               AND NOT EXISTS (
                 SELECT 1 FROM survey_village_stages pv
                  WHERE pv.survey_village_id = vs.survey_village_id
                    AND pv.stage_id = p.id AND pv.state = 'COMPLETED')`,
    },
    {
      label: "stages reported complete with no completion date",
      severity: "FAULT",
      note: "A stage complete with no date cannot appear on the summary "
        + "sheet, which reports the date. A check constraint refuses these.",
      sql: `SELECT count(*)::int AS n
              FROM survey_village_stages vs
              JOIN survey_villages sv ON sv.id = vs.survey_village_id
             WHERE vs.state = 'COMPLETED' AND vs.completed_on IS NULL ${s}`,
    },
    {
      label: "villages recording more extent surveyed than they contain",
      severity: "FAULT",
      note: "A percentage over a hundred. Either the daily returns are "
        + "double-counted or the village extent is wrong.",
      sql: `SELECT count(*)::int AS n FROM (
              SELECT sv.id
                FROM survey_villages sv
                JOIN survey_entries e ON e.survey_village_id = sv.id
                JOIN survey_entry_values sev ON sev.entry_id = e.id
                JOIN survey_measures m ON m.id = sev.measure_id AND m.basis = 'EXTENT'
               WHERE true ${s}
               GROUP BY sv.id, sv.total_extent_ac
              HAVING sum(sev.quantity) > sv.total_extent_ac) x`,
    },
    {
      label: "ground truthing past its date with no reason recorded",
      severity: "WATCH",
      note: "The chase list, not a fault. The reason is demanded at the next "
        + "return or at sign-off; a village nobody has filed for since is "
        + "simply still owing an answer.",
      sql: `SELECT count(*)::int AS n
              FROM survey_village_stages vs
              JOIN survey_villages sv ON sv.id = vs.survey_village_id
              JOIN survey_stages st ON st.id = vs.stage_id
             WHERE st.code = 'GROUND_TRUTHING' AND vs.variance_reason IS NULL
               AND vs.expected_end_on IS NOT NULL ${s}
               AND COALESCE(vs.completed_on, CURRENT_DATE) > vs.expected_end_on`,
    },
    {
      label: "villages under way with no control point recorded",
      severity: "WATCH",
      note: "A real gap the dashboard exists to show. Work is never stopped "
        + "for it, so the count is a chase list rather than a fault.",
      sql: `SELECT count(*)::int AS n
              FROM survey_villages sv
             WHERE EXISTS (SELECT 1 FROM survey_village_stages vs
                    WHERE vs.survey_village_id = sv.id AND vs.state <> 'NOT_STARTED')
               AND NOT EXISTS (SELECT 1 FROM survey_village_gcps g
                    WHERE g.survey_village_id = sv.id) ${s}`,
    },
    {
      label: "progress recorded against a stage no longer in the pipeline",
      severity: "WATCH",
      note: "History from before §071 retired three stages. Kept on purpose: "
        + "it is the record of what was reported at the time.",
      sql: `SELECT count(*)::int AS n
              FROM survey_village_stages vs
              JOIN survey_villages sv ON sv.id = vs.survey_village_id
              JOIN survey_stages st ON st.id = vs.stage_id
             WHERE NOT st.active AND vs.state <> 'NOT_STARTED' ${s}`,
    },
  ];
}

async function main(): Promise<void> {
  const arg = process.argv.indexOf("--programme");
  const code = arg > -1 ? process.argv[arg + 1] ?? null : null;
  const pool = createPool(process.env.DATABASE_URL ?? "", process.env);

  console.log(code ? `Land survey audit — ${code}\n` : "Land survey audit — every programme\n");
  let faults = 0;
  for (const check of checks(code)) {
    const n = Number((await pool.query(check.sql)).rows[0]?.n ?? 0);
    const tag = n === 0 ? "  ok  " : check.severity === "FAULT" ? " FAULT" : " watch";
    console.log(`${tag}  ${String(n).padStart(6)}  ${check.label}`);
    if (n > 0) console.log(`                  ${check.note}`);
    if (n > 0 && check.severity === "FAULT") faults += 1;
  }
  console.log(faults === 0
    ? "\nNothing here could not be written again today."
    : `\n${faults} kind(s) of row the application would refuse today.`);
  await pool.end();
  // Non-zero only on faults, so this can gate a deployment if anybody wants
  // it to. A watch is a fact about the work, not a reason to stop.
  process.exit(faults === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
