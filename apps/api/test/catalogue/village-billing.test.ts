/**
 * Submitting a village for billing (§066).
 *
 * A resurvey contract does not pay for a village in one go. It releases half
 * the value once ground truthing is signed off, thirty per cent at records
 * preparation, and the last fifth on final submission. Which villages are at
 * which claim is the question the office asks before every review, and it was
 * answered out of a spreadsheet.
 *
 * What is being tested is that the claim is a record of something somebody
 * did — a covering letter that went to the department on a date, under a file
 * number — and not a status the software infers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let villageA = "";
let villageB = "";

async function send(
  method: "POST" | "GET" | "PATCH" | "DELETE", headers: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body, meta: body?.meta };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);
const del = (h: Headers, u: string) => send("DELETE", h, u);

async function ver(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM survey_village_billing WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

async function makeVillage(name: string): Promise<string> {
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'ASR') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'KOYYURU',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const unit = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("V"), name, mandal])).rows[0].id);
  const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_id: unit, total_extent_ac: 420 });
  expect(sv.status, JSON.stringify(sv.body)).toBe(201);
  return String(sv.data.id);
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Billing programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA");
  villageB = await makeVillage("BUTCHAMPETA");
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("recording a claim", () => {
  it("fills in the contract's share so nobody types 50 three hundred times", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 1, reference_no: "RC/2026/114" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.percent).toBe(50);
    expect(r.data.status).toBe("SUBMITTED");
    // Dated today unless somebody says otherwise, because the common case is
    // recording a letter as it goes out.
    expect(r.data.submitted_on).toBeTruthy();
  });

  it("keeps the share that was actually agreed when it differs", async () => {
    // A later contract may split 40/40/20. The rows written under this one
    // must not move when it does, so the percentage is on the claim.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/billing`,
      { milestone: 1, percent: 40 });
    expect(r.status).toBe(201);
    expect(r.data.percent).toBe(40);
  });

  it("refuses a second claim on the same milestone, and says what to do", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("MILESTONE_ALREADY_CLAIMED");
    expect(r.body.message).toMatch(/already been submitted/i);
    expect(r.body.message).toMatch(/status or reference/i);
  });

  it("will not record a claim as approved without the date it was approved", async () => {
    // A decided claim with no decision date cannot be aged, and ageing them
    // is the reason to track them at all.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 2, status: "APPROVED" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DECISION_DATE_REQUIRED");
  });

  it("refuses a submission dated in the future", async () => {
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 3, submitted_on: soon });
    expect(r.status).toBe(422);
  });

  it("accepts a backdated one, because the letter went out last week", async () => {
    const past = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 3, submitted_on: past, extent_ac: 411.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.submitted_on).toBe(past);
    // The extent claimed is what was surveyed, which need not be the extent
    // in the revenue record.
    expect(r.data.extent_ac).toBe(411.5);
  });
});

describe("what has been claimed on a village", () => {
  it("adds up the share released, ignoring what came back", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    expect(r.status).toBe(200);
    // Milestone 1 at 50 and milestone 3 at 20 are standing; the approved
    // attempt at 2 was refused above and never written.
    expect(r.meta.claimed_percent).toBe(70);
    expect(r.data.map((c: any) => c.milestone)).toEqual([1, 3]);
  });

  it("stops counting a claim the department returned", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    const third = list.data.find((c: any) => c.milestone === 3);
    const today = new Date().toISOString().slice(0, 10);
    const r = await patch({ ...w.admin, ...(await ver(third.id)) },
      `/api/v1/survey/billing/${third.id}`,
      { status: "REJECTED", decided_on: today, remarks: "LPM sheets short" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const after = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    expect(after.meta.claimed_percent).toBe(50);
  });

  it("will not let a claim be marked paid with no date on it", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/billing`);
    const first = list.data.find((c: any) => c.milestone === 1);
    const r = await patch({ ...w.admin, ...(await ver(first.id)) },
      `/api/v1/survey/billing/${first.id}`, { status: "PAID" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DECISION_DATE_REQUIRED");
  });
});

describe("pulling the list the office needs", () => {
  it("finds every claim in a window", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&from=2000-01-01&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.data.length).toBeGreaterThanOrEqual(3);
    // Named, not just identified: the list is read by people.
    expect(r.data[0].village_name).toBeTruthy();
  });

  it("filters to one milestone", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&milestone=1`);
    expect(r.data.every((c: any) => c.milestone === 1)).toBe(true);
    expect(r.data.length).toBe(2);
  });

  it("filters to one status", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&status=REJECTED`);
    expect(r.data.length).toBe(1);
    expect(r.data[0].milestone).toBe(3);
  });

  it("lists villages still owing a milestone", async () => {
    // The question before a review: who is due a second claim. A returned
    // claim leaves the village owing that milestone again.
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=2`);
    expect(r.status).toBe(200);
    const ids = r.data.map((v: any) => v.id);
    expect(ids).toContain(villageA);
    expect(ids).toContain(villageB);

    const owed3 = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=3`);
    // Village A's third claim was returned, so it is owed again.
    expect(owed3.data.map((v: any) => v.id)).toContain(villageA);
  });

  it("says which milestones a still-owing village has already claimed", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/billing?project_id=${programmeId}&outstanding=2`);
    const a = r.data.find((v: any) => v.id === villageA);
    expect(a.claimed_milestones).toEqual([1]);
  });

  it("refuses a filter it does not know rather than ignoring it", async () => {
    const r = await get(w.admin, `/api/v1/survey/billing?milestone=1&nonsense=1`);
    expect(r.status).toBe(422);
  });
});

describe("removing a claim", () => {
  it("lets a claim entered by mistake be taken back off the village", async () => {
    const created = await post(w.admin, `/api/v1/survey/villages/${villageB}/billing`,
      { milestone: 2 });
    expect(created.status).toBe(201);
    const r = await del(w.admin, `/api/v1/survey/billing/${created.data.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const after = await get(w.admin, `/api/v1/survey/villages/${villageB}/billing`);
    expect(after.data.map((c: any) => c.milestone)).not.toContain(2);
  });

  it("does not find a claim that was never there", async () => {
    const r = await del(w.admin,
      "/api/v1/survey/billing/00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(404);
  });
});
