/**
 * More than one person on a task (§note 13).
 *
 * The owner stays the owner — the person the task is on, who answers for it —
 * and everybody else working it is a collaborator. That is also what people
 * mean when they say a task has several assignees: somebody is still
 * responsible for it.
 *
 * Being a collaborator has to mean being able to work the task, or it means
 * nothing at all, so that is most of what is tested here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, uniq, type CatalogueWorld, type Headers } from "./fixture.js";

let w: CatalogueWorld;
let projectId = "";

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

async function task(over: Record<string, unknown> = {}) {
  const r = await send("POST", w.admin, "/api/v1/tasks", {
    project_id: projectId, title: `Shared ${uniq("T")}`, ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id ? r.body : r.data;
}

const detail = (id: string, h: Headers = w.admin) => send("GET", h, `/api/v1/tasks/${id}`);
const addMate = (id: string, userId: string, h: Headers = w.admin) =>
  send("POST", h, `/api/v1/tasks/${id}/collaborators`, { user_id: userId });
const dropMate = (id: string, userId: string, h: Headers = w.admin) =>
  send("DELETE", h, `/api/v1/tasks/${id}/collaborators/${userId}`);

beforeAll(async () => {
  w = await buildWorld();
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  projectId = String((await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status)
     VALUES($1,$2,$3,'Collaboration project','ACTIVE') RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ")])).rows[0].id);
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("who is on a task", () => {
  it("lists everybody helping, by name rather than by id", async () => {
    // A list of UUIDs is not an answer to "who is on this".
    const t = await task();
    const r = await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const d = await detail(String(t.id));
    expect(d.body.collaborators).toHaveLength(1);
    expect(d.body.collaborators[0].name).toBeTruthy();
    expect(d.body.collaborators[0].user_id).toBe(w.roleUserId.EMPLOYEE);
  });

  it("keeps the owner on the task row, where everything else reads it", async () => {
    // The board, the filters, my-work and the workload report all read
    // assignee_id, and it still means the one person who answers for this.
    const t = await task({ assignee_id: w.roleUserId.TEAM_LEAD });
    await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    const d = await detail(String(t.id));
    expect(d.body.assignee_id).toBe(w.roleUserId.TEAM_LEAD);
    expect(d.body.collaborators.map((c: any) => c.user_id)).not.toContain(w.roleUserId.TEAM_LEAD);
  });

  it("refuses to add the person who already owns it", async () => {
    const t = await task({ assignee_id: w.roleUserId.TEAM_LEAD });
    const r = await addMate(String(t.id), w.roleUserId.TEAM_LEAD);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("already owns");
  });

  it("treats adding somebody twice as pressing the button twice", async () => {
    const t = await task();
    expect((await addMate(String(t.id), w.roleUserId.EMPLOYEE)).status).toBe(201);
    const again = await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    expect(again.status).toBe(200);
    expect(again.data.already).toBe(true);
    const d = await detail(String(t.id));
    expect(d.body.collaborators).toHaveLength(1);
  });

  it("refuses an account that is not active here", async () => {
    const t = await task();
    const r = await addMate(String(t.id), "00000000-0000-4000-8000-000000000000");
    expect(r.status).toBe(422);
  });

  it("removes somebody, and says so plainly when they were never on it", async () => {
    const t = await task();
    await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    expect((await dropMate(String(t.id), w.roleUserId.EMPLOYEE)).status).toBe(200);
    const again = await dropMate(String(t.id), w.roleUserId.EMPLOYEE);
    expect(again.status).toBe(404);
    expect(JSON.stringify(again.body)).toContain("not on this task");
  });

  it("is not something anybody can do", async () => {
    // Deciding who works what is one decision whichever end of it you are at.
    const t = await task();
    const r = await addMate(String(t.id), w.roleUserId.EMPLOYEE, w.role.EMPLOYEE);
    expect([401, 403]).toContain(r.status);
  });
});

describe("what being on a task lets you do", () => {
  it("lets a collaborator work the task", async () => {
    /*
     * The whole point of adding somebody is that they do some of it. Before
     * this, a person added to a task still could not touch it — which made
     * being added mean nothing at all.
     */
    const t = await task({ assignee_id: w.roleUserId.TEAM_LEAD });
    await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    const version = Number((await w.pool.query(
      "SELECT version FROM tasks WHERE id = $1", [t.id])).rows[0].version);

    const r = await send("PATCH", { ...w.role.EMPLOYEE, "if-match": String(version) },
      `/api/v1/tasks/${t.id}`, { description: "Picked up the vectorisation half" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("still refuses somebody who is on neither end of it", async () => {
    const t = await task({ assignee_id: w.roleUserId.TEAM_LEAD });
    const version = Number((await w.pool.query(
      "SELECT version FROM tasks WHERE id = $1", [t.id])).rows[0].version);
    const r = await send("PATCH", { ...w.role.EMPLOYEE, "if-match": String(version) },
      `/api/v1/tasks/${t.id}`, { description: "Not mine to touch" });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain("belongs to somebody else");
  });

  it("stops letting them once they are taken off it", async () => {
    const t = await task({ assignee_id: w.roleUserId.TEAM_LEAD });
    await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    await dropMate(String(t.id), w.roleUserId.EMPLOYEE);
    const version = Number((await w.pool.query(
      "SELECT version FROM tasks WHERE id = $1", [t.id])).rows[0].version);
    const r = await send("PATCH", { ...w.role.EMPLOYEE, "if-match": String(version) },
      `/api/v1/tasks/${t.id}`, { description: "No longer mine" });
    expect(r.status).toBe(403);
  });

  it("goes away with the task", async () => {
    // A collaborator row pointing at a deleted task is a row nobody can read
    // and nobody can clear.
    const t = await task();
    await addMate(String(t.id), w.roleUserId.EMPLOYEE);
    await w.pool.query("DELETE FROM tasks WHERE id = $1", [t.id]);
    const left = await w.pool.query(
      "SELECT count(*)::int AS n FROM task_collaborators WHERE task_id = $1", [t.id]);
    expect(left.rows[0].n).toBe(0);
  });
});
