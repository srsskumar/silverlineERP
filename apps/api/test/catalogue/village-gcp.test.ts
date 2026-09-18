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

describe("grid coordinates beside the geographic ones (§070)", () => {
  it("records a northing and easting with the grid they are on", async () => {
    // Drawings and LPM sheets are in the grid; latitude and longitude are
    // what travels between systems. Recording only one means somebody
    // converts by hand every time the other is needed.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/gcps`, {
      point_code: "GCP-GRID",
      latitude: 17.6868231, longitude: 83.2184815,
      easting_m: 736412.318, northing_m: 1956043.772, grid_zone: "44N",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.easting_m).toBe(736412.318);
    expect(r.data.northing_m).toBe(1956043.772);
    expect(r.data.grid_zone).toBe("44N");
  });

  it("keeps the grid reference to the millimetre it was given to", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/gcps`);
    const g = list.data.find((x: any) => x.point_code === "GCP-GRID");
    expect(g.northing_m).toBe(1956043.772);
  });

  it("refuses an easting with no northing against it", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-HALF", latitude: 16.5, longitude: 80.6,
      easting_m: 736412.318, grid_zone: "44N",
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/both a northing and an easting/i);
  });

  it("refuses a grid reference that does not say which grid", async () => {
    // Without a zone a northing and easting are two numbers, not a position,
    // and a hand conversion against the wrong zone is a point in the wrong
    // state.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-NOZONE", latitude: 16.5, longitude: 80.6,
      easting_m: 736412.318, northing_m: 1956043.772,
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/name the grid/i);
  });

  it("still takes a point with no grid reference at all", async () => {
    // A controller that only gave a geographic fix is not an error.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-GEOONLY", latitude: 16.5061789, longitude: 80.6480113,
    });
    expect(r.status).toBe(201);
    expect(r.data.easting_m).toBeNull();
  });

  it("adds a grid reference to a point that was recorded without one", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    const g = list.data.find((x: any) => x.point_code === "GCP-GEOONLY");
    const r = await patch({ ...w.admin, "if-match": String(g.version) },
      `/api/v1/survey/gcps/${g.id}`,
      { easting_m: 245123.5, northing_m: 1826110.25, grid_zone: "44N" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.northing_m).toBe(1826110.25);
  });

  it("carries the grid onto the programme-wide list", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/gcps`);
    const g = r.data.find((x: any) => x.point_code === "GCP-GRID");
    expect(g.easting_m).toBe(736412.318);
    expect(g.grid_zone).toBe("44N");
  });
});

describe("correcting a grid reference says what is wrong with it", () => {
  it("refuses a grid pair with no zone, in words rather than as a constraint", async () => {
    /*
     * The rule lived only on the create path, so a patch got past the schema,
     * reached the database, and came back as "A referenced record or value is
     * invalid" — a check constraint talking to a person.
     */
    const made = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-ZONELESS", latitude: 16.5, longitude: 80.6,
    });
    const r = await patch({ ...w.admin, "if-match": String(made.data.version) },
      `/api/v1/survey/gcps/${made.data.id}`,
      { easting_m: 736412.3, northing_m: 1956043.7 });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/name the grid/i);
    expect(r.body.message).not.toMatch(/referenced record/i);
  });

  it("accepts a grid pair when the point already carries a zone", async () => {
    // The schema cannot see the row; only the route can tell whether the
    // point ends up with a zone against it.
    const made = await post(w.admin, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: "GCP-HASZONE", latitude: 16.5, longitude: 80.6,
      easting_m: 1000, northing_m: 2000, grid_zone: "44N",
    });
    const r = await patch({ ...w.admin, "if-match": String(made.data.version) },
      `/api/v1/survey/gcps/${made.data.id}`,
      { easting_m: 736412.3, northing_m: 1956043.7 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("refuses clearing the zone while a reference still stands", async () => {
    const list = await get(w.admin, `/api/v1/survey/villages/${villageB}/gcps`);
    const g = list.data.find((x: any) => x.point_code === "GCP-HASZONE");
    const r = await patch({ ...w.admin, "if-match": String(g.version) },
      `/api/v1/survey/gcps/${g.id}`, { grid_zone: null });
    expect(r.status).toBe(422);
  });
});

describe("a date that is not a date", () => {
  /*
   * Thirteen report endpoints handed the query string straight to Postgres as
   * `$n::date`. A typo, a stale bookmark or a spreadsheet pasting "N/A"
   * reached the database and the caller got a 500 and a stack trace where
   * what they needed was one sentence about one field.
   */
  const bad = ["rubbish", "2026-13-01", "2026-02-30", "01/02/2026", "N/A", ""];

  it("is refused by every window the survey module reports over", async () => {
    const urls = (d: string) => [
      `/api/v1/survey/villages/${villageA}/daily?from=${d}`,
      `/api/v1/survey/villages/${villageA}/daily?to=${d}`,
      `/api/v1/survey/projects/${programmeId}/progress?from=${d}`,
      `/api/v1/survey/projects/${programmeId}/progress?to=${d}`,
      `/api/v1/survey/projects/${programmeId}/report?as_of=${d}`,
      `/api/v1/survey/projects/${programmeId}/timeline?from=${d}`,
      `/api/v1/survey/projects/${programmeId}/rover-productivity?from=${d}`,
      `/api/v1/survey/projects/${programmeId}/employee-productivity?from=${d}`,
      `/api/v1/survey/projects/${programmeId}/unfiled?from=${d}`,
      `/api/v1/survey/projects/${programmeId}/villages?as_of=${d}`,
      // The two that carry their own date handling rather than the shared
      // window: a custom report range, and the entries list.
      `/api/v1/survey/projects/${programmeId}/report?from=${d}&to=${d}`,
      `/api/v1/survey/entries?from=${d}`,
      `/api/v1/survey/entries?to=${d}`,
    ];
    for (const d of bad) {
      if (d === "") continue; // an empty value means "not given", and defaults
      for (const url of urls(d)) {
        const r = await get(w.admin, url);
        expect(r.status, `${url} -> ${r.status}`).toBe(422);
        expect(String(r.body.message), url).toMatch(/date|YYYY-MM-DD/i);
      }
    }
  }, 60_000);

  it("treats an absent value as absent rather than as a bad one", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress?from=`);
    expect(r.status).toBe(200);
  });

  it("says which field it is complaining about", async () => {
    // "A date is invalid" sends somebody hunting through four date pickers.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?to=rubbish`);
    expect(r.body.message).toMatch(/\bto\b/);
  });

  it("still accepts a real date", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?from=2026-01-01&to=2026-12-31`);
    expect(r.status).toBe(200);
  });
});

describe("who may record a control point", () => {
  /*
   * The point is established by whoever stands on it with the base station:
   * a surveyor or a team lead. Neither holds survey.manage, so requiring it
   * meant the one person who knew the fix could not enter it. The
   * coordinates travelled to the office as a photograph of a notebook and
   * were retyped by somebody who had never seen the pillar, which is exactly
   * where a digit goes missing from a ten-figure coordinate.
   */
  beforeAll(async () => {
    // Visibility into a programme comes from being on it. Which is the same
    // fact as being the person who establishes its control: nobody stands on
    // the pillar of a village they were never put on.
    await post(w.admin, `/api/v1/survey/villages/${villageB}/crew`, {
      employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING",
    });
  });

  it("lets a crew member record the point they are standing on", async () => {
    const r = await post(w.directUser, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: uniq("FIELD"),
      latitude: 17.512345, longitude: 82.612345,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("lets them correct their own figures", async () => {
    const made = await post(w.directUser, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: uniq("FIX"), latitude: 17.5, longitude: 82.6,
    });
    expect(made.status).toBe(201);
    // Corrections carry the version they are correcting, here as everywhere:
    // two people fixing the same coordinate is exactly the case that needs it.
    const r = await send("PATCH",
      { ...w.directUser, "if-match": String(made.data.version) },
      `/api/v1/survey/gcps/${made.data.id}`, { latitude: 17.512999 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Number(r.data.latitude)).toBeCloseTo(17.512999, 6);
  });

  it("does not let them delete one", async () => {
    // An established point is what everything in the village was surveyed
    // from. Removing it is a decision about the record, not an observation,
    // and it stays with the desk.
    const made = await post(w.directUser, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: uniq("KEEP"), latitude: 17.51, longitude: 82.61,
    });
    const r = await send("DELETE", w.directUser, `/api/v1/survey/gcps/${made.data.id}`);
    expect(r.status).toBe(403);
  });

  it("does not let a read-only role record one", async () => {
    const r = await post(w.role.CLIENT_VIEWER, `/api/v1/survey/villages/${villageB}/gcps`, {
      point_code: uniq("NOPE"), latitude: 17.5, longitude: 82.6,
    });
    expect(r.status).toBe(403);
  });
});
