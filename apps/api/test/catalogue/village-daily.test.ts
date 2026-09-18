/**
 * A village's returns, day by day (§note 19).
 *
 * The summary sheet totals a village's life. This is the working underneath
 * it: "eighty-two per cent turnout" is a figure somebody queries, and the
 * answer is the days in the middle where the department sent nobody — which
 * is only visible a day at a time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let village = "";
let roverA = "";
let roverB = "";

async function send(method: "POST" | "GET", h: Headers, url: string, payload?: unknown) {
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

const day = (n: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Daily programme" });
  programmeId = String(p.data.id);

  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'ASR') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'KOYYURU',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);
  const unit = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,'ADAKULA',$3) RETURNING id`,
    [w.orgId, uniq("V"), mandal])).rows[0].id);
  const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_id: unit, total_extent_ac: 200 });
  village = String(sv.data.id);

  await post(w.admin, `/api/v1/survey/villages/${village}/stage`, {
    stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: day(-5),
    gt_govt_staff_allocated: 2, gt_crew_allocated: 4,
  });

  const mk = async (code: string) => String((await w.pool.query(
    `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
     VALUES($1,$2,$3,'SURVEY','AVAILABLE','GOOD') RETURNING id`,
    [w.orgId, code, `Rover ${code}`])).rows[0].id);
  roverA = await mk(uniq("RA"));
  roverB = await mk(uniq("RB"));
  await post(w.admin, `/api/v1/survey/villages/${village}/rovers/bulk`,
    { asset_ids: [roverA, roverB], allocated_on: day(-5) });

  // Three days: everybody there; one rover idle; the department absent.
  await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: village, entry_date: day(-3), teams_deployed: 2,
    values: { GOVT_LAND_EXTENT_AC: 20, GOVT_LAND_POINTS: 80 },
    govt_staff_present: 2, crew_present: 4,
    rovers: [
      { asset_id: roverA, status: "UTILIZED", area_ac: 12 },
      { asset_id: roverB, status: "UTILIZED", area_ac: 8 },
    ],
  });
  await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: village, entry_date: day(-2), teams_deployed: 2,
    values: { GOVT_LAND_EXTENT_AC: 14, GOVT_LAND_POINTS: 55 },
    govt_staff_present: 1, crew_present: 4,
    rovers: [
      { asset_id: roverA, status: "UTILIZED", area_ac: 14 },
      { asset_id: roverB, status: "IDLE", idle_reason: "ROVER" },
    ],
  });
  await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: village, entry_date: day(-1), teams_deployed: 2,
    values: { GOVT_LAND_EXTENT_AC: 2 },
    govt_staff_present: 0, crew_present: 4,
    low_progress_reason: "OTHER", low_progress_remarks: "No VRO",
    rovers: [
      { asset_id: roverA, status: "IDLE", idle_reason: "NO_DEPT_STAFF" },
      { asset_id: roverB, status: "IDLE", idle_reason: "ROVER" },
    ],
  });
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the day-by-day sheet", () => {
  it("returns one row per return, in date order", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.days).toHaveLength(3);
    expect(r.data.days.map((d: any) => d.entry_date))
      .toEqual([day(-3), day(-2), day(-1)]);
  });

  it("shows rovers allocated, used and idle on each day", async () => {
    // A count of instruments used means nothing without how many were out:
    // one of two is a different day from one of six.
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    const second = r.data.days[1];
    expect(second.rovers_allocated).toBe(2);
    expect(second.rovers_used).toBe(1);
    expect(second.rovers_idle).toBe(1);
  });

  it("shows who was there against what was agreed", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    expect(r.data.village.gt_govt_staff_allocated).toBe(2);
    expect(r.data.village.gt_crew_allocated).toBe(4);
    expect(r.data.days.map((d: any) => d.govt_staff_present)).toEqual([2, 1, 0]);
    expect(r.data.days.map((d: any) => d.crew_present)).toEqual([4, 4, 4]);
  });

  it("names the reason a thin day was thin", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    const last = r.data.days[2];
    expect(last.low_progress_label).toBeTruthy();
  });

  it("sums the columns it shows, from the rows it shows", async () => {
    // The line at the bottom is computed from the same rows as the lines
    // above, so the two can never disagree.
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    const t = r.data.totals;
    expect(t.return_days).toBe(3);
    expect(t.team_days).toBe(6);
    expect(t.rover_days_used).toBe(3);
    expect(t.rover_days_idle).toBe(3);
    expect(t.govt_staff_days).toBe(3);
    expect(t.crew_days).toBe(12);
    expect(t.values.GOVT_LAND_EXTENT_AC).toBe(36);
    expect(t.values.GOVT_LAND_POINTS).toBe(135);
  });

  it("totals attendance against the allocation, and counts the empty days", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    const t = r.data.totals;
    // Three days at two agreed is six expected; three turned up.
    expect(t.govtStaffExpected).toBe(6);
    expect(t.govtStaffDays).toBe(3);
    expect(t.govtStaffPct).toBe(50);
    expect(t.crewPct).toBe(100);
    expect(t.daysWithNoGovtStaff).toBe(1);
    expect(t.daysShort).toBe(2);
  });

  it("narrows to a window without changing what the rows mean", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/villages/${village}/daily?from=${day(-2)}&to=${day(-1)}`);
    expect(r.data.days).toHaveLength(2);
    expect(r.data.totals.return_days).toBe(2);
    expect(r.data.totals.govt_staff_days).toBe(1);
  });

  it("returns an honest nothing for a window with no returns", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/villages/${village}/daily?from=2000-01-01&to=2000-01-31`);
    expect(r.status).toBe(200);
    expect(r.data.days).toEqual([]);
    expect(r.data.totals.return_days).toBe(0);
    expect(r.data.totals.govtStaffPct).toBeNull();
  });
});

describe("the programme summary", () => {
  it("carries rovers, crew and attendance per village", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const row = r.data.find((v: any) => v.village === "ADAKULA");
    expect(row.rovers_allocated).toBe(2);
    expect(row.rover_days_used).toBe(3);
    expect(row.rover_days_idle).toBe(3);
    expect(row.rover_utilisation_pct).toBe(50);
    expect(row.return_days).toBe(3);
    expect(row.team_days).toBe(6);
    expect(row.govt_staff_days).toBe(3);
    expect(row.crew_days).toBe(12);
    expect(row.days_no_govt_staff).toBe(1);
  });

  it("agrees with the day-by-day sheet it summarises", async () => {
    // Two queries, one answer. If these drift the sheet stops being trusted.
    const sheet = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const daily = await get(w.admin, `/api/v1/survey/villages/${village}/daily`);
    const row = sheet.data.find((v: any) => v.village === "ADAKULA");
    expect(row.rover_days_used).toBe(daily.data.totals.rover_days_used);
    expect(row.rover_days_idle).toBe(daily.data.totals.rover_days_idle);
    expect(row.govt_staff_days).toBe(daily.data.totals.govt_staff_days);
    expect(row.crew_days).toBe(daily.data.totals.crew_days);
    expect(row.team_days).toBe(daily.data.totals.team_days);
  });
});
