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
      survey_village_id: villageA, entry_date: day(1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("ROVER_DAY_INVALID");
    expect(r.body.message).toContain("must say why");
  });

  it("refuses \"other\" with nothing written", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE", idle_reason: "OTHER" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toContain("must say what happened");
  });

  it("names every problem at once rather than one per attempt", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(1), values: {},
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
      survey_village_id: villageA, entry_date: day(1), values: {},
      rovers: [{ asset_id: roverA, status: "IDLE", idle_reason: "HUNGOVER" }],
    });
    expect(r.status).toBe(422);
  });
});

describe("a thin day", () => {
  it("demands a reason when the day is below the programme threshold", async () => {
    // Five acres is the threshold on this programme; two is below it.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(2),
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
      survey_village_id: villageA, entry_date: day(2),
      values: { GOVT_LAND_EXTENT_AC: 2 },
      rovers: [{ asset_id: roverA, status: "UTILIZED", area_ac: 2 }],
      low_progress_reason: "ACCESS",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("demands nothing of a day that meets the threshold", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: day(3),
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
