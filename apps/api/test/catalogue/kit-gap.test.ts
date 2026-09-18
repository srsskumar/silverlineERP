/**
 * Why a village with four people on it shows no instruments (§note 18).
 *
 * A rover follows the person it is issued to, so assigning crew to a village
 * usually brings their kit. Usually — one person is crew on several villages
 * at once, and an instrument can only be in one place. The database enforces
 * that with an exclusion constraint, so the carry silently skips and the
 * screen shows a crewed village with nothing allocated.
 *
 * The answer is never "the software forgot". It is "that rover is in Koyyuru
 * until Thursday", and that is a sentence somebody can act on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, uniquePhone, workDate,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let villageA = "";
let villageB = "";
let surveyor = "";
let roverId = "";

async function send(
  method: "POST" | "GET" | "DELETE", h: Headers, url: string, payload?: unknown,
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
    { village_id: unit, total_extent_ac: 100 });
  return String(sv.data.id);
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Kit programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA");
  villageB = await makeVillage("BUTCHAMPETA");

  surveyor = String((await w.pool.query(
    `INSERT INTO employees(org_id, emp_no, first_name, last_name, status, date_of_joining, phone)
     VALUES($1,$2,'Ravi','Kumar','ACTIVE',CURRENT_DATE,$3) RETURNING id`,
    [w.orgId, uniq("E"), uniquePhone()])).rows[0].id);

  roverId = String((await w.pool.query(
    `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
     VALUES($1,$2,'Rover R1','SURVEY','ASSIGNED','GOOD') RETURNING id`,
    [w.orgId, uniq("RV")])).rows[0].id);
  // Issued to the surveyor: this is what makes the kit follow them.
  await w.pool.query(
    `INSERT INTO asset_assignments(org_id, asset_id, employee_id, issued_at, condition, reason)
     VALUES($1,$2,$3, now(), 'GOOD', 'Field survey')`, [w.orgId, roverId, surveyor]);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("kit following the crew", () => {
  it("brings the instrument to the first village they are put on", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/crew`,
      { employee_id: surveyor, stage_code: "GROUND_TRUTHING" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.rovers_brought).toHaveLength(1);

    const held = await get(w.admin, `/api/v1/survey/villages/${villageA}/rovers`);
    expect(held.data).toHaveLength(1);
  });

  it("cannot bring it to a second village at the same time", async () => {
    // Not a bug: an instrument is accounted to one village per day, and the
    // database says so.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: surveyor, stage_code: "GROUND_TRUTHING" });
    expect(r.status).toBe(201);
    expect(r.data.rovers_brought).toHaveLength(0);
    expect(r.data.rovers_left_elsewhere).toHaveLength(1);

    const held = await get(w.admin, `/api/v1/survey/villages/${villageB}/rovers`);
    expect(held.data).toHaveLength(0);
  });
});

describe("explaining the empty village", () => {
  it("names the instrument, the person and the village holding it", async () => {
    // The screen used to show four people and nothing allocated, with no
    // explanation anywhere.
    const r = await get(w.admin, `/api/v1/survey/villages/${villageB}/kit-gap`);
    expect(r.status).toBe(200);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].employee_name).toMatch(/Ravi/);
    expect(r.data[0].held_by_village_name).toBe("ADAKULA");
    expect(r.data[0].held_since).toBeTruthy();
  });

  it("says nothing about the village that actually has the kit", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/kit-gap`);
    expect(r.data).toEqual([]);
  });
});

describe("bringing it here", () => {
  it("moves the instrument, releasing it where it was", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/rovers/claim`,
      { asset_ids: [roverId] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.brought).toBe(1);

    const here = await get(w.admin, `/api/v1/survey/villages/${villageB}/rovers`);
    expect(here.data.filter((x: any) => !x.released_on)).toHaveLength(1);
  });

  it("leaves the day it was last out with the village that worked it", async () => {
    /*
     * A rover is accounted to one village per day. Releasing it the same day
     * it arrives somewhere else would put one instrument on two villages for
     * that day, and every utilisation figure would double-count it.
     */
    const rows = await w.pool.query(
      `SELECT survey_village_id, allocated_on, released_on
         FROM survey_rover_allocations WHERE asset_id = $1 ORDER BY allocated_on`, [roverId]);
    const [first, second] = rows.rows;
    expect(first.released_on).not.toBeNull();
    expect(new Date(second.allocated_on).getTime())
      .toBeGreaterThan(new Date(first.released_on).getTime());
  });

  it("now reports no gap on the village that has it", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageB}/kit-gap`);
    expect(r.data).toEqual([]);
  });

  it("reports the gap against the village it left", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/kit-gap`);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].held_by_village_name).toBe("BUTCHAMPETA");
  });

  it("refuses an instrument that does not exist rather than reporting success", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers/claim`,
      { asset_ids: ["00000000-0000-0000-0000-000000000000"] });
    expect(r.data.brought).toBe(0);
    expect(r.data.refused).toHaveLength(1);
  });

  it("refuses an empty request rather than reporting nothing done", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers/claim`,
      { asset_ids: [] });
    expect(r.status).toBe(422);
  });
});

describe("a rover that arrived this morning", () => {
  it("is not released yesterday, and says when it will actually arrive", async () => {
    /*
     * The check constraint on these dates refuses a release before the
     * allocation, and rightly: a rover cannot leave a village before it got
     * there. The stint stands as a single day and the new village gets it
     * tomorrow — which is what happens on the ground anyway, since somebody
     * has to drive it over.
     */
    const third = await makeVillage("SAME DAY");
    const r = await post(w.admin, `/api/v1/survey/villages/${third}/rovers/claim`,
      { asset_ids: [roverId] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.brought).toBe(1);
    // Told, rather than left to be discovered when today's return has no
    // instrument on it.
    expect(r.data.arriving).toHaveLength(1);
    expect(r.data.arriving[0].on > workDate()).toBe(true);
  });

  it("leaves no day where one instrument is on two villages", async () => {
    const rows = (await w.pool.query(
      `SELECT survey_village_id, allocated_on, released_on
         FROM survey_rover_allocations WHERE asset_id = $1
        ORDER BY allocated_on`, [roverId])).rows;
    for (let i = 1; i < rows.length; i += 1) {
      const prevEnd = rows[i - 1].released_on;
      expect(prevEnd, `stint ${i - 1} never ended`).not.toBeNull();
      expect(new Date(rows[i].allocated_on).getTime())
        .toBeGreaterThan(new Date(prevEnd).getTime());
    }
  });
});
