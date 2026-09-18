/**
 * The control points a village was surveyed from (§069).
 *
 * A GCP is the fixed, known point the DGPS base sits over, and every
 * measurement in the village is relative to it. Establishing one is a
 * one-time job done before ground truthing starts; there is usually exactly
 * one, and a large or awkward village needs two or three.
 *
 * The coordinates lived in a notebook. Re-establishing a control point
 * because nobody wrote it down is a day's work with a base station.
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
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

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
  return String(sv.data.id);
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Control programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA");
  villageB = await makeVillage("BUTCHAMPETA");
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("recording a control point", () => {
  it("takes a name, a fix, a height and how it was established", async () => {
    // The remarks are the part somebody needs two years later and the part
    // nobody writes down.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/gcps`, {
      point_code: "GCP-1",
      latitude: 17.6868231, longitude: 83.2184815, elevation_m: 45.212,
      established_on: workDate(),
      remarks: "Tied to BM 42 on the mandal office plinth; 45 min base observation, PDOP 1.4",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.latitude).toBe(17.6868231);
    expect(r.data.elevation_m).toBe(45.212);
    expect(r.data.warnings).toEqual([]);
  });

  it("keeps the fix to the centimetre it was given to", async () => {
    // Seven decimal places is about a centimetre. Rounding a control point
    // is the one thing that must not happen to it.
    const r = await get(w.admin, `/api/v1/survey/villages/${villageA}/gcps`);
    expect(r.data[0].latitude).toBe(17.6868231);
    expect(r.data[0].longitude).toBe(83.2184815);
  });

  it("takes a second point, because a big village needs more than one", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/gcps`, {
      point_code: "GCP-2", latitude: 17.7012004, longitude: 83.2301887,
    });
    expect(r.status).toBe(201);
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/gcps`);
    expect(list.data.map((g: any) => g.point_code)).toEqual(["GCP-1", "GCP-2"]);
  });

  it("refuses the same name twice on one village, and says what to do", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/gcps`, {
      point_code: "GCP-1", latitude: 17.6, longitude: 83.2,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("POINT_ALREADY_RECORDED");
    expect(r.body.message).toMatch(/correct the coordinates/i);
  });

  it("takes a point with nothing but a name and a fix", async () => {
    // A horizontal control point is still a control point.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-1", latitude: 16.5061789, longitude: 80.6480113,
    });
    expect(r.status).toBe(201);
    expect(r.data.elevation_m).toBeNull();
  });
});

describe("what looks wrong about a fix", () => {
  it("warns that coordinates look swapped, and still records them", async () => {
    /*
     * Typed into each other's boxes is the mistake people make copying off a
     * controller. Warned rather than refused: the person is looking straight
     * at the number, and refusing one they can see is worse than saying what
     * looks odd.
     */
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-SWAP", latitude: 83.2184815, longitude: 17.6868231,
    });
    expect(r.status).toBe(201);
    expect(r.data.warnings).toContain("SWAPPED");
  });

  it("warns about a point outside India", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-PARIS", latitude: 48.8584, longitude: 2.2945,
    });
    expect(r.status).toBe(201);
    expect(r.data.warnings).toContain("OUTSIDE_INDIA");
  });

  it("warns when the figures are too coarse to locate a pillar", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-ROUND", latitude: 17, longitude: 83,
    });
    expect(r.data.warnings).toContain("LOW_PRECISION");
  });

  it("refuses a latitude that is not one at all", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-BAD", latitude: 200, longitude: 83,
    });
    expect(r.status).toBe(422);
  });

  it("recomputes the warnings on read rather than storing them", async () => {
    // A stored judgement goes stale the first time the bounds are improved.
    const list = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    const swapped = list.data.find((g: any) => g.point_code === "GCP-SWAP");
    expect(swapped.warnings).toContain("SWAPPED");
  });
});

describe("correcting a point", () => {
  it("fixes a swapped pair, and the warning goes with it", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    const swapped = list.data.find((g: any) => g.point_code === "GCP-SWAP");
    const r = await patch({ ...w.admin, "if-match": String(swapped.version) },
      `/api/v1/survey/gcps/${swapped.id}`,
      { latitude: 17.6868231, longitude: 83.2184815 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.warnings).toEqual([]);
  });

  it("removes a point recorded by mistake", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    const paris = list.data.find((g: any) => g.point_code === "GCP-PARIS");
    const r = await send("DELETE", w.admin, `/api/v1/survey/gcps/${paris.id}`);
    expect(r.status).toBe(200);
    const after = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    expect(after.data.map((g: any) => g.point_code)).not.toContain("GCP-PARIS");
  });

  it("does not find a point that was never there", async () => {
    const r = await send("DELETE", w.admin,
      "/api/v1/survey/gcps/00000000-0000-0000-0000-000000000000");
    expect(r.status).toBe(404);
  });
});

describe("the control list for the whole programme", () => {
  it("lists every point with the village it belongs to", async () => {
    // The department asks for this with the final submission, and building
    // it village by village off a thousand screens is a day nobody has.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/gcps`);
    expect(r.status).toBe(200);
    expect(r.data.length).toBeGreaterThanOrEqual(4);
    expect(r.data[0].village_name).toBeTruthy();
    expect(r.data.every((g: any) => g.point_code && g.latitude)).toBe(true);
  });
});
