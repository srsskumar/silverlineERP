/**
 * A survey programme with a life behind it.
 *
 * The 100-village demo programme had stages and a scatter of daily returns,
 * which is enough to see that the screens work and not enough to see whether
 * they *say* anything. Nobody could ask it the questions the module exists to
 * answer: how many crew-days went into a finished village, how many days the
 * department sent nobody, which instruments sat idle and why, which villages
 * came in short of the extent the revenue record claims.
 *
 * So this fills in the life: a daily return for every working day a village
 * was being ground-truthed, each one carrying who turned up on both sides,
 * what each instrument did, and what was measured — then walks the village on
 * through the pipeline.
 *
 * Deliberately varied, because uniform data hides every bug worth finding.
 * Villages are dealt a profile by index so the set covers, on purpose:
 *
 *   - villages finished all the way to submission, and villages not started
 *   - days the department fielded nobody at all, and days they were short
 *   - days our own crew was short
 *   - every idle-rover reason, including instrument faults and no-show days
 *   - thin days with a reason attached
 *   - extents that came in over the record, under it, and bang on
 *
 * Additive and re-runnable: it never deletes, and it skips any village that
 * already carries returns from a previous run.
 *
 *   DATABASE_URL=<session pooler url> npx tsx src/scripts/seed-survey-lifecycle.ts
 */

import "../common/env.js";
import { createPool } from "../database/db.js";

const PROGRAMME = process.env.SEED_PROGRAMME ?? "Land Resurvey 2026";

/**
 * A deterministic generator, so a second run over a fresh database produces
 * the same programme. Debugging "the village that went wrong" is impossible
 * when the village is different every time.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Working days only: a resurvey crew does not file on a Sunday. */
function workingDaysBack(from: Date, count: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Every idle reason in the vocabulary, so each one has data behind it. */
const IDLE_REASONS = [
  "ROVER", "EQUIPMENT", "WEATHER", "ACCESS", "NO_DEPT_STAFF",
  "DATA_TECHNICAL", "EMPLOYEE", "FIELD_CONDITIONS", "DEPENDENCY",
] as const;

const THIN_REASONS = [
  "WEATHER", "ACCESS", "NO_DEPT_STAFF", "FIELD_CONDITIONS", "DEPENDENCY",
] as const;

/**
 * How far a village's surveyed extent lands from the revenue record.
 *
 * Spread on purpose: most villages come in close, a handful are well over
 * and a handful well under, so the "extent differs by more than x%" filter
 * has something real to find at every threshold anybody would type.
 */
function extentFactor(r: () => number, i: number): number {
  if (i % 17 === 0) return between(r, 1.14, 1.28);   // well over the record
  if (i % 13 === 0) return between(r, 0.70, 0.86);   // well under
  if (i % 7 === 0) return between(r, 1.04, 1.11);    // a little over
  if (i % 5 === 0) return between(r, 0.90, 0.97);    // a little under
  return between(r, 0.985, 1.015);                   // as recorded
}

/** Where each village gets to in the pipeline. */
type Profile = "SUBMITTED" | "RECORDS" | "VECTORIZED" | "GT_SIGNED"
  | "GT_DONE" | "GT_RUNNING" | "ON_HOLD" | "NOT_STARTED";

function profileFor(i: number): Profile {
  const n = i % 100;
  if (n < 12) return "SUBMITTED";
  if (n < 22) return "RECORDS";
  if (n < 34) return "VECTORIZED";
  if (n < 48) return "GT_SIGNED";
  if (n < 58) return "GT_DONE";
  if (n < 80) return "GT_RUNNING";
  if (n < 86) return "ON_HOLD";
  return "NOT_STARTED";
}

const STAGES_IN_ORDER = [
  "GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "VECTORIZATION_QC",
  "RECORDS_PREPARATION", "LPM_GENERATION", "SUBMISSION",
] as const;

/** How far through the pipeline each profile has reached. */
const REACHED: Record<Profile, number> = {
  SUBMITTED: 7, RECORDS: 5, VECTORIZED: 4, GT_SIGNED: 2,
  GT_DONE: 1, GT_RUNNING: 0, ON_HOLD: 0, NOT_STARTED: 0,
};

async function main(): Promise<void> {
  /*
   * The application's own pool factory, not a hand-rolled one.
   *
   * It resolves the TLS mode from the connection string and the environment
   * the same way the API does — a script that invents its own SSL handling
   * fails against the managed pooler with a certificate error that says
   * nothing about what to do next.
   */
  const pool = createPool(process.env.DATABASE_URL ?? "", process.env);
  const db = await pool.connect();

  try {
    const programme = (await db.query(
      "SELECT id, org_id FROM survey_projects WHERE name = $1", [PROGRAMME])).rows[0];
    if (!programme) throw new Error(`No programme called "${PROGRAMME}"`);
    const { id: projectId, org_id: orgId } = programme;

    const actor = (await db.query(
      "SELECT id FROM users WHERE org_id = $1 ORDER BY created_at LIMIT 1", [orgId])).rows[0];
    const userId = actor?.id ?? null;

    const measures = new Map<string, string>((await db.query(
      "SELECT id, code FROM survey_measures WHERE org_id = $1", [orgId])).rows
      .map(m => [String(m.code), String(m.id)]));
    const stageIds = new Map<string, string>((await db.query(
      "SELECT id, code FROM survey_stages WHERE org_id = $1", [orgId])).rows
      .map(m => [String(m.code), String(m.id)]));

    const villages = (await db.query(
      `SELECT sv.id, sv.total_extent_ac, ou.name
         FROM survey_villages sv JOIN org_units ou ON ou.id = sv.village_id
        WHERE sv.survey_project_id = $1 ORDER BY ou.name`, [projectId])).rows;

    console.log(`${PROGRAMME}: ${villages.length} villages`);

    let filled = 0, entries = 0, backfilled = 0;

    for (let i = 0; i < villages.length; i += 1) {
      const v = villages[i];
      const r = rng(1000 + i * 7919);
      const profile = profileFor(i);

      /*
       * Days that already exist are left exactly as they are.
       *
       * The unique key on (village, date) does that, so a re-run fills the
       * gaps rather than doubling the history — and a village that was
       * half-seeded by an earlier pass gets the rest of its days without
       * losing the ones it had.
       */
      await db.query("BEGIN");

      // Staffing agreed with the mandal, and the crew we field against it.
      const govtAllocated = 1 + Math.floor(r() * 3);   // 1-3
      const crewAllocated = 3 + Math.floor(r() * 4);   // 3-6
      await db.query(
        `UPDATE survey_villages
            SET gt_govt_staff_allocated = $2, gt_crew_allocated = $3,
                version = version + 1, updated_at = now(), updated_by = $4
          WHERE id = $1`, [v.id, govtAllocated, crewAllocated, userId]);

      const rovers = (await db.query(
        `SELECT asset_id FROM survey_rover_allocations
          WHERE survey_village_id = $1 AND released_on IS NULL LIMIT 3`, [v.id])).rows
        .map(x => String(x.asset_id));

      const crew = (await db.query(
        `SELECT employee_id FROM survey_crew
          WHERE survey_village_id = $1 AND released_on IS NULL LIMIT 6`, [v.id])).rows
        .map(x => String(x.employee_id));

      /*
       * Days written before this script existed, filled in.
       *
       * An earlier pass left a scatter of returns with no attendance on them
       * at all, and a village whose ground truthing ran for sixteen days but
       * only has attendance on three is not a village anybody can ask how
       * many crew-days went into it. Their quantities are left untouched —
       * only the columns that were never populated get written.
       */
      const bare = (await db.query(
        `SELECT e.id, e.entry_date
           FROM survey_entries e
          WHERE e.survey_village_id = $1
            AND (e.govt_staff_present IS NULL OR e.crew_present IS NULL)`, [v.id])).rows;

      for (let b = 0; b < bare.length; b += 1) {
        const roll = r();
        const govtPresent = roll < 0.11 ? 0
          : roll < 0.28 ? Math.max(0, govtAllocated - 1)
            : govtAllocated;
        const crewRoll = r();
        const crewPresent = crewRoll < 0.08 ? Math.max(1, crewAllocated - 2)
          : crewRoll < 0.20 ? Math.max(1, crewAllocated - 1)
            : crewAllocated;
        await db.query(
          `UPDATE survey_entries
              SET govt_staff_present = COALESCE(govt_staff_present, $2),
                  crew_present = COALESCE(crew_present, $3),
                  low_progress_reason = CASE
                    WHEN low_progress_reason IS NULL AND $2 = 0 THEN 'NO_DEPT_STAFF'
                    ELSE low_progress_reason END,
                  updated_at = now(), updated_by = $4
            WHERE id = $1`,
          [bare[b].id, govtPresent, crewPresent, userId]);
        backfilled += 1;

        // And what the instruments did, where that was never recorded either.
        for (let k = 0; k < rovers.length; k += 1) {
          const idle = govtPresent === 0 ? true : r() < 0.22;
          await db.query(
            `INSERT INTO survey_entry_rovers(org_id, entry_id, asset_id, status,
               idle_reason, area_ac, employee_id)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (entry_id, asset_id) DO NOTHING`,
            [orgId, bare[b].id, rovers[k],
              idle ? "IDLE" : "UTILIZED",
              idle ? (govtPresent === 0 ? "NO_DEPT_STAFF"
                : IDLE_REASONS[(i + b + k) % IDLE_REASONS.length]) : null,
              idle ? null : null,
              crew[k % Math.max(1, crew.length)] ?? null]);
        }
      }


      /*
       * A village with returns against it has been worked.
       *
       * The profile deals some villages as not started, but an earlier pass
       * left returns on a few of them — and a village that is "not started"
       * while carrying a fortnight of daily returns is a contradiction the
       * screens would faithfully display. Where the record says somebody was
       * there, the record wins and the village is treated as running.
       */
      const hasHistory = Number((await db.query(
        "SELECT count(*)::int n FROM survey_entries WHERE survey_village_id = $1",
        [v.id])).rows[0].n) > 0;
      const effectiveProfile: Profile =
        profile === "NOT_STARTED" && hasHistory ? "GT_RUNNING" : profile;
      if (effectiveProfile === "NOT_STARTED") { await db.query("COMMIT"); continue; }

      /*
       * How many days the village was walked, and the extent it came in at.
       *
       * A running village has filed some of its days; a finished one has
       * filed all of them. The extent is spread over the days rather than
       * split evenly, because a real return is never a twelfth of the total.
       */
      const totalAc = Number(v.total_extent_ac ?? 0) || between(r, 120, 900);
      const target = round(totalAc * extentFactor(r, i), 3);
      const days = effectiveProfile === "GT_RUNNING" || effectiveProfile === "ON_HOLD"
        ? 4 + Math.floor(r() * 6)
        : 8 + Math.floor(r() * 10);

      const started = new Date();
      started.setUTCDate(started.getUTCDate() - 2);

      /*
       * Only the days this village does not already have.
       *
       * An earlier pass left some villages with a scatter of returns. Those
       * days are left exactly as they are, but they also cannot carry a
       * share of the extent being laid down now — writing over them is
       * refused by the unique key, and counting on them would leave the
       * village short of the extent it was meant to reach, which is the one
       * figure this data exists to make meaningful.
       */
      const existing = new Set((await db.query(
        `SELECT entry_date FROM survey_entries WHERE survey_village_id = $1`, [v.id])).rows
        .map(x => new Date(x.entry_date).toISOString().slice(0, 10)));
      const dates = workingDaysBack(started, days).filter(d => !existing.has(d));
      if (dates.length === 0) { await db.query("COMMIT"); continue; }

      // Weights, so the daily figures vary the way real ones do.
      const weights = dates.map(() => 0.4 + r());
      // A running village has only covered part of its extent so far.
      const wanted = effectiveProfile === "GT_RUNNING" || effectiveProfile === "ON_HOLD"
        ? target * between(r, 0.35, 0.75) : target;

      /*
       * What the village is already credited with, from days written before.
       *
       * Laid down on top rather than instead of: the village reaches the
       * extent it was meant to reach, counting everything already on its
       * record.
       */
      const already = Number((await db.query(
        `SELECT COALESCE(sum(ev.quantity), 0) q
           FROM survey_entries e
           JOIN survey_entry_values ev ON ev.entry_id = e.id
           JOIN survey_measures m ON m.id = ev.measure_id AND m.basis = 'EXTENT'
          WHERE e.survey_village_id = $1`, [v.id])).rows[0].q);
      const covered = Math.max(0, wanted - already);

      /*
       * A day the department sent nobody produces almost nothing, and those
       * days have to come out of the *distribution* rather than off the
       * total — otherwise every village with absences quietly lands short of
       * the extent it was supposed to reach, and the variance against the
       * revenue record stops meaning what it says.
       *
       * So attendance is rolled first, the day factors are known up front,
       * and the shares are normalised over them.
       */
      const dayRolls = dates.map(() => ({ govt: r(), crew: r(), thin: r() }));
      const dayFactors = dayRolls.map(d => (d.govt < 0.11 ? between(r, 0.02, 0.12) : 1));
      const effective = weights.map((wt, k) => wt * dayFactors[k]);
      const effectiveSum = effective.reduce((t, x) => t + x, 0) || 1;

      for (let d = 0; d < dates.length; d += 1) {
        const date = dates[d];

        /*
         * Who turned up.
         *
         * Most days everybody does. Roughly one day in nine the department
         * sends nobody at all, and one in six they are short — which is the
         * pattern the attendance report exists to surface. Our own crew is
         * short less often, and occasionally over strength when a
         * neighbouring village lends people.
         */
        const roll = dayRolls[d].govt;
        const govtPresent = roll < 0.11 ? 0
          : roll < 0.28 ? Math.max(0, govtAllocated - 1)
            : govtAllocated;
        const crewRoll = dayRolls[d].crew;
        const crewPresent = crewRoll < 0.08 ? Math.max(1, crewAllocated - 2)
          : crewRoll < 0.20 ? Math.max(1, crewAllocated - 1)
            : crewRoll > 0.96 ? crewAllocated + 1
              : crewAllocated;

        // The village still reaches the extent it was meant to; the days
        // nobody came are made up on the days somebody did, which is what
        // happens on the ground.
        const acresToday = round(covered * (effective[d] / effectiveSum), 3);
        const thin = govtPresent === 0 || dayRolls[d].thin < 0.12;

        const entry = (await db.query(
          `INSERT INTO survey_entries(org_id, survey_project_id, survey_village_id, entry_date,
             teams_deployed, dgps_base, dgps_rovers, notes,
             low_progress_reason, low_progress_remarks,
             govt_staff_present, crew_present, created_by, updated_by)
           VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
           ON CONFLICT (survey_village_id, entry_date) DO NOTHING
           RETURNING id`,
          [orgId, projectId, v.id, date,
            Math.max(1, Math.round(crewPresent / 2)), 1, rovers.length,
            thin && govtPresent === 0 ? "Crew stood down; no revenue staff on site" : null,
            thin ? (govtPresent === 0 ? "NO_DEPT_STAFF" : pick(r, THIN_REASONS)) : null,
            thin && govtPresent === 0 ? "VRO did not attend" : null,
            govtPresent, crewPresent, userId])).rows[0];
        if (!entry) continue;
        entries += 1;

        /*
         * What each instrument did.
         *
         * An instrument idles when there is nobody to walk with, when it
         * faults, and for every other reason in the vocabulary — each of
         * which needs data behind it or the idle-reason breakdown is a
         * screen nobody has ever seen populated.
         */
        for (let k = 0; k < rovers.length; k += 1) {
          const idle = govtPresent === 0 ? true : r() < 0.22;
          /*
           * Cycled rather than drawn at random.
           *
           * A random pick over nine reasons and a handful of idle days
           * leaves most of the vocabulary with no data behind it, and the
           * idle-reason breakdown is then a screen nobody has ever seen
           * populated. Walking the list guarantees every reason appears.
           */
          const reason = govtPresent === 0
            ? "NO_DEPT_STAFF"
            : IDLE_REASONS[(i + d + k) % IDLE_REASONS.length];
          await db.query(
            `INSERT INTO survey_entry_rovers(org_id, entry_id, asset_id, status,
               idle_reason, remarks, area_ac, employee_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (entry_id, asset_id) DO NOTHING`,
            [orgId, entry.id, rovers[k],
              idle ? "IDLE" : "UTILIZED",
              idle ? reason : null,
              // A remark on the reasons that need one on the ground: a
              // fault is a maintenance job and wants saying which fault.
              idle && (reason === "ROVER" || reason === "EQUIPMENT")
                ? "Base would not initialise; swapped at midday" : null,
              idle ? null : round(acresToday / Math.max(1, rovers.length), 3),
              crew[k % Math.max(1, crew.length)] ?? null]);
        }

        // What was measured. Points track extent but never exactly — a
        // hamlet boundary is a lot of points over very little ground.
        const values: Array<[string, number]> = [
          ["GOVT_LAND_EXTENT_AC", round(acresToday * 0.38, 3)],
          ["PRIVATE_LAND_EXTENT_AC", round(acresToday * 0.62, 3)],
          ["GOVT_LAND_POINTS", Math.round(acresToday * between(r, 1.6, 3.2))],
          ["PRIVATE_LAND_POINTS", Math.round(acresToday * between(r, 3.0, 6.5))],
          ["VILLAGE_BOUNDARY_POINTS", Math.round(acresToday * between(r, 0.2, 0.6))],
          ["HABITATION_BOUNDARY_POINTS", Math.round(acresToday * between(r, 0.4, 1.4))],
        ];
        for (const [code, qty] of values) {
          const measureId = measures.get(code);
          if (!measureId || qty <= 0) continue;
          await db.query(
            `INSERT INTO survey_entry_values(org_id, entry_id, measure_id, quantity)
             VALUES($1,$2,$3,$4) ON CONFLICT (entry_id, measure_id) DO NOTHING`,
            [orgId, entry.id, measureId, qty]);
        }
      }

      /* ------------------------------------------------- the pipeline */

      const firstDay = dates[0], lastDay = dates[dates.length - 1];
      const reached = REACHED[effectiveProfile];

      for (let sIdx = 0; sIdx < STAGES_IN_ORDER.length; sIdx += 1) {
        const code = STAGES_IN_ORDER[sIdx];
        const stageId = stageIds.get(code);
        if (!stageId) continue;

        let state: string | null = null;
        let startedOn: string | null = null, completedOn: string | null = null;

        if (sIdx < reached) {
          state = "COMPLETED";
          startedOn = sIdx === 0 ? firstDay : lastDay;
          completedOn = lastDay;
        } else if (sIdx === reached) {
          state = effectiveProfile === "ON_HOLD" ? "ON_HOLD" : "IN_PROGRESS";
          startedOn = sIdx === 0 ? firstDay : lastDay;
        }
        if (!state) continue;

        await db.query(
          `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state,
             started_on, completed_on, remarks, updated_by)
           VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8)
           ON CONFLICT (survey_village_id, stage_id)
           DO UPDATE SET state = EXCLUDED.state, started_on = EXCLUDED.started_on,
                         completed_on = EXCLUDED.completed_on, remarks = EXCLUDED.remarks,
                         updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [orgId, v.id, stageId, state, startedOn, completedOn,
            effectiveProfile === "ON_HOLD" && sIdx === reached
              ? "Waiting on the mandal to confirm two disputed parcels" : null,
            userId]);

        // The history behind it, so time-in-stage is answerable.
        await db.query(
          `INSERT INTO survey_stage_history(org_id, survey_village_id, stage_id,
             from_state, to_state, remarks, changed_by, changed_at)
           VALUES($1,$2,$3,'NOT_STARTED',$4,$5,$6,$7::date)`,
          [orgId, v.id, stageId, state, null, userId, startedOn ?? lastDay]);
      }

      /*
       * A control point for every village that has been walked (§069).
       *
       * Coordinates scattered around coastal Andhra, to seven decimals. One
       * village in twenty gets a second point, which is what happens on a
       * large or awkward one.
       */
      const lat = round(between(r, 15.7, 18.4), 7);
      const lng = round(between(r, 79.9, 83.6), 7);

      /*
       * The same point on a grid (§070).
       *
       * Coastal Andhra sits in UTM 44N. These are plausible eastings and
       * northings for that zone rather than a true projection of the
       * latitude and longitude above — the point of the demo data is that
       * both columns are populated and legible, not that they agree to the
       * millimetre.
       *
       * One village in nine is left with a geographic fix only, because a
       * controller that gave one and not the other is a real case and the
       * screen has to read properly when the grid columns are empty.
       */
      const hasGrid = i % 9 !== 0;
      const easting = hasGrid ? round(between(r, 210_000, 790_000), 3) : null;
      const northing = hasGrid ? round(between(r, 1_730_000, 2_040_000), 3) : null;

      await db.query(
        `INSERT INTO survey_village_gcps(org_id, survey_village_id, point_code,
           latitude, longitude, elevation_m, easting_m, northing_m, grid_zone,
           remarks, established_on, created_by, updated_by)
         VALUES($1,$2,'GCP-1',$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$11)
         ON CONFLICT (survey_village_id, point_code) DO NOTHING`,
        [orgId, v.id, lat, lng, round(between(r, 8, 210), 3),
          easting, northing, hasGrid ? '44N' : null,
          `Tied to BM ${10 + Math.floor(r() * 90)}; ${
            30 + Math.floor(r() * 40)} min base observation, PDOP ${round(between(r, 1.1, 2.4), 1)}`,
          firstDay, userId]);
      if (i % 20 === 0) {
        await db.query(
          `INSERT INTO survey_village_gcps(org_id, survey_village_id, point_code,
             latitude, longitude, elevation_m, easting_m, northing_m, grid_zone,
             remarks, established_on, created_by, updated_by)
           VALUES($1,$2,'GCP-2',$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$11)
           ON CONFLICT (survey_village_id, point_code) DO NOTHING`,
          [orgId, v.id, round(lat + between(r, 0.004, 0.02), 7),
            round(lng + between(r, 0.004, 0.02), 7), round(between(r, 8, 210), 3),
            easting === null ? null : round(easting + between(r, 400, 2200), 3),
            northing === null ? null : round(northing + between(r, 400, 2200), 3),
            hasGrid ? '44N' : null,
            "Second point; village straddles a ridge and one base could not see both halves",
            firstDay, userId]);
      }

      /*
       * Certified totals on a handful of finished villages (§068).
       *
       * A recount at handover, differing from the running sum by a little —
       * which is the case the certified-vs-recorded columns exist to show.
       */
      if (reached >= 2 && i % 11 === 0) {
        const code = "GOVT_LAND_EXTENT_AC";
        const measureId = measures.get(code);
        const recorded = (await db.query(
          `SELECT COALESCE(sum(ev.quantity), 0) q
             FROM survey_entry_values ev
             JOIN survey_entries e ON e.id = ev.entry_id
            WHERE e.survey_village_id = $1 AND ev.measure_id = $2`, [v.id, measureId])).rows[0];
        const sum = Number(recorded.q);
        if (measureId && sum > 0) {
          await db.query(
            `INSERT INTO survey_village_finals(org_id, survey_village_id, measure_id,
               quantity, reason, certified_by, created_by, updated_by)
             VALUES($1,$2,$3,$4,$5,$6,$6,$6)
             ON CONFLICT (survey_village_id, measure_id) DO NOTHING`,
            [orgId, v.id, measureId, round(sum * between(r, 0.96, 1.03), 3),
              "Recount at handover; two parcels merged with the adjoining survey number",
              userId]);
        }
      }

      await db.query("COMMIT");
      filled += 1;
      if (filled % 10 === 0) console.log(`  ${filled} villages filled…`);
    }

    console.log(`
filled ${filled} villages`);
    console.log(`${entries} daily returns written, ${backfilled} earlier ones filled in`);

    const shape = (await db.query(
      `SELECT
         (SELECT count(*)::int FROM survey_entries WHERE survey_project_id = $1) AS entries,
         (SELECT count(*)::int FROM survey_entries
           WHERE survey_project_id = $1 AND govt_staff_present = 0) AS no_dept_days,
         (SELECT count(*)::int FROM survey_entry_rovers er
            JOIN survey_entries e ON e.id = er.entry_id
           WHERE e.survey_project_id = $1 AND er.status = 'IDLE') AS idle_rover_days,
         (SELECT count(DISTINCT er.idle_reason) FROM survey_entry_rovers er
            JOIN survey_entries e ON e.id = er.entry_id
           WHERE e.survey_project_id = $1 AND er.status = 'IDLE') AS idle_reasons,
         (SELECT count(*)::int FROM survey_village_gcps g
            JOIN survey_villages sv ON sv.id = g.survey_village_id
           WHERE sv.survey_project_id = $1) AS control_points`,
      [projectId])).rows[0];
    console.log("shape:", shape);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
