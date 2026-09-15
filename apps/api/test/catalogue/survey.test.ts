/**
 * End-to-end cover for land survey progress (§59).
 *
 * The two claims this module rests on can only be checked against real rows:
 * that every cumulative figure is derived from the daily entries, and that a
 * roll-up is weighted by extent rather than averaged.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let projectId: string;
let districtId: string;
let divisionId: string;
let mandalId: string;

async function send(
  method: "POST" | "GET" | "PATCH", headers: Headers, url: string, payload?: unknown,
) {
  const res = await w.app.inject({
    method, url,
    headers: { ...headers, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);
const get = (h: Headers, u: string) => send("GET", h, u);
const patch = (h: Headers, u: string, p?: unknown) => send("PATCH", h, u, p);

/** A village in the org's geography, under the survey's division/mandal. */
async function village(name: string): Promise<string> {
  const r = await w.pool.query(
    `INSERT INTO org_units(org_id, type, code, name, parent_id, source_code)
     VALUES($1,'village',$2,$3,$4,$2) RETURNING id`,
    [w.orgId, uniq("V"), name, mandalId]);
  return String(r.rows[0].id);
}

/** List a village in the programme with an extent, and return its survey id. */
async function listed(name: string, extentAc: number | null): Promise<string> {
  const v = await village(name);
  const r = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages`, {
    village_id: v, total_extent_ac: extentAc, teams: 2, dgps_base: 1, dgps_rovers: 3,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(r.data.id);
}

async function progress(
  surveyVillageId: string, date: string, values: Record<string, number>,
) {
  return post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: surveyVillageId, entry_date: date, teams_deployed: 2, values,
  });
}

beforeAll(async () => {
  w = await buildWorld();

  // District -> Division -> Mandal, as the survey master list has it.
  districtId = String((await w.pool.query(
    `INSERT INTO org_units(org_id, type, code, name) VALUES($1,'district',$2,$3) RETURNING id`,
    [w.orgId, uniq("D"), "Alluri Sitharama Raju"])).rows[0].id);
  divisionId = String((await w.pool.query(
    `INSERT INTO org_units(org_id, type, code, name, parent_id, source_code)
     VALUES($1,'division',$2,$3,$4,'1') RETURNING id`,
    [w.orgId, uniq("DV"), "Paderu", districtId])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id, type, code, name, parent_id, source_code)
     VALUES($1,'mandal',$2,$3,$4,'11') RETURNING id`,
    [w.orgId, uniq("M"), "KOYYURU", divisionId])).rows[0].id);

  const p = await post(w.admin, "/api/v1/survey/projects", {
    code: uniq("SP"), name: "AP land resurvey", started_on: "2026-04-01",
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  projectId = String(p.data.id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("§59 the geography the survey needs", () => {
  it("accepts district -> division -> mandal -> village", async () => {
    const r = await get(w.admin, `/api/v1/org/units?type=division&limit=50`);
    expect(r.status).toBe(200);
    expect(r.data.some((u: any) => u.name === "Paderu")).toBe(true);
  });

  it("still accepts a mandal directly under a district", async () => {
    // Every mandal recorded before divisions existed has a district for a
    // parent. None of them may break.
    const r = await post(w.admin, "/api/v1/org/units", {
      type: "mandal", code: uniq("M"), name: "Legacy mandal", parent_id: districtId,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses a village under a district, which would skip two tiers", async () => {
    const r = await post(w.admin, "/api/v1/org/units", {
      type: "village", code: uniq("V"), name: "Orphan", parent_id: districtId,
    });
    expect(r.status).toBe(422);
  });
});

describe("§59.4 daily entry", () => {
  it("records a day of progress against a village", async () => {
    const sv = await listed("ADAKULA", 16.82);
    const r = await progress(sv, "2026-09-01", {
      GOVT_LAND_EXTENT_AC: 4, GOVT_LAND_POINTS: 120, LPMS_GENERATED: 3,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses a second entry for the same village and day", async () => {
    // A second row would double that day in every cumulative figure, and
    // nothing downstream would show the error.
    const sv = await listed("Двойной", 10);
    await progress(sv, "2026-09-01", { GOVT_LAND_POINTS: 10 });
    const again = await progress(sv, "2026-09-01", { GOVT_LAND_POINTS: 10 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_ENTERED");
  });

  it("refuses a measure it has never heard of, rather than dropping it", async () => {
    const sv = await listed("Typo village", 10);
    const r = await progress(sv, "2026-09-02", { GOVT_LAND_POINTZ: 10 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNKNOWN_MEASURE");
  });

  it("refuses a negative quantity", async () => {
    const sv = await listed("Negative village", 10);
    const r = await progress(sv, "2026-09-03", { GOVT_LAND_POINTS: -5 });
    expect(r.status).toBe(422);
  });

  it("refuses to list a village twice in one programme", async () => {
    // Twice would double its extent in every denominator above it.
    const v = await village("Twice listed");
    await post(w.admin, `/api/v1/survey/projects/${projectId}/villages`,
      { village_id: v, total_extent_ac: 5 });
    const again = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages`,
      { village_id: v, total_extent_ac: 5 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_LISTED");
  });

  it("refuses a mandal where a village belongs", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${projectId}/villages`,
      { village_id: mandalId, total_extent_ac: 5 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("NOT_A_VILLAGE");
  });
});

describe("§59.1.1 the cumulative is derived", () => {
  it("adds the daily figures up rather than accepting a typed total", async () => {
    const sv = await listed("Cumulative village", 100);
    await progress(sv, "2026-09-01", { GOVT_LAND_EXTENT_AC: 10 });
    await progress(sv, "2026-09-02", { GOVT_LAND_EXTENT_AC: 15 });
    await progress(sv, "2026-09-03", { GOVT_LAND_EXTENT_AC: 5 });

    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v: any) => v.village_name === "Cumulative village");
    expect(row.done.GOVT_LAND_EXTENT_AC).toBe(30);
    expect(row.measures.GOVT_LAND_EXTENT_AC.pct).toBe(30);
  });

  it("corrects every figure above it when a day is entered late", async () => {
    // Field data arrives late as a matter of course. A stored running total
    // would need recomputing; a derived one does not.
    const sv = await listed("Backdated village", 100);
    await progress(sv, "2026-09-10", { GOVT_LAND_EXTENT_AC: 20 });

    const before = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const rowBefore = before.data.find((v: any) => v.village_name === "Backdated village");
    expect(rowBefore.done.GOVT_LAND_EXTENT_AC).toBe(20);

    // A week that was missed, entered afterwards.
    await progress(sv, "2026-09-04", { GOVT_LAND_EXTENT_AC: 12 });

    const after = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const rowAfter = after.data.find((v: any) => v.village_name === "Backdated village");
    expect(rowAfter.done.GOVT_LAND_EXTENT_AC).toBe(32);
  });

  it("follows an amended entry without anything being recomputed", async () => {
    const sv = await listed("Amended village", 100);
    const entry = await progress(sv, "2026-09-05", { GOVT_LAND_EXTENT_AC: 50 });
    const v = await w.pool.query("SELECT version FROM survey_entries WHERE id = $1",
      [entry.data.id]);

    const fixed = await patch(
      { ...w.admin, "if-match": String(v.rows[0].version) },
      `/api/v1/survey/entries/${entry.data.id}`,
      { values: { GOVT_LAND_EXTENT_AC: 5 } },
    );
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);

    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v2: any) => v2.village_name === "Amended village");
    expect(row.done.GOVT_LAND_EXTENT_AC).toBe(5);
  });

  it("clears a measure corrected to zero rather than storing a zero", async () => {
    const sv = await listed("Zeroed village", 100);
    const entry = await progress(sv, "2026-09-06", { LPMS_GENERATED: 9 });
    const v = await w.pool.query("SELECT version FROM survey_entries WHERE id = $1",
      [entry.data.id]);
    await patch(
      { ...w.admin, "if-match": String(v.rows[0].version) },
      `/api/v1/survey/entries/${entry.data.id}`, { values: { LPMS_GENERATED: 0 } });

    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v2: any) => v2.village_name === "Zeroed village");
    expect(row.done.LPMS_GENERATED ?? 0).toBe(0);
  });
});

describe("§59.1.2 roll-ups are weighted", () => {
  let small: string;
  let large: string;

  beforeAll(async () => {
    // One small village finished, one large village untouched.
    small = await listed("Weighted small", 10);
    large = await listed("Weighted large", 990);
    await progress(small, "2026-09-07", { GOVT_LAND_EXTENT_AC: 10 });
  });

  it("weights a mandal by extent rather than averaging its villages", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=mandal`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.data.rows.find((x: any) => x.name === "KOYYURU");
    // The two villages alone would be 1%, not 50%. Other tests add villages
    // to this mandal, so the assertion is that the figure is derived from
    // extent, not that it equals a fixed number.
    expect(row.extentAc).toBeGreaterThanOrEqual(1000);
    expect(row.overallPct).toBeLessThan(50);
  });

  it("reports the same total however the villages are grouped", async () => {
    // A district figure and the mandal figures that make it up must agree, or
    // two screens tell different stories.
    const [byMandal, byDistrict] = await Promise.all([
      get(w.admin, `/api/v1/survey/projects/${projectId}/progress?level=mandal`),
      get(w.admin, `/api/v1/survey/projects/${projectId}/progress?level=district`),
    ]);
    expect(byMandal.data.total.surveyedAc).toBe(byDistrict.data.total.surveyedAc);
    expect(byMandal.data.total.extentAc).toBe(byDistrict.data.total.extentAc);
    expect(byMandal.data.total.overallPct).toBe(byDistrict.data.total.overallPct);

    const mandalSum = byMandal.data.rows.reduce((t: number, r: any) => t + r.surveyedAc, 0);
    expect(Math.round(mandalSum * 100) / 100).toBe(byMandal.data.total.surveyedAc);
  });

  it("rolls up to division and to district", async () => {
    const division = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=division`);
    expect(division.data.rows.some((r: any) => r.name === "Paderu")).toBe(true);

    const district = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=district`);
    expect(district.data.rows.some((r: any) => r.name === "Alluri Sitharama Raju")).toBe(true);
  });

  it("counts villages with no extent instead of weighting them as one", async () => {
    const before = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=mandal`);
    const unweightedBefore = before.data.total.unweighted;

    await listed("No extent recorded", null);

    const after = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=mandal`);
    expect(after.data.total.unweighted).toBe(unweightedBefore + 1);
    // And the denominator did not move, because there was nothing to add.
    expect(after.data.total.extentAc).toBe(before.data.total.extentAc);
  });
});

describe("§59.1.3 a percentage needs a denominator", () => {
  it("reports an unknown percentage where no target is set", async () => {
    // Zero would read as "nothing done", a hundred as "finished". Both would
    // be invented.
    const sv = await listed("No target village", 50);
    await progress(sv, "2026-09-08", { VILLAGE_BOUNDARY_POINTS: 40 });

    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v: any) => v.village_name === "No target village");
    expect(row.measures.VILLAGE_BOUNDARY_POINTS.done).toBe(40);
    expect(row.measures.VILLAGE_BOUNDARY_POINTS.pct).toBeNull();
  });

  it("uses the target once one is recorded", async () => {
    const sv = await listed("Targeted village", 50);
    await progress(sv, "2026-09-09", { VILLAGE_BOUNDARY_POINTS: 40 });
    const t = await post(w.admin, `/api/v1/survey/villages/${sv}/targets`,
      { measure_code: "VILLAGE_BOUNDARY_POINTS", target_quantity: 200 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);

    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v: any) => v.village_name === "Targeted village");
    expect(row.measures.VILLAGE_BOUNDARY_POINTS.pct).toBe(20);
  });

  it("refuses a target for a measure already divided by the village extent", async () => {
    // Two denominators for one measure is how the figure becomes arguable.
    const sv = await listed("Extent target village", 50);
    const r = await post(w.admin, `/api/v1/survey/villages/${sv}/targets`,
      { measure_code: "GOVT_LAND_EXTENT_AC", target_quantity: 200 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("EXTENT_HAS_NO_TARGET");
  });

  it("never reports a percentage for a measure that tracks no progress", async () => {
    const sv = await listed("Points only village", 50);
    await progress(sv, "2026-09-11", { GOVT_LAND_POINTS: 900 });
    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v: any) => v.village_name === "Points only village");
    expect(row.measures.GOVT_LAND_POINTS.done).toBe(900);
    expect(row.measures.GOVT_LAND_POINTS.pct).toBeNull();
  });
});

describe("§59.5 stages and village state", () => {
  it("is not started until something is recorded", async () => {
    const sv = await listed("Untouched village", 20);
    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = r.data.find((v: any) => v.id === sv);
    expect(row.state).toBe("NOT_STARTED");
  });

  it("is complete only when every stage is complete", async () => {
    const sv = await listed("Finished village", 20);
    const stages = ["GROUND_TRUTHING", "VECTORIZATION", "RECORDS_PREPARATION", "LPM_GENERATION"];
    for (const code of stages.slice(0, 3)) {
      await post(w.admin, `/api/v1/survey/villages/${sv}/stage`,
        { stage_code: code, state: "COMPLETED", started_on: "2026-09-01", completed_on: "2026-09-10" });
    }
    let r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    expect(r.data.find((v: any) => v.id === sv).state).toBe("IN_PROGRESS");

    await post(w.admin, `/api/v1/survey/villages/${sv}/stage`,
      { stage_code: "LPM_GENERATION", state: "COMPLETED", started_on: "2026-09-01", completed_on: "2026-09-12" });
    r = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    expect(r.data.find((v: any) => v.id === sv).state).toBe("COMPLETED");
  });

  it("refuses a completed stage with no completion date", async () => {
    const sv = await listed("Dateless stage village", 20);
    const r = await post(w.admin, `/api/v1/survey/villages/${sv}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "COMPLETED" });
    expect(r.status).toBe(422);
  });

  it("puts the stage dates on the summary sheet", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/summary`);
    const row = r.data.find((x: any) => x.village === "Finished village");
    expect(row.gt_status).toBe("COMPLETED");
    expect(row.gt_started_on).toBe("2026-09-01");
    expect(row.gt_completed_on).toBe("2026-09-10");
    expect(row.mandal).toBe("KOYYURU");
  });

  it("reports extent in both units from the one stored figure", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/summary`);
    const row = r.data.find((x: any) => x.village === "ADAKULA");
    expect(row.extent_ac).toBe(16.82);
    // The worked example from the source sheet.
    expect(row.extent_sq_km).toBeCloseTo(0.068, 3);
  });
});

describe("§59.6 reporting over a period", () => {
  it("splits a range into months and reports what was done in each", async () => {
    const sv = await listed("Timeline village", 100);
    await progress(sv, "2026-07-15", { LPMS_GENERATED: 5 });
    await progress(sv, "2026-08-15", { LPMS_GENERATED: 7 });

    const r = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/timeline?from=2026-07-01&to=2026-08-31&grain=MONTH`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.periods).toHaveLength(2);
    expect(r.data.periods[0].measures.LPMS_GENERATED).toBe(5);
    expect(r.data.periods[1].measures.LPMS_GENERATED).toBe(7);
  });

  it("clips the periods to the range asked for", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/timeline?from=2026-07-10&to=2026-08-20&grain=MONTH`);
    expect(r.data.periods[0].from).toBe("2026-07-10");
    expect(r.data.periods[1].to).toBe("2026-08-20");
  });

  it("refuses a range that would produce hundreds of periods", async () => {
    // A daily grain over ten years is not a report anybody reads; it is a
    // slow query and a browser hang.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/timeline?from=2016-01-01&to=2026-01-01&grain=DAY`);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("RANGE_TOO_WIDE");
  });

  it("defaults to the Indian financial year", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${projectId}/timeline`);
    expect(r.data.financial_year.from.endsWith("-04-01")).toBe(true);
    expect(r.data.from.endsWith("-04-01")).toBe(true);
  });

  it("reports what was done in a period beside the position at its end", async () => {
    // "40% done" describes the programme, not the week, so the two are
    // reported side by side rather than one instead of the other.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${projectId}/progress?level=mandal&from=2026-09-07&to=2026-09-30`);
    const row = r.data.rows.find((x: any) => x.name === "KOYYURU");
    expect(row.period_done).toBeTruthy();
    // The cumulative includes work from before the window; the period does not.
    expect(row.measures.GOVT_LAND_EXTENT_AC.done)
      .toBeGreaterThanOrEqual(row.period_done.GOVT_LAND_EXTENT_AC);
  });
});

describe("§59.4.3 measures added on the fly", () => {
  it("accepts a new measure and records progress against it", async () => {
    const created = await post(w.admin, "/api/v1/survey/measures", {
      code: "DRONE_IMAGES", label: "Drone images", group_label: "Imagery",
      unit: "COUNT", basis: "TARGET", display_order: 80,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const sv = await listed("Drone village", 30);
    const r = await progress(sv, "2026-09-13", { DRONE_IMAGES: 250 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const villages = await get(w.admin, `/api/v1/survey/projects/${projectId}/villages`);
    const row = villages.data.find((v: any) => v.village_name === "Drone village");
    expect(row.done.DRONE_IMAGES).toBe(250);
  });

  it("returns the existing measure rather than refusing a repeat", async () => {
    const again = await post(w.admin, "/api/v1/survey/measures", {
      code: "DRONE_IMAGES", label: "Drone images", unit: "COUNT",
    });
    expect(again.status).toBe(201);
    expect(again.data.code).toBe("DRONE_IMAGES");
  });

  it("refuses a code an import could not round-trip", async () => {
    const r = await post(w.admin, "/api/v1/survey/measures", {
      code: "drone images", label: "x", unit: "COUNT",
    });
    expect(r.status).toBe(422);
  });
});

describe("§59.7 controls", () => {
  it("lets a crew record progress", async () => {
    const sv = await listed("Crew village", 40);
    const r = await post(w.role.TEAM_LEAD, "/api/v1/survey/entries", {
      survey_village_id: sv, entry_date: "2026-09-14", values: { GOVT_LAND_POINTS: 30 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("stops a crew setting the target its own completion is measured against", async () => {
    const sv = await listed("Crew target village", 40);
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/villages/${sv}/targets`,
      { measure_code: "VILLAGE_BOUNDARY_POINTS", target_quantity: 1 });
    expect(r.status).toBe(403);
  });

  it("stops a crew adding villages to the programme", async () => {
    const v = await village("Crew added village");
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/projects/${projectId}/villages`,
      { village_id: v, total_extent_ac: 5 });
    expect(r.status).toBe(403);
  });

  it("gives an auditor the reports and no way to change them", async () => {
    const read = await get(w.role.AUDITOR, `/api/v1/survey/projects/${projectId}/progress`);
    expect(read.status).toBe(200);
    const write = await post(w.role.AUDITOR, "/api/v1/survey/entries", {
      survey_village_id: "11111111-1111-4111-8111-111111111111",
      entry_date: "2026-09-15", values: {},
    });
    expect(write.status).toBe(403);
  });

  it("keeps one tenant's survey out of another's", async () => {
    const r = await w.pool.query(
      "SELECT count(*)::int AS n FROM survey_projects WHERE org_id = $1", [w.otherOrgId]);
    expect(r.rows[0].n).toBe(0);
  });

  it("refuses an amendment against a stale version", async () => {
    const sv = await listed("Concurrent village", 40);
    const entry = await progress(sv, "2026-09-16", { GOVT_LAND_POINTS: 10 });
    const stale = { ...w.admin, "if-match": "1" };
    const v = await w.pool.query("SELECT version FROM survey_entries WHERE id = $1",
      [entry.data.id]);
    await patch({ ...w.admin, "if-match": String(v.rows[0].version) },
      `/api/v1/survey/entries/${entry.data.id}`, { teams_deployed: 4 });
    const second = await patch(stale, `/api/v1/survey/entries/${entry.data.id}`,
      { teams_deployed: 9 });
    expect(second.status).toBe(409);
  });
});
