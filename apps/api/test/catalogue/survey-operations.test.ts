/**
 * Field operations (§59, phases 1-3 of the specification).
 *
 * The principle being tested is the one the specification states: daily
 * operational activity is the source of truth. A rover's day, a thin day's
 * reason, and every stage movement all have to be recorded where they happen
 * and roll up without anybody retyping them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";
import { runSurveyAlerts } from "../../src/modules/jobs/surveyAlerts.js";

let w: CatalogueWorld;
let programmeId: string;
let villageA: string;
let roverA: string;
let roverB: string;

async function send(
  method: "POST" | "GET" | "PATCH", headers: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

async function makeRover(code: string): Promise<string> {
  const r = await w.pool.query(
    `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
     VALUES($1,$2,$3,'SURVEY','AVAILABLE','GOOD') RETURNING id`,
    [w.orgId, code, `Rover ${code}`]);
  return String(r.rows[0].id);
}

const day = (n: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'ASR') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'KOYYURU',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const village = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,'ADAKULA',$3) RETURNING id`,
    [w.orgId, uniq("V"), mandal])).rows[0].id);

  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Operations programme" });
  programmeId = String(p.data.id);
  // Below five acres a day is low progress on this programme.
  await w.pool.query(
    "UPDATE survey_projects SET low_progress_threshold_ac = 5 WHERE id = $1", [programmeId]);

  const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_id: village, total_extent_ac: 100 });
  villageA = String(sv.data.id);

  roverA = await makeRover(uniq("RA"));
  roverB = await makeRover(uniq("RB"));
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the pipeline the specification describes", () => {
  it("runs GT, QC, vectorization, vectorization QC, records, LPM, submission", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress`);
    const codes = r.data.pipeline.map((s: any) => s.code);
    expect(codes).toEqual([
      "GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "VECTORIZATION_QC",
      "RECORDS_PREPARATION", "LPM_GENERATION", "SUBMISSION", "REWORK",
    ]);
  });

  it("leaves rework enterable from wherever the work failed", async () => {
    // It is not reached in sequence, so it has no predecessor to wait for.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress`);
    const rework = r.data.pipeline.find((s: any) => s.code === "REWORK");
    expect(rework.requires).toBeNull();
  });
});

describe("a rover's day", () => {
  it("records a row per rover rather than a count", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(0), teams_deployed: 2,
      values: { GOVT_LAND_EXTENT_AC: 6 },
      rovers: [
        { asset_id: roverA, status: "UTILIZED", area_ac: 6 },
        { asset_id: roverB, status: "IDLE", idle_reason: "WEATHER" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const rows = await w.pool.query(
      "SELECT status, idle_reason FROM survey_entry_rovers WHERE entry_id = $1 ORDER BY status",
      [r.data.id]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ status: "IDLE", idle_reason: "WEATHER" });
  });

  it("derives the rover count from the rows, so the two cannot disagree", async () => {
    const e = await w.pool.query(
      "SELECT dgps_rovers FROM survey_entries WHERE survey_village_id = $1 AND entry_date = $2",
      [villageA, day(0)]);
    // One of the two was in use.
    expect(e.rows[0].dgps_rovers).toBe(1);
  });

  it("ignores a rover count the payload disagrees with", async () => {
    // The screen shows the rovers assigned to the village and does not let
    // anybody type over it, but the API is the boundary that has to hold: a
    // count that disagrees with the instruments named beside it makes the
    // utilisation figures answer a question nobody asked.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-2), teams_deployed: 1,
      dgps_rovers: 99,
      values: { GOVT_LAND_EXTENT_AC: 8 },
      rovers: [
        { asset_id: roverA, status: "UTILIZED", area_ac: 8 },
        { asset_id: roverB, status: "IDLE", idle_reason: "WEATHER" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const e = await w.pool.query(
      "SELECT dgps_rovers FROM survey_entries WHERE id = $1", [r.data.id]);
    // One of the two named rovers was in use. Not ninety-nine.
    expect(e.rows[0].dgps_rovers).toBe(1);
  });

  it("refuses an idle rover with no reason", async () => {
    // An idle count with no reasons behind it is not a finding anybody can use.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("ROVER_DAY_INVALID");
    expect(r.body.message).toContain("must say why");
  });

  it("refuses \"other\" with nothing written", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE", idle_reason: "OTHER" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain("must say what happened");
  });

  it("names every problem at once rather than one per attempt", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-1), values: {},
      rovers: [
        { asset_id: roverA, status: "IDLE" },
        { asset_id: roverB, status: "UTILIZED", idle_reason: "WEATHER" },
      ],
    });
    expect(r.body.message).toContain("must say why");
    expect(r.body.message).toContain("cannot also carry an idle reason");
  });

  it("refuses a reason it does not know", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE", idle_reason: "HUNGOVER" }],
    });
    expect(r.status).toBe(422);
  });
});

describe("a thin day", () => {
  it("demands a reason when the day is below the programme threshold", async () => {
    // Five acres is the threshold on this programme; two is below it.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-3),
      values: { GOVT_LAND_EXTENT_AC: 2 },
      rovers: [{ asset_id: roverA, status: "UTILIZED", area_ac: 2 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("LOW_PROGRESS_REASON_REQUIRED");
    // The refusal states the figure and the threshold rather than "too low".
    expect(r.body.message).toContain("below the 5 acre threshold");
  });

  it("accepts the day once a reason is given", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-3),
      values: { GOVT_LAND_EXTENT_AC: 2 },
      rovers: [{ asset_id: roverA, status: "UTILIZED", area_ac: 2 }],
      low_progress_reason: "ACCESS",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("demands nothing of a day that meets the threshold", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-6),
      values: { GOVT_LAND_EXTENT_AC: 9 },
      rovers: [{ asset_id: roverA, status: "UTILIZED", area_ac: 9 }],
    });
    expect(r.status).toBe(201);
  });

  it("demands nothing where the programme sets no threshold", async () => {
    // Nagging a crew to explain a rule nobody set is how a form gets ignored.
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "No threshold" });
    const v = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id)
       SELECT $1,'village',$2,'Elsewhere',id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1
       RETURNING id`, [w.orgId, uniq("V")])).rows[0].id);
    const sv = await post(w.admin, `/api/v1/survey/projects/${other.data.id}/villages`,
      { village_id: v, total_extent_ac: 50 });
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: sv.data.id, entry_date: day(0),
      values: { GOVT_LAND_EXTENT_AC: 0.1 },
      rovers: [{ asset_id: roverB, status: "UTILIZED" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe("stage history", () => {
  it("keeps every movement, so time spent per stage is answerable", async () => {
    // The specification's worked example: nine days in GT, two in QC.
    await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: day(0) });
    await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "COMPLETED",
        started_on: day(0), completed_on: day(9), remarks: "All parcels walked" });

    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/history`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.movements.length).toBeGreaterThanOrEqual(2);
    const first = r.data.movements[0];
    expect(first.from_state).toBeNull();
    expect(first.to_state).toBe("IN_PROGRESS");
    expect(first.changed_by_name).toBeTruthy();
  });

  it("records what a stage moved from, not only what it moved to", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/history`);
    const completion = r.data.movements.find((m: any) => m.to_state === "COMPLETED");
    expect(completion.from_state).toBe("IN_PROGRESS");
    expect(completion.remarks).toBe("All parcels walked");
  });

  it("does not record a movement that changed nothing", async () => {
    const before = (await get(w.admin, `/api/v1/survey/villages/${villageA}/history`))
      .data.movements.length;
    await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "COMPLETED",
        started_on: day(0), completed_on: day(9) });
    const after = (await get(w.admin, `/api/v1/survey/villages/${villageA}/history`))
      .data.movements.length;
    expect(after).toBe(before);
  });
});

describe("hold and rework", () => {
  it("overrides the derived status, because a hold is a decision", async () => {
    const r = await post({ ...w.admin, ...(await ver("survey_villages", villageA)) },
      `/api/v1/survey/villages/${villageA}/status`,
      { status_override: "ON_HOLD", status_remarks: "Landowner dispute" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const villages = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    const v = villages.data.find((x: any) => x.id === villageA);
    expect(v.status).toBe("ON_HOLD");
    // The stages still say what they said; the hold sits beside them.
    expect(v.state).toBe("IN_PROGRESS");
  });

  it("demands a reason for a hold", async () => {
    const r = await post({ ...w.admin, ...(await ver("survey_villages", villageA)) },
      `/api/v1/survey/villages/${villageA}/status`, { status_override: "REWORK" });
    expect(r.status).toBe(422);
  });

  it("returns to the derived status when the hold is lifted", async () => {
    const r = await post({ ...w.admin, ...(await ver("survey_villages", villageA)) },
      `/api/v1/survey/villages/${villageA}/status`,
      { status_override: null, status_remarks: "Dispute settled" });
    expect(r.status).toBe(200);
    const villages = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    expect(villages.data.find((x: any) => x.id === villageA).status).toBe("IN_PROGRESS");
  });
});

describe("the village plan", () => {
  it("takes the extent and the expected date the GT user enters", async () => {
    // The import often arrives with the extent column empty; this is where it
    // gets filled in.
    const r = await patch({ ...w.admin, ...(await ver("survey_villages", villageA)) },
      `/api/v1/survey/villages/${villageA}/plan`,
      { total_extent_ac: 120, expected_completion_on: day(30) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const villages = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    const v = villages.data.find((x: any) => x.id === villageA);
    expect(Number(v.total_extent_ac)).toBe(120);
    expect(v.expected_completion_on).toBe(day(30));
  });
});

describe("who is on the programme", () => {
  it("puts an employee on a programme with a role", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/employees`,
      { employee_id: w.directEmployee, project_role: "GT_USER" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const list = await get(w.admin, `/api/v1/survey/projects/${programmeId}/employees`);
    expect(list.data[0].employee_name).toBeTruthy();
    expect(list.data[0].project_role).toBe("GT_USER");
  });

  it("lets the same person hold a different role on another programme", async () => {
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Second programme" });
    const r = await post(w.admin, `/api/v1/survey/projects/${other.data.id}/employees`,
      { employee_id: w.directEmployee, project_role: "QC_USER" });
    expect(r.status).toBe(201);
  });

  it("re-assigning updates the role rather than refusing", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/employees`,
      { employee_id: w.directEmployee, project_role: "TEAM_LEAD" });
    expect(r.status).toBe(201);
    const list = await get(w.admin, `/api/v1/survey/projects/${programmeId}/employees`);
    expect(list.data.find((e: any) => e.employee_id === w.directEmployee).project_role)
      .toBe("TEAM_LEAD");
  });

  it("is refused to somebody who cannot assign", async () => {
    const r = await post(w.role.EMPLOYEE, `/api/v1/survey/projects/${programmeId}/employees`,
      { employee_id: w.siteEmployee });
    expect(r.status).toBe(403);
  });
});

describe("productivity and forecasting", () => {
  it("measures an employee from the daily returns, not from anything typed", async () => {
    // An output figure somebody types is a figure somebody chose.
    const entry = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(-4),
      values: { GOVT_LAND_EXTENT_AC: 8 },
      rovers: [
        { asset_id: roverA, status: "UTILIZED", area_ac: 8, employee_id: w.directEmployee },
        { asset_id: roverB, status: "IDLE", idle_reason: "ROVER",
          employee_id: w.directEmployee },
      ],
    });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);

    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/employee-productivity`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.data.employees.find((e: any) => e.employee_id === w.directEmployee);
    expect(row.employee_name).toBeTruthy();
    expect(Number(row.area_ac)).toBe(8);
    expect(row.rover_days_used).toBe(1);
    expect(row.rover_days_idle).toBe(1);
    expect(row.rover_utilisation_pct).toBe(50);
  });

  it("averages an employee over days worked, not calendar days", async () => {
    // The days they were not out are not theirs.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/employee-productivity`);
    const row = r.data.employees.find((e: any) => e.employee_id === w.directEmployee);
    expect(row.avg_daily_ac).toBe(8);
  });

  it("groups a rover's idle days by the reason given", async () => {
    // "Three idle days" is a number; "three idle days, all rover fault" is a
    // maintenance job.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/rover-productivity`);
    expect(r.status).toBe(200);
    const rover = r.data.rovers.find((x: any) => x.asset_id === roverB);
    expect(rover.idle_days).toBeGreaterThan(0);
    // Contains rather than first: two reasons with one day each have no
    // meaningful order between them, and asserting one would be asserting
    // the sort's tie-breaking rather than the grouping.
    expect(rover.idle_reasons).toContainEqual(
      expect.objectContaining({ reason: "ROVER", label: "Rover issue" }));
  });

  it("reports a rover's utilisation against the days it was assigned", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/rover-productivity`);
    const rover = r.data.rovers.find((x: any) => x.asset_id === roverA);
    expect(rover.assigned_days).toBe(rover.utilized_days + rover.idle_days);
    expect(rover.utilisation_pct).toBeGreaterThan(0);
  });
});

describe("bottlenecks", () => {
  it("finds a village sitting past its expected completion", async () => {
    await patch({ ...w.admin, ...(await ver("survey_villages", villageA)) },
      `/api/v1/survey/villages/${villageA}/plan`, { expected_completion_on: day(-5) });

    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/bottlenecks`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stuck = r.data.bottlenecks.find((b: any) => b.villageId === villageA);
    expect(stuck.kinds).toContain("PAST_EXPECTED_COMPLETION");
  });

  it("counts the kinds, so a dashboard can say what sort of trouble it is in", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/bottlenecks`);
    expect(r.data.by_kind).toHaveProperty("PAST_EXPECTED_COMPLETION");
  });

  it("reports idle rovers as a bottleneck in their own right", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/bottlenecks`);
    const stuck = r.data.bottlenecks.find((b: any) => b.villageId === villageA);
    expect(stuck.kinds).toContain("ROVERS_IDLE");
  });
});

describe("the forecast is management information", () => {
  it("keeps the target and the projection apart", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/forecast`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.forecast).toHaveProperty("targetDate");
    expect(r.data.forecast).toHaveProperty("forecastDate");
    expect(r.data.forecast).toHaveProperty("requiredPaceAcPerDay");
  });

  it("reports village completion and area completion separately", async () => {
    // The specification is explicit that these are not interchangeable.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/forecast`);
    expect(r.data).toHaveProperty("village_completion_pct");
    expect(r.data).toHaveProperty("area_completion_pct");
  });

  it("gives the recent rates, because a lifetime average hides a slowdown", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/forecast`);
    for (const k of ["last_7_days_ac_per_day", "last_14_days_ac_per_day", "last_30_days_ac_per_day"]) {
      expect(r.data.recent_pace, k).toHaveProperty(k);
    }
  });

  it("is refused to a crew member", async () => {
    // "Employees should not see management-only forecast information."
    const r = await get(w.role.EMPLOYEE, `/api/v1/survey/projects/${programmeId}/forecast`);
    expect(r.status).toBe(403);
  });

  it("is refused to a team lead", async () => {
    const r = await get(w.role.TEAM_LEAD, `/api/v1/survey/projects/${programmeId}/forecast`);
    expect(r.status).toBe(403);
  });

  it("is allowed to a project manager", async () => {
    const r = await get(w.role.PROJECT_MANAGER, `/api/v1/survey/projects/${programmeId}/forecast`);
    expect(r.status).toBe(200);
  });
});

describe("project-scoped visibility", () => {
  it("shows an administrator every programme", async () => {
    const r = await get(w.admin, "/api/v1/survey/projects");
    expect(r.data.length).toBeGreaterThan(1);
  });

  it("shows an employee only the programmes they are on", async () => {
    // Without this an employee could read every district's figures.
    const mine = await get(w.directUser, "/api/v1/survey/projects");
    expect(mine.status).toBe(200);
    const ids = mine.data.map((p: any) => p.id);
    expect(ids).toContain(programmeId);
    // The other programmes created in this file are not theirs.
    const all = await get(w.admin, "/api/v1/survey/projects");
    expect(ids.length).toBeLessThan(all.data.length);
  });

  it("shows nothing to an employee on no programme at all", async () => {
    // An empty list must be an empty result, not every programme, which is
    // what a missing filter silently produces.
    const r = await get(w.siteUser, "/api/v1/survey/projects");
    expect(r.status).toBe(200);
    expect(r.data).toEqual([]);
  });

  it("answers 404 rather than 403 for a programme they may not see", async () => {
    // Telling somebody a programme exists that they may not see is itself a
    // disclosure.
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Not theirs" });
    const r = await get(w.directUser, `/api/v1/survey/projects/${other.data.id}/progress`);
    expect(r.status).toBe(404);
  });

  it("lets them read the programme they are on", async () => {
    const r = await get(w.directUser, `/api/v1/survey/projects/${programmeId}/progress`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("hides a disabled programme from the crew but not from an administrator", async () => {
    // Disabling is a visibility decision; the data stays exactly where it is.
    await w.pool.query("UPDATE survey_projects SET status = 'DISABLED' WHERE id = $1",
      [programmeId]);
    const crew = await get(w.directUser, "/api/v1/survey/projects");
    expect(crew.data.map((p: any) => p.id)).not.toContain(programmeId);

    const admin = await get(w.admin, "/api/v1/survey/projects");
    expect(admin.data.map((p: any) => p.id)).toContain(programmeId);

    // And nothing was deleted.
    const villages = await w.pool.query(
      "SELECT count(*)::int AS n FROM survey_villages WHERE survey_project_id = $1",
      [programmeId]);
    expect(villages.rows[0].n).toBeGreaterThan(0);
    await w.pool.query("UPDATE survey_projects SET status = 'ACTIVE' WHERE id = $1",
      [programmeId]);
  });
});

describe("punching in and out against a village", () => {
  /**
   * A punch, as the mobile app sends one.
   *
   * Without coordinates by default. This employee carries a geofence
   * assignment, and a punch outside it is correctly queued for review rather
   * than opening the day — which is the fence working, and not what these
   * tests are about. One test below sends coordinates deliberately.
   */
  async function punch(
    type: "CHECK_IN" | "CHECK_OUT", extra: Record<string, unknown> = {},
  ) {
    return post(w.directUser, "/api/v1/attendance/events", {
      employee_id: w.directEmployee,
      event_type: type,
      client_timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  /**
   * Clear the day and open it again.
   *
   * A check-out against a day that is already closed is a no-op -- the route
   * hands back the check-out that closed it. Several of these tests need a
   * genuinely open day to say anything about the gate at all, and sharing one
   * day between them made an earlier test's check-out answer a later one's.
   */
  async function freshDay(villageId?: string) {
    await w.pool.query(
      `DELETE FROM attendance_records WHERE employee_id = $1 AND work_date = $2::date`,
      [w.directEmployee, workDate()]);
    await w.pool.query(
      `DELETE FROM attendance_events WHERE employee_id = $1
         AND server_timestamp >= $2::date`, [w.directEmployee, workDate()]);
    await punch("CHECK_IN", villageId ? { survey_village_id: villageId } : {});
  }

  it("records which village the punch was for", async () => {
    // Attendance already captured the time, the position and the geofence.
    // Which village the person turned up *for* was the missing piece.
    const r = await punch("CHECK_IN", { survey_village_id: villageA });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const row = await w.pool.query(
      `SELECT survey_village_id FROM attendance_events
       WHERE employee_id = $1 AND event_type = 'CHECK_IN'
       ORDER BY server_timestamp DESC LIMIT 1`, [w.directEmployee]);
    expect(String(row.rows[0].survey_village_id)).toBe(villageA);
  });

  it("still captures the position, which it always did", async () => {
    // A punch outside the fence is queued for review; either way the event
    // is stored with its coordinates, and the village travels with it.
    const r = await post(w.siteUser, "/api/v1/attendance/events", {
      employee_id: w.siteEmployee,
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      latitude: 17.6868, longitude: 83.2185, gps_accuracy: 8,
      survey_village_id: villageA,
    });
    expect([201, 202]).toContain(r.status);

    const row = await w.pool.query(
      `SELECT lat, lng, gps_accuracy, survey_village_id FROM attendance_events
       WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [w.siteEmployee]);
    expect(Number(row.rows[0].lat)).toBeCloseTo(17.6868, 3);
    expect(String(row.rows[0].survey_village_id)).toBe(villageA);
  });

  it("refuses to close the day while the return is unfiled", async () => {
    // A village with nothing filed for today. villageA already has a return
    // from the rover tests above, and the gate would correctly let that one
    // through.
    const unfiled = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Unfiled village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });

    await freshDay(unfiled.data.id);
    const r = await punch("CHECK_OUT", { survey_village_id: unfiled.data.id });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DAILY_PROGRESS_REQUIRED");
    expect(r.body.message).toContain("before punching out");
  });

  it("lets them close the day by saying why they cannot file it", async () => {
    // Requiring it absolutely would strand a crew member with a dead battery:
    // they could not punch out at all, and corrupt attendance is worse than a
    // late return.
    const unfiled = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Deferred village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });

    await freshDay(unfiled.data.id);
    const r = await punch("CHECK_OUT", {
      survey_village_id: unfiled.data.id,
      progress_deferred_reason: "DATA_TECHNICAL",
      progress_deferred_remarks: "No signal at the site all day",
    });
    // 201 when the punch opens the day's record, 200 when it closes one that
    // is already open. Which of the two is attendance's affair; what matters
    // here is that the survey gate let it through.
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);

    const row = await w.pool.query(
      `SELECT progress_deferred_reason FROM attendance_events
       WHERE employee_id = $1 AND event_type = 'CHECK_OUT'
         AND survey_village_id = $2`, [w.directEmployee, unfiled.data.id]);
    // Recorded rather than silent.
    expect(row.rows[0].progress_deferred_reason).toBe("DATA_TECHNICAL");
  });

  it("will not take \"other\" as a reason with nothing written", async () => {
    // A reason nobody can read is the same as no reason. The table refuses it
    // too; this says so as a validation failure rather than a fault.
    await freshDay(villageA);
    const r = await punch("CHECK_OUT", {
      survey_village_id: villageA,
      progress_deferred_reason: "OTHER",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("VALIDATION_ERROR");
  });

  it("never refuses a punch that already happened in the field", async () => {
    // The crew works with no signal for hours. Punches go into the offline
    // queue and replay later, and the queue gives up on a rejected op -- so
    // refusing a replay would delete a punch that physically occurred and
    // leave the person shown as still on site. Worse than a late return.
    const unfiled = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Offline village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });

    await freshDay(unfiled.data.id);
    const r = await punch("CHECK_OUT", {
      survey_village_id: unfiled.data.id,
      queued_offline: true,
    });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);

    // Accepted, but not silently: the unfiled return is on the record for
    // somebody to chase.
    const row = await w.pool.query(
      `SELECT progress_deferred_reason, progress_deferred_remarks
       FROM attendance_events
       WHERE employee_id = $1 AND event_type = 'CHECK_OUT'
         AND survey_village_id = $2`, [w.directEmployee, unfiled.data.id]);
    expect(row.rowCount, "the punch was recorded").toBe(1);
    expect(row.rows[0].progress_deferred_reason).toBe("UNFILED_OFFLINE");
    expect(row.rows[0].progress_deferred_remarks).toBeTruthy();
  });

  it("treats a punch made hours ago as history, not as a prompt", async () => {
    // Same reasoning without the client having to say so: a punch stamped
    // long enough ago cannot be one somebody is standing there making.
    const unfiled = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Stale village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });

    await freshDay(unfiled.data.id);
    const r = await post(w.directUser, "/api/v1/attendance/events", {
      employee_id: w.directEmployee,
      event_type: "CHECK_OUT",
      client_timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      survey_village_id: unfiled.data.id,
    });
    expect(r.status, JSON.stringify(r.body)).not.toBe(422);
  });

  it("closes the day without argument once the return is filed", async () => {
    // villageA has today's return from the rover tests above.
    await freshDay(villageA);
    const r = await punch("CHECK_OUT", { survey_village_id: villageA });
    expect([200, 201]).toContain(r.status);
  });

  it("tells a crew member which villages are theirs and what is outstanding", async () => {
    // The punch screen has no project picker and no search. It has the one or
    // two villages this person was put on, and it has to know whether the
    // day's return is already in before it sends a punch that would be
    // refused.
    await post(w.admin, `/api/v1/survey/villages/${villageA}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });

    const r = await get(w.directUser, "/api/v1/survey/me/villages");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mine = r.body.data as Array<Record<string, unknown>>;
    const a = mine.find(v => v.id === villageA);
    expect(a, "the village they are crewed to").toBeTruthy();
    expect(a!.village_name).toBeTruthy();
    // villageA has today's return from the rover tests above.
    expect(a!.filed_today).toBe(true);
    expect(r.body.work_date).toBe(workDate());
  });

  it("does not hand a crew member somebody else's villages", async () => {
    // Somebody else's village, in the same programme. Being on a programme
    // is not being on every village in it.
    const other = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Not theirs',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });

    const r = await get(w.directUser, "/api/v1/survey/me/villages");
    const ids = (r.body.data as Array<{ id: string }>).map(v => v.id);
    expect(ids).not.toContain(other.data.id);
  });

  it("drops a village from the list once they are released from it", async () => {
    // The list is what they are working now, not what they have ever worked.
    const crew = await get(w.admin, `/api/v1/survey/villages/${villageA}/crew`);
    const row = (crew.body.data as Array<{ id: string; employee_id: string }>)
      .find(c => c.employee_id === w.directEmployee);
    expect(row, "the crew row assigned above").toBeTruthy();
    await post(w.admin, `/api/v1/survey/crew/${row!.id}/release`, {});

    const r = await get(w.directUser, "/api/v1/survey/me/villages");
    const ids = (r.body.data as Array<{ id: string }>).map(v => v.id);
    expect(ids).not.toContain(villageA);
  });

  it("lists who was on site and did not file the day's return", async () => {
    // Attendance knows who turned up. Set against the returns actually filed,
    // the difference is the supervisor's chase list, and nothing else
    // produces it.
    const chased = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Chased village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });
    await freshDay(chased.data.id);

    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/unfiled`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (r.body.data as Array<Record<string, unknown>>)
      .find(x => x.survey_village_id === chased.data.id);
    expect(row, "the village they punched into with nothing filed").toBeTruthy();
    expect(row!.employee_name).toBeTruthy();
    // Nobody accounted for it, which is the case worth chasing first.
    expect(row!.reason).toBeNull();
    expect(r.body.unexplained).toBeGreaterThan(0);
  });

  it("keeps an accounted-for day on the list, with its reason", async () => {
    // "No signal all day" is an answer. A fortnight of it is a finding, and
    // it can only be seen if those days are still on the list.
    const excused = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,'Excused village',id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V")])).rows[0].id),
      total_extent_ac: 40,
    });
    await freshDay(excused.data.id);
    await punch("CHECK_OUT", {
      survey_village_id: excused.data.id,
      progress_deferred_reason: "DATA_TECHNICAL",
    });

    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/unfiled`);
    const row = (r.body.data as Array<Record<string, unknown>>)
      .find(x => x.survey_village_id === excused.data.id);
    expect(row, "still listed, not hidden").toBeTruthy();
    expect(row!.reason).toBe("DATA_TECHNICAL");
    expect(r.body.accounted).toBeGreaterThan(0);
  });

  it("drops a village off the chase list once its return is filed", async () => {
    // villageA has today's return, and people punched into it above.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/unfiled`);
    const ids = (r.body.data as Array<{ survey_village_id: string }>)
      .map(x => x.survey_village_id);
    expect(ids).not.toContain(villageA);
  });

  it("leaves an office day alone, which has no village", async () => {
    // Not every punch is field work, and one with no village has no return
    // to demand.
    const r = await punch("CHECK_OUT");
    expect([200, 201, 409, 422]).toContain(r.status);
    // Whatever attendance decides about a second check-out, it is not the
    // survey module refusing it.
    if (r.status === 422) expect(r.body.code).not.toBe("DAILY_PROGRESS_REQUIRED");
  });
});

/**
 * The daily, weekly and monthly report (§23).
 *
 * One endpoint at three sizes, because "what happened in this period" is one
 * question and three endpoints would be three places for the same arithmetic
 * to drift apart.
 */
describe("the period report", () => {
  const report = (q: string) =>
    get(w.admin, `/api/v1/survey/projects/${programmeId}/report?${q}`);

  it("covers the whole week even when it is run mid-week", async () => {
    // A weekly report run on Wednesday that stops on Wednesday compares three
    // days against last week's seven, and every comparison it prints is wrong.
    const r = await report("grain=WEEK");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.data.period as { from: string; to: string };
    const days = (Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`))
      / 86_400_000 + 1;
    expect(days).toBe(7);
    expect(new Date(`${p.from}T00:00:00Z`).getUTCDay(), "weeks start on Monday").toBe(1);
  });

  it("sets the period against the one before it", async () => {
    const r = await report("grain=WEEK");
    const prior = r.body.data.previous_period as { from: string; to: string };
    const period = r.body.data.period as { from: string };
    // The previous period ends the day before this one starts, with no gap
    // and no overlap.
    expect(new Date(`${prior.to}T00:00:00Z`).getTime() + 86_400_000)
      .toBe(new Date(`${period.from}T00:00:00Z`).getTime());
    expect(r.body.data.area).toHaveProperty("direction");
  });

  it("says nothing about a percentage when the previous period had nothing", async () => {
    // "+100%" against a start from nothing is a number that means nothing.
    const r = await report("grain=YEAR&as_of=2019-06-01");
    expect(r.body.data.area.changePct).toBeNull();
  });

  it("divides by the days actually worked, not the days on the calendar", async () => {
    // A crew that worked four days of seven is not going at four-sevenths of
    // its own pace, and reporting it that way understates them by nearly half.
    const r = await report("grain=WEEK");
    const e = r.body.data.effort;
    expect(e.calendar_days).toBe(7);
    expect(e.active_days).toBeLessThanOrEqual(e.calendar_days);
    if (e.active_days > 0) {
      expect(e.area_per_active_day).toBeGreaterThan(0);
    } else {
      // Nothing worked is not a pace of zero; it is no pace at all.
      expect(e.area_per_active_day).toBeNull();
    }
  });

  it("reports the position as it stood at the end of the period", async () => {
    // A report for a past period that changes every time it is re-run is not
    // a report.
    const first = await report("grain=MONTH&as_of=2026-01-15");
    const again = await report("grain=MONTH&as_of=2026-01-15");
    expect(first.body.data.overall).toEqual(again.body.data.overall);
    expect(first.body.data.period.to).toBe("2026-01-31");
  });

  it("breaks the period down by mandal, and by district when asked", async () => {
    const byMandal = await report("grain=MONTH&level=mandal");
    expect(byMandal.body.data.level).toBe("mandal");
    expect(Array.isArray(byMandal.body.data.units)).toBe(true);
    const byDistrict = await report("grain=MONTH&level=district");
    expect(byDistrict.body.data.level).toBe("district");
    // A district holds at least as many villages as one of its mandals.
    const d = (byDistrict.body.data.units as Array<{ villages: number }>)
      .reduce((t, x) => t + x.villages, 0);
    const mm = (byMandal.body.data.units as Array<{ villages: number }>)
      .reduce((t, x) => t + x.villages, 0);
    expect(d).toBe(mm);
  });

  it("carries both the movement and the position for each unit", async () => {
    const r = await report("grain=MONTH&level=mandal");
    const unit = (r.body.data.units as Array<Record<string, unknown>>)[0];
    expect(unit, "at least one unit").toBeTruthy();
    expect(unit).toHaveProperty("period");
    expect(unit).toHaveProperty("previous");
    expect(unit).toHaveProperty("cumulative");
  });

  it("names the stages that moved, which quantities alone cannot show", async () => {
    // "Four villages finished ground truthing" is usually the first thing
    // anybody asks, and no measure total answers it.
    const r = await report("grain=YEAR");
    expect(Array.isArray(r.body.data.stage_movements)).toBe(true);
  });

  it("defaults to the day, and refuses nothing for an unknown grain", async () => {
    expect((await report("")).body.data.grain).toBe("DAY");
    // An unrecognised grain falls back rather than failing: a report that
    // refuses to run is worse than one that runs at the wrong size.
    expect((await report("grain=FORTNIGHT")).body.data.grain).toBe("DAY");
  });

  it("is refused to somebody who may not read the programme", async () => {
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Not theirs" });
    const r = await get(w.directUser, `/api/v1/survey/projects/${other.data.id}/report`);
    expect(r.status).toBe(404);
  });
});

/**
 * Survey alerts (§27).
 *
 * The bottleneck report already says what is stuck — to whoever opens it,
 * which is the problem: a village that has gone quiet is exactly the one
 * nobody is looking at.
 */
describe("alerting on work that has stopped", () => {
  async function alertsFor(villageId: string): Promise<Array<Record<string, any>>> {
    return (await w.pool.query(
      `SELECT DISTINCT title, body, event_key FROM notifications
       WHERE type = 'SURVEY_ALERT' AND entity_id = $1 ORDER BY event_key`,
      [villageId])).rows;
  }

  async function newVillage(name: string): Promise<string> {
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id)
         SELECT $1,'village',$2,$3,id FROM org_units
         WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
        [w.orgId, uniq("V"), name])).rows[0].id),
      total_extent_ac: 40,
    });
    return String(v.data.id);
  }

  it("raises a village past the date somebody committed to", async () => {
    const id = await newVillage("Overdue village");
    await w.pool.query(
      "UPDATE survey_villages SET expected_completion_on = CURRENT_DATE - 5 WHERE id = $1",
      [id]);

    await runSurveyAlerts(w.pool);
    const rows = await alertsFor(id);
    const overdue = rows.find(r => String(r.event_key).startsWith("survey.overdue:"));
    expect(overdue, JSON.stringify(rows)).toBeTruthy();
    expect(overdue!.title).toContain("past its completion date");
    expect(overdue!.body).toContain("5 days ago");
  });

  it("does not say it twice, however often the worker runs", async () => {
    // A job running every few minutes that alerts every few minutes gets
    // muted, and then the feature is worse than not having it.
    const id = await newVillage("Repeat village");
    await w.pool.query(
      "UPDATE survey_villages SET expected_completion_on = CURRENT_DATE - 2 WHERE id = $1",
      [id]);

    await runSurveyAlerts(w.pool);
    const first = await w.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1", [id]);
    await runSurveyAlerts(w.pool);
    await runSurveyAlerts(w.pool);
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1", [id]);
    expect(after.rows[0].n).toBe(first.rows[0].n);
    expect(first.rows[0].n).toBeGreaterThan(0);
  });

  it("says it again when the date is moved and missed again", async () => {
    // A fresh commitment missed is fresh news, and the key names the date
    // rather than the village for exactly that reason.
    const id = await newVillage("Moved village");
    await w.pool.query(
      "UPDATE survey_villages SET expected_completion_on = CURRENT_DATE - 9 WHERE id = $1",
      [id]);
    await runSurveyAlerts(w.pool);
    const before = (await alertsFor(id)).length;

    await w.pool.query(
      "UPDATE survey_villages SET expected_completion_on = CURRENT_DATE - 1 WHERE id = $1",
      [id]);
    await runSurveyAlerts(w.pool);
    expect((await alertsFor(id)).length).toBeGreaterThan(before);
  });

  it("leaves a village alone once somebody has put it on hold", async () => {
    // Somebody has already decided about it. Telling them again is noise.
    const id = await newVillage("Held village");
    await w.pool.query(
      `UPDATE survey_villages SET expected_completion_on = CURRENT_DATE - 5,
         status_override = 'ON_HOLD' WHERE id = $1`, [id]);
    await runSurveyAlerts(w.pool);
    expect(await alertsFor(id)).toHaveLength(0);
  });

  it("raises a village with crew on it and nothing filed", async () => {
    const id = await newVillage("Silent village");
    await post(w.admin, `/api/v1/survey/villages/${id}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });

    await runSurveyAlerts(w.pool);
    const silent = (await alertsFor(id))
      .find(r => String(r.event_key).startsWith("survey.silent:"));
    expect(silent, "crew assigned, no return").toBeTruthy();
    expect(silent!.body).toContain("no return has ever been filed");
  });

  it("does not call a village with nobody on it silent", async () => {
    // A village nobody is working is not silent, it is simply not being
    // worked — and saying otherwise buries the ones that matter.
    const id = await newVillage("Unstaffed village");
    await runSurveyAlerts(w.pool);
    expect((await alertsFor(id))
      .filter(r => String(r.event_key).startsWith("survey.silent:"))).toHaveLength(0);
  });

  it("raises a stage that has sat in progress longer than the programme allows", async () => {
    const id = await newVillage("Stalled village");
    await post(w.admin, `/api/v1/survey/villages/${id}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS",
    });
    await w.pool.query(
      `UPDATE survey_village_stages SET started_on = CURRENT_DATE - 60
       WHERE survey_village_id = $1`, [id]);

    await runSurveyAlerts(w.pool);
    const stalled = (await alertsFor(id))
      .find(r => String(r.event_key).startsWith("survey.stalled:"));
    expect(stalled, "stage past its SLA").toBeTruthy();
    expect(stalled!.title).toContain("stalled");
  });

  it("arrives in the inbox somebody actually opens", async () => {
    // An alert written to a table nobody reads is not an alert. The inbox
    // does not filter by type, so this is the whole journey.
    const id = await newVillage("Inbox village");
    await post(w.admin, `/api/v1/survey/villages/${id}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });
    await runSurveyAlerts(w.pool);

    const inbox = await get(w.directUser, "/api/v1/notifications?limit=100");
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const mine = (inbox.body.data as Array<Record<string, unknown>>)
      .filter(n => n.type === "SURVEY_ALERT");
    expect(mine.length, "survey alerts reach the inbox").toBeGreaterThan(0);
    // And point at the village, so opening one goes somewhere useful.
    expect(mine[0].entity_type).toBe("survey_village");
  });

  it("reaches the crew on the village, not everybody who can read the module", async () => {
    // An alert that reaches people who cannot act on it is how alerts get
    // muted.
    const id = await newVillage("Crewed village");
    await post(w.admin, `/api/v1/survey/villages/${id}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });
    await runSurveyAlerts(w.pool);

    const mine = await w.pool.query(
      `SELECT 1 FROM notifications n JOIN users u ON u.id = n.recipient_id
       WHERE n.entity_id = $1 AND u.employee_id = $2`, [id, w.directEmployee]);
    expect(mine.rowCount, "the crew member hears about it").toBeGreaterThan(0);
  });
});

describe("adding and correcting one village by hand", () => {
  it("creates the location from a name and a mandal", async () => {
    // Somebody adding a single village has its name and the mandal it sits
    // in, not a location id. Making them create the location elsewhere and
    // come back is why a bulk import gets opened for one row.
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
      [w.orgId])).rows[0].id);
    const code = uniq("VN");
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Hand-added village", village_code: code,
      mandal_id: mandal, total_extent_ac: 55,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const unit = await w.pool.query(
      "SELECT name, parent_id FROM org_units WHERE org_id=$1 AND source_code=$2",
      [w.orgId, code]);
    expect(unit.rows[0].name).toBe("Hand-added village");
    expect(String(unit.rows[0].parent_id)).toBe(mandal);
  });

  it("still takes an existing location by id", async () => {
    const villageUnit = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id)
       SELECT $1,'village',$2,'Pre-existing',id FROM org_units
       WHERE org_id=$1 AND type='mandal' LIMIT 1 RETURNING id`,
      [w.orgId, uniq("V")])).rows[0].id);
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_id: villageUnit, total_extent_ac: 20,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses a half-filled request rather than guessing", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "No mandal given", total_extent_ac: 10,
    });
    expect(r.status).toBe(422);
  });

  it("corrects the extent, which otherwise needs the whole file re-imported", async () => {
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
      [w.orgId])).rows[0].id);
    const made = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Wrong extent", village_code: uniq("VE"),
      mandal_id: mandal, total_extent_ac: 10,
    });
    const id = String(made.data.id);
    const r = await patch(
      { ...w.admin, ...(await ver("survey_villages", id)) },
      `/api/v1/survey/villages/${id}`,
      { total_extent_ac: 250, village_name: "Right extent" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Number(r.data.total_extent_ac)).toBe(250);

    // The name follows the location, since a misspelling in the source list
    // follows the village everywhere.
    const unit = await w.pool.query(
      "SELECT name FROM org_units WHERE id=(SELECT village_id FROM survey_villages WHERE id=$1)", [id]);
    expect(unit.rows[0].name).toBe("Right extent");
  });

  it("is refused to a crew member", async () => {
    const r = await post(w.directUser, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Not theirs", village_code: uniq("VX"), mandal_id: programmeId,
    });
    expect([401, 403, 404]).toContain(r.status);
  });
});

describe("who and what is deployed on a programme", () => {
  const dep = (level: string) =>
    get(w.admin, `/api/v1/survey/projects/${programmeId}/deployment?level=${level}`);

  it("rolls the same people up to mandal and to district", async () => {
    await post(w.admin, `/api/v1/survey/villages/${villageA}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });

    const mandal = await dep("mandal");
    expect(mandal.status, JSON.stringify(mandal.body)).toBe(200);
    const district = await dep("district");

    // A district contains its mandals, so it cannot hold fewer villages.
    const sum = (b: any) =>
      (b.data.units as Array<{ villages: number }>).reduce((t, u) => t + u.villages, 0);
    expect(sum(district)).toBe(sum(mandal));
    expect(district.body.data.level).toBe("district");
  });

  it("names the people rather than only counting them", async () => {
    // "Four crew" is a number; knowing which four is what the question is
    // actually for.
    const r = await dep("village");
    const withCrew = (r.body.data.units as Array<Record<string, any>>)
      .find((u) => u.crew > 0);
    expect(withCrew, "a village with crew on it").toBeTruthy();
    expect(withCrew!.people[0].name).toBeTruthy();
    expect(withCrew!.people[0].emp_no).toBeTruthy();
  });

  it("reports programme staff apart from village crew", async () => {
    /*
     * Somebody put on the programme belongs to every level of it. Dividing
     * them between mandals would invent a posting nobody made; leaving them
     * out understates a district that has a manager and no crew yet.
     */
    const r = await dep("mandal");
    expect(Array.isArray(r.body.data.programme_staff)).toBe(true);
    expect(r.body.data.totals).toHaveProperty("programme_staff");
  });

  it("counts a person once even when they are on several villages", async () => {
    const second = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Second posting", village_code: uniq("VD"),
      mandal_id: String((await w.pool.query(
        "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
        [w.orgId])).rows[0].id),
    });
    await post(w.admin, `/api/v1/survey/villages/${second.data.id}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });

    const r = await dep("district");
    const people = (r.body.data.units as Array<Record<string, any>>)
      .flatMap((u) => u.people as Array<{ employee_id: string }>)
      .map((p) => p.employee_id);
    // One person on two villages is one person.
    expect(people.filter((id) => id === w.directEmployee).length)
      .toBeLessThanOrEqual(r.body.data.units.length);
    expect(r.body.data.totals.crew).toBeGreaterThan(0);
  });

  it("is refused for a programme they may not see", async () => {
    const other = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Not theirs" });
    const r = await get(w.directUser, `/api/v1/survey/projects/${other.data.id}/deployment`);
    expect(r.status).toBe(404);
  });
});

describe("the district a village rolls up to", () => {
  it("finds it whether the mandal reports through a division or not", async () => {
    /*
     * A mandal reports either straight to a district or through a division,
     * so the district is the parent in one shape and the grandparent in the
     * other. Reading only one would file every village in a
     * division-organised district as having no district — and the Villages
     * filter would then offer a list that silently excluded them.
     */
    const district = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Deep district')
       RETURNING id`, [w.orgId, uniq("D")])).rows[0].id);
    const division = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'division',$2,'A division',$3)
       RETURNING id`, [w.orgId, uniq("DV"), district])).rows[0].id);
    const mandal = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Deep mandal',$3)
       RETURNING id`, [w.orgId, uniq("M"), division])).rows[0].id);

    await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Deep village", village_code: uniq("DVL"),
      mandal_id: mandal, total_extent_ac: 30,
    });

    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    const deep = (r.body.data as Array<Record<string, unknown>>)
      .find((v) => v.village_name === "Deep village");
    expect(deep, "the village was listed").toBeTruthy();
    expect(deep!.district_name, "found through the division").toBe("Deep district");
    expect(deep!.division_name).toBe("A division");
  });

  it("finds it when the mandal reports straight to the district", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    const shallow = (r.body.data as Array<Record<string, unknown>>)
      .find((v) => v.district_name && !v.division_name);
    expect(shallow, "a village whose mandal has no division").toBeTruthy();
  });
});

describe("assigning people and instruments in one go", () => {
  it("puts a whole crew on a stage at once", async () => {
    // Four or five people assigned one form at a time is how the fifth gets
    // forgotten.
    const ids = [] as string[];
    for (let i = 0; i < 3; i += 1) {
      ids.push(String((await w.pool.query(
        `INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status)
         VALUES($1,$2,'Crew','+9191000${String(70000 + i).slice(-5)}','2026-01-01','ACTIVE')
         RETURNING id`, [w.orgId, uniq("E")])).rows[0].id));
    }
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/crew/bulk`, {
      employee_ids: ids, stage_code: "GT_QC",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.assigned).toBe(3);
  });

  it("reports somebody already on that stage instead of failing the rest", async () => {
    const one = String((await w.pool.query(
      `INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status)
       VALUES($1,$2,'Repeat','+919100070900','2026-01-01','ACTIVE') RETURNING id`,
      [w.orgId, uniq("E")])).rows[0].id);
    await post(w.admin, `/api/v1/survey/villages/${villageA}/crew/bulk`,
      { employee_ids: [one], stage_code: "VECTORIZATION" });
    const again = await post(w.admin, `/api/v1/survey/villages/${villageA}/crew/bulk`,
      { employee_ids: [one], stage_code: "VECTORIZATION" });
    expect(again.data.already_assigned).toBe(1);
    expect(again.data.assigned).toBe(0);
  });

  it("will not put somebody who has left onto work", async () => {
    const gone = String((await w.pool.query(
      `INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status)
       VALUES($1,$2,'Departed','+919100070901','2026-01-01','EXITED') RETURNING id`,
      [w.orgId, uniq("E")])).rows[0].id);
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/crew/bulk`,
      { employee_ids: [gone], stage_code: "GT_QC" });
    expect(r.data.refused).toBe(1);
    expect(r.data.assigned).toBe(0);
  });

  it("allocates several rovers together and names the one that is busy", async () => {
    /*
     * Refusing the whole request because one instrument is out means doing
     * the other four again by hand.
     */
    const free1 = await makeRover(uniq("RA"));
    const free2 = await makeRover(uniq("RB"));
    const busy = await makeRover(uniq("RC"));

    const other = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Holds a rover", village_code: uniq("VH"),
      mandal_id: String((await w.pool.query(
        "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
        [w.orgId])).rows[0].id),
    });
    await post(w.admin, `/api/v1/survey/villages/${other.data.id}/rovers`,
      { asset_id: busy, allocated_on: workDate() });

    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers/bulk`, {
      asset_ids: [free1, free2, busy], allocated_on: workDate(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.allocated).toBe(2);
    expect(r.data.clashes).toHaveLength(1);
    expect(r.data.clashes[0].with_village).toBe("Holds a rover");
  });

  it("corrects an allocation's dates", async () => {
    const asset = await makeRover(uniq("RD"));
    const made = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers`,
      { asset_id: asset, allocated_on: workDate() });
    const r = await patch(w.admin, `/api/v1/survey/rovers/${made.data.id}`,
      { released_on: workDate() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.released_on).toBeTruthy();
  });

  it("refuses a correction that would release it before it went out", async () => {
    const asset = await makeRover(uniq("RE"));
    const made = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers`,
      { asset_id: asset, allocated_on: workDate() });
    const r = await patch(w.admin, `/api/v1/survey/rovers/${made.data.id}`,
      { released_on: "2020-01-01" });
    expect(r.status).toBe(422);
  });
});

describe("moving villages between programmes", () => {
  it("takes the progress with them", async () => {
    /*
     * Programmes get split and merged — a district carved into its own
     * contract, two pilots folded together. Re-importing the list into the
     * other programme would leave the progress behind, which is the whole
     * record.
     */
    const target = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Receiving programme" });
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
      [w.orgId])).rows[0].id);
    const village = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Travelling village", village_code: uniq("VT"),
      mandal_id: mandal, total_extent_ac: 60,
    });
    await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: village.data.id, entry_date: day(0),
      teams_deployed: 1, values: { GOVT_LAND_EXTENT_AC: 9 },
    });

    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages/move`, {
      village_ids: [village.data.id], to_project_id: target.data.id,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.moved).toBe(1);

    // The village and its return are both on the new programme.
    const moved = await w.pool.query(
      "SELECT survey_project_id FROM survey_villages WHERE id=$1", [village.data.id]);
    expect(String(moved.rows[0].survey_project_id)).toBe(String(target.data.id));
    const entry = await w.pool.query(
      "SELECT survey_project_id FROM survey_entries WHERE survey_village_id=$1",
      [village.data.id]);
    expect(String(entry.rows[0].survey_project_id)).toBe(String(target.data.id));
  });

  it("refuses to move a village into the programme it is already in", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages/move`, {
      village_ids: [villageA], to_project_id: programmeId,
    });
    expect(r.status).toBe(422);
  });

  it("reports a village the target already lists rather than duplicating it", async () => {
    const target = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Already has it" });
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1",
      [w.orgId])).rows[0].id);
    const unit = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id)
       VALUES($1,'village',$2,'Shared village',$3) RETURNING id`,
      [w.orgId, uniq("VS"), mandal])).rows[0].id);
    const here = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
      { village_id: unit });
    await post(w.admin, `/api/v1/survey/projects/${target.data.id}/villages`,
      { village_id: unit });

    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages/move`, {
      village_ids: [here.data.id], to_project_id: target.data.id,
    });
    expect(r.data.moved).toBe(0);
    expect(r.data.already_there).toBe(1);
  });
});

describe("a programme and its project, created together", () => {
  it("creates the project alongside the programme", async () => {
    /*
     * The two were separate records with an optional link, so setting up
     * survey work meant creating a programme, creating a project, and
     * remembering to connect them — a step people forget, then wonder why
     * the board is empty.
     */
    const code = uniq("PR");
    const r = await post(w.admin, "/api/v1/survey/projects", { code, name: "Paired programme" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.project_id, "a project was created and linked").toBeTruthy();

    const project = await w.pool.query(
      "SELECT code, name, status FROM projects WHERE id = $1", [r.data.project_id]);
    expect(project.rows[0].name).toBe("Paired programme");
    expect(project.rows[0].code).toBe(code);
  });

  it("carries the programme's dates onto the project", async () => {
    const r = await post(w.admin, "/api/v1/survey/projects", {
      code: uniq("PR"), name: "Dated programme",
      started_on: "2026-04-01", target_completion_on: "2026-12-31",
    });
    const project = await w.pool.query(
      "SELECT planned_start_date, planned_end_date FROM projects WHERE id = $1",
      [r.data.project_id]);
    expect(String(project.rows[0].planned_start_date)).toContain("2026-04-01");
  });

  it("suffixes a code an unrelated project already uses rather than refusing", async () => {
    // The programme is what the person asked for. Refusing it because some
    // other project shares a code would make the pairing worse than not
    // having it.
    const code = uniq("CL");
    await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, created_by)
       SELECT $1, (SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1), $2, 'Existing', $3`,
      [w.orgId, code, w.adminId ?? null]);

    const r = await post(w.admin, "/api/v1/survey/projects", { code, name: "Clashing" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const project = await w.pool.query(
      "SELECT code FROM projects WHERE id = $1", [r.data.project_id]);
    expect(project.rows[0].code).toBe(`${code}-SV`);
  });

  it("can be told not to, for a programme that has no board work", async () => {
    const r = await post(w.admin, "/api/v1/survey/projects", {
      code: uniq("NP"), name: "No project", create_project: false,
    });
    expect(r.data.project_id).toBeNull();
  });

  it("gives an older programme a project on request", async () => {
    const made = await post(w.admin, "/api/v1/survey/projects", {
      code: uniq("OL"), name: "Made before pairing", create_project: false,
    });
    const r = await post(w.admin, `/api/v1/survey/projects/${made.data.id}/pair`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.project_id).toBeTruthy();

    const check = await w.pool.query(
      "SELECT project_id FROM survey_projects WHERE id = $1", [made.data.id]);
    expect(String(check.rows[0].project_id)).toBe(String(r.data.project_id));
  });

  it("refuses to pair a programme that already has one", async () => {
    // Two projects for one programme is worse than none: half the work ends
    // up on a board nobody opens.
    const made = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("AP"), name: "Already paired" });
    const r = await post(w.admin, `/api/v1/survey/projects/${made.data.id}/pair`, {});
    expect(r.status).toBe(409);
  });
});

describe("what a village's crew are carrying", () => {
  it("shows equipment that reached the village through a person", async () => {
    /*
     * Two ways a thing can be at a village: allocated to the village, or
     * issued to somebody who is on its crew. The second is how a tripod, a
     * radio and a battery usually travel — signed out to a surveyor, not to
     * a place — and it was invisible here, so a village's equipment looked
     * like whatever happened to be allocated formally.
     */
    const asset = await makeRover(uniq("CA"));
    await post(w.admin, "/api/v1/assets/assign-bulk", {
      asset_ids: [asset], employee_id: w.directEmployee, reason: "Field kit",
    });
    await post(w.admin, `/api/v1/survey/villages/${villageA}/crew`, {
      employee_id: w.directEmployee, stage_code: "RECORDS_PREPARATION",
    });

    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/crew-assets`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (r.body.data as Array<Record<string, unknown>>)
      .find((x) => x.asset_id === asset);
    expect(row, "the asset their crew member is carrying").toBeTruthy();
    expect(row!.employee_name).toBeTruthy();
    expect(row!.phone, "so it can be chased without a directory lookup").toBeTruthy();
    expect(row!.issued_at).toBeTruthy();
  });

  it("marks the ones already allocated to the village in their own right", async () => {
    // Otherwise the same instrument reads as two, and the daily return
    // accounts for one of them.
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/crew-assets`);
    for (const row of r.body.data as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty("also_allocated");
    }
  });

  it("stops showing it once the person is off the crew", async () => {
    // Releasing somebody from the village does not take the equipment off
    // them — it stops being this village's business, which is the point of
    // reporting it separately from the allocations.
    const crew = await get(w.admin, `/api/v1/survey/villages/${villageA}/crew`);
    const row = (crew.body.data as Array<Record<string, any>>)
      .find((c) => c.employee_id === w.directEmployee && c.stage_code === "RECORDS_PREPARATION");
    expect(row).toBeTruthy();
    await post(w.admin, `/api/v1/survey/crew/${row!.id}/release`, {});

    const after = await get(w.admin, `/api/v1/survey/villages/${villageA}/crew-assets`);
    const stillThere = (after.body.data as Array<Record<string, unknown>>)
      .filter((x) => x.employee_id === w.directEmployee
        && x.stage_label === "Records preparation");
    expect(stillThere).toHaveLength(0);
  });
});
