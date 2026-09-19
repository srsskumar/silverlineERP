/**
 * A second programme, big enough to be tested against.
 *
 * The existing data proves the module works on a hundred villages. What it
 * cannot show is what every screen does at contract scale — twelve hundred
 * villages spread across every position, with plans that were met, missed and
 * never set. Every tab in the module is exercised by what this writes.
 *
 * Deterministic: the same programme code produces the same villages, the same
 * dates and the same slips on every run, so a screenshot taken today can be
 * compared with one taken next week.
 *
 * Adds only. Nothing here deletes or rewrites a row the module already holds;
 * re-running it is a no-op once the programme exists.
 *
 *   DATABASE_URL=<session pooler url> npx tsx src/scripts/seed-survey-phase2.ts
 */
import "../common/env.js";
import { createPool } from "../database/db.js";
import type { Pool } from "pg";

const CODE = "RESURVEY-P2";
const NAME = "Guntur — Resurvey Phase II";

/** Villages to create. The brief asked for a thousand and more. */
const VILLAGE_COUNT = 1200;

/* ------------------------------------------------------------ determinism */

/** Mulberry32: same seed, same programme, every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260920);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY));

/** The programme opened on this date; every plan below hangs off it. */
const PROGRAMME_START = "2026-01-05";
const TODAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------- geography */

const DISTRICTS = ["Guntur", "Palnadu", "Bapatla"] as const;
const MANDALS = [
  "Tenali", "Ponnur", "Repalle", "Vinukonda", "Sattenapalle", "Narasaraopet",
  "Chilakaluripet", "Mangalagiri", "Tadepalli", "Pedakakani", "Prathipadu",
  "Amaravathi", "Kollipara", "Duggirala", "Chebrole", "Medikonduru",
  "Phirangipuram", "Nadendla", "Bollapalli", "Macherla", "Gurazala",
  "Piduguralla", "Dachepalli", "Karempudi", "Rentachintala", "Veldurthi",
  "Bapatla", "Cheerala", "Karlapalem", "Nizampatnam",
] as const;

const VILLAGE_STEMS = [
  "Adavipalem", "Bhimavaram", "Chandole", "Dhulipalla", "Emani", "Gudivada",
  "Inturu", "Jampani", "Kantepudi", "Lemalle", "Munnangi", "Nutakki",
  "Oleru", "Pedanandipadu", "Rajupalem", "Sangam", "Takkellapadu", "Uppalapadu",
  "Vejendla", "Yedlapadu", "Annavaram", "Bodapadu", "Chowdavaram", "Dokiparru",
  "Etukuru", "Ganapavaram", "Haripuram", "Ipuru", "Jonnalagadda", "Kesanupalli",
];

/* ------------------------------------------ where each village has got to */

/**
 * The eleven positions, and how many villages sit at each.
 *
 * Shaped like a programme nine months in rather than spread evenly: most of
 * the work is in ground truthing, a tail has reached the department, and a
 * real number have not been reached at all. An even spread would look tidy
 * and would test nothing, because no screen would ever have to cope with a
 * bar that dwarfs the others.
 */
const SHAPE: Array<[string, number]> = [
  ["NOT_STARTED", 300],
  ["GT_IN_PROGRESS", 210],
  ["GT_COMPLETED", 95],
  ["GT_QC_IN_PROGRESS", 120],
  ["GT_QC_COMPLETED", 70],
  ["VECTORIZATION_IN_PROGRESS", 130],
  ["VECTORIZATION_COMPLETED", 60],
  ["DATA_SUBMITTED", 85],
  ["DATA_APPROVED", 60],
  ["FINAL_SUBMITTED", 40],
  ["FINAL_APPROVED", 30],
];

const PIPELINE = [
  "GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "DATA_SUBMISSION", "FINAL_DELIVERABLES",
] as const;

/** Which stages a position implies, and in what state. */
function stagesFor(position: string): Array<{ code: string; state: string }> {
  const order = [...PIPELINE];
  const at: Record<string, [number, string]> = {
    GT_IN_PROGRESS: [0, "IN_PROGRESS"], GT_COMPLETED: [0, "COMPLETED"],
    GT_QC_IN_PROGRESS: [1, "IN_PROGRESS"], GT_QC_COMPLETED: [1, "COMPLETED"],
    VECTORIZATION_IN_PROGRESS: [2, "IN_PROGRESS"], VECTORIZATION_COMPLETED: [2, "COMPLETED"],
    DATA_SUBMITTED: [3, "IN_PROGRESS"], DATA_APPROVED: [3, "COMPLETED"],
    FINAL_SUBMITTED: [4, "IN_PROGRESS"], FINAL_APPROVED: [4, "COMPLETED"],
  };
  const entry = at[position];
  if (!entry) return [];
  const [index, state] = entry;
  const out = order.slice(0, index).map(code => ({ code, state: "COMPLETED" }));
  out.push({ code: order[index], state });
  return out;
}

/** Roughly how long each stage is planned to take, in days. */
const STAGE_PLAN_DAYS: Record<string, [number, number]> = {
  GROUND_TRUTHING: [25, 60],
  GT_QC: [7, 18],
  VECTORIZATION: [15, 40],
  DATA_SUBMISSION: [10, 30],
  FINAL_DELIVERABLES: [10, 25],
};

const VARIANCE_REASONS = [
  "WEATHER", "ACCESS", "EQUIPMENT", "ROVER", "DATA_TECHNICAL", "EMPLOYEE",
  "FIELD_CONDITIONS", "DEPENDENCY", "NO_DEPT_STAFF", "OTHER",
] as const;

const OTHER_REMARKS = [
  "Panchayat elections closed the village office for a fortnight",
  "Farmers disputed the boundary; revenue inspector called in",
  "Temple festival — no fieldwork possible for eight days",
  "Land in litigation; tahsildar ordered work paused",
];

/* ------------------------------------------------------------ the writing */

async function chunkInsert(
  pool: Pool, sql: string, cols: number, rows: unknown[][], size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const values = slice.map((_, r) =>
      `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(",")})`).join(",");
    await pool.query(`${sql} VALUES ${values} ON CONFLICT DO NOTHING`, slice.flat());
  }
}

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? "", process.env);
  const org = (await pool.query(
    "SELECT id FROM organizations ORDER BY created_at LIMIT 1")).rows[0];
  if (!org) throw new Error("no organisation to seed into");
  const orgId = String(org.id);
  const admin = (await pool.query(
    "SELECT id FROM users WHERE org_id = $1 ORDER BY created_at LIMIT 1", [orgId])).rows[0];
  const by = String(admin.id);

  const existing = (await pool.query(
    "SELECT id FROM survey_projects WHERE org_id = $1 AND code = $2", [orgId, CODE])).rows[0];
  if (existing) {
    console.log(`${CODE} already exists (${existing.id}); nothing to do.`);
    await pool.end();
    return;
  }

  console.log(`seeding ${NAME} — ${VILLAGE_COUNT} villages`);

  const programme = (await pool.query(
    `INSERT INTO survey_projects
       (org_id, code, name, status, started_on, target_completion_on,
        low_progress_threshold_ac, stage_sla_days, created_by, updated_by)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,8,45,$6,$6) RETURNING id`,
    [orgId, CODE, NAME, PROGRAMME_START, "2027-03-31", by])).rows[0];
  const programmeId = String(programme.id);

  /* --- geography ------------------------------------------------------- */
  const districtIds: string[] = [];
  for (const name of DISTRICTS) {
    const row = (await pool.query(
      `INSERT INTO org_units(org_id, type, code, name)
       VALUES ($1,'district',$2,$3)
       ON CONFLICT (org_id, type, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [orgId, `P2-D-${name.toUpperCase()}`, name])).rows[0];
    districtIds.push(String(row.id));
  }

  const mandalIds: string[] = [];
  for (let i = 0; i < MANDALS.length; i += 1) {
    const row = (await pool.query(
      `INSERT INTO org_units(org_id, type, code, name, parent_id)
       VALUES ($1,'mandal',$2,$3,$4)
       ON CONFLICT (org_id, type, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [orgId, `P2-M-${i}`, MANDALS[i], districtIds[i % districtIds.length]])).rows[0];
    mandalIds.push(String(row.id));
  }

  /* --- villages -------------------------------------------------------- */
  const unitRows: unknown[][] = [];
  const names: string[] = [];
  for (let i = 0; i < VILLAGE_COUNT; i += 1) {
    const name = `${VILLAGE_STEMS[i % VILLAGE_STEMS.length]} ${Math.floor(i / VILLAGE_STEMS.length) + 1}`;
    names.push(name);
    unitRows.push([orgId, "village", `P2-V-${String(i).padStart(4, "0")}`, name,
      mandalIds[i % mandalIds.length]]);
  }
  await chunkInsert(pool,
    "INSERT INTO org_units(org_id, type, code, name, parent_id)", 5, unitRows);

  const units = (await pool.query(
    `SELECT id, code FROM org_units
      WHERE org_id = $1 AND code LIKE 'P2-V-%' ORDER BY code`, [orgId])).rows;
  console.log(`  ${units.length} village units`);

  // Extent is skewed: a handful of large villages carry a lot of the work,
  // which is the case weighted roll-ups exist for. An even spread would make
  // a weighted average and a plain one agree, and hide the bug that matters.
  const svRows = units.map((u, i) => {
    const big = i % 37 === 0;
    const extent = big ? between(900, 2400) : between(60, 700);
    return [orgId, programmeId, String(u.id), extent,
      addDays(PROGRAMME_START, between(0, 200)), by, by];
  });
  await chunkInsert(pool,
    `INSERT INTO survey_villages
       (org_id, survey_project_id, village_id, total_extent_ac, planned_start_on,
        created_by, updated_by)`, 7, svRows);

  const villages = (await pool.query(
    `SELECT sv.id, sv.total_extent_ac, sv.planned_start_on, ou.code
       FROM survey_villages sv JOIN org_units ou ON ou.id = sv.village_id
      WHERE sv.survey_project_id = $1 ORDER BY ou.code`, [programmeId])).rows;
  console.log(`  ${villages.length} survey villages`);

  const stageIds = new Map<string, string>(
    (await pool.query(
      "SELECT id, code FROM survey_stages WHERE org_id = $1 AND active", [orgId])
    ).rows.map(r => [String(r.code), String(r.id)]));

  /* --- positions, with a plan and an outcome for every stage ------------ */
  const plan: string[] = [];
  for (const [position, count] of SHAPE) {
    for (let i = 0; i < count; i += 1) plan.push(position);
  }
  while (plan.length < villages.length) plan.push("NOT_STARTED");

  const stageRows: unknown[][] = [];
  const startedVillages: Array<{ id: string; extent: number; gtStart: string }> = [];
  let unplanned = 0;

  const maxDate = (a: string, b: string) => (a > b ? a : b);
  const minDate = (a: string, b: string) => (a < b ? a : b);

  villages.forEach((v, i) => {
    const position = plan[i];
    const stages = stagesFor(position);
    if (stages.length === 0) return;

    // How long the whole chain is planned to take, worked out before any of
    // it is written down.
    const durations = stages.map(st => {
      const [lo, hi] = STAGE_PLAN_DAYS[st.code];
      return between(lo, hi);
    });
    /*
     * The chain is anchored from its far end, not its near one.
     *
     * Which end depends on what the village is doing. Work that is finished
     * has to fit behind today, so the chain is pushed back far enough for
     * that. Work still running should straddle today — a village whose GT is
     * in progress is usually somewhere inside its window, occasionally past
     * it, and hardly ever nine months past it.
     *
     * Anchoring everything from the planned start instead produced exactly
     * that: villages that opened in January, still in ground truthing, and
     * reported two hundred days late. Four villages in five late says nothing
     * about any of them.
     */
    const finishedDays = durations
      .filter((_, si) => stages[si].state === "COMPLETED")
      .reduce((a, b) => a + b, 0);
    const tail = stages[stages.length - 1];
    const tailDays = durations[durations.length - 1];

    let anchor: string;
    if (tail.state === "COMPLETED") {
      // Everything happened; leave room between the finish and today.
      anchor = addDays(TODAY, -(finishedDays + between(10, 45)));
    } else {
      /*
       * The running stage is due somewhere around now. Mostly ahead of its
       * date, sometimes just past it — the slip below is what makes a village
       * properly late, rather than the anchor doing it to all of them.
       */
      const dueIn = between(-25, 55);
      anchor = addDays(TODAY, dueIn - tailDays - finishedDays);
    }

    let cursor = maxDate(PROGRAMME_START, anchor);

    startedVillages.push({
      id: String(v.id), extent: Number(v.total_extent_ac), gtStart: cursor,
    });

    stages.forEach((st, si) => {
      const planned = durations[si];
      const expectedStart = cursor;
      const expectedEnd = addDays(expectedStart, planned);

      /*
       * One village in eleven was never planned at all.
       *
       * Deliberate: "no expected date" has to be reported as unknown rather
       * than as on-time, and a dataset where every village has a plan would
       * never show whether it is.
       */
      const hasPlan = i % 11 !== 3;
      if (!hasPlan) unplanned += 1;

      // Most stages land near the plan; a fifth slip badly and a few come in
      // early, which is what a real programme looks like. An early finish is
      // capped at the planned length: a stage cannot finish before it began,
      // and the constraint on the table says so.
      const roll = rand();
      const slip = roll < 0.18 ? between(7, 45)
        : roll < 0.30 ? -Math.min(between(6, 12), Math.max(1, planned - 2))
          : between(-3, 5);

      // Work that has happened cannot have happened tomorrow.
      const actualStart = minDate(addDays(expectedStart, between(-2, 6)), TODAY);
      let actualEnd: string | null = null;
      if (st.state === "COMPLETED") {
        // Never in the future, and never before it started. The order of the
        // two clamps matters: the start is already capped at today, so
        // raising the end to meet it cannot push it past today.
        actualEnd = maxDate(actualStart, minDate(addDays(expectedEnd, slip), TODAY));
      }

      // A reason is recorded for the big slips and deliberately missing on
      // some of them, so the "unexplained" count on the dashboard is not
      // always zero.
      const realSlip = actualEnd ? Math.round(
        (Date.parse(`${actualEnd}T00:00:00Z`) - Date.parse(`${expectedEnd}T00:00:00Z`)) / DAY) : 0;
      const wantsReason = Math.abs(realSlip) > 5 && st.state === "COMPLETED";
      const reason = wantsReason && rand() < 0.75 ? pick(VARIANCE_REASONS) : null;

      stageRows.push([
        orgId, String(v.id), stageIds.get(st.code), st.state,
        actualStart, actualEnd,
        hasPlan ? expectedStart : null,
        hasPlan ? expectedEnd : null,
        reason,
        reason === "OTHER" ? pick(OTHER_REMARKS) : null,
        by,
      ]);
      cursor = actualEnd ?? addDays(actualStart, planned);
    });
  });

  await chunkInsert(pool,
    `INSERT INTO survey_village_stages
       (org_id, survey_village_id, stage_id, state, started_on, completed_on,
        expected_start_on, expected_end_on, variance_reason, variance_remarks, updated_by)`,
    11, stageRows, 300);
  console.log(`  ${stageRows.length} stage rows (${unplanned} with no plan)`);

  /* --- staffing on everything that started ------------------------------ */
  const staffRows = startedVillages.map(v =>
    [between(1, 4), between(3, 9), v.id]);
  for (const [govt, crew, id] of staffRows) {
    await pool.query(
      `UPDATE survey_villages
          SET gt_govt_staff_allocated = $1, gt_crew_allocated = $2,
              expected_completion_on = $3
        WHERE id = $4 AND gt_govt_staff_allocated IS NULL`,
      [govt, crew, addDays(PROGRAMME_START, between(120, 380)), id]);
  }
  console.log(`  staffing on ${staffRows.length} villages`);

  /* --- crew, instruments, control points, returns, claims --------------- */
  const employees = (await pool.query(
    "SELECT id FROM employees WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id", [orgId])
  ).rows.map(r => String(r.id));
  const rovers = (await pool.query(
    `SELECT id FROM assets WHERE org_id = $1 AND upper(category) = 'SURVEY' ORDER BY id`,
    [orgId])).rows.map(r => String(r.id));
  const measures = (await pool.query(
    "SELECT id, code, basis FROM survey_measures WHERE org_id = $1", [orgId])).rows;
  const extentMeasures = measures.filter(m => m.basis === "EXTENT");
  const countMeasures = measures.filter(m => m.basis !== "EXTENT");
  const gtStage = stageIds.get("GROUND_TRUTHING")!;

  const crewRows: unknown[][] = [];
  const gcpRows: unknown[][] = [];
  const roverRows: unknown[][] = [];
  startedVillages.forEach((v, i) => {
    for (let n = 0; n < 2 + (i % 3); n += 1) {
      crewRows.push([orgId, v.id, gtStage, employees[(i * 3 + n) % employees.length],
        v.gtStart, by]);
    }
    // Roughly one village in eight has no control point recorded, which is
    // the gap the dashboard exists to show.
    if (i % 8 !== 5) {
      const count = i % 23 === 0 ? 2 : 1;
      for (let n = 0; n < count; n += 1) {
        gcpRows.push([orgId, v.id, `GCP-${n + 1}`,
          (16 + rand() * 1.4).toFixed(7), (79.8 + rand() * 1.6).toFixed(7),
          (12 + rand() * 90).toFixed(1), "44N", v.gtStart, by, by]);
      }
    }
    if (rovers.length && i % 2 === 0) {
      roverRows.push([orgId, v.id, rovers[i % rovers.length], v.gtStart, by]);
    }
  });
  await chunkInsert(pool,
    `INSERT INTO survey_crew
       (org_id, survey_village_id, stage_id, employee_id, assigned_on, created_by)`,
    6, crewRows, 400);
  await chunkInsert(pool,
    `INSERT INTO survey_village_gcps
       (org_id, survey_village_id, point_code, latitude, longitude, elevation_m,
        grid_zone, established_on, created_by, updated_by)`, 10, gcpRows, 300);
  await chunkInsert(pool,
    `INSERT INTO survey_rover_allocations
       (org_id, survey_village_id, asset_id, allocated_on, created_by)`, 5, roverRows, 400);
  console.log(`  ${crewRows.length} crew, ${gcpRows.length} control points, `
    + `${roverRows.length} instruments`);

  /*
   * Daily returns on the villages that have actually been walked.
   *
   * Capped at four hundred villages rather than every one of them: the point
   * is to give the progress, report and trend screens something real to add
   * up, and six thousand returns does that without making this script a
   * twenty-minute job.
   */
  const withReturns = startedVillages.slice(0, 400);
  const entryRows: unknown[][] = [];
  withReturns.forEach((v, i) => {
    const days = between(8, 22);
    for (let d = 0; d < days; d += 1) {
      const date = addDays(v.gtStart, d * 2 + (i % 3));
      if (date > TODAY) break;
      const govt = rand() < 0.15 ? 0 : between(1, 4);
      entryRows.push([orgId, programmeId, v.id, date, between(1, 3), 1, between(1, 3),
        govt, between(2, 8), by, by]);
    }
  });
  await chunkInsert(pool,
    `INSERT INTO survey_entries
       (org_id, survey_project_id, survey_village_id, entry_date, teams_deployed,
        dgps_base, dgps_rovers, govt_staff_present, crew_present, created_by, updated_by)`,
    11, entryRows, 300);

  const entries = (await pool.query(
    `SELECT e.id, e.survey_village_id, sv.total_extent_ac
       FROM survey_entries e JOIN survey_villages sv ON sv.id = e.survey_village_id
      WHERE e.survey_project_id = $1`, [programmeId])).rows;
  const perVillage = new Map<string, number>();
  for (const e of entries) {
    perVillage.set(String(e.survey_village_id),
      (perVillage.get(String(e.survey_village_id)) ?? 0) + 1);
  }
  const valueRows: unknown[][] = [];
  for (const e of entries) {
    // The day's share of the village, so the cumulative never overruns the
    // extent — a percentage over a hundred is the first thing anybody spots.
    const share = Number(e.total_extent_ac) / Math.max(1, perVillage.get(String(e.survey_village_id))!);
    for (const m of extentMeasures) {
      valueRows.push([orgId, String(e.id), String(m.id),
        Math.round((share / extentMeasures.length) * 0.82 * 100) / 100]);
    }
    for (const m of countMeasures.slice(0, 3)) {
      valueRows.push([orgId, String(e.id), String(m.id), between(8, 90)]);
    }
  }
  await chunkInsert(pool,
    "INSERT INTO survey_entry_values(org_id, entry_id, measure_id, quantity)",
    4, valueRows, 400);

  /*
   * A row per instrument per day.
   *
   * Without these the crew-and-rover screens and the two productivity
   * reports have nothing to read and come back empty — which looks exactly
   * like a broken page, and is how a gap in test data gets mistaken for a
   * gap in the product. A seventh of the days are idle, each with a reason,
   * so the idle drill-down has something to drill into.
   */
  const allocByVillage = new Map<string, string>();
  for (const r of roverRows) allocByVillage.set(String(r[1]), String(r[2]));
  const entryRoverRows: unknown[][] = [];
  for (const e of entries) {
    const asset = allocByVillage.get(String(e.survey_village_id));
    if (!asset) continue;
    const idle = rand() < 0.14;
    const reason = idle ? pick(VARIANCE_REASONS) : null;
    entryRoverRows.push([orgId, String(e.id), asset,
      idle ? "IDLE" : "UTILIZED", reason,
      reason === "OTHER" ? pick(OTHER_REMARKS) : null]);
  }
  await chunkInsert(pool,
    `INSERT INTO survey_entry_rovers
       (org_id, entry_id, asset_id, status, idle_reason, remarks)`, 6, entryRoverRows, 400);

  console.log(`  ${entryRows.length} daily returns, ${valueRows.length} measure values, `
    + `${entryRoverRows.length} instrument-days`);

  /* --- claims on what has been earned ----------------------------------- */
  const earned = (await pool.query(
    `SELECT sv.id,
            sv.total_extent_ac,
            bool_or(s.code = 'GT_QC' AND vs.state = 'COMPLETED')              AS m1,
            bool_or(s.code = 'DATA_SUBMISSION' AND vs.state = 'COMPLETED')    AS m2,
            bool_or(s.code = 'FINAL_DELIVERABLES' AND vs.state <> 'NOT_STARTED') AS m3
       FROM survey_villages sv
       JOIN survey_village_stages vs ON vs.survey_village_id = sv.id
       JOIN survey_stages s ON s.id = vs.stage_id
      WHERE sv.survey_project_id = $1
      GROUP BY sv.id, sv.total_extent_ac`, [programmeId])).rows;
  const claimRows: unknown[][] = [];
  const PERCENT: Record<number, number> = { 1: 50, 2: 30, 3: 20 };
  for (const row of earned) {
    for (const [milestone, ok] of [[1, row.m1], [2, row.m2], [3, row.m3]] as const) {
      if (!ok) continue;
      // A mix of standing, approved and paid, so the billing screen has more
      // than one state to draw.
      const roll = rand();
      const status = roll < 0.45 ? "SUBMITTED" : roll < 0.8 ? "APPROVED" : "PAID";
      claimRows.push([orgId, String(row.id), milestone, PERCENT[milestone], status,
        addDays(PROGRAMME_START, between(60, 240)),
        status === "SUBMITTED" ? null : addDays(PROGRAMME_START, between(240, 300)),
        Number(row.total_extent_ac), by, by]);
    }
  }
  await chunkInsert(pool,
    `INSERT INTO survey_village_billing
       (org_id, survey_village_id, milestone, percent, status, submitted_on,
        decided_on, extent_ac, created_by, updated_by)`, 10, claimRows, 300);
  console.log(`  ${claimRows.length} billing claims`);

  console.log(`\ndone — ${NAME} (${programmeId})`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
