/**
 * Reading a programme costs the programme, not the organisation.
 *
 * The live contract holds twelve hundred villages in one programme and
 * twelve and a half thousand stage rows across the organisation. Every read
 * of a village list, a dashboard or a report went through one helper that
 * fetched every stage row and every target in the organisation and threw
 * away the ones that belonged elsewhere -- so a two-village programme paid
 * for the twelve-hundred-village one on every screen.
 *
 * These pin the scoping, the picker shape the entry screen now asks for,
 * and the single-village read it opens on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeA = "";
let programmeB = "";
let villageA = "";
let villageB = "";
let measureCode = "";

async function send(
  method: "POST" | "GET" | "PATCH" | "DELETE", h: Headers, url: string, payload?: unknown,
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

async function makeVillage(programme: string, name: string, extent = 200): Promise<string> {
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,$3) RETURNING id`,
    [w.orgId, uniq("D"), `${name} district`])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("M"), `${name} mandal`, district])).rows[0].id);
  const unit = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("V"), name, mandal])).rows[0].id);
  const sv = await post(w.admin, `/api/v1/survey/projects/${programme}/villages`,
    { village_id: unit, total_extent_ac: extent });
  expect(sv.status, JSON.stringify(sv.body)).toBe(201);
  return String(sv.data.id);
}

/** The SQL the helper sends while a request runs, so scoping can be read off it. */
async function sqlDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = w.pool.query.bind(w.pool);
  (w.pool as any).query = (...args: any[]) => {
    if (typeof args[0] === "string") seen.push(args[0]);
    return (original as any)(...args);
  };
  try { await fn(); } finally { (w.pool as any).query = original; }
  return seen;
}

beforeAll(async () => {
  w = await buildWorld();
  const a = await post(w.admin, "/api/v1/survey/projects", { code: uniq("SPA"), name: "Programme A" });
  const b = await post(w.admin, "/api/v1/survey/projects", { code: uniq("SPB"), name: "Programme B" });
  programmeA = String(a.data.id);
  programmeB = String(b.data.id);
  villageA = await makeVillage(programmeA, "ADAKULA", 300);
  villageB = await makeVillage(programmeB, "BUTCHAMPETA", 100);
  const m = await get(w.admin, "/api/v1/survey/measures");
  measureCode = String((m.data.measures as Array<{ code: string; basis: string }>)
    .find(x => x.basis === "TARGET")!.code);
  // A target and a started stage on B only, so anything of B's that leaks
  // into A's answer is visible.
  await post(w.admin, `/api/v1/survey/villages/${villageB}/targets`,
    { measure_code: measureCode, target_quantity: 40 });
  // Started the way the module starts it: ground truthing will not begin
  // without the staffing agreed with the mandal (§067).
  const started = await post(w.admin, `/api/v1/survey/villages/${villageB}/start-gt`, {
    started_on: "2026-01-05", expected_end_on: "2026-02-28",
    employee_ids: [w.directEmployee], govt_staff_allocated: 2, crew_allocated: 5,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
});

afterAll(async () => { await w.app.close(); });

describe("the village list reads only its own programme", () => {
  it("does not fetch the organisation's stage and target rows", async () => {
    const sql = await sqlDuring(async () => {
      const r = await get(w.admin, `/api/v1/survey/projects/${programmeA}/villages`);
      expect(r.status).toBe(200);
    });
    const stageRead = sql.find(s => s.includes("FROM survey_village_stages vs"));
    const targetRead = sql.find(s => s.includes("FROM survey_targets t"));
    expect(stageRead, "stage rows are read").toBeTruthy();
    expect(targetRead, "target rows are read").toBeTruthy();
    // Both joined to the programme's villages, not merely to the organisation.
    expect(stageRead).toMatch(/sv\.survey_project_id = \$2/);
    expect(targetRead).toMatch(/sv\.survey_project_id = \$2/);
  });

  it("still answers with the programme's own stages and targets", async () => {
    await post(w.admin, `/api/v1/survey/villages/${villageA}/targets`,
      { measure_code: measureCode, target_quantity: 25 });
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeA}/villages`);
    expect(r.data).toHaveLength(1);
    const row = r.data[0];
    expect(row.id).toBe(villageA);
    expect(Object.values(row.targets as Record<string, number>)).toEqual([25]);
    // B's started ground truthing is B's.
    expect(row.stages.GROUND_TRUTHING ?? "NOT_STARTED").toBe("NOT_STARTED");
    const rb = await get(w.admin, `/api/v1/survey/projects/${programmeB}/villages`);
    expect(rb.data[0].stages.GROUND_TRUTHING).toBe("IN_PROGRESS");
    expect(Object.values(rb.data[0].targets as Record<string, number>)).toEqual([40]);
  });
});

describe("the picker shape (fields=picker)", () => {
  it("carries the names and nothing about the position", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeA}/villages?fields=picker`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    const row = r.data[0];
    expect(row).toMatchObject({
      id: villageA, village_name: "ADAKULA", mandal_name: "ADAKULA mandal",
      district_name: "ADAKULA district",
    });
    for (const heavy of ["stages", "stage_dates", "measures", "done", "targets", "assignee_name"]) {
      expect(row, heavy).not.toHaveProperty(heavy);
    }
  });

  it("does not run the position queries at all", async () => {
    const sql = await sqlDuring(async () => {
      await get(w.admin, `/api/v1/survey/projects/${programmeA}/villages?fields=picker`);
    });
    expect(sql.some(s => s.includes("FROM survey_village_stages vs"))).toBe(false);
    expect(sql.some(s => s.includes("JOIN survey_entry_values ev"))).toBe(false);
  });
});

describe("one village on its own", () => {
  it("is the same row the list gives", async () => {
    const list = await get(w.admin, `/api/v1/survey/projects/${programmeA}/villages`);
    const one = await get(w.admin, `/api/v1/survey/villages/${villageA}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.data).toEqual(list.data[0]);
  });

  it("reads only that village's rows", async () => {
    const sql = await sqlDuring(async () => {
      await get(w.admin, `/api/v1/survey/villages/${villageA}`);
    });
    const villages = sql.find(s => s.includes("FROM survey_villages sv") && s.includes("ORDER BY m.name, v.name"));
    expect(villages).toMatch(/AND sv\.id = \$3/);
    const cumulative = sql.find(s => s.includes("JOIN survey_entry_values ev"));
    expect(cumulative).toMatch(/e\.survey_village_id = \$4/);
  });

  it("is refused to somebody outside the programme, as not found", async () => {
    const r = await get(w.directUser, `/api/v1/survey/villages/${villageA}`);
    expect(r.status).toBe(404);
    const other = await get(w.admin, `/api/v1/survey/villages/00000000-0000-0000-0000-000000000000`);
    expect(other.status).toBe(404);
  });
});

describe("the department's village rows", () => {
  it("carry the days in the current stage without a per-stage breakdown", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeB}/dashboard`);
    expect(r.status).toBe(200);
    const v = r.data.villages[0];
    expect(v).toHaveProperty("days_in_stage");
    expect(v).not.toHaveProperty("stage_days");
    // The programme-wide figures per stage are still there.
    expect(Array.isArray(r.data.stage_days)).toBe(true);
  });
});

describe("the department's headline agrees with the office's", () => {
  it("uses the certified total where one has been set", async () => {
    const measure = (await get(w.admin, "/api/v1/survey/measures")).data.measures
      .find((x: { basis: string }) => x.basis === "EXTENT").code as string;
    const filed = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: "2026-01-06", values: { [measure]: 30 },
      gt_variance_reason: "WEATHER",
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const done = await post(w.admin, `/api/v1/survey/villages/${villageB}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-01-07",
      variance_reason: "WEATHER",
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const certified = await send("PUT", w.admin, `/api/v1/survey/villages/${villageB}/finals`, {
      finals: [{ measure_code: measure, quantity: 45, reason: "Recounted at handover" }],
    });
    expect(certified.status, JSON.stringify(certified.body)).toBe(200);
    const office = await get(w.admin, `/api/v1/survey/projects/${programmeB}/progress`);
    const department = await get(w.admin, `/api/v1/survey/projects/${programmeB}/dashboard`);
    expect(office.data.total.surveyedAc).toBe(45);
    expect(department.data.totals.surveyed_ac).toBe(45);
    expect(department.data.villages[0].surveyed_ac).toBe(45);
    // A period report asks what was done in it, and a recount is not a week's work.
    const period = await get(w.admin,
      `/api/v1/survey/projects/${programmeB}/dashboard?from=2026-01-01&to=2026-01-31`);
    expect(period.data.totals.surveyed_ac).toBe(30);
  });
});
