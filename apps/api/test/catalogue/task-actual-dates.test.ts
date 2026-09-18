/**
 * When work actually started and finished (§note 14).
 *
 * Every task already carried a planned pair of dates and, invisibly, an
 * actual pair stamped by the status trigger. Nothing read the actual pair, so
 * the question a programme manager asks every month — what did we finish in
 * August — was answered off planned dates, which is a plan, not a record.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let projectId = "";

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

async function task(title: string) {
  const r = await send("POST", w.admin, "/api/v1/tasks", { project_id: projectId, title });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String((r.body.id ? r.body : r.data).id);
}

async function ver(id: string): Promise<Headers> {
  const r = await w.pool.query("SELECT version FROM tasks WHERE id = $1", [id]);
  return { "if-match": String(r.rows[0].version) };
}

const move = async (id: string, status: string) =>
  send("PATCH", { ...w.admin, ...(await ver(id)) },
    `/api/v1/tasks/${id}/status`, { status });

/** Backlog to done the long way round, since the workflow has a review step. */
async function finish(id: string) {
  await move(id, "IN_PROGRESS");
  await move(id, "IN_REVIEW");
  const r = await move(id, "DONE");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Backdates the stamp the trigger wrote, standing in for older work. */
async function stampedAt(id: string, column: "actual_start_at" | "actual_end_at", day: string) {
  await w.pool.query(
    `UPDATE tasks SET ${column} = ($2 || ' 10:00 Asia/Kolkata')::timestamptz WHERE id = $1`,
    [id, day]);
}

beforeAll(async () => {
  w = await buildWorld();
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  projectId = String((await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status)
     VALUES($1,$2,$3,'Actual dates project','ACTIVE') RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ")])).rows[0].id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("what the task reports about itself", () => {
  it("has no actual dates before anybody starts it", async () => {
    const id = await task("Untouched");
    const r = await send("GET", w.admin, `/api/v1/tasks/${id}`);
    expect(r.data.actual_start_on).toBeNull();
    expect(r.data.actual_end_on).toBeNull();
  });

  it("stamps the start the first time the task leaves the backlog", async () => {
    const id = await task("Started");
    await move(id, "IN_PROGRESS");
    const r = await send("GET", w.admin, `/api/v1/tasks/${id}`);
    expect(r.data.actual_start_on).toBeTruthy();
    expect(r.data.actual_end_on).toBeNull();
  });

  it("stamps the end when it is done", async () => {
    const id = await task("Finished");
    await finish(id);
    const r = await send("GET", w.admin, `/api/v1/tasks/${id}`);
    expect(r.data.actual_end_on).toBeTruthy();
  });

  it("reports the day in Indian time, not UTC", async () => {
    // A crew closing a task at 01:00 in Vijayawada closed it that day. UTC
    // still thinks it is the previous evening, and the month's figures move.
    const id = await task("Just after midnight");
    await finish(id);
    await w.pool.query(
      `UPDATE tasks SET actual_end_at = '2026-08-31 20:30:00+00' WHERE id = $1`, [id]);
    const r = await send("GET", w.admin, `/api/v1/tasks/${id}`);
    expect(r.data.actual_end_on).toBe("2026-09-01");
  });
});

describe("pulling records by when the work happened", () => {
  let older = "", newer = "";

  beforeAll(async () => {
    older = await task("Closed in August");
    await finish(older);
    await stampedAt(older, "actual_start_at", "2026-08-03");
    await stampedAt(older, "actual_end_at", "2026-08-20");

    newer = await task("Closed in September");
    await finish(newer);
    await stampedAt(newer, "actual_start_at", "2026-09-02");
    await stampedAt(newer, "actual_end_at", "2026-09-15");
  });

  const list = (qs: string) =>
    send("GET", w.admin, `/api/v1/tasks?project_id=${projectId}&limit=100&${qs}`);

  it("finds what finished inside a window and nothing outside it", async () => {
    const r = await list("finished_from=2026-08-01&finished_to=2026-08-31");
    expect(r.status).toBe(200);
    const ids = r.data.map((t: any) => t.id);
    expect(ids).toContain(older);
    expect(ids).not.toContain(newer);
  });

  it("finds what started inside a window", async () => {
    const r = await list("started_from=2026-09-01&started_to=2026-09-30");
    const ids = r.data.map((t: any) => t.id);
    expect(ids).toContain(newer);
    expect(ids).not.toContain(older);
  });

  it("includes the boundary days themselves", async () => {
    // A window that excluded its own end date would silently drop the last
    // day of every month anybody reported on.
    const r = await list("finished_from=2026-08-20&finished_to=2026-08-20");
    expect(r.data.map((t: any) => t.id)).toContain(older);
  });

  it("leaves out work that was never finished", async () => {
    const open = await task("Still running");
    await move(open, "IN_PROGRESS");
    const r = await list("finished_from=2000-01-01&finished_to=2100-01-01");
    expect(r.data.map((t: any) => t.id)).not.toContain(open);
  });

  it("combines with the other filters rather than replacing them", async () => {
    const r = await list("finished_from=2026-08-01&finished_to=2026-09-30&status=DONE");
    const ids = r.data.map((t: any) => t.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
  });

  it("refuses a date that is not a date", async () => {
    const r = await list("finished_from=last-August");
    expect(r.status).toBe(422);
  });
});
