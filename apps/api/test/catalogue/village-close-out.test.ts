/**
 * Closing out a finished village (§068), and the rules a claim falls under.
 *
 * Two things that happen at the end of a village's life: somebody stands
 * behind its totals, and somebody claims the money for it. Both were
 * spreadsheet work.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
let village = "";

async function send(
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE", h: Headers, url: string, payload?: unknown,
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
const put = (h: Headers, u: string, p?: unknown) => send("PUT", h, u, p);

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

const stage = (v: string, code: string, state: string, extra: Record<string, unknown> = {}) =>
  post(w.admin, `/api/v1/survey/villages/${v}/stage`, { stage_code: code, state, ...extra });

/** Walks a village up to and including the named stage. */
async function completeTo(v: string, last: string) {
  const order = ["GROUND_TRUTHING", "GT_QC", "VECTORIZATION", "DATA_SUBMISSION", "FINAL_DELIVERABLES"];
  for (const code of order) {
    const extra = code === "GROUND_TRUTHING"
      ? { gt_govt_staff_allocated: 2, gt_crew_allocated: 4 } : {};
    const r = await stage(v, code, "COMPLETED", { completed_on: workDate(), ...extra });
    expect(r.status, `${code}: ${JSON.stringify(r.body)}`).toBe(200);
    if (code === last) return;
  }
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Close-out programme" });
  programmeId = String(p.data.id);
  village = await makeVillage("ADAKULA");
  await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: village, entry_date: workDate(), teams_deployed: 1,
    values: { GOVT_LAND_EXTENT_AC: 120, GOVT_LAND_POINTS: 400 },
  });
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("what a milestone may be claimed on", () => {
  it("refuses the first claim before ground-truthing QC has signed off", async () => {
    // A claim raised early is one the department returns, and a returned
    // claim costs a month.
    const r = await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 1 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("MILESTONE_NOT_EARNED");
    expect(r.body.message).toMatch(/not started/i);
  });

  it("still refuses while that stage is only in progress", async () => {
    await stage(village, "GROUND_TRUTHING", "COMPLETED",
      { completed_on: workDate(), gt_govt_staff_allocated: 2, gt_crew_allocated: 4 });
    await stage(village, "GT_QC", "IN_PROGRESS");
    const r = await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 1 });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/in progress/i);
  });

  it("allows it once that stage is signed off", async () => {
    await stage(village, "GT_QC", "COMPLETED", { completed_on: workDate() });
    const r = await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("holds the second claim until the department has approved the data", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 2 });
    expect(r.status).toBe(422);
    // §071 renamed the checkpoint; the claim still waits on the same event.
    expect(r.body.message).toMatch(/data submission/i);
  });

  it("holds the third until the deliverables have gone in", async () => {
    await completeTo(village, "DATA_SUBMISSION");
    expect((await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 2 })).status).toBe(201);
    const third = await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 3 });
    expect(third.status).toBe(422);

    await completeTo(village, "FINAL_DELIVERABLES");
    expect((await post(w.admin, `/api/v1/survey/villages/${village}/billing`,
      { milestone: 3 })).status).toBe(201);
  });

  it("skips unearned villages in a batch rather than failing all of them", async () => {
    // One unfinished village must not stop the other three hundred and
    // ninety-nine.
    const fresh = await makeVillage("UNEARNED");
    const r = await post(w.admin, "/api/v1/survey/billing/bulk",
      { survey_village_ids: [fresh, village], action: "SUBMIT", milestone: 1 });
    expect(r.status).toBe(200);
    expect(r.data.skipped.some((x: any) => x.reason === "NOT_EARNED")).toBe(true);
    expect(r.data.skipped.some((x: any) => x.village_name === "UNEARNED")).toBe(true);
  });
});

describe("certifying the totals", () => {
  it("reports the recorded figure against nothing certified, to begin with", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/finals`);
    expect(r.status).toBe(200);
    const acres = r.data.find((m: any) => m.code === "GOVT_LAND_EXTENT_AC");
    expect(acres.recorded).toBe(120);
    expect(acres.certified).toBeNull();
    expect(acres.difference).toBeNull();
  });

  it("takes a certified figure with the reason it differs", async () => {
    const r = await put(w.admin, `/api/v1/survey/villages/${village}/finals`, {
      finals: [
        { measure_code: "GOVT_LAND_EXTENT_AC", quantity: 118.5,
          reason: "Recount at handover; two parcels merged" },
        { measure_code: "GOVT_LAND_POINTS", quantity: 396,
          reason: "Four points rejected at QC" },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.certified).toBe(2);
  });

  it("reports both figures and the gap, never hiding one behind the other", async () => {
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/finals`);
    const acres = r.data.find((m: any) => m.code === "GOVT_LAND_EXTENT_AC");
    expect(acres.recorded).toBe(120);
    expect(acres.certified).toBe(118.5);
    expect(acres.difference).toBe(-1.5);
    expect(acres.reason).toMatch(/recount/i);
    // Attributed: a figure somebody stands behind names who.
    expect(acres.certified_by_name).toBeTruthy();
  });

  it("carries the certified figure into every roll-up", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress?level=village`);
    const row = r.data.rows.find((x: any) => x.name === "ADAKULA");
    expect(row.measures.GOVT_LAND_EXTENT_AC.done).toBe(118.5);
  });

  it("leaves a period report alone, because a recount is not a week's work", async () => {
    /*
     * A certified total is a statement about the village, not about the
     * week. Folding it into a period would drop the whole recount into
     * whichever week somebody happened to certify it in.
     */
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/report?from=${workDate()}&to=${workDate()}`);
    expect(r.data.measures.GOVT_LAND_EXTENT_AC.current).toBe(120);
  });

  it("refuses a certified figure with no reason", async () => {
    const r = await put(w.admin, `/api/v1/survey/villages/${village}/finals`, {
      finals: [{ measure_code: "GOVT_LAND_EXTENT_AC", quantity: 100 }],
    });
    expect(r.status).toBe(422);
  });

  it("refuses a measure that does not exist", async () => {
    const r = await put(w.admin, `/api/v1/survey/villages/${village}/finals`, {
      finals: [{ measure_code: "MADE_UP", quantity: 1, reason: "Testing" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNKNOWN_MEASURE");
  });

  it("will not certify a village where nothing has been signed off", async () => {
    // Freezing a figure the crews are still adding to would widen a
    // difference nobody meant to create, every day.
    const fresh = await makeVillage("STILL RUNNING");
    const r = await put(w.admin, `/api/v1/survey/villages/${fresh}/finals`, {
      finals: [{ measure_code: "GOVT_LAND_EXTENT_AC", quantity: 10, reason: "Too early" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("NOTHING_FINISHED");
  });

  it("lets a certified figure be taken back off", async () => {
    const r = await send("DELETE", w.admin,
      `/api/v1/survey/villages/${village}/finals/GOVT_LAND_POINTS`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await get(w.admin, `/api/v1/survey/villages/${village}/finals`);
    const points = after.data.find((m: any) => m.code === "GOVT_LAND_POINTS");
    expect(points.certified).toBeNull();
    // And the village reads as its returns again.
    expect(points.recorded).toBe(400);
  });

  it("replaces a certified figure rather than stacking a second one", async () => {
    await put(w.admin, `/api/v1/survey/villages/${village}/finals`, {
      finals: [{ measure_code: "GOVT_LAND_EXTENT_AC", quantity: 119, reason: "Second recount" }],
    });
    const r = await get(w.admin, `/api/v1/survey/villages/${village}/finals`);
    const acres = r.data.find((m: any) => m.code === "GOVT_LAND_EXTENT_AC");
    expect(acres.certified).toBe(119);
    const held = await w.pool.query(
      "SELECT count(*)::int n FROM survey_village_finals WHERE survey_village_id=$1", [village]);
    expect(held.rows[0].n).toBe(1);
  });
});
