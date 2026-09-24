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
 * password and sign in as them. The rule now: a super administrator is
 * only another super administrator's to change, and an account holding a
 * sensitive permission (security, accounts, pay, personal data, money) the
 * caller lacks is out of their reach. Ordinary working permissions do not
 * count, so HR can still reset the staff who ask them to.
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

  it("refuses an HR manager resetting a payroll officer or a super administrator", async () => {
    const hr = await headersFor((await createUser("hr", ["HR_MANAGER"])).username);
    const payroll = await createUser("pay", ["PAYROLL_OFFICER"]);
    const before = await passwordHash(payroll.id);
    const res = await patchUser(hr, payroll.id, { password: "hr-knows-this-one-now" });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toMatch(/can do things you cannot/);
    expect(await passwordHash(payroll.id)).toBe(before);

    const root = await passwordHash(superAdminId);
    expect((await patchUser(hr, superAdminId, { password: "hr-knows-this-one-now" })).statusCode).toBe(403);
    expect(await passwordHash(superAdminId)).toBe(root);
  });

  it("lets an HR manager reset an employee, a team lead and a project manager", async () => {
    // The everyday case, and the reason HR is told about locked-out staff:
    // these accounts hold task permissions HR does not, none of them sensitive.
    const hr = await headersFor((await createUser("hr", ["HR_MANAGER"])).username);
    for (const role of ["EMPLOYEE", "TEAM_LEAD", "PROJECT_MANAGER"]) {
      const staff = await createUser(role.toLowerCase(), [role]);
      const res = await patchUser(hr, staff.id, { password: "a-fresh-password-2026", must_change_password: true });
      expect(res.statusCode, `${role}: ${res.body}`).toBe(200);
      const signIn = await app.inject({
        method: "POST", url: "/api/v1/auth/login",
        payload: { username: staff.username, password: "a-fresh-password-2026" },
      });
      expect(signIn.statusCode, role).toBe(200);
    }
  });

  it("applies the same rule to the roles a target already holds", async () => {
    // A custom administrator with admin.configure but no pay permissions can
    // take a team lead's roles away, and cannot strip a payroll officer of
    // theirs.
    const root = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const roleRes = await app.inject({
      method: "POST", url: "/api/v1/admin/roles",
      headers: { ...root, "idempotency-key": randomUUID() },
      payload: {
        code: `ROLEADMIN_${randomUUID().slice(0, 6).toUpperCase()}`, name: "Role administrator",
        permissions: ["auth.login", "admin.configure", "users.read", "task.read", "tasks.read", "project.read"],
      },
    });
    expect(roleRes.statusCode, roleRes.body).toBe(201);
    const roleAdmin = await createUser("radm", []);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [roleAdmin.id, roleRes.json().id]);
    const headers = await headersFor(roleAdmin.username);
    const put = (id: string, roles: Array<{ role_id: string }>) => app.inject({
      method: "PUT", url: `/api/v1/admin/users/${id}/roles`,
      headers: { ...headers, "idempotency-key": randomUUID() }, payload: { roles },
    });
    const payroll = await createUser("pay", ["PAYROLL_OFFICER"]);
    expect((await put(payroll.id, [])).statusCode).toBe(403);
    const lead = await createUser("tl", ["TEAM_LEAD"]);
    const ok = await put(lead.id, []);
    expect(ok.statusCode, ok.body).toBe(200);
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

  /*
   * A-011: PATCH /admin/users/:id revoked every session for the target user
   * on ANY successful call, unconditionally -- even a patch that only
   * touched `phone` or `must_change_password`. The web admin UI's own copy
   * ("Disabling an account signs it out ... Setting a password here signs
   * the account out ...") only promises sign-out for auth_status/password/
   * mfa_policy changes, so an admin correcting a coworker's phone number
   * would silently force-sign-out every device they were using, with no
   * warning anywhere. Every other side effect in this handler (e.g. closing
   * password-reset requests) is already correctly gated on which field
   * changed; the session revocation line was the one left unconditional.
   */
  it("does not revoke sessions for a patch that only touches phone/must_change_password", async () => {
    const admin = await headersFor((await createUser("adm", ["ADMIN"])).username);
    const target = await createUser("emp", ["EMPLOYEE"]);
    await headersFor(target.username); // creates an active session row

    const before = (
      await pool.query("SELECT revoked FROM sessions WHERE user_id = $1", [target.id])
    ).rows;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.revoked === false)).toBe(true);

    const res = await patchUser(admin, target.id, { phone: "9876543212" });
    expect(res.statusCode, res.body).toBe(200);

    const after = (
      await pool.query("SELECT revoked FROM sessions WHERE user_id = $1", [target.id])
    ).rows;
    expect(after.every((r) => r.revoked === false)).toBe(true);
  });

  it("still revokes sessions when auth_status, password or mfa_policy actually change", async () => {
    const admin = await headersFor((await createUser("adm", ["ADMIN"])).username);
    const target = await createUser("emp", ["EMPLOYEE"]);
    await headersFor(target.username);

    const res = await patchUser(admin, target.id, { mfa_policy: "EXEMPT" });
    expect(res.statusCode, res.body).toBe(200);

    const after = (
      await pool.query("SELECT revoked FROM sessions WHERE user_id = $1", [target.id])
    ).rows;
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.revoked === true)).toBe(true);
  });
});

describe("changing your own account", () => {
  /*
   * The admin route takes no current password, and lets a policy be set on
   * any account the caller may manage -- which includes their own. On the
   * production system an administrator could set their own mfa_policy to
   * EXEMPT and then switch their authenticator off on the security screen,
   * and whoever held a stolen administrator token could set that account's
   * password without knowing the old one. Both stay possible the proper
   * way: the password under Account security, the policy through another
   * administrator, as is already the rule for your own roles.
   */
  it("refuses an administrator setting their own password or two-factor policy here", async () => {
    const me = await createUser("adm", ["ADMIN"]);
    const headers = await headersFor(me.username);
    const before = await passwordHash(me.id);

    const password = await patchUser(headers, me.id, { password: "chosen-with-a-stolen-token" });
    expect(password.statusCode, password.body).toBe(422);
    expect((password.json() as { code: string }).code).toBe("SELF_SECURITY_CHANGE");
    expect(await passwordHash(me.id)).toBe(before);

    const policy = await patchUser(headers, me.id, { mfa_policy: "EXEMPT" });
    expect(policy.statusCode, policy.body).toBe(422);
    const row = (await pool.query("SELECT mfa_policy FROM users WHERE id = $1", [me.id])).rows[0];
    expect(row.mfa_policy).toBe("INHERIT");

    // The refusal is about those two fields, not about the account: their
    // own mobile number is still theirs to correct here.
    const phone = await patchUser(headers, me.id, { phone: "9876543210" });
    expect(phone.statusCode, phone.body).toBe(200);
  });

  it("still lets another administrator set them", async () => {
    const me = await createUser("adm", ["ADMIN"]);
    const peer = await headersFor((await createUser("adm2", ["ADMIN"])).username);
    expect((await patchUser(peer, me.id, { mfa_policy: "EXEMPT" })).statusCode).toBe(200);
    expect((await patchUser(peer, me.id, { password: "set-by-a-colleague-2026" })).statusCode).toBe(200);
    await headersFor(me.username, "set-by-a-colleague-2026");
  });
});
