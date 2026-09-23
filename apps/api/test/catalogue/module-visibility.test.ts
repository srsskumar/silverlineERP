/**
 * Which screens a role sees, on top of what its permissions already allow
 * (owner request, 2026-09-24: "let admin/superadmin decide what to be
 * visible for field employees based on their role").
 *
 * The role-visibility table (065) already answers "how much of the
 * organisation's data does this role see" -- a different, already-shipped
 * question. This is "which of the app's screens does this role see at all",
 * and it must never become a second, accidental way to answer the first
 * one: hiding a module is a UI convenience, and the suite's job is to prove
 * that holds even when it would be easiest to let it slip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorld, createUser, idem, uniq, PASSWORD,
  type CatalogueWorld, type Headers,
} from "./fixture.js";
import { MODULE_CATALOG } from "@silverline/shared";

let w: CatalogueWorld;

async function call(method: "GET" | "PUT" | "POST", h: Headers, url: string, payload?: unknown) {
  const res = await w.app.inject({
    method, url, headers: { ...h, ...(method === "GET" ? {} : idem()) },
    ...(payload === undefined ? {} : { payload }),
  });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, data: body?.data ?? body };
}

const getMatrix = (h = w.admin) => call("GET", h, "/api/v1/admin/module-visibility");
const setModule = (
  role_code: string, module_code: string, visible: boolean | null, h = w.admin,
) => call("PUT", h, "/api/v1/admin/module-visibility", { role_code, module_code, visible });

/** A fresh session, so /auth/me and every route see the settings as they now stand. */
async function signIn(username: string) {
  const res = await w.app.inject({
    method: "POST", url: "/api/v1/auth/login",
    headers: { ...idem() }, payload: { username, password: PASSWORD },
  });
  const body = res.json();
  const token = (body.data ?? body)?.access_token ?? (body.data ?? body)?.tokens?.access_token;
  expect(token, `sign-in for ${username}: ${JSON.stringify(body).slice(0, 200)}`).toBeTruthy();
  return { authorization: `Bearer ${token}` } as Headers;
}

const usernameOf = async (userId: string) =>
  String((await w.pool.query("SELECT username FROM users WHERE id = $1", [userId])).rows[0].username);

beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w?.app.close(); await w?.pool.end(); });

describe("the catalog", () => {
  it("lists every module the shared catalog defines, for every role in the org", async () => {
    const r = await getMatrix();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.data.modules).toHaveLength(MODULE_CATALOG.length);
    expect(r.data.cells).toHaveLength(r.data.roles.length * MODULE_CATALOG.length);
  });

  it("is not something anybody can read or change without admin.configure", async () => {
    expect((await getMatrix(w.role.EMPLOYEE)).status).toBeGreaterThanOrEqual(401);
    expect((await setModule("EMPLOYEE", "my-work", false, w.role.EMPLOYEE)).status)
      .toBeGreaterThanOrEqual(401);
  });
});

describe("resolving a cell with no override", () => {
  it("defaults to true when the role's real grants include the module's permission", async () => {
    // EMPLOYEE holds task.read (S4), which is what "my-work" is named after.
    const r = await getMatrix();
    const cell = r.data.cells.find((c: any) => c.role_code === "EMPLOYEE" && c.module_code === "my-work");
    expect(cell).toMatchObject({ visible: true, default_visible: true, source: "default" });
  });

  it("defaults to false when the role's real grants do not include it", async () => {
    // EMPLOYEE holds no payroll permission at all.
    const r = await getMatrix();
    const cell = r.data.cells.find((c: any) => c.role_code === "EMPLOYEE" && c.module_code === "payroll");
    expect(cell).toMatchObject({ visible: false, default_visible: false, source: "default" });
  });

  it("defaults the one permission-less module (security) to visible for every role", async () => {
    const r = await getMatrix();
    const security = r.data.cells.filter((c: any) => c.module_code === "security");
    expect(security.length).toBeGreaterThan(0);
    for (const c of security) expect(c).toMatchObject({ visible: true, source: "default" });
  });
});

describe("setting an override", () => {
  afterAll(async () => { await setModule("EMPLOYEE", "my-work", null); });

  it("changes the resolved cell without changing what the default would be", async () => {
    expect((await setModule("EMPLOYEE", "my-work", false)).status).toBe(200);
    const r = await getMatrix();
    const cell = r.data.cells.find((c: any) => c.role_code === "EMPLOYEE" && c.module_code === "my-work");
    expect(cell).toMatchObject({ visible: false, default_visible: true, source: "override" });
  });

  it("null clears the override and reverts to the computed default", async () => {
    expect((await setModule("EMPLOYEE", "my-work", null)).status).toBe(200);
    const r = await getMatrix();
    const cell = r.data.cells.find((c: any) => c.role_code === "EMPLOYEE" && c.module_code === "my-work");
    expect(cell).toMatchObject({ visible: true, default_visible: true, source: "default" });
  });

  it("refuses an unknown role or module", async () => {
    expect((await setModule("NOT_A_ROLE", "my-work", false)).status).toBe(404);
    expect((await setModule("EMPLOYEE", "not-a-module", false)).status).toBe(404);
  });

  it("refuses to hide a super administrator's module", async () => {
    // The role that puts every other visibility rule right when it is set
    // wrong cannot itself be hidden from -- the same reason its scope can't
    // be narrowed (role-visibility, migration 065).
    const r = await setModule("SUPER_ADMIN", "admin", false);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("every screen");
  });

  it("still allows showing or clearing a super administrator's module", async () => {
    // Only narrowing (hiding) is refused -- an explicit "show" or a "revert
    // to default" never takes anything away from the floor role.
    expect((await setModule("SUPER_ADMIN", "admin", true)).status).toBe(200);
    expect((await setModule("SUPER_ADMIN", "admin", null)).status).toBe(200);
  });
});

describe("GET /api/v1/auth/me exposes the caller's own resolved modules", () => {
  it("merges across every role the user holds -- visible if any of them shows it", async () => {
    const username = `cat_combo_${uniq()}`;
    const comboId = await createUser(w.pool, w.orgId, { username, roles: ["EMPLOYEE", "TEAM_LEAD"] });
    try {
      // Neither EMPLOYEE nor TEAM_LEAD holds audit.read by default, so
      // "audit" starts hidden for both.
      const before = await w.app.inject({
        method: "GET", url: "/api/v1/auth/me", headers: await signIn(username),
      });
      expect(before.json().modules.audit).toBe(false);

      // An override on just one of the two roles this account holds is
      // enough to show it -- the merge is an OR, not an AND.
      expect((await setModule("EMPLOYEE", "audit", true)).status).toBe(200);
      const after = await w.app.inject({
        method: "GET", url: "/api/v1/auth/me", headers: await signIn(username),
      });
      expect(after.json().modules.audit).toBe(true);
    } finally {
      await setModule("EMPLOYEE", "audit", null);
      await w.pool.query("DELETE FROM user_roles WHERE user_id = $1", [comboId]);
      await w.pool.query("DELETE FROM users WHERE id = $1", [comboId]);
    }
  });

  it("resolves every module the shared catalog defines", async () => {
    const h = await signIn(await usernameOf(w.roleUserId.EMPLOYEE));
    const res = await w.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: h });
    const modules = res.json().modules as Record<string, boolean>;
    for (const m of MODULE_CATALOG) expect(typeof modules[m.code], m.code).toBe("boolean");
  });
});

describe("the invariant: visibility never gates the API", () => {
  afterAll(async () => { await setModule("EMPLOYEE", "projects", null); });

  it("still lets a hidden module's route answer normally, if the role holds the permission", async () => {
    // EMPLOYEE holds project.read, which "projects" is named after.
    const employeeHeaders = await signIn(await usernameOf(w.roleUserId.EMPLOYEE));
    const before = await call("GET", employeeHeaders, "/api/v1/projects?limit=5");
    expect(before.status).toBe(200);

    // Hide the module -- a purely cosmetic change, from EMPLOYEE's point of view.
    expect((await setModule("EMPLOYEE", "projects", false)).status).toBe(200);

    // /auth/me now says the module is hidden ...
    const me = await w.app.inject({
      method: "GET", url: "/api/v1/auth/me", headers: await signIn(await usernameOf(w.roleUserId.EMPLOYEE)),
    });
    expect(me.json().modules.projects).toBe(false);

    // ... but the route this "hidden" screen calls is untouched: the same
    // permission check as before, answering the same way as before.
    const after = await call("GET", employeeHeaders, "/api/v1/projects?limit=5");
    expect(after.status).toBe(200);
    expect(after.data.map((p: any) => p.id)).toEqual(before.data.map((p: any) => p.id));
  });
});
