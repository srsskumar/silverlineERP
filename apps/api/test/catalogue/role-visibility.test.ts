/**
 * Who sees the whole organisation, and who sees their own work (§note 17).
 *
 * The machinery to restrict somebody has always been there — user_roles
 * carries a scope and every list honours it. What was missing was a default:
 * a role row with no scope meant global, so the safe setting was the one an
 * administrator had to remember to apply, and mostly did not.
 *
 * Configurable per organisation, because the answer differs. A contractor
 * running one district wants its project managers to see everything; one
 * running six does not.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, idem, uniq, PASSWORD,
  type CatalogueWorld, type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let projectA = "";
let projectB = "";

async function call(method: "GET" | "PUT" | "POST", h: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method, url, headers: { ...h, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

const setVisibility = (code: string, scope: string, h = w.admin) =>
  call("PUT", h, `/api/v1/admin/role-visibility/${code}`, { default_scope: scope });

/** A fresh session, so the scopes are the ones the policy resolves now. */
async function signIn(username: string, password = PASSWORD) {
  const res = await w.app.inject({
    method: "POST", url: "/api/v1/auth/login",
    headers: { ...idem() }, payload: { username, password },
  });
  const body = res.json();
  const token = (body.data ?? body)?.access_token
    ?? (body.data ?? body)?.tokens?.access_token;
  expect(token, `sign-in for ${username}: ${JSON.stringify(body).slice(0, 200)}`).toBeTruthy();
  return { authorization: `Bearer ${token}` } as Headers;
}

beforeAll(async () => {
  w = await buildWorld();
  const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
  const mk = async (name: string) => String((await w.pool.query(
    `INSERT INTO projects(org_id, workspace_id, code, name, status)
     VALUES($1,$2,$3,$4,'ACTIVE') RETURNING id`,
    [w.orgId, ws.rows[0].id, uniq("PRJ"), name])).rows[0].id);
  projectA = await mk("Theirs");
  projectB = await mk("Somebody else's");
}, 180_000);

afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the setting itself", () => {
  it("lists every role with what it currently sees", async () => {
    const r = await call("GET", w.admin, "/api/v1/admin/role-visibility");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const employee = r.data.find((x: any) => x.code === "EMPLOYEE");
    expect(employee.default_scope).toBe("ASSIGNED");
    const auditor = r.data.find((x: any) => x.code === "AUDITOR");
    expect(auditor.default_scope).toBe("GLOBAL");
  });

  it("says how many accounts a change would touch", async () => {
    // Changing what a role sees is not a small decision, and the number of
    // people it lands on is the first thing anybody asks.
    const r = await call("GET", w.admin, "/api/v1/admin/role-visibility");
    const employee = r.data.find((x: any) => x.code === "EMPLOYEE");
    expect(typeof employee.accounts).toBe("number");
    expect(typeof employee.individually_scoped).toBe("number");
  });

  it("can be changed both ways", async () => {
    expect((await setVisibility("TEAM_LEAD", "GLOBAL")).status).toBe(200);
    expect((await setVisibility("TEAM_LEAD", "ASSIGNED")).status).toBe(200);
  });

  it("refuses to narrow a super administrator", async () => {
    // It is the role that puts the others right when a visibility rule is
    // set wrong, and a scoped one could lock the organisation out of its own
    // configuration.
    const r = await setVisibility("SUPER_ADMIN", "ASSIGNED");
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("whole organisation");
  });

  it("refuses a role nobody has and a scope nobody defined", async () => {
    expect((await setVisibility("NOT_A_ROLE", "ASSIGNED")).status).toBe(404);
    expect((await setVisibility("TEAM_LEAD", "SIDEWAYS")).status).toBe(422);
  });

  it("is not something anybody can change", async () => {
    const r = await setVisibility("TEAM_LEAD", "GLOBAL", w.role.EMPLOYEE);
    expect([401, 403]).toContain(r.status);
  });
});

describe("what a restricted role can actually see", () => {
  it("shows only the projects they have work on", async () => {
    await w.pool.query("UPDATE users SET employee_id = NULL WHERE id = $1",
      [w.roleUserId.TEAM_LEAD]);
    await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, assignee_id, created_by)
       VALUES($1,$2,'Theirs to do','TO_DO',$3,$4)`,
      [w.orgId, projectA, w.roleUserId.TEAM_LEAD, w.adminId]);
    await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, created_by)
       VALUES($1,$2,'Not theirs','TO_DO',$3)`, [w.orgId, projectB, w.adminId]);

    await setVisibility("TEAM_LEAD", "ASSIGNED");
    const h = await signIn(String((await w.pool.query(
      "SELECT username FROM users WHERE id = $1", [w.roleUserId.TEAM_LEAD])).rows[0].username));

    const r = await call("GET", h, "/api/v1/projects?limit=100");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = r.data.map((p: any) => String(p.id));
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);
  });

  it("shows the whole organisation again when the setting says so", async () => {
    // The point of making it configurable is that it can be put back.
    await setVisibility("TEAM_LEAD", "GLOBAL");
    const h = await signIn(String((await w.pool.query(
      "SELECT username FROM users WHERE id = $1", [w.roleUserId.TEAM_LEAD])).rows[0].username));
    const r = await call("GET", h, "/api/v1/projects?limit=100");
    const ids = r.data.map((p: any) => String(p.id));
    expect(ids).toContain(projectB);
  });

  it("counts a project they manage as theirs, before any task is on it", async () => {
    /*
     * Read as the assignee alone, a project manager restricted to their own
     * work would see the one task somebody happened to assign them and none
     * of the project they run — which is not a rule anybody meant.
     */
    const ws = await w.pool.query("SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1", [w.orgId]);
    const managed = String((await w.pool.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status, project_manager_id)
       VALUES($1,$2,$3,'Runs this one','ACTIVE',$4) RETURNING id`,
      [w.orgId, ws.rows[0].id, uniq("PRJ"), w.roleUserId.TEAM_LEAD])).rows[0].id);

    await setVisibility("TEAM_LEAD", "ASSIGNED");
    const h = await signIn(String((await w.pool.query(
      "SELECT username FROM users WHERE id = $1", [w.roleUserId.TEAM_LEAD])).rows[0].username));
    const r = await call("GET", h, "/api/v1/projects?limit=100");
    expect(r.data.map((p: any) => String(p.id))).toContain(managed);
  });

  it("counts a task they were put on to help with", async () => {
    const helping = String((await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, created_by)
       VALUES($1,$2,'Helping out','TO_DO',$3) RETURNING id`,
      [w.orgId, projectB, w.adminId])).rows[0].id);
    await w.pool.query(
      `INSERT INTO task_collaborators(org_id, task_id, user_id) VALUES($1,$2,$3)`,
      [w.orgId, helping, w.roleUserId.TEAM_LEAD]);

    const h = await signIn(String((await w.pool.query(
      "SELECT username FROM users WHERE id = $1", [w.roleUserId.TEAM_LEAD])).rows[0].username));
    const r = await call("GET", h, `/api/v1/tasks?limit=100`);
    expect(r.data.map((t: any) => String(t.id))).toContain(helping);
  });

  it("leaves an individually scoped account alone", async () => {
    // Somebody set that scope on purpose, and it is narrower than any
    // default — a default must never widen it.
    const before = await w.pool.query(
      "SELECT count(*)::int AS n FROM user_roles WHERE scope_type IS NOT NULL");
    await setVisibility("TEAM_LEAD", "GLOBAL");
    const after = await w.pool.query(
      "SELECT count(*)::int AS n FROM user_roles WHERE scope_type IS NOT NULL");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
