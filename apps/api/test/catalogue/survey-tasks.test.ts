/**
 * Survey work on the task board (§59, extending §S4).
 *
 * The choice being tested is that the task's status is what a village's state
 * means. The thing to prove is that there is exactly one source: moving a
 * task must move the survey report, and the stage row's own columns must stay
 * out of it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STAGE_PIPELINE } from "@silverline/shared";
import { workDate, buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

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

describe("the task is the single source of the village's state", () => {
  it("starts every village not started", async () => {
    expect((await villageRow("ADAKULA")).state).toBe("NOT_STARTED");
  });

  it("moves the survey report when a stage task moves", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "GROUND_TRUTHING"), "IN_PROGRESS",
      { start: "2026-09-02T06:00:00Z" });

    const after = await villageRow("ADAKULA");
    expect(after.stages.GROUND_TRUTHING).toBe("IN_PROGRESS");
    expect(after.state).toBe("IN_PROGRESS");
  });

  it("puts the task's actual dates on the summary sheet", async () => {
    // The summary reports GT start and completion, and those are when the
    // work happened rather than when it was planned.
    //
    // The completion date is the board's to give: a database trigger stamps
    // actual_end_at at the moment a task moves to DONE. That is the whole
    // point of the choice — a completion date cannot be back-written through
    // the survey row, because the survey row does not hold it.
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "GROUND_TRUTHING"), "DONE");

    const summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_status).toBe("COMPLETED");
    // The start date was supplied before the trigger had anything to stamp,
    // so it survives.
    expect(row.gt_started_on).toBe("2026-09-02");
    expect(row.gt_completed_on).toBe(workDate());
  });

  it("lets a wrongly dated completion be corrected on the task, not the survey row", async () => {
    // Field work is reported late, so the stamped date is sometimes wrong.
    // The correction belongs where the fact lives.
    const adakula = await villageRow("ADAKULA");
    await w.pool.query("UPDATE tasks SET actual_end_at = $2 WHERE id = $1",
      [await stageTaskId(adakula.id, "GROUND_TRUTHING"), "2026-09-11T14:00:00Z"]);

    const summary = await get(w.admin, `/api/v1/survey/projects/${programmeId}/summary`);
    const row = summary.data.find((x: any) => x.village === "ADAKULA");
    expect(row.gt_completed_on).toBe("2026-09-11");
  });

  it("ignores the stage row's own columns once a task governs it", async () => {
    // The whole reason for the choice: one fact, one home. A stale value
    // written directly must not win.
    const adakula = await villageRow("ADAKULA");
    await w.pool.query(
      `UPDATE survey_village_stages vs SET state = 'NOT_STARTED', completed_on = NULL
       FROM survey_stages s
       WHERE s.id = vs.stage_id AND vs.survey_village_id = $1 AND s.code = 'GROUND_TRUTHING'`,
      [adakula.id]);

    const after = await villageRow("ADAKULA");
    expect(after.stages.GROUND_TRUTHING).toBe("COMPLETED");
  });

  it("reads a stage under review as still in progress", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "VECTORIZATION"), "IN_REVIEW");
    expect((await villageRow("ADAKULA")).stages.VECTORIZATION).toBe("IN_PROGRESS");
  });

  it("reads a blocked stage as on hold", async () => {
    const adakula = await villageRow("ADAKULA");
    await setTaskStatus(await stageTaskId(adakula.id, "RECORDS_PREPARATION"), "BLOCKED");
    expect((await villageRow("ADAKULA")).stages.RECORDS_PREPARATION).toBe("ON_HOLD");
  });

  it("completes the village only when every stage task is done", async () => {
    const adakula = await villageRow("ADAKULA");
    for (const code of STAGE_PIPELINE.map(st => st.code)) {
      await setTaskStatus(await stageTaskId(adakula.id, code), "DONE",
        { end: "2026-09-12T10:00:00Z" });
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
