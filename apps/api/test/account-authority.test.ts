import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { VOLATILE_TABLES } from "./tables.js";
import { testDatabaseUrl } from "./database.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedDatabase } from "../src/database/seed.js";

/**
 * AUTH-1 -- who may administer whose account.
 *
 * users.manage used to be enough to set anybody's password, and the HR
 * manager role holds it: an HR manager could reset an administrator's
 * password and sign in as them. The rule now is the one view-as already
 * follows -- you may only change an account that can do nothing you cannot.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";
const PASSWORD = "Pass1234!";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let superAdminId = "";

async function createUser(prefix: string, roles: string[]): Promise<{ id: string; username: string }> {
  const username = `${prefix}_${randomUUID().slice(0, 8)}`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const id = (await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, username, hash],
  )).rows[0].id as string;
  for (const code of roles) {
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2",
      [id, code],
    );
  }
  return { id, username };
}

async function headersFor(username: string, password = PASSWORD) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
}

function patchUser(headers: Record<string, string>, id: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH", url: `/api/v1/admin/users/${id}`,
    headers: { ...headers, "idempotency-key": randomUUID() }, payload,
  });
}

async function passwordHash(id: string): Promise<string> {
  return (await pool.query("SELECT password_hash FROM users WHERE id = $1", [id])).rows[0].password_hash;
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({ databaseUrl: TEST_DB, jwtSecret: JWT_SECRET, loginRateLimitMax: 1000 });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${VOLATILE_TABLES}`);
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  superAdminId = seed.adminId;
});

describe("changing somebody else's account", () => {
  it("refuses an HR manager resetting an administrator's password", async () => {
    const hr = await createUser("hr", ["HR_MANAGER"]);
    const admin = await createUser("adm", ["ADMIN"]);
    const before = await passwordHash(admin.id);

    const res = await patchUser(await headersFor(hr.username), admin.id, {
      password: "hr-knows-this-one-now",
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(await passwordHash(admin.id)).toBe(before);
    // ...and the administrator can still sign in with their own.
    await headersFor(admin.username);
  });

  it("refuses an HR manager disabling an administrator or excusing their MFA", async () => {
    const hr = await headersFor((await createUser("hr", ["HR_MANAGER"])).username);
    const admin = await createUser("adm", ["ADMIN"]);
    expect((await patchUser(hr, admin.id, { auth_status: "DISABLED" })).statusCode).toBe(403);
    expect((await patchUser(hr, admin.id, { mfa_policy: "EXEMPT" })).statusCode).toBe(403);
    const row = (await pool.query("SELECT auth_status, mfa_policy FROM users WHERE id = $1", [admin.id])).rows[0];
    expect(row.auth_status).toBe("ACTIVE");
    expect(row.mfa_policy).not.toBe("EXEMPT");
  });

  it("refuses an administrator changing a super administrator", async () => {
    const admin = await headersFor((await createUser("adm", ["ADMIN"])).username);
    const before = await passwordHash(superAdminId);
    const res = await patchUser(admin, superAdminId, { password: "admin-knows-this-one" });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toMatch(/super administrator/);
    expect(await passwordHash(superAdminId)).toBe(before);
  });

  it("refuses an administrator replacing a super administrator's roles", async () => {
    const admin = await headersFor((await createUser("adm", ["ADMIN"])).username);
    const res = await app.inject({
      method: "PUT", url: `/api/v1/admin/users/${superAdminId}/roles`,
      headers: { ...admin, "idempotency-key": randomUUID() },
      payload: { roles: [] },
    });
    expect(res.statusCode, res.body).toBe(403);
    const held = await pool.query(
      "SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1",
      [superAdminId],
    );
    expect(held.rows.map((r) => r.code)).toContain("SUPER_ADMIN");
  });

  it("still lets an HR manager reset an account that holds no more than they do", async () => {
    const hr = await headersFor((await createUser("hr", ["HR_MANAGER"])).username);
    const peer = await createUser("hr2", ["HR_MANAGER"]);
    const res = await patchUser(hr, peer.id, { password: "a-fresh-password-2026" });
    expect(res.statusCode, res.body).toBe(200);
    await headersFor(peer.username, "a-fresh-password-2026");
  });

  it("still lets an administrator reset an employee and change their roles", async () => {
    const admin = await headersFor((await createUser("adm", ["ADMIN"])).username);
    const emp = await createUser("emp", ["EMPLOYEE"]);
    expect((await patchUser(admin, emp.id, { password: "a-fresh-password-2026" })).statusCode).toBe(200);
    const teamLead = (await pool.query("SELECT id FROM roles WHERE code = 'TEAM_LEAD'")).rows[0].id;
    const roles = await app.inject({
      method: "PUT", url: `/api/v1/admin/users/${emp.id}/roles`,
      headers: { ...admin, "idempotency-key": randomUUID() },
      payload: { roles: [{ role_id: teamLead }] },
    });
    expect(roles.statusCode, roles.body).toBe(200);
  });

  it("still lets a super administrator change an administrator", async () => {
    const root = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const admin = await createUser("adm", ["ADMIN"]);
    expect((await patchUser(root, admin.id, { password: "a-fresh-password-2026" })).statusCode).toBe(200);
  });
});
