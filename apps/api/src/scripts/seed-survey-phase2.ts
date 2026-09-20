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
  onConflict = "ON CONFLICT DO NOTHING",
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const values = slice.map((_, r) =>
      `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(",")})`).join(",");
    await pool.query(`${sql} VALUES ${values} ${onConflict}`, slice.flat());
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

  /*
   * Re-runnable rather than all-or-nothing.
   *
   * Every insert below either carries ON CONFLICT DO NOTHING or is looked up
   * first, and the generator is seeded, so a second run writes only what a
   * first run missed. An early exit on "the programme exists" meant a run
   * that failed halfway could only be fixed by deleting what it had written.
   */
  const existing = (await pool.query(
    "SELECT id FROM survey_projects WHERE org_id = $1 AND code = $2", [orgId, CODE])).rows[0];
  console.log(existing
    ? `topping up ${NAME}`
    : `seeding ${NAME} — ${VILLAGE_COUNT} villages`);

  const programmeId = existing ? String(existing.id) : String((await pool.query(
    `INSERT INTO survey_projects
       (org_id, code, name, status, started_on, target_completion_on,
        low_progress_threshold_ac, stage_sla_days, created_by, updated_by)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,8,45,$6,$6) RETURNING id`,
    [orgId, CODE, NAME, PROGRAMME_START, "2027-03-31", by])).rows[0].id);

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
  /*
   * The programme's own instruments.
   *
   * A rover can only be in one village at a time, and the register held a
   * dozen — so allocating them across nine hundred villages wrote twelve
   * rows and the crew, rover and productivity screens came back all but
   * empty. A twelve-hundred-village resurvey is worked with a fleet, and
   * these are it. Coded P2-RVR- so they are obviously this programme's.
   */
  const ROVER_FLEET = 140;
  const assetRows: unknown[][] = [];
  for (let i = 0; i < ROVER_FLEET; i += 1) {
    assetRows.push([orgId, `P2-RVR-${String(i).padStart(3, "0")}`,
      `DGPS Rover P2-${String(i).padStart(3, "0")}`, "SURVEY",
      `SN-P2-${String(100000 + i)}`, "GOOD", "AVAILABLE", by]);
  }
  await chunkInsert(pool,
    `INSERT INTO assets
       (org_id, asset_code, name, category, serial_number, condition, status, created_by)`,
    8, assetRows, 200);
  const rovers = (await pool.query(
    `SELECT id FROM assets WHERE org_id = $1 AND asset_code LIKE 'P2-RVR-%' ORDER BY asset_code`,
    [orgId])).rows.map(r => String(r.id));
  console.log(`  ${rovers.length} instruments in the fleet`);
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
    // One instrument, one village: the register enforces it, so allocating
    // the same rover round a loop would write the first and discard the rest.
    if (rovers.length && i < rovers.length) {
      roverRows.push([orgId, v.id, rovers[i], v.gtStart, by]);
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
  /*
   * Spread across the ladder rather than taken off the front of the list.
   *
   * The villages are ordered by code and the ladder was dealt in that order,
   * so the first four hundred were all early-stage — and the dashboard showed
   * nothing surveyed at exactly the stages where the work is most complete.
   * Every fourth village, wherever it sits, gives every rung returns behind
   * it.
   */
  const withReturns = startedVillages.filter((_, i) => i % 2 === 0);
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
  /*
   * Upserted, not inserted-and-skipped.
   *
   * The share each day carries is the village's extent divided by however
   * many days it has, so it changes whenever a run adds a day. Leaving the
   * old rows alone made the cumulative overshoot the extent — every village
   * with returns was reporting more surveyed than it contains, which is the
   * one number anybody spots. Rewriting them makes a second run converge on
   * the same figures as the first rather than pile on top of it.
   */
  await chunkInsert(pool,
    "INSERT INTO survey_entry_values(org_id, entry_id, measure_id, quantity)",
    4, valueRows, 400,
    "ON CONFLICT (entry_id, measure_id) DO UPDATE SET quantity = EXCLUDED.quantity");

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
  // Who was carrying it. Employee productivity is attributed entirely through
  // the instrument, so a rover-day with no person on it counts for nobody.
  const crewByVillage = new Map<string, string[]>();
  for (const r of crewRows) {
    const v = String(r[1]);
    crewByVillage.set(v, [...(crewByVillage.get(v) ?? []), String(r[3])]);
  }
  const entryRoverRows: unknown[][] = [];
  for (const e of entries) {
    const village = String(e.survey_village_id);
    const asset = allocByVillage.get(village);
    if (!asset) continue;
    const crew = crewByVillage.get(village) ?? [];
    const idle = rand() < 0.14;
    const reason = idle ? pick(VARIANCE_REASONS) : null;
    entryRoverRows.push([orgId, String(e.id), asset,
      idle ? "IDLE" : "UTILIZED", reason,
      reason === "OTHER" ? pick(OTHER_REMARKS) : null,
      crew.length ? crew[Math.floor(rand() * crew.length)] : null]);
  }
  await chunkInsert(pool,
    `INSERT INTO survey_entry_rovers
       (org_id, entry_id, asset_id, status, idle_reason, remarks, employee_id)`,
    7, entryRoverRows, 400);

  console.log(`  ${entryRows.length} daily returns, ${valueRows.length} measure values, `
    + `${entryRoverRows.length} instrument-days`);

  /* --- claims on what has been earned ----------------------------------- */
  const earned = (await pool.query(
    `SELECT sv.id,
            sv.total_extent_ac,
            bool_or(s.code = 'GT_QC' AND vs.state = 'COMPLETED')              AS m1,
            bool_or(s.code = 'DATA_SUBMISSION' AND vs.state = 'COMPLETED')    AS m2,
            -- COMPLETED, not merely started (§078). Submitting is not being
            -- paid for, and this line used to say otherwise — which is how
            -- the corpus came to hold thirty-nine claims the routes would
            -- refuse today.
            bool_or(s.code = 'FINAL_DELIVERABLES' AND vs.state = 'COMPLETED') AS m3
       FROM survey_villages sv
       JOIN survey_village_stages vs ON vs.survey_village_id = sv.id
       JOIN survey_stages s ON s.id = vs.stage_id
      WHERE sv.survey_project_id = $1
      GROUP BY sv.id, sv.total_extent_ac`, [programmeId])).rows;
  const claimRows: unknown[][] = [];
  const PERCENT: Record<number, number> = { 1: 50, 2: 30, 3: 20 };
  for (const row of earned) {
    /*
     * Claims are a sequence, and stop at the first one not earned.
     *
     * The routes refuse a milestone whose predecessor is not standing, and
     * this loop used to emit each one independently — so a village that had
     * earned the second and not the first got a second claim on its own,
     * which the department cannot reconcile against its own file.
     */
    for (const [milestone, ok] of [[1, row.m1], [2, row.m2], [3, row.m3]] as const) {
      if (!ok) break;
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

  /* --- every other case a screen has to draw ---------------------------- */

  /*
   * A programme that only ever produced happy rows tests nothing. What
   * follows is the awkward half: days that went badly and said why, villages
   * paused or sent back, claims the department returned, figures certified
   * at something other than what was recorded, and people and instruments
   * that have come off a village and left a history behind them.
   */

  // Low progress, with a reason. Every reason in the vocabulary appears, and
  // "other" always carries the sentence that makes it useful.
  const lowRows = (await pool.query(
    `SELECT id FROM survey_entries WHERE survey_project_id = $1
       AND low_progress_reason IS NULL ORDER BY id`, [programmeId])).rows;
  let lowSet = 0;
  for (let i = 0; i < lowRows.length; i += 1) {
    if (i % 8 !== 3) continue;
    /*
     * Counted off the rows selected, not off the loop index.
     *
     * Taking every eighth row and then indexing the reason by the same `i`
     * strides 8 through a list of 10, which visits five of them and never
     * the other five. The same aliasing once left seven of nine idle reasons
     * with no data at all.
     */
    const reason = VARIANCE_REASONS[lowSet % VARIANCE_REASONS.length];
    await pool.query(
      `UPDATE survey_entries
          SET low_progress_reason = $2, low_progress_remarks = $3
        WHERE id = $1`,
      [lowRows[i].id, reason,
        reason === "OTHER" ? pick(OTHER_REMARKS) : null]);
    lowSet += 1;
  }
  console.log(`  ${lowSet} short days with a reason`);

  // Punches on a slice of the returns, so the attendance-to-progress join
  // has something on both sides of it.
  await pool.query(
    `UPDATE survey_entries
        SET punch_in_at  = (entry_date + time '08:15') AT TIME ZONE 'Asia/Kolkata',
            punch_out_at = (entry_date + time '17:40') AT TIME ZONE 'Asia/Kolkata',
            punch_in_lat = 16.31, punch_in_lng = 80.44,
            punch_out_lat = 16.32, punch_out_lng = 80.45
      WHERE survey_project_id = $1 AND punch_in_at IS NULL
        AND (('x' || substr(md5(id::text), 1, 8))::bit(32)::int % 5) = 0`,
    [programmeId]);

  /*
   * Villages held and villages sent back.
   *
   * Neither is a rung on the ladder — both are things true about a village at
   * a rung — so both have to appear somewhere for the dashboard's flags to
   * have anything to count.
   */
  const running = (await pool.query(
    `SELECT vs.id, vs.survey_village_id, vs.stage_id
       FROM survey_village_stages vs
       JOIN survey_villages v ON v.id = vs.survey_village_id
      WHERE v.survey_project_id = $1 AND vs.state = 'IN_PROGRESS'
      ORDER BY vs.id`, [programmeId])).rows;
  const heldIds = running.filter((_, i) => i % 9 === 4).map(r => r.id);
  if (heldIds.length) {
    await pool.query(
      `UPDATE survey_village_stages SET state = 'ON_HOLD'
        WHERE id = ANY($1::uuid[])`, [heldIds]);
    await pool.query(
      `UPDATE survey_villages SET status_override = 'ON_HOLD',
              status_remarks = 'Paused pending revenue department clearance'
        WHERE id IN (SELECT survey_village_id FROM survey_village_stages
                      WHERE id = ANY($1::uuid[]))`, [heldIds]);
  }

  const reworkStage = stageIds.get("REWORK");
  const reworkRows: unknown[][] = [];
  if (reworkStage) {
    const candidates = (await pool.query(
      `SELECT v.id FROM survey_villages v
        WHERE v.survey_project_id = $1
          AND EXISTS (SELECT 1 FROM survey_village_stages vs
                       JOIN survey_stages s ON s.id = vs.stage_id
                      WHERE vs.survey_village_id = v.id AND s.code = 'GT_QC'
                        AND vs.state = 'COMPLETED')
        ORDER BY v.id LIMIT 45`, [programmeId])).rows;
    candidates.forEach((v, i) => {
      reworkRows.push([orgId, String(v.id), reworkStage,
        i % 3 === 0 ? "COMPLETED" : "IN_PROGRESS",
        addDays(TODAY, -between(20, 80)),
        i % 3 === 0 ? addDays(TODAY, -between(1, 15)) : null,
        "Boundary disputed after QC; parcels re-walked", by]);
    });
    await chunkInsert(pool,
      `INSERT INTO survey_village_stages
         (org_id, survey_village_id, stage_id, state, started_on, completed_on,
          remarks, updated_by)`, 8, reworkRows, 200);
    await pool.query(
      `UPDATE survey_villages SET status_override = 'REWORK',
              status_remarks = 'Returned by QC; boundary parcels re-walked'
        WHERE id = ANY($1::uuid[]) AND status_override IS NULL`,
      [reworkRows.filter(r => r[3] === "IN_PROGRESS").map(r => r[1])]);
  }
  console.log(`  ${heldIds.length} held, ${reworkRows.length} in or through rework`);

  /*
   * Targets, so a count measure has a denominator.
   *
   * Without one the completion of a points or parcels measure is reported as
   * unknown — correctly, and on every village, which means that branch of
   * the report never gets looked at.
   */
  const targetVillages = (await pool.query(
    `SELECT id, total_extent_ac FROM survey_villages
      WHERE survey_project_id = $1 ORDER BY id LIMIT 500`, [programmeId])).rows;
  const targetRows: unknown[][] = [];
  for (const v of targetVillages) {
    for (const m of countMeasures.slice(0, 3)) {
      targetRows.push([orgId, String(v.id), String(m.id),
        Math.max(10, Math.round(Number(v.total_extent_ac) / between(2, 6))), by]);
    }
  }
  await chunkInsert(pool,
    `INSERT INTO survey_targets
       (org_id, survey_village_id, measure_id, target_quantity, updated_by)`,
    5, targetRows, 400);
  console.log(`  ${targetRows.length} targets`);

  /*
   * Certified totals on the villages that are finished.
   *
   * Deliberately not equal to what the returns add up to on all of them: the
   * whole point of certifying is that somebody signs a figure, and the screen
   * that shows both exists because the two differ.
   */
  const finished = (await pool.query(
    `SELECT v.id, v.total_extent_ac FROM survey_villages v
      WHERE v.survey_project_id = $1
        AND EXISTS (SELECT 1 FROM survey_village_stages vs
                     JOIN survey_stages s ON s.id = vs.stage_id
                    WHERE vs.survey_village_id = v.id
                      AND s.code = 'FINAL_DELIVERABLES' AND vs.state = 'COMPLETED')
      ORDER BY v.id`, [programmeId])).rows;
  const finalRows: unknown[][] = [];
  for (let i = 0; i < finished.length; i += 1) {
    const recorded = (await pool.query(
      `SELECT sm.code, COALESCE(sum(sev.quantity), 0) AS q
         FROM survey_entries e
         JOIN survey_entry_values sev ON sev.entry_id = e.id
         JOIN survey_measures sm ON sm.id = sev.measure_id AND sm.basis = 'EXTENT'
        WHERE e.survey_village_id = $1 GROUP BY 1`, [finished[i].id])).rows;
    /*
     * A finished village with no daily returns behind it still gets
     * certified. Its figure is the village's extent rather than a sum of
     * nothing — which is the case the two-figure screen exists for: what was
     * signed, beside what the returns actually add up to.
     */
    const basis = recorded.length ? recorded : extentMeasures.map(m => ({
      code: m.code,
      q: Number((finished[i] as Record<string, unknown>).total_extent_ac ?? 0)
        / Math.max(1, extentMeasures.length),
    }));
    for (const r of basis) {
      const measure = measures.find(m => m.code === r.code);
      if (!measure) continue;
      const drift = i % 3 === 0 ? 1 + (rand() * 0.06 - 0.03) : 1;
      finalRows.push([orgId, String(finished[i].id), String(measure.id),
        Math.round(Number(r.q) * drift * 100) / 100,
        drift === 1 ? "Agrees with the daily returns"
          : "Re-measured at handover against the department's own traverse", by]);
    }
  }
  await chunkInsert(pool,
    `INSERT INTO survey_village_finals
       (org_id, survey_village_id, measure_id, quantity, reason, certified_by)`,
    6, finalRows, 200);
  console.log(`  ${finalRows.length} certified figures`);

  // Claims the department sent back.
  await pool.query(
    `UPDATE survey_village_billing b
        SET status = 'REJECTED', decided_on = $2,
            remarks = 'Returned: extent statement did not match the LPM schedule'
       FROM survey_villages v
      WHERE v.id = b.survey_village_id AND v.survey_project_id = $1
        AND b.status = 'SUBMITTED'
        AND (('x' || substr(md5(b.id::text), 1, 8))::bit(32)::int % 9) = 0`,
    [programmeId, addDays(TODAY, -between(5, 40))]);

  /*
   * People and instruments that have come off a village.
   *
   * A released row is history, and the screens that show "who is on this
   * village now" are only correct if there is history for them to exclude.
   */
  /*
   * Ground truthing past its date must say why (§074), so the data has to
   * honour the rule the routes now enforce. Left unexplained on a slice of
   * them deliberately: the dashboard counts villages slipping with no reason
   * recorded, and a dataset where that count is always zero never shows it.
   */
  const overdueGt = (await pool.query(
    `SELECT vs.id FROM survey_village_stages vs
       JOIN survey_stages s ON s.id = vs.stage_id
       JOIN survey_villages v ON v.id = vs.survey_village_id
      WHERE v.survey_project_id = $1 AND s.code = 'GROUND_TRUTHING'
        AND vs.variance_reason IS NULL
        AND vs.expected_end_on IS NOT NULL
        AND COALESCE(vs.completed_on, CURRENT_DATE) > vs.expected_end_on
      ORDER BY vs.id`, [programmeId])).rows;
  let explained = 0;
  for (let i = 0; i < overdueGt.length; i += 1) {
    // Four in five explained; the rest are the chase list.
    if (i % 5 === 2) continue;
    const reason = VARIANCE_REASONS[explained % VARIANCE_REASONS.length];
    await pool.query(
      `UPDATE survey_village_stages
          SET variance_reason = $2, variance_remarks = $3 WHERE id = $1`,
      [overdueGt[i].id, reason, reason === "OTHER" ? pick(OTHER_REMARKS) : null]);
    explained += 1;
  }
  console.log(`  ${explained} overdue ground truthings explained `
    + `(${overdueGt.length - explained} still to answer for)`);

  // GREATEST, because somebody cannot come off a village before they went
  // on to it — and the table says so.
  await pool.query(
    `UPDATE survey_crew c SET released_on = GREATEST(c.assigned_on, $2::date)
       FROM survey_villages v
      WHERE v.id = c.survey_village_id AND v.survey_project_id = $1
        AND c.released_on IS NULL
        AND (('x' || substr(md5(c.id::text), 1, 8))::bit(32)::int % 11) = 0`,
    [programmeId, addDays(TODAY, -between(3, 30))]);
  await pool.query(
    `UPDATE survey_rover_allocations ra
        SET released_on = GREATEST(ra.allocated_on, $2::date)
       FROM survey_villages v
      WHERE v.id = ra.survey_village_id AND v.survey_project_id = $1
        AND ra.released_on IS NULL
        AND (('x' || substr(md5(ra.id::text), 1, 8))::bit(32)::int % 13) = 0`,
    [programmeId, addDays(TODAY, -between(2, 20))]);

  /* --- bring the claims back in line with the rules -------------------- */

  /*
   * Claims the routes would refuse today.
   *
   * The generator above used to release the third milestone on a submission
   * rather than an acceptance (§078 moved it), and to emit each milestone
   * independently rather than as a sequence — so the corpus carried claims
   * that could not be raised now. A demonstration dataset that contradicts
   * the rules it is demonstrating is worse than no dataset.
   *
   * All of them go. Keeping a handful to exercise the dashboard's
   * "claimed without a sign-off" count was tried and is wrong: an audit that
   * always reports a fault is an audit people learn to scroll past, and the
   * case is already covered by a test that claims a village and then has the
   * acceptance withdrawn. Edge cases belong in tests; the corpus should be
   * something the rules would accept.
   */
  const KEEP_LEGACY = 0;

  const stale = (await pool.query(
    `SELECT b.id, b.milestone
       FROM survey_village_billing b
       JOIN survey_villages sv ON sv.id = b.survey_village_id
      WHERE sv.survey_project_id = $1 AND b.status <> 'REJECTED'
        AND NOT EXISTS (
          SELECT 1 FROM survey_village_stages vs
            JOIN survey_stages st ON st.id = vs.stage_id
           WHERE vs.survey_village_id = b.survey_village_id
             AND st.code = CASE b.milestone
                   WHEN 1 THEN 'GT_QC'
                   WHEN 2 THEN 'DATA_SUBMISSION'
                   ELSE 'FINAL_DELIVERABLES' END
             AND vs.state = 'COMPLETED')
      ORDER BY b.milestone DESC, b.id`, [programmeId])).rows;

  const keep = stale.filter(r => Number(r.milestone) === 3).slice(0, KEEP_LEGACY);
  const keepIds = new Set(keep.map(r => String(r.id)));
  const drop = stale.filter(r => !keepIds.has(String(r.id))).map(r => String(r.id));

  if (drop.length) {
    await pool.query("DELETE FROM survey_village_billing WHERE id = ANY($1::uuid[])", [drop]);
  }

  /*
   * And claims whose predecessor is missing.
   *
   * Removed from the top down, because dropping the first of three would
   * orphan the two above it — the loop runs until nothing more is orphaned.
   */
  let orphaned = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const r = await pool.query(
      `DELETE FROM survey_village_billing b
        USING survey_villages sv
        WHERE sv.id = b.survey_village_id AND sv.survey_project_id = $1
          AND b.milestone > 1 AND b.status <> 'REJECTED'
          AND NOT EXISTS (
            SELECT 1 FROM survey_village_billing e
             WHERE e.survey_village_id = b.survey_village_id
               AND e.milestone = b.milestone - 1 AND e.status <> 'REJECTED')`,
      [programmeId]);
    orphaned += r.rowCount ?? 0;
    if (!r.rowCount) break;
  }
  console.log(`  claims reconciled: ${drop.length} withdrawn, ${orphaned} orphaned`);

  console.log(`\ndone — ${NAME} (${programmeId})`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
