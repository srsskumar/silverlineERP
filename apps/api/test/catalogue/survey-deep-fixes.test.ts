/**
 * Bugs found in the survey deep-QA round (lane 1), each pinned by the probe
 * that found it live (scripts/qa/survey/probe-api.mjs):
 *   SV-004 release dates that are not dates were a 500
 *   SV-005 start-gt put an exited employee on a village
 *   SV-006 start-gt did not bring the crew's issued kit, unlike every other crew route
 *   SV-007 completing a stage without resending started_on erased the start date
 *   SV-008 a stage could be completed before it started, or in the future
 *   SV-009 a village's extent could not be cleared although the schema allows null
 *   SV-010 a plan could finish before it starts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
let mandalId: string;

const day = (offset: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function send(method: "POST" | "GET" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown, extra: Headers = {}) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()), ...extra },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);

async function village(name = "Deep village"): Promise<string> {
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_name: name, village_code: uniq("DV"), mandal_id: mandalId, total_extent_ac: 100 });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return String(v.data.id);
}
async function employee(status = "ACTIVE"): Promise<string> {
  return String((await w.pool.query(
    `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining, status)
     VALUES ($1, $2, 'Deep', 'Crew', $3, CURRENT_DATE, $4) RETURNING id`,
    [w.orgId, uniq("DC"), `9${Math.floor(100000000 + Math.random() * 899999999)}`, status])).rows[0].id);
}
const startGt = (v: string, ids: string[], started = day(-5)) =>
  post(w.admin, `/api/v1/survey/villages/${v}/start-gt`, {
    started_on: started, expected_end_on: day(20), employee_ids: ids,
    govt_staff_allocated: 1, crew_allocated: ids.length,
  });

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Deep district') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Deep mandal',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("DEEP"), name: "Deep programme", create_project: false });
  programmeId = String(p.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("SV-004 release dates", () => {
  it("refuses a crew release date that is not a date, with 422 rather than 500", async () => {
    const v = await village();
    const e = await employee();
    const c = await post(w.admin, `/api/v1/survey/villages/${v}/crew`,
      { employee_id: e, stage_code: "GROUND_TRUTHING", assigned_on: day(-3) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    for (const bad of ["not-a-date", "31/12/2026", "2026-02-30"]) {
      const r = await post(w.admin, `/api/v1/survey/crew/${c.data.id}/release`, { released_on: bad });
      expect(r.status, `${bad}: ${JSON.stringify(r.body)}`).toBe(422);
    }
  });

  it("refuses a rover release date that is not a date, with 422 rather than 500", async () => {
    const v = await village();
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Deep rover','SURVEY','AVAILABLE','GOOD') RETURNING id`,
      [w.orgId, uniq("DR")])).rows[0].id);
    const a = await post(w.admin, `/api/v1/survey/villages/${v}/rovers`, { asset_id: asset, allocated_on: day(-3) });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    for (const bad of ["not-a-date", "31/12/2026"]) {
      const r = await post(w.admin, `/api/v1/survey/rovers/${a.data.id}/release`, { released_on: bad });
      expect(r.status, `${bad}: ${JSON.stringify(r.body)}`).toBe(422);
    }
  });
});

describe("SV-005 / SV-006 starting ground truthing", () => {
  it("refuses to put an exited employee on the village, and writes nothing", async () => {
    const v = await village();
    const ok = await employee();
    const gone = await employee("EXITED");
    const r = await startGt(v, [ok, gone]);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const crew = await send("GET", w.admin, `/api/v1/survey/villages/${v}/crew`);
    expect(crew.data).toEqual([]);
  });

  it("brings the crew's issued instruments to the village, as the crew routes do", async () => {
    const v = await village();
    const e = await employee();
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,'Issued rover','SURVEY','ASSIGNED','GOOD') RETURNING id`,
      [w.orgId, uniq("IR")])).rows[0].id);
    await w.pool.query(
      `INSERT INTO asset_assignments(org_id, asset_id, employee_id, condition, reason)
       VALUES($1,$2,$3,'GOOD','field kit')`, [w.orgId, asset, e]);
    const r = await startGt(v, [e]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rovers = await send("GET", w.admin, `/api/v1/survey/villages/${v}/rovers`);
    expect((rovers.data as any[]).some((x) => x.asset_id === asset && x.out), JSON.stringify(rovers.data)).toBe(true);
  });
});

describe("SV-007 / SV-008 stage dates", () => {
  let v: string;
  beforeAll(async () => {
    v = await village();
    expect((await startGt(v, [await employee()])).status).toBe(201);
  });
  const set = (body: Record<string, unknown>) =>
    post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: "GROUND_TRUTHING", ...body });

  it("keeps the recorded start when a completion does not resend it", async () => {
    const r = await set({ state: "COMPLETED", completed_on: day(-1) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.started_on).toBe(day(-5));
    expect((await set({ state: "IN_PROGRESS" })).data.started_on).toBe(day(-5));
  });

  it("still clears the start when asked to explicitly", async () => {
    const r = await set({ state: "IN_PROGRESS", started_on: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.started_on).toBeNull();
    expect((await set({ state: "IN_PROGRESS", started_on: day(-5) })).status).toBe(200);
  });

  it("refuses a completion dated before the recorded start", async () => {
    const r = await set({ state: "COMPLETED", completed_on: day(-9) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses a start or a completion dated in the future", async () => {
    const a = await set({ state: "COMPLETED", completed_on: day(3) });
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    const b = await set({ state: "IN_PROGRESS", started_on: day(3) });
    expect(b.status, JSON.stringify(b.body)).toBe(422);
  });
});

describe("SV-009 / SV-010 village edits", () => {
  it("clears the extent when asked to", async () => {
    const v = await village();
    const before = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    const r = await send("PATCH", w.admin, `/api/v1/survey/villages/${v}`, { total_extent_ac: null },
      { "if-match": String(before.data.version) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    expect(after.data.total_extent_ac).toBeNull();
  });

  it("refuses a plan that finishes before it starts", async () => {
    const v = await village();
    const before = await send("GET", w.admin, `/api/v1/survey/villages/${v}`);
    const r = await send("PATCH", w.admin, `/api/v1/survey/villages/${v}/plan`,
      { planned_start_on: day(10), expected_completion_on: day(1) },
      { "if-match": String(before.data.version) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });
});

/*
 * SV-011 a claim's status could move anywhere, a paid claim included
 * SV-012 a decision could be dated before the claim was submitted
 * SV-013 a claim could be deleted when paid, or from under later milestones
 */
describe("SV-011 / SV-012 / SV-013 billing claims", () => {
  let v: string;
  const claims = async () => (await send("GET", w.admin, `/api/v1/survey/villages/${v}/billing`)).data as any[];
  const claim = async (m: number) => (await claims()).find((c) => c.milestone === m);
  const patch = async (m: number, body: Record<string, unknown>) => {
    const c = await claim(m);
    return send("PATCH", w.admin, `/api/v1/survey/billing/${c.id}`, body, { "if-match": String(c.version) });
  };

  beforeAll(async () => {
    v = await village("Billing village");
    expect((await startGt(v, [await employee()], day(-8))).status).toBe(201);
    let n = -7;
    for (const code of ["GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "DATA_SUBMISSION"]) {
      const a = await post(w.admin, `/api/v1/survey/villages/${v}/stage`,
        { stage_code: code, state: "IN_PROGRESS", started_on: day(n) });
      const b = await post(w.admin, `/api/v1/survey/villages/${v}/stage`,
        { stage_code: code, state: "COMPLETED", started_on: day(n), completed_on: day(n + 1) });
      expect([a.status, b.status], JSON.stringify(b.body)).toEqual([200, 200]);
      n += 1;
    }
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 1, submitted_on: day(-2) })).status).toBe(201);
    expect((await post(w.admin, `/api/v1/survey/villages/${v}/billing`, { milestone: 2, submitted_on: day(-2) })).status).toBe(201);
  });

  it("refuses a decision dated before the claim was submitted", async () => {
    const r = await patch(2, { status: "APPROVED", decided_on: day(-5) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it("refuses to delete a claim with a later milestone standing on it", async () => {
    const c = await claim(1);
    const r = await send("DELETE", w.admin, `/api/v1/survey/billing/${c.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("walks SUBMITTED -> APPROVED -> PAID, and a paid claim then stays paid", async () => {
    expect((await patch(1, { status: "APPROVED", decided_on: day(-1) })).status).toBe(200);
    expect((await patch(1, { status: "PAID", decided_on: day(0) })).status).toBe(200);
    for (const status of ["SUBMITTED", "REJECTED", "APPROVED"]) {
      const r = await patch(1, { status, decided_on: status === "SUBMITTED" ? null : day(0) });
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(r.body.code).toBe("CLAIM_TRANSITION_REFUSED");
    }
    const pct = await patch(1, { percent: 10 });
    expect(pct.status, JSON.stringify(pct.body)).toBe(409);
    // The paper trail can still be corrected.
    expect((await patch(1, { reference_no: "LTR-42" })).status).toBe(200);
  });

  it("lets a returned claim be resubmitted, which is how rework is billed again", async () => {
    expect((await patch(2, { status: "REJECTED", decided_on: day(0) })).status).toBe(200);
    const r = await patch(2, { status: "SUBMITTED", decided_on: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("refuses to delete a paid claim", async () => {
    // Milestone 2 is removed first so the only reason left is that 1 is paid.
    const two = await claim(2);
    expect((await send("DELETE", w.admin, `/api/v1/survey/billing/${two.id}`)).status).toBe(200);
    const one = await claim(1);
    const r = await send("DELETE", w.admin, `/api/v1/survey/billing/${one.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
  });

  it("applies the same transitions to a bulk decision", async () => {
    const r = await post(w.admin, "/api/v1/survey/billing/bulk", {
      survey_village_ids: [v], action: "DECIDE", milestone: 1, status: "REJECTED",
      decided_on: day(0), dry_run: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.would_change ?? r.data.changed ?? 0).toBe(0);
    expect(JSON.stringify(r.data.skipped)).toContain("CLAIM_CLOSED");
  });
});
