/**
 * Who was allotted to ground truthing, and who turned up (§067).
 *
 * Ground truthing is walked by our crew alongside government staff — the
 * village revenue officer, the mandal surveyor. The contract is staffed on
 * both sides fielding the agreed numbers, and when the department's people do
 * not come the crew stands in the village doing nothing at our cost.
 *
 * That gap was invisible. The return recorded teams and rovers; it did not
 * record how many people of either kind were actually there, so "we lost nine
 * days in Koyyuru waiting for the VRO" was something a supervisor knew and
 * nothing could show.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let villageA = "";
let villageB = "";

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
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

const day = (n: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
    { village_id: unit, total_extent_ac: 200 });
  expect(sv.status, JSON.stringify(sv.body)).toBe(201);
  return String(sv.data.id);
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Staffing programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA");
  villageB = await makeVillage("BUTCHAMPETA");
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("starting ground truthing", () => {
  it("will not start without the staffing agreed with the mandal", async () => {
    // The one moment anybody knows the answer is now. A programme that
    // started without it can never show the days the department sent nobody.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("STAFFING_REQUIRED");
    expect(r.body.message).toMatch(/government staff/i);
  });

  it("starts once both numbers are given, and remembers them", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: day(-6),
      gt_govt_staff_allocated: 2, gt_crew_allocated: 4,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const held = await w.pool.query(
      "SELECT gt_govt_staff_allocated g, gt_crew_allocated c FROM survey_villages WHERE id=$1",
      [villageA]);
    expect(Number(held.rows[0].g)).toBe(2);
    expect(Number(held.rows[0].c)).toBe(4);
  });

  it("does not ask again once the village carries the figures", async () => {
    // Correcting a stage later should not re-open a settled question.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: day(-6) });
    expect(r.status).toBe(200);
  });

  it("asks nothing of the stages that are not jointly staffed", async () => {
    // No other stage is walked with the department, and asking on the rest
    // would collect figures that mean nothing.
    await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED",
      started_on: day(-6), completed_on: day(-1),
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/stage`,
      { stage_code: "GT_QC", state: "IN_PROGRESS" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("refuses a headcount that is obviously a typo", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS",
      gt_govt_staff_allocated: 99999, gt_crew_allocated: 4,
    });
    expect(r.status).toBe(422);
  });

  it("refuses a fraction of a person", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS",
      gt_govt_staff_allocated: 2.5, gt_crew_allocated: 4,
    });
    expect(r.status).toBe(422);
  });

  it("lets the allocation be corrected afterwards", async () => {
    // The mandal reassigns people, and an allocation nobody can change is
    // one everybody stops believing.
    const v = await w.pool.query("SELECT version FROM survey_villages WHERE id=$1", [villageA]);
    const r = await patch({ ...w.admin, "if-match": String(v.rows[0].version) },
      `/api/v1/survey/villages/${villageA}/plan`, { gt_govt_staff_allocated: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const held = await w.pool.query(
      "SELECT gt_govt_staff_allocated g FROM survey_villages WHERE id=$1", [villageA]);
    expect(Number(held.rows[0].g)).toBe(3);
  });
});

describe("the day's return", () => {
  beforeAll(async () => {
    await post(w.admin, `/api/v1/survey/villages/${villageB}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: day(-5),
      gt_govt_staff_allocated: 2, gt_crew_allocated: 4,
    });
  });

  it("records who was actually there, on each side", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: day(-4), teams_deployed: 1,
      values: { GOVT_LAND_EXTENT_AC: 12 },
      govt_staff_present: 2, crew_present: 4,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.govt_staff_present).toBe(2);
    expect(r.data.crew_present).toBe(4);
  });

  it("takes nobody-came as a real answer, not as a missing one", async () => {
    // Zero is the fact worth counting. Blank means nobody was asked, which
    // is a different thing entirely.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: day(-3), teams_deployed: 1,
      values: { GOVT_LAND_EXTENT_AC: 2 },
      govt_staff_present: 0, crew_present: 4,
      low_progress_reason: "OTHER", low_progress_remarks: "VRO did not come",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.govt_staff_present).toBe(0);
  });

  it("still accepts a return that says nothing about attendance", async () => {
    // Returns filed before this existed, and stages that are not ground
    // truthing. Demanding it everywhere would break both.
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: day(-2), teams_deployed: 1,
      values: { GOVT_LAND_EXTENT_AC: 8 },
    });
    expect(r.status).toBe(201);
    expect(r.data.govt_staff_present).toBeNull();
  });

  it("carries the allocation onto the row, so 4 reads as 4 of 4", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/entries?survey_village_id=${villageB}&limit=10`);
    const row = r.data.find((e: any) => e.entry_date === day(-4));
    expect(Number(row.gt_govt_staff_allocated)).toBe(2);
    expect(Number(row.gt_crew_allocated)).toBe(4);
  });

  it("refuses more people than any village is staffed with", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: day(-1), teams_deployed: 1,
      values: { GOVT_LAND_EXTENT_AC: 1 }, govt_staff_present: 5000,
    });
    expect(r.status).toBe(422);
  });

  it("keeps both numbers in the trail when attendance is amended", async () => {
    // "Who changed four government staff to nought" is exactly the question
    // an amended attendance gets asked.
    const list = await get(w.admin,
      `/api/v1/survey/entries?survey_village_id=${villageB}&limit=10`);
    const row = list.data.find((e: any) => e.entry_date === day(-4));
    const r = await patch({ ...w.admin, "if-match": String(row.version) },
      `/api/v1/survey/entries/${row.id}`,
      { govt_staff_present: 1, amendment_reason: "Recount" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const audit = await w.pool.query(
      `SELECT before_state, after_state FROM audit_events
        WHERE action = 'survey.entry.amend' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0].before_state.govt_staff_present).toBe(2);
  });
});

describe("what the reports make of it", () => {
  it("reports turnout against the allocation on the progress screen", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?from=${day(-30)}&to=${day(0)}`);
    expect(r.status).toBe(200);
    const s = r.data.staffing;
    // Three returns were filed and only two say anything about attendance.
    // The silent one is left out of both sides rather than counted as zero.
    expect(s.daysRecorded).toBe(2);
    expect(s.daysWithNoGovtStaff).toBe(1);
    expect(s.govtStaffPct).not.toBeNull();
  });

  it("narrows attendance with the rest of the filter", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?from=${day(-30)}&to=${day(0)}`
      + `&village_id=${villageA}`);
    // Village A has an allocation and no returns against it.
    expect(r.data.staffing.daysRecorded).toBe(0);
  });

  it("puts attendance on the period report beside the acres", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/report?from=${day(-30)}&to=${day(0)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.staffing.daysRecorded).toBe(2);
    expect(r.data.staffing.daysWithNoGovtStaff).toBe(1);
  });

  it("compares a chosen range against the same length before it", async () => {
    // A range somebody picked has no calendar predecessor, and comparing
    // eleven days against thirty would be worse than not comparing at all.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/report?from=${day(-6)}&to=${day(0)}`);
    expect(r.data.period.from).toBe(day(-6));
    expect(r.data.previous_period.to).toBe(day(-7));
    expect(r.data.previous_period.from).toBe(day(-13));
  });

  it("refuses a range that starts after it ends", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/report?from=${day(0)}&to=${day(-6)}`);
    expect(r.status).toBe(422);
  });

  it("puts allocation and attendance on the village sheet", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const row = r.data.find((v: any) => v.village === "BUTCHAMPETA");
    expect(row.gt_govt_staff_allocated).toBe(2);
    expect(row.gt_crew_allocated).toBe(4);
    expect(row.attendance_days).toBe(2);
    expect(row.days_no_govt_staff).toBe(1);
  });

  it("buckets attendance on the trend, period by period", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/timeline?from=${day(-30)}&to=${day(0)}&grain=MONTH`);
    expect(r.status).toBe(200);
    const withStaff = r.data.periods.filter((p: any) => p.staffing.daysRecorded > 0);
    expect(withStaff.length).toBeGreaterThan(0);
  });
});
