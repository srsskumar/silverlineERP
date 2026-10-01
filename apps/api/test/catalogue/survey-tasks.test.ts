/**
 * Survey work on the task board (§59, extending §S4).
 *
 * The board is generated from the programme and carries who and when-planned,
 * but since owner decision 2026-10-01 #7 (SG-D3) it does not carry state: the
 * stage row is what a village's state means, linked task or not. The thing to
 * prove is still that there is exactly one source -- now the row: moving a
 * task must not move the survey report.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAGE_PIPELINE } from "@silverline/shared";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let programmeId: string;
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

async function ver(table: string, id: string): Promise<Headers> {
  const r = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  return { "if-match": String(r.rows[0].version) };
}

/** Move a task straight in the database: the board's own API is S4's business. */
async function setTaskStatus(taskId: string, status: string, dates?: {
  start?: string; end?: string;
}) {
  await w.pool.query(
    `UPDATE tasks SET status = $2,
       actual_start_at = COALESCE($3::timestamptz, actual_start_at),
       actual_end_at = COALESCE($4::timestamptz, actual_end_at)
     WHERE id = $1`,
    [taskId, status, dates?.start ?? null, dates?.end ?? null]);
}

async function villageRow(name: string) {
  const r = await get(w.admin, `/api/v1/survey/projects/${programmeId}/villages`);
  return r.data.find((v: any) => v.village_name === name);
}

async function stageTaskId(surveyVillageId: string, stageCode: string): Promise<string> {
  const r = await w.pool.query(
    `SELECT vs.task_id FROM survey_village_stages vs
     JOIN survey_stages s ON s.id = vs.stage_id
     WHERE vs.survey_village_id = $1 AND s.code = $2`, [surveyVillageId, stageCode]);
  return String(r.rows[0].task_id);
}

beforeAll(async () => {
  w = await buildWorld();

  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'D') RETURNING id`,
    [w.orgId, uniq("D")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'mandal',$2,'KOYYURU',$3) RETURNING id`,
    [w.orgId, uniq("M"), district])).rows[0].id);

  /*
   * Deliberately unpaired.
   *
   * A programme now comes with its project, which is the point of the
   * pairing — so these tests, which are about what happens *before* a
   * project exists and about linking one by hand afterwards, have to opt
   * out to reach that state at all.
   */
  const p = await post(w.admin, "/api/v1/survey/projects",
    { code: uniq("SP"), name: "Task linked programme", create_project: false });
  programmeId = String(p.data.id);

  for (const name of ["ADAKULA", "Annavaram"]) {
    const v = String((await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id) VALUES($1,'village',$2,$3,$4) RETURNING id`,
      [w.orgId, uniq("V"), name, mandalId])).rows[0].id);
    await post(w.admin, `/api/v1/survey/projects/${programmeId}/villages`,
      { village_id: v, total_extent_ac: 100 });
  }
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("linking the programme to a project", () => {
  it("refuses to generate tasks before the programme has a project", async () => {
    // A task belongs to a project; there is nowhere to put one otherwise.
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: true });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PROJECT_NOT_LINKED");
  });

  it("links the programme to an ordinary project", async () => {
    const r = await patch(
      { ...w.admin, ...(await ver("survey_projects", programmeId)) },
      `/api/v1/survey/projects/${programmeId}`,
      { project_id: w.activeProject });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.project_id).toBe(w.activeProject);
  });
});

describe("generating the board", () => {
  it("previews the row count before writing anything", async () => {
    // A full district is thousands of villages and five times as many rows
    // once the stages are counted.
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.village_tasks).toBe(2);
    // Two villages, one subtask per stage each. Derived rather than a fixed
    // number, so adding a stage to the pipeline does not break the test that
    // is meant to be about previewing.
    expect(r.data.stage_tasks).toBe(2 * STAGE_PIPELINE.length);

    const tasks = await w.pool.query(
      "SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND title LIKE 'Survey %'",
      [w.activeProject]);
    expect(tasks.rows[0].n).toBe(0);
  });

  it("creates one task per village and one subtask per stage", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: false });
    expect(r.data.village_tasks).toBe(2);
    expect(r.data.stage_tasks).toBe(2 * STAGE_PIPELINE.length);

    const adakula = await villageRow("ADAKULA");
    expect(adakula.task_id).toBeTruthy();

    const subtasks = await w.pool.query(
      "SELECT count(*)::int AS n FROM tasks WHERE parent_task_id = $1", [adakula.task_id]);
    expect(subtasks.rows[0].n).toBe(STAGE_PIPELINE.length);
  });

  it("names the task by where the work is", async () => {
    const t = await w.pool.query(
      "SELECT title FROM tasks WHERE id = $1", [(await villageRow("ADAKULA")).task_id]);
    expect(t.rows[0].title).toBe("Survey ADAKULA, KOYYURU");
  });

  it("leaves villages already on the board alone rather than making a second card", async () => {
    const again = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: false });
    expect(again.data.village_tasks).toBe(0);
    expect(again.data.already_linked).toBe(2);
  });
});

/**
 * Set a stage through the survey API, asserting that it took.
 *
 * Since owner decision 2026-10-01 #7 (SG-D3) this is the only thing that
 * moves a stage: the row governs, linked task or not.
 */
async function setStage(surveyVillageId: string, body: Record<string, unknown>) {
  const r = await post(w.admin, `/api/v1/survey/villages/${surveyVillageId}/stage`, body);
  expect(r.status, `${String(body.stage_code)}: ${JSON.stringify(r.body)}`).toBe(200);
}

describe("the stage row is the single source of the village's state (owner decision 2026-10-01 #7)", () => {
  /*
   * This block used to prove the opposite: that the linked task governed and
   * the stage row's own columns were ignored. The owner reversed that (SG-D3)
   * because the dashboard always read the row and the internal screens read
   * the task, and the two disagreed (SG-009). Each test below now proves the
   * row governs and the board is informational.
   */
  it("starts every village not started", async () => {
    expect((await villageRow("ADAKULA")).state).toBe("NOT_STARTED");
  });

  it("does not move the survey report when a stage task moves, only when the stage does", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "GROUND_TRUTHING"), "IN_PROGRESS",
      { start: "2026-09-02T06:00:00Z" });

    // The card moved; the stage did not.
    const moved = await villageRow("ADAKULA");
    expect(moved.stages.GROUND_TRUTHING).toBe("NOT_STARTED");
    expect(moved.state).toBe("NOT_STARTED");

    // Starting ground truthing through the survey API is what moves it.
    await setStage(adakula.id, {
      stage_code: "GROUND_TRUTHING", state: "IN_PROGRESS", started_on: "2026-09-02",
      gt_govt_staff_allocated: 2, gt_crew_allocated: 3,
    });
    const started = await villageRow("ADAKULA");
    expect(started.stages.GROUND_TRUTHING).toBe("IN_PROGRESS");
    expect(started.state).toBe("IN_PROGRESS");
  });

  it("puts the stage row's dates on the summary sheet, not the task's", async () => {
    // The task moving to DONE stamps actual_end_at (a database trigger). That
    // date is no longer the summary's: until the stage itself is completed,
    // the sheet says ground truthing is still in progress.
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "GROUND_TRUTHING"), "DONE");

    let summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    let row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_status).toBe("IN_PROGRESS");
    expect(row.gt_started_on).toBe("2026-09-02");
    expect(row.gt_completed_on).toBeNull();

    await setStage(adakula.id, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-09-11",
    });
    summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_status).toBe("COMPLETED");
    // The start date given when the stage began survives the completion.
    expect(row.gt_started_on).toBe("2026-09-02");
    expect(row.gt_completed_on).toBe("2026-09-11");
  });

  it("corrects a wrongly dated completion on the survey row, not the task", async () => {
    // Field work is reported late, so a recorded date is sometimes wrong.
    // Editing the task's end date changes nothing; the stage row holds it.
    const adakula = await villageRow("ADAKULA");
    await w.pool.query("UPDATE tasks SET actual_end_at = $2 WHERE id = $1",
      [await stageTaskId(adakula.id, "GROUND_TRUTHING"), "2026-09-20T14:00:00Z"]);

    let summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    let row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_completed_on).toBe("2026-09-11");

    await setStage(adakula.id, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED", completed_on: "2026-09-12",
    });
    summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_completed_on).toBe("2026-09-12");
  });

  it("ignores the linked task's status once the stage row says otherwise", async () => {
    // One fact, one home -- now the row. A card dragged back on the board
    // must not un-complete a stage the survey record says is done.
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "GROUND_TRUTHING"), "TO_DO");

    const after = await villageRow("ADAKULA");
    expect(after.stages.GROUND_TRUTHING).toBe("COMPLETED");
    expect(after.stage_dates.GROUND_TRUTHING.completed).toBe("2026-09-12");
  });

  it("does not move a stage when its task goes under review", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "VECTORIZATION"), "IN_REVIEW");
    expect((await villageRow("ADAKULA")).stages.VECTORIZATION).toBe("NOT_STARTED");
  });

  it("reads on hold from the stage row, not from a blocked task", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "FINAL_DELIVERABLES"), "BLOCKED");
    expect((await villageRow("ADAKULA")).stages.FINAL_DELIVERABLES).toBe("NOT_STARTED");

    // GT_QC's predecessor (ground truthing) is complete, so it may be held.
    await setStage(adakula.id, { stage_code: "GT_QC", state: "ON_HOLD" });
    expect((await villageRow("ADAKULA")).stages.GT_QC).toBe("ON_HOLD");
  });

  it("completes the village only when every stage row is complete, whatever the board says", async () => {
    const adakula = await villageRow("ADAKULA");
    const forward = STAGE_PIPELINE.filter(st => !st.offSequence).map(st => st.code);

    // Every card on the board done: the village is still not complete.
    for (const code of forward) {
      await setTaskStatus(await stageTaskId(adakula.id, code), "DONE",
        { end: "2026-09-12T10:00:00Z" });
    }
    expect((await villageRow("ADAKULA")).state).toBe("IN_PROGRESS");

    // Every stage completed through the survey API, in pipeline order.
    for (const code of forward) {
      await setStage(adakula.id, {
        stage_code: code, state: "COMPLETED", completed_on: "2026-09-12",
      });
    }
    const after = await villageRow("ADAKULA");
    expect(after.state).toBe("COMPLETED");

    const progress = await get(w.admin,
      `/api/v1/survey/projects/${programmeId}/progress?level=mandal`);
    const row = progress.data.rows.find((r: any) => r.name === "KOYYURU");
    expect(row.completed).toBe(1);
  });
});

describe("assignment", () => {
  it("carries the assignee's employee name onto the village", async () => {
    // The entry form records a team count; the task records who. That is the
    // gap the link closes.
    const adakula = await villageRow("ADAKULA");
    await w.pool.query("UPDATE tasks SET assignee_id = $2 WHERE id = $1",
      [adakula.task_id, w.roleUserId.TEAM_LEAD]);

    const after = await villageRow("ADAKULA");
    expect(after.assignee_id).toBe(w.roleUserId.TEAM_LEAD);
    expect(after.assignee_name).toBeTruthy();
  });

  it("carries the planned dates, which a village has nowhere else", async () => {
    const adakula = await villageRow("ADAKULA");
    await w.pool.query(
      "UPDATE tasks SET planned_start_date = $2, planned_end_date = $3 WHERE id = $1",
      [adakula.task_id, "2026-10-01", "2026-10-20"]);
    const after = await villageRow("ADAKULA");
    expect(after.planned_start_date).toBe("2026-10-01");
    expect(after.planned_end_date).toBe("2026-10-20");
  });
});

describe("controls", () => {
  it("survives its task being deleted, keeping the survey record", async () => {
    // The work happened whether or not anybody still wants the card.
    const annavaram = await villageRow("Annavaram");
    await w.pool.query("DELETE FROM tasks WHERE id = $1", [annavaram.task_id]);

    const after = await villageRow("Annavaram");
    expect(after).toBeTruthy();
    expect(after.task_id).toBeNull();
  });

  it("falls back to the stage row's own columns once the task is gone", async () => {
    const annavaram = await villageRow("Annavaram");
    await post(w.admin, `/api/v1/survey/villages/${annavaram.id}/stage`, {
      stage_code: "GROUND_TRUTHING", state: "COMPLETED",
      started_on: "2026-08-01", completed_on: "2026-08-15",
    });
    const after = await villageRow("Annavaram");
    expect(after.stages.GROUND_TRUTHING).toBe("COMPLETED");
    expect(after.stage_dates.GROUND_TRUTHING.completed).toBe("2026-08-15");
  });

  it("is refused to a crew that may record progress but not shape the work", async () => {
    const r = await post(w.role.TEAM_LEAD,
      `/api/v1/survey/projects/${programmeId}/generate-tasks`, { dry_run: true });
    expect(r.status).toBe(403);
  });
});

describe("generating a board for a real programme", () => {
  /*
   * A task, an update, then a subtask and a stage link for each of eight
   * stages came to eighteen round trips per village. On 1,182 villages that
   * is 21,276 trips to a database in another data centre, and the request
   * died on a gateway timeout at five minutes — after doing all the work.
   *
   * These pin the two things that fixed it: a preview that counts instead of
   * writing, and a write that is a handful of statements rather than a loop.
   */
  it("previews without writing anything at all", async () => {
    const before = await w.pool.query("SELECT count(*)::int AS n FROM tasks");
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: true, include_stages: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.village_tasks).toBeGreaterThan(0);
    // Six stages plus rework, since §086 (was five plus rework).
    expect(r.data.stage_tasks).toBe(r.data.village_tasks * 7);

    const after = await w.pool.query("SELECT count(*)::int AS n FROM tasks");
    expect(after.rows[0].n, "a preview writes nothing").toBe(before.rows[0].n);
  });

  it("writes every village and every stage, correctly parented", async () => {
    const r = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: false, include_stages: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Six stages plus rework, since §086 (was five plus rework).
    expect(r.data.stage_tasks).toBe(r.data.village_tasks * 7);

    // Every village carries its task, and every subtask hangs off the right
    // parent — the set-based insert relies on ordering, so this is the
    // property most worth pinning.
    const villages = await w.pool.query(
      `SELECT sv.id, sv.task_id FROM survey_villages sv WHERE sv.survey_project_id = $1`,
      [programmeId]);
    for (const v of villages.rows) expect(v.task_id, "village has a task").toBeTruthy();

    const mismatched = await w.pool.query(
      `SELECT count(*)::int AS n
         FROM survey_village_stages vs
         JOIN tasks sub ON sub.id = vs.task_id
         JOIN survey_villages sv ON sv.id = vs.survey_village_id
        WHERE sv.survey_project_id = $1
          AND (sub.parent_task_id IS DISTINCT FROM sv.task_id
               OR sub.village_id IS DISTINCT FROM sv.village_id)`,
      [programmeId]);
    expect(mismatched.rows[0].n, "every subtask under its own village").toBe(0);
  });

  it("leaves villages already on the board alone", async () => {
    // Generating twice should not make a second card for the same village.
    const again = await post(w.admin, `/api/v1/survey/projects/${programmeId}/generate-tasks`,
      { dry_run: false, include_stages: true });
    expect(again.data.village_tasks).toBe(0);
    expect(again.data.already_linked).toBeGreaterThan(0);
  });
});
