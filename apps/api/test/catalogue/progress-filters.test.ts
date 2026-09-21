/**
 * Narrowing the progress screen to part of a programme (§note 15).
 *
 * The screen answered one question — how is the whole programme doing — and
 * the question people actually ask is about a district, a mandal, or the
 * villages stuck at one stage.
 *
 * What is being tested is that the filter reaches the *figures*, not just the
 * table. A screen that filters the rows and leaves "42% complete" standing
 * above them is reporting the programme's number under the district's
 * heading, and somebody will quote it in a meeting.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId = "";
/** Two districts, two mandals each, one village per mandal. */
const V: Record<string, string> = {};

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
const get = (h: Headers, u: string) => send("GET", h, u);
const post = (h: Headers, u: string, p?: unknown) => send("POST", h, u, p);

const progress = (qs = "") =>
  get(w.admin, `/api/v1/survey/projects/${programmeId}/progress${qs ? `?${qs}` : ""}`);

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Filtered programme" });
  programmeId = String(p.data.id);

  for (const [district, mandals] of [["ALLURI", ["KOYYURU", "PADERU"]],
    ["KRISHNA", ["GUDIVADA", "NANDIGAMA"]]] as const) {
    const d = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,$3) RETURNING id`,
      [w.orgId, uniq("D"), district])).rows[0].id);
    for (const mandal of mandals) {
      const m = String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,$3,$4) RETURNING id`,
        [w.orgId, uniq("M"), mandal, d])).rows[0].id);
      const name = `${mandal} VILLAGE`;
      const unit = String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
        [w.orgId, uniq("V"), name, m])).rows[0].id);
      const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
        { village_id: unit, total_extent_ac: 100 });
      V[mandal] = String(sv.data.id);
    }
  }

  // 40 acres on one village in ALLURI, nothing anywhere else. The whole
  // programme is 10% done; ALLURI alone is 20%.
  await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: V.KOYYURU, entry_date: workDate(), teams_deployed: 1,
    values: { GOVT_LAND_EXTENT_AC: 40 },
  });

  // One village finished ground truthing, so a stage filter has something
  // to separate.
  const moved = await post(w.admin, `/api/v1/survey/villages/${V.KOYYURU}/stage`,
    { stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: workDate() });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the unfiltered programme", () => {
  it("reports all four villages", async () => {
    const r = await progress();
    expect(r.status).toBe(200);
    expect(r.data.total.villages).toBe(4);
    expect(r.data.filter.villages).toBe(4);
    expect(r.data.filter.district).toBeNull();
  });

  it("offers only the geography the programme actually covers", async () => {
    // A programme over three mandals should not offer a picker with two
    // hundred.
    const r = await progress();
    expect(r.data.options.districts).toEqual(["ALLURI", "KRISHNA"]);
    expect(r.data.options.mandals).toHaveLength(4);
    expect(r.data.options.villages).toHaveLength(4);
  });
});

describe("narrowing to a district", () => {
  it("counts only its villages", async () => {
    const r = await progress("district=ALLURI");
    expect(r.data.total.villages).toBe(2);
    expect(r.data.filter.villages).toBe(2);
    expect(r.data.filter.of_villages).toBe(4);
  });

  it("recomputes the headline rather than leaving the programme's standing", async () => {
    // 40 of 200 acres in ALLURI is 20%; 40 of 400 across the programme is
    // 10%. The wrong one under a district heading is the whole bug.
    const whole = await progress();
    const one = await progress("district=ALLURI");
    expect(whole.data.total.overallPct).toBe(10);
    expect(one.data.total.overallPct).toBe(20);
  });

  it("narrows the mandal picker to that district", async () => {
    const r = await progress("district=ALLURI");
    expect(r.data.options.mandals).toEqual(["KOYYURU", "PADERU"]);
  });

  it("narrows the stage tallies too", async () => {
    const whole = await progress();
    const one = await progress("district=KRISHNA");
    expect(whole.data.by_stage.GROUND_TRUTHING.notStarted).toBe(3);
    expect(one.data.by_stage.GROUND_TRUTHING.notStarted).toBe(2);
    expect(one.data.by_stage.GROUND_TRUTHING.completed).toBe(0);
  });
});

describe("narrowing to a mandal or a village", () => {
  it("counts one mandal's villages", async () => {
    const r = await progress("mandal=PADERU");
    expect(r.data.total.villages).toBe(1);
    expect(r.data.total.surveyedAc).toBe(0);
  });

  it("counts one village, exactly", async () => {
    const r = await progress(`village_id=${V.KOYYURU}`);
    expect(r.data.total.villages).toBe(1);
    expect(r.data.total.surveyedAc).toBe(40);
    expect(r.data.total.overallPct).toBe(40);
  });

  it("returns an honest nothing when the filter matches no village", async () => {
    // Not an error: an empty district is a real answer, and a 404 here would
    // send somebody looking for a fault that is not there.
    const r = await progress("district=ALLURI&mandal=GUDIVADA");
    expect(r.status).toBe(200);
    expect(r.data.total.villages).toBe(0);
    expect(r.data.rows).toEqual([]);
  });
});

describe("narrowing to a stage", () => {
  it("finds the villages that have finished one", async () => {
    const r = await progress("stage=GROUND_TRUTHING&stage_state=COMPLETED");
    expect(r.data.total.villages).toBe(1);
    expect(r.data.filter.stage).toBe("GROUND_TRUTHING");
  });

  it("treats outstanding as everything not finished", async () => {
    // Not started, in progress and on hold together — the state people ask
    // about and the one no single stage value holds.
    const r = await progress("stage=GROUND_TRUTHING&stage_state=OUTSTANDING");
    expect(r.data.total.villages).toBe(3);
  });

  it("defaults to outstanding when a stage is named without a state", async () => {
    const r = await progress("stage=GROUND_TRUTHING");
    expect(r.data.total.villages).toBe(3);
    expect(r.data.filter.stage_state).toBe("OUTSTANDING");
  });

  it("finds the villages nobody has started", async () => {
    const r = await progress("stage=GROUND_TRUTHING&stage_state=NOT_STARTED");
    expect(r.data.total.villages).toBe(3);
  });

  it("combines with the geography rather than replacing it", async () => {
    const r = await progress("district=ALLURI&stage=GROUND_TRUTHING&stage_state=COMPLETED");
    expect(r.data.total.villages).toBe(1);
  });
});

describe("the equipment and pace figures", () => {
  it("counts rovers over the filtered villages, not the whole programme", async () => {
    // Left unfiltered they would report the programme's instruments beside
    // one district's acres, and the utilisation belongs to neither.
    const asset = String((await w.pool.query(
      `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
       VALUES($1,$2,$3,'SURVEY','AVAILABLE','GOOD') RETURNING id`,
      [w.orgId, uniq("RV"), "Rover"])).rows[0].id);
    await post(w.admin, `/api/v1/survey/villages/${V.KOYYURU}/rovers`,
      { asset_id: asset, allocated_on: workDate() });

    const whole = await progress();
    const other = await progress("district=KRISHNA");
    expect(whole.data.rovers.allocated).toBe(1);
    expect(other.data.rovers.allocated).toBe(0);
  });

  it("paces on the filtered villages' returns", async () => {
    const worked = await progress(`village_id=${V.KOYYURU}`);
    const idle = await progress(`village_id=${V.PADERU}`);
    expect(worked.data.pace.activeDays).toBe(1);
    expect(idle.data.pace.activeDays).toBe(0);
  });
});

describe("work in a village with no extent recorded", () => {
  /*
   * The numerator took every village's work and the denominator only the
   * villages with an extent, so a programme with one unmeasured village read
   * past a hundred percent. The work is real and is reported, apart; it just
   * has nothing to be a percentage of.
   */
  let pid = "";
  beforeAll(async () => {
    const p = await post(w.admin, "/api/v1/survey/projects",
      { code: uniq("SP"), name: "Half-measured programme" });
    pid = String(p.data.id);
    const d = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,$3) RETURNING id`,
      [w.orgId, uniq("D"), "UNMEASURED"])).rows[0].id);
    const m = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,$3,$4) RETURNING id`,
      [w.orgId, uniq("M"), "UNMEASURED MANDAL", d])).rows[0].id);
    const ids: string[] = [];
    for (const name of ["MEASURED", "UNMEASURED"]) {
      const unit = String((await w.pool.query(
        `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
        [w.orgId, uniq("V"), name, m])).rows[0].id);
      const sv = await post(w.admin, `/api/v1/survey/projects/${pid}/villages`,
        { village_id: unit, total_extent_ac: 100 });
      expect(sv.status, JSON.stringify(sv.body)).toBe(201);
      ids.push(String(sv.data.id));
    }
    // The second village's extent was never recorded.
    await w.pool.query("UPDATE survey_villages SET total_extent_ac = NULL WHERE id = $1", [ids[1]]);
    for (const [vid, ac] of [[ids[0], 40], [ids[1], 80]] as const) {
      const r = await post(w.admin, "/api/v1/survey/entries", {
        survey_village_id: vid, entry_date: workDate(), teams_deployed: 1,
        values: { GOVT_LAND_EXTENT_AC: ac },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  it("keeps the progress headline to the villages it can weigh", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${pid}/progress`);
    expect(r.status).toBe(200);
    // 40 of 100, not 120 of 100.
    expect(r.data.total.overallPct).toBe(40);
    expect(r.data.total.surveyedAc).toBe(40);
    expect(r.data.total.unweightedSurveyedAc).toBe(80);
    expect(r.data.total.unweighted).toBe(1);
    const m = r.data.total.measures.GOVT_LAND_EXTENT_AC;
    expect(m.pct).toBe(40);
    expect(m.done).toBe(40);
    expect(m.unweightedDone).toBe(80);
  });

  it("keeps the dashboard's surveyed figure inside its extent", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${pid}/dashboard`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.totals.extent_ac).toBe(100);
    expect(r.data.totals.surveyed_ac).toBe(40);
    expect(r.data.totals.unweighted_surveyed_ac).toBe(80);
    expect(r.data.totals.unweighted_villages).toBe(1);
    for (const row of r.data.rows as Array<{ surveyed_ac: number; extent_ac: number }>) {
      expect(row.surveyed_ac).toBeLessThanOrEqual(row.extent_ac);
    }
  });
});
