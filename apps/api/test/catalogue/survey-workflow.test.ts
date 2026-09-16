/**
 * The survey workflow as it is actually run (§59.5, revised).
 *
 * A crew of several works a village at a stage, rovers come off the asset
 * register, the stages run in a line, and at any moment somebody has to be
 * able to say how many villages sit at each step.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
let villageA: string;
let villageB: string;
let mandalName: string;

async function send(method: "POST" | "GET", headers: Headers, url: string, payload?: unknown) {
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

async function makeAsset(code: string): Promise<string> {
  const r = await w.pool.query(
    `INSERT INTO assets(org_id, asset_code, name, category, status, condition)
     VALUES($1,$2,$3,'SURVEY','AVAILABLE','GOOD') RETURNING id`,
    [w.orgId, code, `Rover ${code}`]);
  return String(r.rows[0].id);
}

async function stage(village: string, code: string, state: string, extra: Record<string, unknown> = {}) {
  return post(w.admin, `/api/v1/survey/villages/${village}/stage`,
    { stage_code: code, state, ...extra });
}

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'ASR') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalName = "KOYYURU";
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("M"), mandalName, district])).rows[0].id);

  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Workflow programme" });
  programmeId = String(p.data.id);

  const ids: string[] = [];
  for (const name of ["ADAKULA", "Annavaram"]) {
    const v = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
      [w.orgId, uniq("V"), name, mandal])).rows[0].id);
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
      { village_id: v, total_extent_ac: 100 });
    ids.push(String(r.data.id));
  }
  [villageA, villageB] = ids;
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the stage pipeline", () => {
  it("includes GT QC between ground truthing and vectorization", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress`);
    const codes = r.data.pipeline.map((s: any) => s.code);
    expect(codes).toContain("GT_QC");
    expect(codes.indexOf("GT_QC")).toBeGreaterThan(codes.indexOf("GROUND_TRUTHING"));
    expect(codes.indexOf("GT_QC")).toBeLessThan(codes.indexOf("VECTORIZATION"));
  });

  it("refuses to start a stage before the one before it is complete", async () => {
    // "Once GT is completed, it will be moved to next stage GT QC."
    const r = await stage(villageA, "GT_QC", "IN_PROGRESS");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("STAGE_BLOCKED");
    // The refusal names the stage in the way rather than saying "not allowed".
    expect(r.body.message).toContain("Ground truthing");
  });

  it("lets the next stage start once its predecessor is complete", async () => {
    expect((await stage(villageA, "GROUND_TRUTHING", "IN_PROGRESS",
      { started_on: "2026-09-01" })).status).toBe(200);
    expect((await stage(villageA, "GROUND_TRUTHING", "COMPLETED",
      { started_on: "2026-09-01", completed_on: "2026-09-10" })).status).toBe(200);
    expect((await stage(villageA, "GT_QC", "IN_PROGRESS")).status).toBe(200);
  });

  it("records the remarks that explain why a village is stuck", async () => {
    // "Two parcels disputed" is why a village sits at QC for three weeks.
    await stage(villageA, "GT_QC", "IN_PROGRESS", { remarks: "Two parcels disputed" });
    const summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.stage_remarks?.GT_QC ?? row.remarks).toBeDefined();
  });

  it("still requires a completion date on a completed stage", async () => {
    const r = await stage(villageB, "GROUND_TRUTHING", "COMPLETED");
    expect(r.status).toBe(422);
  });
});

describe("counting villages by stage", () => {
  it("answers how many villages sit at each step, at mandal level", async () => {
    // The question the request asks to be answerable at any moment. The
    // overall village state cannot: "in progress" covers a village on its
    // first day of GT and one waiting for its LPM.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?level=mandal`);
    const row = r.data.rows.find((x: any) => x.name === mandalName);

    expect(row.by_stage.GROUND_TRUTHING.completed).toBe(1);   // ADAKULA
    expect(row.by_stage.GROUND_TRUTHING.notStarted).toBe(1);  // Annavaram
    expect(row.by_stage.GT_QC.inProgress).toBe(1);
    expect(row.by_stage.VECTORIZATION.notStarted).toBe(2);
  });

  it("gives the same breakdown at district level", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?level=district`);
    const row = r.data.rows.find((x: any) => x.name === "ASR");
    expect(row.by_stage.GROUND_TRUTHING.completed).toBe(1);
  });

  it("counts every village into exactly one state per stage", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/progress`);
    for (const [code, t] of Object.entries<any>(r.data.by_stage)) {
      expect(t.notStarted + t.inProgress + t.completed + t.onHold, code)
        .toBe(r.data.total.villages);
    }
  });
});

describe("the crew", () => {
  it("puts several employees on one village stage", async () => {
    // A task has one assignee, which is right for a task and wrong for a crew.
    for (const emp of [w.directEmployee, w.siteEmployee]) {
      const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/crew`,
        { employee_id: emp, stage_code: "GROUND_TRUTHING" });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const crew = await get(w.admin, `/api/v1/survey/villages/${villageB}/crew`);
    expect(crew.data).toHaveLength(2);
    // By employee name, not a user id.
    expect(crew.data[0].employee_name).toBeTruthy();
  });

  it("refuses the same employee twice on the same stage", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: w.directEmployee, stage_code: "GROUND_TRUTHING" });
    expect(r.status).toBe(409);
  });

  it("allows the same employee on a different stage of the same village", async () => {
    // The GT crew is not the vectorization team, but one person can be on both.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: w.directEmployee, stage_code: "GT_QC" });
    expect(r.status).toBe(201);
  });

  it("releases rather than deletes, so last season is still answerable", async () => {
    const crew = await get(w.admin, `/api/v1/survey/villages/${villageB}/crew`);
    const member = crew.data.find((c: any) => c.stage_code === "GT_QC");
    const r = await post(w.admin, `/api/v1/survey/crew/${member.id}/release`,
      { released_on: "2026-09-20" });
    expect(r.status).toBe(200);

    const after = await get(w.admin, `/api/v1/survey/villages/${villageB}/crew`);
    const released = after.data.find((c: any) => c.id === member.id);
    expect(released).toBeTruthy();
    expect(released.active).toBe(false);
    expect(released.released_on).toBe("2026-09-20");
  });
});

describe("rovers", () => {
  let rover1: string;
  let rover2: string;

  beforeAll(async () => {
    rover1 = await makeAsset(uniq("ROV"));
    rover2 = await makeAsset(uniq("ROV"));
  });

  it("allocates a named instrument from the asset register", async () => {
    // Naming it is what makes "nineteen idle" a fact somebody can act on.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers`,
      { asset_id: rover1, allocated_on: "2026-09-01" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const list = await get(w.admin, `/api/v1/survey/villages/${villageA}/rovers`);
    expect(list.data[0].asset_code).toBeTruthy();
    expect(list.data[0].out).toBe(true);
  });

  it("refuses the same rover in two villages at once", async () => {
    // An overlap would double-count it and make the idle figure wrong.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/rovers`,
      { asset_id: rover1, allocated_on: "2026-09-15" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ROVER_ALREADY_OUT");
    expect(r.body.message).toContain("Release it first");
  });

  it("lets it move once it is back", async () => {
    await w.pool.query(
      "UPDATE survey_rover_allocations SET released_on = '2026-09-30' WHERE asset_id = $1",
      [rover1]);
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/rovers`,
      { asset_id: rover1, allocated_on: "2026-10-01" });
    expect(r.status).toBe(201);
  });

  it("reports what was used against what was out, and what sat idle", async () => {
    // Two rovers out on the day, one reported in use.
    await post(w.admin, `/api/v1/survey/villages/${villageA}/rovers`,
      { asset_id: rover2, allocated_on: "2026-10-01" });
    await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: villageA, entry_date: "2026-10-01",
      teams_deployed: 1, dgps_rovers: 1, values: { GOVT_LAND_EXTENT_AC: 5 },
    });

    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?to=2026-10-01`);
    expect(r.data.rovers.allocated).toBe(2);
    expect(r.data.rovers.used).toBe(1);
    expect(r.data.rovers.idle).toBe(1);
    expect(r.data.rovers.utilisationPct).toBe(50);
  });

  it("has no utilisation figure on a day with nothing allocated", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?to=2026-08-01`);
    expect(r.data.rovers.allocated).toBe(0);
    expect(r.data.rovers.utilisationPct).toBeNull();
  });
});

describe("pace", () => {
  it("reports how fast the work is going and when it would finish", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?to=2026-10-01`);
    expect(r.data.pace).toBeTruthy();
    expect(r.data.pace.activeDays).toBeGreaterThan(0);
    // Two rates: how fast a crew works, and how fast the work actually goes.
    expect(r.data.pace).toHaveProperty("acresPerActiveDay");
    expect(r.data.pace).toHaveProperty("acresPerCalendarDay");
  });

  it("projects a finish date from the calendar rate", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?to=2026-10-01`);
    // 5 acres done of 200; there is a rate, so there is a projection.
    expect(r.data.pace.projectedFinish).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.data.pace.daysToFinish).toBeGreaterThan(0);
  });
});

describe("controls", () => {
  it("lets a crew record progress but not assign the crew", async () => {
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/villages/${villageB}/crew`,
      { employee_id: w.siteEmployee, stage_code: "VECTORIZATION" });
    expect(r.status).toBe(403);
  });

  it("lets a crew move a stage, which is their own work", async () => {
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/villages/${villageB}/stage`,
      { stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", remarks: "Started today" });
    expect(r.status).toBe(200);
  });

  it("does not let a crew allocate equipment", async () => {
    const r = await post(w.role.TEAM_LEAD, `/api/v1/survey/villages/${villageB}/rovers`,
      { asset_id: w.assetId, allocated_on: "2026-10-05" });
    expect(r.status).toBe(403);
  });
});
