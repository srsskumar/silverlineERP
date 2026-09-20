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
    /*
     * Read as the observer, not as an administrator.
     *
     * It used to fetch this as admin, which happened to pass while the
     * dashboard carried nothing commercial at all. It now carries billing
     * eligibility for the people entitled to it (§078), and an assertion
     * against the wrong reader would have been satisfied only by taking that
     * away from everybody. What the claim is actually about is the
     * department's copy.
     */
    const r = await get(w.role.GOVT_OBSERVER,
      `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.status).toBe(200);
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

describe("ground truthing past its date must say why (§074)", () => {
  let late = "";

  beforeAll(async () => {
    late = await makeVillage("KODURU", 110);
    await post(w.admin, `/api/v1/survey/villages/${late}/start-gt`, {
      started_on: "2026-01-08", expected_end_on: "2026-02-08",
      employee_ids: [w.directEmployee], govt_staff_allocated: 2, crew_allocated: 4,
    });
  });

  it("refuses another day's return until somebody says why", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: late, entry_date: workDate(),
      teams_deployed: 1, dgps_rovers: 1, values: { GOVT_LAND_EXTENT_AC: 6 },
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("GT_VARIANCE_REASON_REQUIRED");
    expect(String(r.body.message)).toMatch(/2026-02-08/);
  });

  it("takes the reason on the return, from whoever is filing it", async () => {
    /*
     * The crew on the village can answer this, and so can their team lead, a
     * project manager or an administrator — everybody who may record a day at
     * all. It is asked where somebody who knows is already typing.
     */
    const r = await post(w.directUser, "/api/v1/survey/entries", {
      survey_village_id: late, entry_date: workDate(),
      teams_deployed: 1, dgps_rovers: 1, values: { GOVT_LAND_EXTENT_AC: 6 },
      gt_variance_reason: "NO_DEPT_STAFF",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const on = await w.pool.query(
      `SELECT vs.variance_reason FROM survey_village_stages vs
         JOIN survey_stages s ON s.id = vs.stage_id
        WHERE vs.survey_village_id = $1 AND s.code = 'GROUND_TRUTHING'`, [late]);
    // Written onto the stage, not onto the day: it explains the stage.
    expect(on.rows[0].variance_reason).toBe("NO_DEPT_STAFF");
  });

  it("asks once and then stops asking", async () => {
    const r = await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: late,
      entry_date: new Date(Date.parse(`${workDate()}T00:00:00Z`) - 86400000)
        .toISOString().slice(0, 10),
      teams_deployed: 1, dgps_rovers: 1, values: { GOVT_LAND_EXTENT_AC: 4 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses to sign a late ground truthing off unexplained", async () => {
    const other = await makeVillage("LINGAPALEM", 80);
    await post(w.admin, `/api/v1/survey/villages/${other}/start-gt`, {
      started_on: "2026-01-08", expected_end_on: "2026-02-08",
      employee_ids: [w.directEmployee], govt_staff_allocated: 1, crew_allocated: 3,
    });
    const bad = await post(w.admin, `/api/v1/survey/villages/${other}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-03-01",
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("GT_VARIANCE_REASON_REQUIRED");

    const good = await post(w.admin, `/api/v1/survey/villages/${other}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-03-01",
      variance_reason: "ACCESS",
    });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
  });

  it("says nothing to a village that finished on time", async () => {
    const punctual = await makeVillage("MUDINEPALLI", 70);
    await post(w.admin, `/api/v1/survey/villages/${punctual}/start-gt`, {
      started_on: "2026-01-08", expected_end_on: "2026-03-08",
      employee_ids: [w.directEmployee], govt_staff_allocated: 1, crew_allocated: 2,
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${punctual}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-03-01",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("how long, and sitting with whom (§074)", () => {
  it("reports days in each stage, median beside the mean", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const gt = (r.data.stage_days as Array<Record<string, any>>)
      .find(s => s.code === "GROUND_TRUTHING");
    expect(gt).toBeTruthy();
    expect(gt!.villages_measured).toBeGreaterThan(0);
    // A handful stuck for months drags a mean somewhere no village is.
    expect(gt!.median_days).not.toBeNull();
    expect(gt!.max_days).toBeGreaterThanOrEqual(gt!.median_days);
    expect((r.data.stage_days as unknown[]).length).toBe(5);
  });

  it("names who each village is with, and who has nobody", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const withCrew = (r.data.villages as Array<Record<string, any>>)
      .find(v => (v.holders ?? []).length > 0);
    expect(withCrew, "a village with somebody on it").toBeTruthy();
    expect(typeof withCrew!.days_in_stage === "number" || withCrew!.days_in_stage === null)
      .toBe(true);
  });

  it("tells the department where the work is and never whose desk it is on", async () => {
    const r = await get(w.role.GOVT_OBSERVER,
      `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.status).toBe(200);
    for (const v of r.data.villages as Array<Record<string, unknown>>) {
      expect(v).not.toHaveProperty("holders");
      expect(v).not.toHaveProperty("holder_count");
    }
    for (const st of r.data.stage_days as Array<Record<string, unknown>>) {
      expect(st).not.toHaveProperty("holders");
      // The durations themselves are progress, and they stay.
      expect(st).toHaveProperty("median_days");
    }
  });

  it("carries the actual completion beside the promised one", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const done = (r.data.villages as Array<Record<string, any>>)
      .find(v => v.gt_completed_on !== null);
    expect(done, "a village whose GT is signed off").toBeTruthy();
    expect(done!.gt_expected_end_on).toBeTruthy();
  });

  it("reports surveyed extent in square kilometres as well as acres", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.data.totals.surveyed_sqkm).toBeGreaterThanOrEqual(0);
    // One acre is 0.0040468564224 km², derived and never stored.
    const expected = Math.round(r.data.totals.surveyed_ac * 0.0040468564224 * 100) / 100;
    expect(Math.abs(r.data.totals.surveyed_sqkm - expected)).toBeLessThan(0.05);
    for (const row of r.data.rows as Array<Record<string, number>>) {
      expect(row).toHaveProperty("surveyed_sqkm");
    }
    for (const v of (r.data.villages as Array<Record<string, number>>).slice(0, 5)) {
      expect(v).toHaveProperty("surveyed_sqkm");
    }
  });
});

describe("the mandal roll-up (§075)", () => {
  it("comes with every dashboard, whatever the grouping asked for", async () => {
    // A district says the programme is behind; the mandal says which
    // tahsildar to ring, and it is the level the work is organised at.
    const byDistrict = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?level=district`);
    expect(byDistrict.data.by_mandal).not.toBeNull();
    expect(Array.isArray(byDistrict.data.by_mandal)).toBe(true);
  });

  it("names the district beside each mandal", async () => {
    // Mandal names repeat across districts; thirty bare ones read as a list
    // of nothing.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const rows = r.data.by_mandal as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(x => typeof x.district === "string")).toBe(true);
  });

  it("adds up to the same villages as the level above it", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const mandals = (r.data.by_mandal as Array<{ villages: number }>)
      .reduce((t, x) => t + x.villages, 0);
    const districts = (r.data.rows as Array<{ villages: number }>)
      .reduce((t, x) => t + x.villages, 0);
    expect(mandals).toBe(districts);
    expect(mandals).toBe(r.data.filter.villages);
  });

  it("is left out when the grouping already is mandal", async () => {
    // Two identical tables is not a second view of anything.
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?level=mandal`);
    expect(r.data.by_mandal).toBeNull();
  });

  it("narrows with every other filter on the screen", async () => {
    const all = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const narrowed = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?position=NOT_STARTED`);
    const total = (rows: Array<{ villages: number }>) =>
      rows.reduce((t, x) => t + x.villages, 0);
    expect(total(narrowed.data.by_mandal)).toBe(narrowed.data.filter.villages);
    expect(total(narrowed.data.by_mandal))
      .toBeLessThanOrEqual(total(all.data.by_mandal));
  });
});

describe("the eleven rungs as figures (§076)", () => {
  it("sends every rung with its extent, in the order of the work", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const rows = r.data.totals.positions as Array<Record<string, number | string>>;
    expect(rows).toHaveLength(11);
    expect(rows.map(x => x.key)).toEqual([
      "NOT_STARTED", "GT_IN_PROGRESS", "GT_COMPLETED",
      "GT_QC_IN_PROGRESS", "GT_QC_COMPLETED",
      "VECTORIZATION_IN_PROGRESS", "VECTORIZATION_COMPLETED",
      "DATA_SUBMITTED", "DATA_APPROVED",
      "FINAL_SUBMITTED", "FINAL_APPROVED",
    ]);
    for (const row of rows) {
      for (const field of ["villages", "extent_ac", "extent_sqkm",
        "surveyed_ac", "surveyed_sqkm", "share_pct"]) {
        expect(row, field).toHaveProperty(field);
      }
    }
  });

  it("adds up to the headline, so the table's last row cannot contradict it", async () => {
    /*
     * The whole reason the figures are sent per rung rather than as a
     * finished total: a total fetched separately is a total that can
     * disagree with the rows on the screen, and the reader has no way to
     * tell which of the two is wrong.
     */
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const rows = r.data.totals.positions as Array<Record<string, number>>;
    const sum = (f: string) => rows.reduce((t, x) => t + Number(x[f]), 0);
    expect(sum("villages")).toBe(r.data.totals.villages);
    expect(sum("extent_ac")).toBeCloseTo(r.data.totals.extent_ac, 4);
    expect(sum("surveyed_ac")).toBeCloseTo(r.data.totals.surveyed_ac, 4);
    // And the counts agree with the chart's own tally of the same villages.
    for (const row of rows) {
      expect(row.villages, String(row.key))
        .toBe(r.data.totals.by_position[String(row.key)]);
    }
  });

  it("keeps the shares to a hundred across the rungs shown", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const rows = r.data.totals.positions as Array<{ share_pct: number }>;
    const total = rows.reduce((t, x) => t + x.share_pct, 0);
    // Rounded to a tenth per row, so a tenth or two of drift is arithmetic
    // rather than a mistake.
    expect(Math.abs(total - 100)).toBeLessThan(1);
  });

  it("narrows with the filters, and still adds up", async () => {
    const r = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/dashboard?position=NOT_STARTED`);
    const rows = r.data.totals.positions as Array<Record<string, number>>;
    expect(rows.reduce((t, x) => t + Number(x.villages), 0))
      .toBe(r.data.filter.villages);
    // Every other rung is empty once one is selected.
    for (const row of rows) {
      if (String(row.key) !== "NOT_STARTED") expect(row.villages).toBe(0);
    }
  });
});

describe("billing waits for an acceptance (§078)", () => {
  let awaiting = "";

  beforeAll(async () => {
    awaiting = await makeVillage("NANDIGAMA", 140);
    for (const [code, state, on] of [
      ["GROUND_TRUTHING", "COMPLETED", "2026-02-01"],
      ["GT_QC", "COMPLETED", "2026-02-15"],
      ["VECTORIZATION", "COMPLETED", "2026-03-10"],
      ["DATA_SUBMISSION", "COMPLETED", "2026-04-01"],
    ] as const) {
      await post(w.admin, `/api/v1/survey/villages/${awaiting}/stage`, {
        stage_code: code, state, completed_on: on,
        ...(code === "GROUND_TRUTHING"
          ? { gt_govt_staff_allocated: 2, gt_crew_allocated: 4 } : {}),
      });
    }
    // Deliverables submitted, not yet accepted.
    await post(w.admin, `/api/v1/survey/villages/${awaiting}/stage`, {
      stage_code: "FINAL_DELIVERABLES", state: "IN_PROGRESS", started_on: "2026-04-20",
    });
  });

  it("refuses the third claim on deliverables that have only gone in", async () => {
    const r = await post(w.admin, `/api/v1/survey/villages/${awaiting}/billing`,
      { milestone: 3 });
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/signed off/i);
  });

  it("allows it once the department has accepted them", async () => {
    await post(w.admin, `/api/v1/survey/villages/${awaiting}/stage`, {
      stage_code: "FINAL_DELIVERABLES", state: "COMPLETED", completed_on: "2026-05-15",
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${awaiting}/billing`,
      { milestone: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("counts what is finished but unsigned, per stage", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const rows = r.data.totals.awaiting_sign_off as Array<Record<string, unknown>>;
    // Only the stages that are work; an acceptance does not await itself.
    expect(rows.map(x => x.code)).toEqual(["GROUND_TRUTHING", "VECTORIZATION"]);
    expect(rows.find(x => x.code === "GROUND_TRUTHING")!.signed_off_by).toBe("GT_QC");
    expect(rows.find(x => x.code === "VECTORIZATION")!.signed_off_by)
      .toBe("DATA_SUBMISSION");
  });

  it("agrees with itself about what may be claimed", async () => {
    /*
     * The figure on the dashboard and the list on the village rows are two
     * readings of one rule, and this is where they would drift apart.
     */
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    const villages = r.data.villages as Array<{ earned_milestones: number[] }>;
    for (const milestone of [1, 2, 3]) {
      const fromRows = villages
        .filter(v => v.earned_milestones.includes(milestone)).length;
      expect(Number(r.data.totals.earned[String(milestone)]), `milestone ${milestone}`)
        .toBe(fromRows);
    }
  });

  it("never reports a village as earning a later claim without the earlier one", async () => {
    // The stages are a sequence and the acceptances follow it, so earning the
    // third without the second would mean a stage was signed off out of order.
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    for (const v of r.data.villages as Array<{ earned_milestones: number[] }>) {
      if (v.earned_milestones.includes(3)) expect(v.earned_milestones).toContain(2);
      if (v.earned_milestones.includes(2)) expect(v.earned_milestones).toContain(1);
    }
  });
});

describe("claims that would not be raised today (§079)", () => {
  let legacy = "";

  beforeAll(async () => {
    legacy = await makeVillage("PAMARRU", 100);
    for (const [code, state, on] of [
      ["GROUND_TRUTHING", "COMPLETED", "2026-02-01"],
      ["GT_QC", "COMPLETED", "2026-02-15"],
      ["VECTORIZATION", "COMPLETED", "2026-03-10"],
      ["DATA_SUBMISSION", "COMPLETED", "2026-04-01"],
      ["FINAL_DELIVERABLES", "COMPLETED", "2026-05-01"],
    ] as const) {
      await post(w.admin, `/api/v1/survey/villages/${legacy}/stage`, {
        stage_code: code, state, completed_on: on,
        ...(code === "GROUND_TRUTHING"
          ? { gt_govt_staff_allocated: 1, gt_crew_allocated: 3 } : {}),
      });
    }
    await post(w.admin, `/api/v1/survey/villages/${legacy}/billing`, { milestone: 3 });
    /*
     * Then the acceptance is withdrawn — the department sends the
     * deliverables back. The claim stands; the work no longer qualifies.
     * Exactly the shape of the rows §078 left behind.
     */
    await w.pool.query(
      `UPDATE survey_village_stages vs SET state = 'IN_PROGRESS', completed_on = NULL
         FROM survey_stages s
        WHERE s.id = vs.stage_id AND s.code = 'FINAL_DELIVERABLES'
          AND vs.survey_village_id = $1`, [legacy]);
  });

  it("counts a standing claim against work that is not signed off", async () => {
    const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(Number(r.data.totals.claimed_unearned["3"])).toBeGreaterThanOrEqual(1);
  });

  it("leaves the claim exactly where it is", async () => {
    // A claim already with the department is a fact, not a mistake to erase.
    const claims = await get(w.admin, `/api/v1/survey/villages/${legacy}/billing`);
    expect((claims.data as Array<{ milestone: number }>).some(c => c.milestone === 3))
      .toBe(true);
  });

  it("would refuse the same claim today", async () => {
    const other = await makeVillage("REPALLE-2", 90);
    for (const [code, state, on] of [
      ["GROUND_TRUTHING", "COMPLETED", "2026-02-01"],
      ["GT_QC", "COMPLETED", "2026-02-15"],
      ["VECTORIZATION", "COMPLETED", "2026-03-10"],
      ["DATA_SUBMISSION", "COMPLETED", "2026-04-01"],
    ] as const) {
      await post(w.admin, `/api/v1/survey/villages/${other}/stage`, {
        stage_code: code, state, completed_on: on,
        ...(code === "GROUND_TRUTHING"
          ? { gt_govt_staff_allocated: 1, gt_crew_allocated: 3 } : {}),
      });
    }
    await post(w.admin, `/api/v1/survey/villages/${other}/stage`, {
      stage_code: "FINAL_DELIVERABLES", state: "IN_PROGRESS", started_on: "2026-04-20",
    });
    const r = await post(w.admin, `/api/v1/survey/villages/${other}/billing`,
      { milestone: 3 });
    expect(r.status).toBe(422);
  });

  it("tells the department nothing about any of it", async () => {
    const r = await get(w.role.GOVT_OBSERVER,
      `/api/v1/survey/projects/${programmeId}/dashboard`);
    expect(r.data.totals).not.toHaveProperty("claimed_unearned");
    expect(r.data.totals).not.toHaveProperty("earned");
  });
});
