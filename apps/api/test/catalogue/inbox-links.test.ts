/**
 * An alert you can act on (§note 14).
 *
 * The inbox used to print a bare UUID beside an instruction: "Your report is
 * ready — open Reports to download it", then 51ca94f6-…. That is an
 * instruction and a riddle. Production held seventy of them: ready reports,
 * paused schedules, and villages where crews were posted and nothing had ever
 * been recorded — every one of them a thing somebody was supposed to go and
 * deal with, and none of them a link.
 *
 * Resolved on the server, in the query that already has the row, because the
 * inbox was otherwise fetching each task one at a time just to find out which
 * project it belonged to.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let projectId = "";
let mandalId = "";

async function get(h: Headers, url: string) {
  const res = await w.app.inject({ method: "GET", url, headers: h });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

async function notify(entityType: string, entityId: string | null, type = "ALERT") {
  await w.pool.query(
    `INSERT INTO notifications(org_id, recipient_id, type, title, body, entity_type, entity_id)
     VALUES($1,$2,$3,'QA alert','Something needs attention',$4,$5)`,
    [w.orgId, w.adminId, type, entityType, entityId]);
}

const inbox = async () => (await get(w.admin, "/api/v1/notifications?limit=50")).data;
const findByEntity = (rows: any[], entityType: string) =>
  rows.find((r) => r.entity_type === entityType);

beforeAll(async () => {
  w = await buildWorld();
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  projectId = String((await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status)
     VALUES($1,$2,$3,'Inbox project','ACTIVE') RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ")])).rows[0].id);
  const district = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name) VALUES($1,'district',$2,'Inbox district')
     RETURNING id`, [w.orgId, uniq("ID")])).rows[0].id);
  mandalId = String((await w.pool.query(
    `INSERT INTO org_units(org_id,type,code,name,parent_id)
     VALUES($1,'mandal',$2,'Inbox mandal',$3) RETURNING id`,
    [w.orgId, uniq("IM"), district])).rows[0].id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("every notification knows where it leads", () => {
  it("sends a task alert to the task, on its own project", async () => {
    // The inbox used to fetch each task separately to learn this. The query
    // that reads the notification already knows it.
    const task = (await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, created_by)
       VALUES($1,$2,'Inbox task','TO_DO',$3) RETURNING id`,
      [w.orgId, projectId, w.adminId])).rows[0].id;
    await notify("task", String(task), "SLA_ALERT");

    const row = findByEntity(await inbox(), "task");
    expect(row.href).toBe(`/projects/${projectId}/tasks/${task}`);
  });

  it("sends a survey alert to the village it is about", async () => {
    // "Crew are assigned and no return has ever been filed" is only useful
    // if it takes you to the village to file one.
    const prog = (await w.pool.query(
      `INSERT INTO survey_projects(org_id, code, name, status)
       VALUES($1,$2,'Inbox programme','ACTIVE') RETURNING id`,
      [w.orgId, uniq("IP")])).rows[0].id;
    const unit = (await w.pool.query(
      `INSERT INTO org_units(org_id,type,code,name,parent_id)
       VALUES($1,'village',$2,'Inbox village',$3) RETURNING id`,
      [w.orgId, uniq("IV"), mandalId])).rows[0].id;
    const village = (await w.pool.query(
      `INSERT INTO survey_villages(org_id, survey_project_id, village_id, total_extent_ac)
       VALUES($1,$2,$3,50) RETURNING id`, [w.orgId, prog, unit])).rows[0].id;
    await notify("survey_village", String(village), "SURVEY_ALERT");

    const row = findByEntity(await inbox(), "survey_village");
    expect(row.href).toContain(`village=${village}`);
    expect(row.href).toContain(`project=${prog}`);
  });

  it("sends a ready report to the reports screen", async () => {
    await notify("report", "11111111-1111-4111-8111-111111111111", "REPORT_READY");
    expect(findByEntity(await inbox(), "report").href).toBe("/reports");
  });

  it("sends a paused schedule to the reports screen", async () => {
    await notify("report_schedule", "22222222-2222-4222-8222-222222222222", "REPORT_PAUSED");
    expect(findByEntity(await inbox(), "report_schedule").href).toBe("/reports");
  });

  it("sends a leave alert to the request", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await notify("leave", id, "LEAVE");
    expect(findByEntity(await inbox(), "leave").href).toBe(`/leave/${id}`);
  });
});

describe("what it refuses to pretend", () => {
  it("offers no link when the thing it refers to is gone", async () => {
    // A link to a deleted task is worse than no link: it promises somewhere
    // to go and lands on a page that cannot explain itself.
    await notify("task", "44444444-4444-4444-8444-444444444444", "SLA_ALERT");
    const rows = await inbox();
    const dead = rows.find((r: any) =>
      r.entity_id === "44444444-4444-4444-8444-444444444444");
    expect(dead.href).toBeNull();
  });

  it("offers no link for a type nobody has taught it", async () => {
    await notify("weather_balloon", "55555555-5555-4555-8555-555555555555");
    expect(findByEntity(await inbox(), "weather_balloon").href).toBeNull();
  });

  it("offers no link when there is no record to point at", async () => {
    await notify("task", null, "BROADCAST");
    const rows = await inbox();
    const broadcast = rows.find((r: any) => r.type === "BROADCAST");
    expect(broadcast.href).toBeNull();
  });
});

describe("the inbox still behaves as a list", () => {
  it("pages without the href breaking the cursor", async () => {
    // The columns are aliased now; an unqualified cursor comparison would
    // have made paging ambiguous rather than wrong, which is worse.
    const first = await get(w.admin, "/api/v1/notifications?limit=2");
    expect(first.status).toBe(200);
    if (first.body.next_cursor) {
      const second = await get(w.admin,
        `/api/v1/notifications?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
      expect(second.status).toBe(200);
      const firstIds = first.data.map((r: any) => r.id);
      expect(second.data.every((r: any) => !firstIds.includes(r.id))).toBe(true);
    }
  });

  it("still filters to unread only", async () => {
    const r = await get(w.admin, "/api/v1/notifications?limit=50&unread=true");
    expect(r.status).toBe(200);
    expect(r.data.every((n: any) => n.read_at === null)).toBe(true);
  });
});
