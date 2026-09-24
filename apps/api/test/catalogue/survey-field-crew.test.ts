/**
 * What the phone needs from the server to file a clean day (lane 2 survey
 * gaps, docs/qa/2026-09-24/findings-survey-gaps.md).
 *
 * The phone applies every rule the server applies before it queues anything
 * (§59.9.3), because a refusal that arrives after the crew has left the
 * village has nobody to ask. Each test here is a rule the phone could not
 * apply because the server never told it the fact the rule turns on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let village = "";

async function send(
  method: "POST" | "GET" | "PATCH", h: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...h, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const get = (h: Headers, u: string) => send("GET", h, u);
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

async function rover(code: string, holder: string | null): Promise<string> {
  const id = String((await w.pool.query(
    `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
     VALUES($1,$2,$3,'SURVEY','AVAILABLE','GOOD') RETURNING id`,
    [w.orgId, code, `Rover ${code}`])).rows[0].id);
  if (holder) {
    await w.pool.query(
      `INSERT INTO asset_assignments(org_id, asset_id, employee_id, condition, reason)
       VALUES($1,$2,$3,'GOOD','Field work')`, [w.orgId, id, holder]);
  }
  await post(w.admin, `/api/v1/survey/villages/${village}/rovers`,
    { asset_id: id, allocated_on: workDate() });
  return id;
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("FC"), name: "Field crew programme" });
  programmeId = String(p.data.id);
  const mandal = String((await w.pool.query(
    "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1", [w.orgId])).rows[0].id);
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
    village_name: "Field crew village", village_code: uniq("FCV"), mandal_id: mandal,
    total_extent_ac: 300,
  });
  village = String(v.data.id);
  await post(w.admin, `/api/v1/survey/villages/${village}/crew`, {
    employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
  });
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the instruments a crew member may account for (SG-001)", () => {
  /*
   * The return refuses a rover that is not issued to the person filing
   * (ROVER_NOT_YOURS), and the outbox drops what the server refuses. The
   * phone listed every rover allocated to the village, so the second crew
   * member to mark the day lost it. The list has to say whose each one is.
   */
  let mine = "", theirs = "", nobodys = "";
  beforeAll(async () => {
    mine = await rover(uniq("MINE"), w.directEmployee);
    theirs = await rover(uniq("THEIRS"), w.siteEmployee);
    nobodys = await rover(uniq("FREE"), null);
  });

  it("marks which allocated rovers the caller may file for", async () => {
    const r = await get(w.directUser, `/api/v1/survey/villages/${village}/rovers`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const by = new Map(r.data.map((x: any) => [x.asset_id, x]));
    expect((by.get(mine) as any).issued_to_me).toBe(true);
    expect((by.get(theirs) as any).issued_to_me).toBe(false);
    expect((by.get(nobodys) as any).issued_to_me).toBe(false);
  });

  it("agrees with what the return route accepts", async () => {
    const refused = await post(w.directUser, "/api/v1/survey/entries", {
      survey_village_id: village, entry_date: workDate(), values: {},
      rovers: [{ asset_id: theirs, status: "UTILIZED" }],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ROVER_NOT_YOURS");
  });

  it("counts a rover carried by somebody who reports to the caller", async () => {
    await w.pool.query("UPDATE employees SET reports_to = $1 WHERE id = $2",
      [w.directEmployee, w.siteEmployee]);
    const r = await get(w.directUser, `/api/v1/survey/villages/${village}/rovers`);
    expect(r.data.find((x: any) => x.asset_id === theirs).issued_to_me).toBe(true);
    await w.pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1", [w.siteEmployee]);
  });

  it("marks every rover as fileable for a supervisor", async () => {
    // A project manager files on behalf of anybody (R: supervises).
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/rovers`);
    expect(r.data.every((x: any) => x.issued_to_me === true)).toBe(true);
  });

  it("names who carries each one, so the phone can say who files for it", async () => {
    const r = await get(w.directUser, `/api/v1/survey/villages/${village}/rovers`);
    expect(r.data.find((x: any) => x.asset_id === theirs).holder_name).toBeTruthy();
    expect(r.data.find((x: any) => x.asset_id === nobodys).holder_name).toBeNull();
  });
});

describe("a control point's name is one name, whatever the case (SG-006)", () => {
  it("refuses gcp-1 beside GCP-1", async () => {
    const a = await post(w.admin, `/api/v1/survey/villages/${village}/gcps`,
      { point_code: "GCP-1", latitude: 17.512345, longitude: 82.612345 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await post(w.admin, `/api/v1/survey/villages/${village}/gcps`,
      { point_code: "gcp-1", latitude: 17.512346, longitude: 82.612346 });
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(b.body.code).toBe("POINT_ALREADY_RECORDED");
  });

  it("refuses renaming another point onto it in a different case", async () => {
    const c = await post(w.admin, `/api/v1/survey/villages/${village}/gcps`,
      { point_code: "GCP-2", latitude: 17.513345, longitude: 82.613345 });
    const r = await patch({ ...w.admin, "if-match": String(c.data.version) },
      `/api/v1/survey/gcps/${c.data.id}`, { point_code: "Gcp-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("still lets a point keep its own name when other fields change", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${village}/gcps`);
    const g = list.data.find((x: any) => x.point_code === "GCP-1");
    const r = await patch({ ...w.admin, "if-match": String(g.version) },
      `/api/v1/survey/gcps/${g.id}`, { point_code: "gcp-1", remarks: "renamed own case" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("the crew member's own stage, on their list (SG-013)", () => {
  it("carries the state and start of the stage they are crewed on", async () => {
    await post(w.admin, `/api/v1/survey/villages/${village}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: workDate(),
      gt_govt_staff_allocated: 2, gt_crew_allocated: 3,
    });
    const r = await get(w.directUser, "/api/v1/survey/me/villages");
    const row = r.data.find((x: any) => x.id === village);
    expect(row.stage_state).toBe("IN_PROGRESS");
    expect(row.stage_started_on).toBe(workDate());
  });
});

describe("starting ground truthing keeps what was said (SG-007)", () => {
  it("stores the remarks given at start on the ground-truthing stage", async () => {
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1", [w.orgId])).rows[0].id);
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Start remarks village", village_code: uniq("SRV"), mandal_id: mandal,
      total_extent_ac: 40,
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${v.data.id}/start-gt`, {
      started_on: workDate(), expected_end_on: "2099-01-01",
      employee_ids: [w.siteEmployee], govt_staff_allocated: 1, crew_allocated: 1,
      remarks: "VRO agreed two staff from Monday",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await get(w.admin, `/api/v1/survey/villages/${v.data.id}`);
    expect(after.data.stage_dates.GROUND_TRUTHING.remarks).toBe("VRO agreed two staff from Monday");
  });
});

describe("an amended return's trail carries both sides (SG-012)", () => {
  it("records attendance in the after state as well as the before", async () => {
    const e = await post(w.directUser, "/api/v1/survey/entries", {
      survey_village_id: village, entry_date: workDate(),
      values: { GOVT_LAND_EXTENT_AC: 5 }, govt_staff_present: 4, crew_present: 3,
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    const r = await patch({ ...w.directUser, "if-match": String(e.data.version) },
      `/api/v1/survey/entries/${e.data.id}`, { govt_staff_present: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const audit = (await w.pool.query(
      `SELECT before_state, after_state FROM audit_events
        WHERE action = 'survey.entry.amend' AND entity_id = $1`, [e.data.id])).rows[0];
    expect(audit.before_state.govt_staff_present).toBe(4);
    expect(audit.after_state.govt_staff_present).toBe(0);
    expect(audit.after_state.crew_present).toBe(3);
  });
});

describe("moving a stage keeps what the call did not mention (SG-015)", () => {
  it("does not blank the start date or the remarks when completing", async () => {
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1", [w.orgId])).rows[0].id);
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Keep stage fields", village_code: uniq("KSF"), mandal_id: mandal,
      total_extent_ac: 40,
    });
    const start = "2026-01-05";
    await post(w.admin, `/api/v1/survey/villages/${v.data.id}/start-gt`, {
      started_on: start, expected_end_on: "2099-01-01",
      employee_ids: [w.siteEmployee], govt_staff_allocated: 1, crew_allocated: 1,
      remarks: "Agreed with the MRO",
    });
    const done = await post(w.admin, `/api/v1/survey/villages/${v.data.id}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: workDate(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.data.started_on).toBe(start);
    expect(done.data.remarks).toBe("Agreed with the MRO");
  });

  it("still clears them when the caller says null", async () => {
    const mandal = String((await w.pool.query(
      "SELECT id FROM org_units WHERE org_id=$1 AND type='mandal' LIMIT 1", [w.orgId])).rows[0].id);
    const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
      village_name: "Clear stage fields", village_code: uniq("CSF"), mandal_id: mandal,
    });
    await post(w.admin, `/api/v1/survey/villages/${v.data.id}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: "2026-01-05",
      remarks: "x", gt_govt_staff_allocated: 1, gt_crew_allocated: 1,
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${v.data.id}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "NOT_STARTED", started_on: null, remarks: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.started_on).toBeNull();
    expect(r.data.remarks).toBeNull();
  });
});
