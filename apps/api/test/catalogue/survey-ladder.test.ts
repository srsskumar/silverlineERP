/**
 * One village, one position (§071).
 *
 * The module tracked seven stages with four states each and asked a reader to
 * hold the combinations in their head. The contract reports eleven positions,
 * and this is the screen a government official is shown — so what it may and
 * may not contain is tested as carefully as what it says.
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

async function makeVillage(name: string, extent = 200): Promise<string> {
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,$3) RETURNING id`,
    [w.orgId, uniq("D"), `${name} district`])).rows[0].id);
  const mandal = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("M"), `${name} mandal`, district])).rows[0].id);
  const unit = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
    [w.orgId, uniq("V"), name, mandal])).rows[0].id);
  const sv = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
    { village_id: unit, total_extent_ac: extent });
  return String(sv.data.id);
}

/** Put a village at a stage directly, the way the QC screens do. */
async function setStage(villageId: string, code: string, state: string, on = "2026-01-05") {
  const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/stage`, {
    stage_code: code, state,
    ...(state === "COMPLETED" ? { completed_on: on } : {}),
    ...(state === "IN_PROGRESS" ? { started_on: on } : {}),
  });
  return r;
}

beforeAll(async () => {
  w = await buildWorld();
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Ladder programme" });
  programmeId = String(p.data.id);
  villageA = await makeVillage("ADAKULA", 300);
  villageB = await makeVillage("BUTCHAMPETA", 100);
});

afterAll(async () => { await w.app.close(); });

describe("the five-stage pipeline", () => {
  it("offers exactly the stages the eleven positions are made of", async () => {
    const r = await get(w.admin, "/api/v1/survey/measures");
    const codes = (r.data.stages as Array<{ code: string }>).map(s => s.code);
    for (const live of ["GROUND_TRUTHING", "GT_QC", "VECTORIZATION",
      "DATA_SUBMISSION", "FINAL_DELIVERABLES"]) {
      expect(codes, live).toContain(live);
    }
    // Retired by §071. The rows survive; the stage stops being offered, so
    // nothing new can be recorded against it.
    for (const gone of ["VECTORIZATION_QC", "RECORDS_PREPARATION", "LPM_GENERATION"]) {
      expect(codes, gone).not.toContain(gone);
    }
  });

  it("will not start a stage whose predecessor is unfinished", async () => {
    const r = await setStage(villageB, "FINAL_DELIVERABLES", "IN_PROGRESS");
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/data submission|DATA_SUBMISSION/i);
  });
});

describe("the dashboard", () => {
  it("places every village on exactly one rung, and they add to the total", async () => {
    /*
     * Started through start-gt rather than by setting the stage directly.
     * Ground truthing refuses to begin without the staffing agreed with the
     * mandal (§067), which is the whole reason a single commencement call
     * exists — the stage, the crew, the headcounts and the dates are one
     * decision and the system treats them as one.
     */
    const started = await post(w.admin, `/api/v1/survey/villages/${villageA}/start-gt`, {
      started_on: "2026-01-05", expected_end_on: "2026-02-28",
      employee_ids: [w.directEmployee],
      govt_staff_allocated: 2, crew_allocated: 5,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.data;
    expect(d.ladder).toHaveLength(11);
    const counted = Object.values(d.totals.by_position as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    expect(counted).toBe(d.totals.villages);
    expect(d.totals.by_position.GT_IN_PROGRESS).toBe(1);
    expect(d.totals.by_position.NOT_STARTED).toBe(d.totals.villages - 1);
  });

  it("moves a village up the ladder as the work advances", async () => {
    const at = async () => {
      const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
      return (r.data.villages as Array<{ id: string; position: string }>)
        .find(v => v.id === villageA)?.position;
    };
    expect(await at()).toBe("GT_IN_PROGRESS");
    await setStage(villageA, "GROUND_TRUTHING", "COMPLETED");
    expect(await at()).toBe("GT_COMPLETED");
    await setStage(villageA, "GT_QC", "COMPLETED");
    expect(await at()).toBe("GT_QC_COMPLETED");
    await setStage(villageA, "VECTORIZATION", "COMPLETED");
    expect(await at()).toBe("VECTORIZATION_COMPLETED");
    await setStage(villageA, "DATA_SUBMISSION", "IN_PROGRESS");
    expect(await at()).toBe("DATA_SUBMITTED");
    await setStage(villageA, "DATA_SUBMISSION", "COMPLETED");
    expect(await at()).toBe("DATA_APPROVED");
  });

  it("filters to one rung and keeps the roll-up honest", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?position=DATA_APPROVED`);
    expect(r.status).toBe(200);
    expect(r.data.filter.villages).toBe(1);
    expect(r.data.villages).toHaveLength(1);
    expect(r.data.villages[0].id).toBe(villageA);
    // The roll-up is over the filtered villages, so the two cannot disagree.
    const rows = r.data.rows as Array<{ villages: number }>;
    expect(rows.reduce((t, x) => t + x.villages, 0)).toBe(1);
  });

  it("reports a started village with no control point, without refusing it", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    // villageA is well under way and no GCP was ever recorded for it.
    expect(r.data.totals.gcp_missing).toBeGreaterThanOrEqual(1);
    const v = (r.data.villages as Array<{ id: string; gcp_count: number }>)
      .find(x => x.id === villageA);
    expect(v!.gcp_count).toBe(0);
  });

  it("refuses a date that is not one", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?from=rubbish`);
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/date|YYYY-MM-DD/i);
  });
});

describe("what an observer may see", () => {
  /*
   * The dashboard is handed to people outside the company. What it does not
   * carry matters more than what it does, so the absence is asserted rather
   * than assumed.
   */
  it("carries no money, no names and no equipment", async () => {
    /*
     * Checked as field names rather than as words.
     *
     * The first version of this looked for the substring "employee" and
     * "rover" anywhere in the response, which caught the delay reasons
     * "Employee issue" and "Rover issue" (§073) — labels describing why a
     * programme is behind, not people or equipment. What must not appear is
     * an identifier or a figure: the name of a person, the code of an
     * instrument, or anything about what the work is worth.
     */
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const body = JSON.stringify(r.data);
    for (const leak of ["employee_id", "employee_name", "assignee", "asset_id",
      "asset_code", "serial_number", "milestone", "billing", "claim", "invoice",
      "amount", "percent_claimed", "extent_rate", "crew_assigned"]) {
      expect(body, leak).not.toContain(leak);
    }
    // And no UUID belonging to a person or an asset, whatever it is called.
    const people = await w.pool.query(
      "SELECT id FROM employees WHERE org_id = $1 LIMIT 50", [w.orgId]);
    for (const row of people.rows) expect(body).not.toContain(String(row.id));
  });

  it("lets an observer read the dashboard and nothing else", async () => {
    const observer = w.role.GOVT_OBSERVER;

    const dash = await get(observer, `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.data.totals.villages).toBeGreaterThan(0);

    const picker = await get(observer, "/api/v1/survey/dashboard/projects");
    expect(picker.status).toBe(200);
    // Three fields and no fourth: the programme record is not theirs to read.
    for (const row of picker.data as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual(["code", "id", "name"]);
    }

    // Everything else in the module is closed to them.
    for (const url of [
      `/api/v1/survey/projects`,
      `/api/v1/survey/projects/${programmeId}/progress`,
      `/api/v1/survey/projects/${programmeId}/summary`,
      `/api/v1/survey/projects/${programmeId}/deployment`,
      `/api/v1/survey/villages/${villageA}/crew`,
      `/api/v1/survey/villages/${villageA}/billing`,
      `/api/v1/survey/entries`,
    ]) {
      const r = await get(observer, url);
      expect(r.status, `${url} -> ${r.status}`).toBe(403);
    }
  });

  it("does not let an observer write anything", async () => {
    const observer = w.role.GOVT_OBSERVER;
    const r = await post(observer, "/api/v1/survey/entries", {
      survey_village_id: villageB, entry_date: workDate(), values: {},
    });
    expect(r.status).toBe(403);
  });
});

describe("starting ground truthing", () => {
  it("records the crew, the headcounts and both dates in one call", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageB}/start-gt`, {
      started_on: "2026-01-10",
      expected_end_on: "2026-03-15",
      employee_ids: [w.directEmployee],
      govt_staff_allocated: 2,
      crew_allocated: 6,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.data.crew_added).toBe(1);
    expect(r.data.started_on).toBe("2026-01-10");
    expect(r.data.expected_end_on).toBe("2026-03-15");

    const dash = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const v = (dash.data.villages as Array<Record<string, any>>).find(x => x.id === villageB);
    expect(v!.position).toBe("GT_IN_PROGRESS");
    expect(v!.gt_started_on).toBe("2026-01-10");
    expect(v!.gt_expected_end_on).toBe("2026-03-15");
  });

  it("says a control point is missing without stopping the crew", async () => {
    // A crew already walking the boundary is not sent home because a
    // ten-figure coordinate has not been typed yet.
    const v2 = await makeVillage("CHINTALA");
    const r = await post(w.admin, `/api/v1/survey/villages/${v2}/start-gt`, {
      started_on: "2026-01-10", expected_end_on: "2026-02-10",
      employee_ids: [w.directEmployee],
    });
    expect(r.status).toBe(201);
    expect(String(r.data.gcp_note)).toMatch(/no control point/i);
  });

  it("refuses a village with nobody on it", async () => {
    const v3 = await makeVillage("DHARMAPURI");
    const r = await post(w.admin, `/api/v1/survey/villages/${v3}/start-gt`, {
      started_on: "2026-01-10", expected_end_on: "2026-02-10", employee_ids: [],
    });
    expect(r.status).toBe(422);
  });

  it("refuses a finish before the start", async () => {
    const v4 = await makeVillage("ERRAGUNTA");
    const r = await post(w.admin, `/api/v1/survey/villages/${v4}/start-gt`, {
      started_on: "2026-02-10", expected_end_on: "2026-01-10",
      employee_ids: [w.directEmployee],
    });
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/before the start/i);
  });

  it("writes nothing at all when one employee id is wrong", async () => {
    // A village half-started is worse than one not started, because it looks
    // done. Everything named is checked before anything is written.
    const v5 = await makeVillage("GOLLAPALLI");
    const r = await post(w.admin, `/api/v1/survey/villages/${v5}/start-gt`, {
      started_on: "2026-01-10", expected_end_on: "2026-02-10",
      employee_ids: [w.directEmployee, "123e4567-e89b-12d3-a456-426614174999"],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);

    const dash = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const v = (dash.data.villages as Array<Record<string, any>>).find(x => x.id === v5);
    expect(v!.position).toBe("NOT_STARTED");
    expect(v!.gt_started_on).toBeNull();
    const crew = await get(w.admin, `/api/v1/survey/villages/${v5}/crew`);
    expect(crew.data).toHaveLength(0);
  });

  it("will not restart a village whose GT is already signed off", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/start-gt`, {
      started_on: "2026-01-10", expected_end_on: "2026-02-10",
      employee_ids: [w.directEmployee],
    });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/rework/i);
  });
});

describe("billing gates after the rename", () => {
  it("still holds the second claim until the department approves the data", async () => {
    // villageA is at DATA_APPROVED, so the second claim is earned.
    const r = await post(w.admin, `/api/v1/survey/villages/${villageA}/billing`,
      { milestone: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    // villageB has only just started GT, so it is not.
    const early = await post(w.admin, `/api/v1/survey/villages/${villageB}/billing`,
      { milestone: 2 });
    expect(early.status).toBe(422);
  });
});

describe("a stage carries its plan (§072)", () => {
  let planned = "";

  beforeAll(async () => {
    planned = await makeVillage("HANUMANPALEM", 150);
    await post(w.admin, `/api/v1/survey/villages/${planned}/start-gt`, {
      started_on: "2026-01-05", expected_end_on: "2026-02-05",
      employee_ids: [w.directEmployee], govt_staff_allocated: 2, crew_allocated: 5,
    });
  });

  it("puts the dates on the stage, not beside it", async () => {
    // §071 briefly held these on the village as well. Two rows holding the
    // same two facts is how the two come to disagree.
    const cols = await w.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'survey_villages' AND column_name IN
          ('gt_started_on', 'gt_expected_end_on')`);
    expect(cols.rowCount).toBe(0);

    const row = await w.pool.query(
      `SELECT vs.started_on, vs.expected_start_on, vs.expected_end_on
         FROM survey_village_stages vs JOIN survey_stages s ON s.id = vs.stage_id
        WHERE vs.survey_village_id = $1 AND s.code = 'GROUND_TRUTHING'`, [planned]);
    expect(row.rows[0].expected_end_on).toBeTruthy();
  });

  it("reports how far off plan a finished stage came in", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${planned}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED",
      completed_on: "2026-02-20", variance_reason: "WEATHER",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.variance_days).toBe(15);
    expect(r.data.variance_note).toBe("15 days late");
    expect(r.data.variance_needs_reason).toBe(false);
  });

  it("does not erase the plan when somebody records what happened", async () => {
    /*
     * The bug this guards: an update that carried no expected dates would
     * copy the absent fields over the plan, and the variance every screen
     * reports would quietly become null the first time anybody touched the
     * stage.
     */
    const r = await post(w.admin, `/api/v1/survey/villages/${planned}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-02-21",
    });
    expect(r.status).toBe(200);
    expect(r.data.expected_end_on).toBe("2026-02-05");
    expect(r.data.variance_days).toBe(16);
    // The reason given earlier stands too.
    expect(r.data.variance_reason).toBe("WEATHER");
  });

  it("refuses a plan that finishes before it starts", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${planned}/stage`, {
      stage_code: "GT_QC", state: "IN_PROGRESS", started_on: "2026-03-01",
      expected_start_on: "2026-04-01", expected_end_on: "2026-03-01",
    });
    expect(r.status).toBe(422);
  });

  it('refuses an "other" variance with nothing said', async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${planned}/stage`, {
      stage_code: "GT_QC", state: "IN_PROGRESS", started_on: "2026-03-01",
      variance_reason: "OTHER",
    });
    expect(r.status).toBe(422);
  });

  it("carries the slip and the stage responsible onto the dashboard", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const v = (r.data.villages as Array<Record<string, any>>).find(x => x.id === planned);
    expect(v!.slip_days).toBe(16);
    expect(v!.slip_stage).toBe("GROUND_TRUTHING");
    expect(v!.slip_note).toBe("16 days late");
    expect(v!.slip_reason).toBe("WEATHER");
    expect(r.data.totals.late).toBeGreaterThanOrEqual(1);
  });

  it("counts a village with no dates as unplanned rather than on time", async () => {
    // A village with no expected date is not a village running to time, and
    // counting it as one is how a programme reports itself green.
    const bare = await makeVillage("INDUKURPET", 90);
    await post(w.admin, `/api/v1/survey/villages/${bare}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: "2026-03-01",
      gt_govt_staff_allocated: 1, gt_crew_allocated: 3,
    });
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const v = (r.data.villages as Array<Record<string, any>>).find(x => x.id === bare);
    expect(v!.slip_note).toBeNull();
    expect(v!.slip_days).toBeNull();
    expect(r.data.totals.unplanned).toBeGreaterThanOrEqual(1);
  });
});

describe("the village list at scale", () => {
  it("honours a limit instead of ignoring it", async () => {
    /*
     * This route took a `limit` and returned everything anyway. At twelve
     * hundred villages that is a two-megabyte answer to a request for two
     * rows — and a parameter that does nothing is worse than one that does
     * not exist, because the caller believes it worked.
     */
    const paged = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages?limit=2`);
    expect(paged.status).toBe(200);
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.total).toBeGreaterThan(2);
    expect(paged.body.has_more).toBe(true);

    const second = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/villages?limit=2&offset=2`);
    expect(second.body.data[0].id).not.toBe(paged.body.data[0].id);
  });

  it("still returns the whole list when no page is asked for", async () => {
    // The Villages screen filters, sorts and exports what it holds; a default
    // page would silently narrow all three.
    const all = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
    expect(all.body.data.length).toBe(all.body.total);
    expect(all.body.has_more).toBe(false);
  });
});

describe("why the work is held up (§073)", () => {
  let held = "";

  beforeAll(async () => {
    held = await makeVillage("JANGAREDDYGUDEM", 120);
    await post(w.admin, `/api/v1/survey/villages/${held}/start-gt`, {
      started_on: "2026-01-06", expected_end_on: "2026-02-06",
      employee_ids: [w.directEmployee], govt_staff_allocated: 2, crew_allocated: 4,
    });
    // A stage that missed its date, and said why.
    await post(w.admin, `/api/v1/survey/villages/${held}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED",
      completed_on: "2026-03-20", variance_reason: "NO_DEPT_STAFF",
    });
    // A day that fell short, and said why.
    await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: held, entry_date: workDate(),
      teams_deployed: 1, dgps_rovers: 1, values: { GOVT_LAND_EXTENT_AC: 1 },
      low_progress_reason: "WEATHER",
    });
  });

  it("counts each reason in its own unit and never sums across them", async () => {
    /*
     * A stage, an instrument-day and a short day are three different things.
     * Adding them would produce a number with no meaning, so each source is
     * reported separately and says what it counts.
     */
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reasons = r.data.reasons;
    expect(reasons.stage_variance.unit).toBe("stages");
    expect(reasons.instrument_idle.unit).toBe("instrument-days");
    expect(reasons.low_progress.unit).toBe("days");
    expect(Object.keys(reasons).sort())
      .toEqual(["instrument_idle", "low_progress", "stage_variance"]);
  });

  it("lists every reason in the vocabulary, including the ones at zero", async () => {
    // A reason that never occurred is a finding of its own, but only if the
    // reader can see it was looked for. A list that shows only what happened
    // reads differently every time it is opened.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    for (const group of ["stage_variance", "instrument_idle", "low_progress"]) {
      const codes = (r.data.reasons[group].by_reason as Array<{ code: string }>)
        .map(x => x.code);
      expect(codes, group).toEqual([
        "WEATHER", "ACCESS", "EQUIPMENT", "ROVER", "DATA_TECHNICAL", "EMPLOYEE",
        "FIELD_CONDITIONS", "DEPENDENCY", "NO_DEPT_STAFF", "OTHER",
      ]);
    }
  });

  it("counts the stage that missed its date under the reason given", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const row = (r.data.reasons.stage_variance.by_reason as Array<Record<string, number | string>>)
      .find(x => x.code === "NO_DEPT_STAFF");
    expect(Number(row!.count)).toBeGreaterThanOrEqual(1);
    expect(Number(row!.villages)).toBeGreaterThanOrEqual(1);
  });

  it("drills a reason down to the villages behind it", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard`
      + `?reason=NO_DEPT_STAFF&reason_source=stage_variance`);
    expect(r.status).toBe(200);
    expect(r.data.filter.reason).toBe("NO_DEPT_STAFF");
    const ids = (r.data.villages as Array<{ id: string }>).map(v => v.id);
    expect(ids).toContain(held);
    // The roll-up is over the same villages, so the number clicked and the
    // list shown cannot disagree.
    expect((r.data.rows as Array<{ villages: number }>)
      .reduce((t, x) => t + x.villages, 0)).toBe(r.data.filter.villages);
  });

  it("keeps the three sources apart when drilling", async () => {
    // "Weather" against a stage that missed its date and "weather" against an
    // idle instrument are different facts about different villages. Merging
    // them would hand somebody a list that does not match what they clicked.
    const short = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard`
      + `?reason=WEATHER&reason_source=low_progress`);
    expect((short.data.villages as Array<{ id: string }>).map(v => v.id)).toContain(held);

    const stage = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard`
      + `?reason=WEATHER&reason_source=stage_variance`);
    expect((stage.data.villages as Array<{ id: string }>).map(v => v.id)).not.toContain(held);
  });

  it("searches every source when none is named", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?reason=WEATHER`);
    expect((r.data.villages as Array<{ id: string }>).map(v => v.id)).toContain(held);
  });

  it("refuses a reason it does not record, and says which it does", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?reason=RAIN`);
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/WEATHER/);
  });

  it("refuses a source that is not one of the three", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?reason=WEATHER&reason_source=vibes`);
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/instrument_idle/);
  });

  it("still tells an observer nothing it should not", async () => {
    // The reasons are aggregate counts of why a programme is behind, which is
    // exactly what the department is entitled to. No instrument, no person
    // and no claim is named alongside them.
    const r = await get(w.role.GOVT_OBSERVER,
      `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.data);
    for (const leak of ["asset_code", "employee_id", "employee_name", "serial_number",
      "milestone", "percent_claimed", "amount", "invoice"]) {
      expect(body, leak).not.toContain(leak);
    }
  });
});
