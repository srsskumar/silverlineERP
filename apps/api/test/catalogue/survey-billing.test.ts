/**
 * Billing what the field actually measured (§note 9).
 *
 * The survey module records acres surveyed per village per day. The billing
 * module raises running-account bills against a BOQ. They measure the same
 * work, and until now nothing joined them — the quantity on the bill was
 * typed in from a spreadsheet kept alongside the system, and two measurements
 * of one job drift.
 *
 * On a government contract the bill has to tie to the measurement book, so
 * every case below is one where the honest number is awkward: more ground
 * than the tender allowed, a village re-measured downwards, a stage finished
 * but never dated.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, workDate, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let mandalId: string;

async function send(
  method: "POST" | "GET" | "DELETE", headers: Headers, url: string, payload?: unknown,
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
const del = (h: Headers, u: string) => send("DELETE", h, u);

/** A day in the past, so a return is never dated in the future. */
const day = (back: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};

/**
 * A survey programme with its own project, and a BOQ line to bill against.
 *
 * Built through the API rather than by insert, so the test exercises the
 * same pairing the setup screen does.
 */
async function programme(opts: { boqQuantity?: number; rate?: number } = {}) {
  const created = await post(w.admin, "/api/v1/survey/projects", {
    code: uniq("BILL"), name: "Billable programme", create_project: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const projectId = String(created.data.project_id);
  const boq = await post(w.admin, `/api/v1/projects/${projectId}/boq`, {
    item_code: "1.1", description: "Resurvey of agricultural land", unit: "acre",
    quantity: opts.boqQuantity ?? 1000, rate: opts.rate ?? 450,
  });
  expect(boq.status, JSON.stringify(boq.body)).toBe(201);
  return {
    programmeId: String(created.data.id),
    projectId,
    boqItemId: String(boq.data.id),
  };
}

async function village(programmeId: string, extent = 500) {
  const v = await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`, {
    village_name: `Billable ${uniq("V")}`, village_code: uniq("BV"),
    mandal_id: mandalId, total_extent_ac: extent,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return String(v.data.id);
}

async function record(villageId: string, date: string, acres: number) {
  const r = await post(w.admin, "/api/v1/survey/entries", {
    survey_village_id: villageId, entry_date: date, teams_deployed: 1,
    values: { GOVT_LAND_EXTENT_AC: acres },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function measureId(code = "GOVT_LAND_EXTENT_AC"): Promise<string> {
  const r = await w.pool.query(
    "SELECT id FROM survey_measures WHERE org_id = $1 AND code = $2", [w.orgId, code]);
  return String(r.rows[0].id);
}

async function stageId(code: string): Promise<string> {
  const r = await w.pool.query(
    "SELECT id FROM survey_stages WHERE org_id = $1 AND code = $2", [w.orgId, code]);
  return String(r.rows[0].id);
}

const link = (projectId: string, body: Record<string, unknown>) =>
  post(w.admin, `/api/v1/projects/${projectId}/survey-boq-links`, body);

const proposal = (projectId: string, periodTo?: string) =>
  get(w.admin, `/api/v1/projects/${projectId}/measured-proposal`
    + (periodTo ? `?period_to=${periodTo}` : ""));

beforeAll(async () => {
  w = await buildWorld();
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Bill district') RETURNING id`,
    [w.orgId, uniq("BD")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'Bill mandal',$3) RETURNING id`,
    [w.orgId, uniq("BM"), district])).rows[0].id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("saying which measurement pays for which BOQ line", () => {
  it("links a line to a measure", async () => {
    const { projectId, boqItemId } = await programme();
    const r = await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Number(r.data.factor)).toBe(1);

    const list = await get(w.admin, `/api/v1/projects/${projectId}/survey-boq-links`);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].measure_code).toBe("GOVT_LAND_EXTENT_AC");
  });

  it("refuses a second measure on the same line", async () => {
    // A BOQ line is one item at one rate. Two sources leaves no answer to
    // "where did this quantity come from", which is the first question asked
    // when a bill is queried.
    const { projectId, boqItemId } = await programme();
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    const again = await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId("VILLAGE_BOUNDARY_POINTS"),
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("separate BOQ line");
  });

  it("refuses a BOQ line that belongs to another project", async () => {
    const a = await programme();
    const b = await programme();
    const r = await link(a.projectId, {
      boq_item_id: b.boqItemId, measure_id: await measureId(),
    });
    expect(r.status).toBe(422);
  });

  it("refuses a project no survey programme is running against", async () => {
    // There would be no field measurements to bill from.
    const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
    const plain = await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status, contract_value)
       VALUES($1,$2,$3,'Unpaired project','ACTIVE',1000000) RETURNING id`,
      [w.orgId, ws.rows[0].id, uniq("PRJ")]);
    const boq = await post(w.admin, `/api/v1/projects/${plain.rows[0].id}/boq`, {
      item_code: "1.1", description: "Something else", unit: "cum", quantity: 10, rate: 100,
    });
    const r = await link(String(plain.rows[0].id), {
      boq_item_id: String(boq.data.id), measure_id: await measureId(),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("Pair a programme");
  });

  it("refuses a measure and a stage nobody defined", async () => {
    const { projectId, boqItemId } = await programme();
    const bogus = "00000000-0000-4000-8000-000000000000";
    expect((await link(projectId, { boq_item_id: boqItemId, measure_id: bogus })).status).toBe(422);
    expect((await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(), stage_id: bogus,
    })).status).toBe(422);
  });

  it("refuses a factor that would bill every line as nothing", async () => {
    const { projectId, boqItemId } = await programme();
    const r = await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(), factor: 0,
    });
    expect(r.status).toBe(422);
  });

  it("is not something a reader can set up", async () => {
    // It says what the contract pays for.
    const { projectId, boqItemId } = await programme();
    const r = await post(w.role.AUDITOR, `/api/v1/projects/${projectId}/survey-boq-links`,
      { boq_item_id: boqItemId, measure_id: await measureId() });
    expect([401, 403]).toContain(r.status);
  });

  it("can be removed, and says so plainly when it is already gone", async () => {
    const { projectId, boqItemId } = await programme();
    const made = await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    expect((await del(w.admin, `/api/v1/survey-boq-links/${made.data.id}`)).status).toBe(200);
    const again = await del(w.admin, `/api/v1/survey-boq-links/${made.data.id}`);
    expect(again.status).toBe(404);
    expect(JSON.stringify(again.body)).toContain("already gone");
  });
});

describe("the lists a link is built from", () => {
  it("offers the measures and stages to somebody with BOQ access", async () => {
    const { projectId } = await programme();
    const r = await get(w.role.BID_TENDER_MANAGER,
      `/api/v1/projects/${projectId}/survey-measure-options`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.measures.length).toBeGreaterThan(0);
    expect(r.data.stages.length).toBeGreaterThan(0);
    expect(r.data.programme).toBeTruthy();
  });

  it("is gated on the BOQ, not on the survey module", async () => {
    /*
     * Setting up a link is a commercial decision about what the contract pays
     * for, so it follows BOQ access. Served from billing's own endpoint for
     * the same reason: reading the survey module's lists would make these
     * dropdowns depend on a grant nobody would think to check, and a dropdown
     * that renders empty for an unmentioned permission is worse than none.
     *
     * HR holds survey.read and no BOQ access, which is exactly the wrong way
     * round for this screen.
     */
    const { projectId } = await programme();
    const r = await get(w.role.HR_MANAGER,
      `/api/v1/projects/${projectId}/survey-measure-options`);
    expect([401, 403]).toContain(r.status);
  });

  it("says there is no programme when the project is not a survey one", async () => {
    const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
    const plain = await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status, contract_value)
       VALUES($1,$2,$3,'Plain project','ACTIVE',500000) RETURNING id`,
      [w.orgId, ws.rows[0].id, uniq("PRJ")]);
    const r = await get(w.admin,
      `/api/v1/projects/${plain.rows[0].id}/survey-measure-options`);
    expect(r.status).toBe(200);
    expect(r.data.programme).toBeNull();
  });
});

describe("the proposal", () => {
  it("is the total measured across every village on the programme", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    const a = await village(programmeId);
    const b = await village(programmeId);
    await record(a, day(3), 120);
    await record(a, day(2), 30);
    await record(b, day(2), 50);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });

    const r = await proposal(projectId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.lines).toHaveLength(1);
    expect(r.data.lines[0].cumulativeQuantity).toBe(200);
    expect(r.data.lines[0].thisQuantity).toBe(200);
    expect(r.data.has_work).toBe(true);
  });

  it("counts only what was measured on or before the bill date", async () => {
    // A bill is a claim as at a date. Work done after it belongs on the next
    // one.
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(5), 100);
    await record(v, day(1), 60);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });

    const r = await proposal(projectId, day(3));
    expect(r.data.lines[0].cumulativeQuantity).toBe(100);
  });

  it("converts the field unit into the contract unit", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    await record(await village(programmeId), day(2), 100);
    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(), factor: 0.404686,
    });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(40.469);
  });

  it("subtracts what an earlier bill already certified", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(5), 300);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });

    const bill = await post(w.admin, "/api/v1/ra-bills", {
      project_id: projectId, period_from: day(30), period_to: day(4),
      lines: [{ boq_item_id: boqItemId, cumulative_quantity: 300 }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const id = String(bill.data.id);
    const v1 = await w.pool.query("SELECT version FROM ra_bills WHERE id=$1", [id]);
    await post({ ...w.admin, "if-match": String(v1.rows[0].version) },
      `/api/v1/ra-bills/${id}/status`, { status: "SUBMITTED" });
    const v2 = await w.pool.query("SELECT version FROM ra_bills WHERE id=$1", [id]);
    await post({ ...w.admin, "if-match": String(v2.rows[0].version) },
      `/api/v1/ra-bills/${id}/status`, { status: "CERTIFIED" });

    await record(v, day(2), 150);
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(450);
    expect(r.data.lines[0].previousQuantity).toBe(300);
    expect(r.data.lines[0].thisQuantity).toBe(150);
  });

  it("says when there is nothing further to bill", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    await village(programmeId);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(0);
    expect(r.data.lines[0].flags).toContain("NOTHING_NEW");
    expect(r.data.has_work).toBe(false);
  });

  it("flags more ground than the BOQ allowed for, without capping it", async () => {
    // The ground had more land in it than the tender estimated. That is a
    // variation with a process attached, not a number to quietly shave.
    const { programmeId, projectId, boqItemId } = await programme({ boqQuantity: 100 });
    await record(await village(programmeId, 900), day(2), 400);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(400);
    expect(r.data.lines[0].flags).toContain("EXCEEDS_BOQ");
  });

  it("says plainly when nothing on the project is linked yet", async () => {
    const { projectId } = await programme();
    const r = await proposal(projectId);
    expect(r.status).toBe(200);
    expect(r.data.lines).toHaveLength(0);
    expect(r.body.message).toContain("field measurement");
  });

  it("refuses a bill date that is not a date", async () => {
    const { projectId } = await programme();
    for (const bad of ["2026-13-01", "31/12/2026", "soon"]) {
      expect((await proposal(projectId, bad)).status, bad).toBe(422);
    }
  });
});

/**
 * Completing a stage, asserting that it happened.
 *
 * The pipeline refuses a stage whose predecessors are unfinished, and an
 * earlier version of these tests ignored that refusal — so the village never
 * reached the stage, the proposal correctly measured nothing, and the test
 * passed for the wrong reason. Every step is checked now.
 */
async function complete(villageId: string, stageCode: string, on: string) {
  const r = await post(w.admin, `/api/v1/survey/villages/${villageId}/stage`, {
    stage_code: stageCode, state: "COMPLETED", completed_on: on,
  });
  expect(r.status, `${stageCode}: ${JSON.stringify(r.body)}`).toBe(200);
}

describe("billing only what is finished", () => {
  it("counts a village once it has completed the gating stage", async () => {
    // Ground truthing is not a finished parcel, but it is a milestone a
    // contract can pay on. Either way the rule is the same: measure the
    // villages that reached it, and no others.
    const { programmeId, projectId, boqItemId } = await programme();
    const done = await village(programmeId);
    const walking = await village(programmeId);
    await record(done, day(4), 200);
    await record(walking, day(4), 150);
    await complete(done, "GROUND_TRUTHING", day(3));

    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });

    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(200);
  });

  it("does not count a village that finished the stage after the bill date", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(8), 200);
    await complete(v, "GROUND_TRUTHING", day(2));
    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });
    const r = await proposal(projectId, day(5));
    expect(r.data.lines[0].cumulativeQuantity).toBe(0);
  });

  it("counts a stage the task board finished, not just one set by hand", async () => {
    // Most programmes run their stages as tasks. Reading only the stage row
    // would bill nothing at all for those, which is nearly all of them.
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(6), 320);

    const task = await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, actual_end_at, created_by)
       VALUES($1,$2,'Ground truthing','DONE',$3::date,$4) RETURNING id`,
      [w.orgId, projectId, day(4), w.adminId]);
    await w.pool.query(
      `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state, task_id)
       VALUES($1,$2,$3,'NOT_STARTED',$4)
       ON CONFLICT (survey_village_id, stage_id)
       DO UPDATE SET task_id = EXCLUDED.task_id`,
      [w.orgId, v, await stageId("GROUND_TRUTHING"), task.rows[0].id]);

    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });
    const r = await proposal(projectId);
    // The row still says NOT_STARTED. The task governs, and the task is done.
    expect(r.data.lines[0].cumulativeQuantity).toBe(320);
  });

  it("leaves out a task finished without an end date, and says how much", async () => {
    // A card dragged to Done without an end time. A bill is a claim as at a
    // date and that completion cannot be placed before or after it. Silently
    // under-billing is the worse failure: nobody notices money never claimed.
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(4), 275);

    const task = await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, created_by)
       VALUES($1,$2,'Ground truthing','DONE',$3) RETURNING id`,
      [w.orgId, projectId, w.adminId]);
    await w.pool.query(
      `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state, task_id)
       VALUES($1,$2,$3,'NOT_STARTED',$4)
       ON CONFLICT (survey_village_id, stage_id)
       DO UPDATE SET task_id = EXCLUDED.task_id`,
      [w.orgId, v, await stageId("GROUND_TRUTHING"), task.rows[0].id]);

    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });

    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(0);
    expect(r.data.lines[0].undated_villages).toBe(1);
    expect(r.data.lines[0].undated_quantity).toBe(275);
    expect(r.data.lines[0].flags).toContain("UNDATED_COMPLETIONS");
  });

  it("counts everything when no stage gates the line", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    await record(await village(programmeId), day(2), 90);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(90);
    expect(r.data.lines[0].undated_villages).toBe(0);
  });
});

describe("what the proposal must never do", () => {
  it("does not count work from another programme's villages", async () => {
    // Two programmes, two projects. A quantity crossing between them would
    // bill one client for another's work.
    const mine = await programme();
    const theirs = await programme();
    await record(await village(theirs.programmeId), day(2), 999);
    await record(await village(mine.programmeId), day(2), 10);
    await link(mine.projectId, {
      boq_item_id: mine.boqItemId, measure_id: await measureId(),
    });
    const r = await proposal(mine.projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(10);
  });

  it("does not count a different measure's quantities", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await post(w.admin, "/api/v1/survey/entries", {
      survey_village_id: v, entry_date: day(2), teams_deployed: 1,
      values: { GOVT_LAND_EXTENT_AC: 40, VILLAGE_BOUNDARY_POINTS: 5000 },
    });
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(40);
  });

  it("covers every programme running against the one project", async () => {
    /*
     * Two programmes sharing a project is a real configuration — production
     * has one today — and it is usually somebody picking an existing project
     * when creating the second programme rather than a deliberate choice.
     *
     * Summing both is still the right answer: the BOQ belongs to the
     * contract, and everything delivered against that contract is billable
     * under it. Surprising enough to be worth writing down, because the
     * alternative reading silently drops one programme's work.
     */
    const first = await programme();
    const second = await post(w.admin, "/api/v1/survey/projects", {
      code: uniq("SHARE"), name: "Second programme, same contract",
      project_id: first.projectId, create_project: false,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    await record(await village(first.programmeId), day(3), 70);
    await record(await village(String(second.data.id)), day(3), 30);
    await link(first.projectId, {
      boq_item_id: first.boqItemId, measure_id: await measureId(),
    });

    const r = await proposal(first.projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(100);
  });

  it("raises no bill by itself", async () => {
    // A measurement book is certified by an engineer who walks the ground.
    // Software billing automatically from its own records would assert
    // something it is in no position to assert.
    const { programmeId, projectId, boqItemId } = await programme();
    await record(await village(programmeId), day(2), 100);
    await link(projectId, { boq_item_id: boqItemId, measure_id: await measureId() });
    await proposal(projectId);
    const bills = await w.pool.query(
      "SELECT count(*)::int AS n FROM ra_bills WHERE project_id = $1", [projectId]);
    expect(bills.rows[0].n).toBe(0);
  });

  it("is not readable by somebody without billing access", async () => {
    const { projectId } = await programme();
    const r = await get(w.role.EMPLOYEE, `/api/v1/projects/${projectId}/measured-proposal`);
    expect([401, 403, 404]).toContain(r.status);
  });
});
