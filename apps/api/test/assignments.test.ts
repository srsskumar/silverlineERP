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
 * §076 -- putting a person on the work they are on.
 *
 * The rule under test is the one that was decided deliberately: the role
 * decides the screens, the assignment decides the data. So the assertions
 * are about what a scoped account can *reach*, not about what rows the
 * endpoint wrote -- and about the ways this could lock somebody out, which
 * is the failure that would happen silently to somebody in a mandal.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
}

async function mkEmployee(withLogin: boolean, roles: string[] = ["EMPLOYEE"]) {
  const tag = randomUUID().slice(0, 8);
  const emp = await pool.query(
    `INSERT INTO employees (org_id, emp_no, first_name, last_name, phone, date_of_joining)
     VALUES ($1,$2,'Ravi','Kumar','+919000000000',CURRENT_DATE) RETURNING id`,
    [orgId, `EMP${tag}`],
  );
  const employeeId = emp.rows[0].id as string;
  let userId: string | null = null;
  const username = `asg_${tag}`;
  if (withLogin) {
    const hash = await bcrypt.hash("Pass1234!", 4);
    const u = await pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status, employee_id)
       VALUES ($1,$2,$3,'ACTIVE',$4) RETURNING id`,
      [orgId, username, hash, employeeId],
    );
    userId = u.rows[0].id as string;
    for (const code of roles) {
      const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)",
        [userId, role.rows[0].id]);
    }
  }
  return { employeeId, userId, username };
}

async function mkWorkspace(headers: Record<string, string>) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/workspaces", headers,
    payload: { name: `WS${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return (res.json() as { id: string }).id;
}

async function mkProject(headers: Record<string, string>, name: string) {
  const workspace_id = await mkWorkspace(headers);
  const res = await app.inject({
    method: "POST", url: "/api/v1/projects", headers,
    payload: { workspace_id, code: `P${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(0, 16), name },
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return (res.json() as { id: string }).id;
}

async function mkProgramme(name: string) {
  const res = await pool.query(
    `INSERT INTO survey_projects (org_id, code, name) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, `SP${Date.now()}${Math.floor(Math.random() * 1000)}`, name],
  );
  return res.rows[0].id as string;
}

function put(headers: Record<string, string>, employeeId: string, body: unknown) {
  return app.inject({
    method: "PUT", url: `/api/v1/employees/${employeeId}/assignments`, headers, payload: body,
  });
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
});

describe("reading what somebody is on", () => {
  it("says the whole organisation when nothing has been narrowed", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(true);
    const res = await app.inject({
      method: "GET", url: `/api/v1/employees/${employeeId}/assignments`, headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: Record<string, unknown> }).data;
    expect(body.project_access).toBe("ORGANISATION");
    expect(body.summary).toContain("every project in the organisation");
    // The choices come with it, so the screen never has to ask twice.
    expect(body.choices).toBeTruthy();
  });

  it("says so plainly when the employee has no login to scope", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(false);
    const res = await app.inject({
      method: "GET", url: `/api/v1/employees/${employeeId}/assignments`, headers: admin,
    });
    expect((res.json() as { data: { user: unknown } }).data.user).toBeNull();
  });

  it("404s for an employee in another organisation", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({
      method: "GET", url: `/api/v1/employees/${randomUUID()}/assignments`, headers: admin,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("narrowing what they see", () => {
  it("gives a scoped role the projects it was put on, and nothing else", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const mine = await mkProject(admin, "Theirs");
    await mkProject(admin, "Somebody else\'s");
    const { employeeId, username } = await mkEmployee(true, ["PROJECT_MANAGER"]);

    /*
     * Before: nothing at all.
     *
     * The visibility policy already says a project manager sees assigned
     * work rather than the whole register -- and nobody had ever been
     * assigned anything, because the only way to do it was pasting a UUID.
     * So every project manager, team lead and employee account in the
     * system opened the projects screen and found it empty. This is what
     * that gap looks like from the inside.
     */
    let them = await headersFor(username, "Pass1234!");
    let list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    expect(((list.json() as { data: unknown[] }).data).length).toBe(0);

    const res = await put(admin, employeeId, {
      project_access: "ASSIGNED", project_ids: [mine], programmes: [],
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    // Their old session is gone, because a narrowed scope that waits for a
    // token to lapse is not a narrowed scope.
    const stale = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    expect(stale.statusCode).toBe(401);

    them = await headersFor(username, "Pass1234!");
    list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    const names = ((list.json() as { data: Array<{ name: string }> }).data).map((p) => p.name);
    expect(names).toEqual(["Theirs"]);
  });

  it("takes a project away again", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const one = await mkProject(admin, "One");
    const two = await mkProject(admin, "Two");
    const { employeeId, username } = await mkEmployee(true, ["PROJECT_MANAGER"]);

    await put(admin, employeeId, {
      project_access: "ASSIGNED", project_ids: [one, two], programmes: [],
    });
    let them = await headersFor(username, "Pass1234!");
    let list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    expect(((list.json() as { data: unknown[] }).data).length).toBe(2);

    await put(admin, employeeId, { project_access: "ASSIGNED", project_ids: [one], programmes: [] });
    them = await headersFor(username, "Pass1234!");
    list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    expect(((list.json() as { data: Array<{ name: string }> }).data).map((p) => p.name))
      .toEqual(["One"]);
  });

  it("an unscoped role still sees the whole register", async () => {
    // AUDITOR is GLOBAL by policy, so nothing here should narrow it.
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    await mkProject(admin, "One");
    await mkProject(admin, "Two");
    const { username } = await mkEmployee(true, ["AUDITOR"]);
    const them = await headersFor(username, "Pass1234!");
    const list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: them });
    expect(((list.json() as { data: unknown[] }).data).length).toBe(2);
  });

  it("does not touch which screens they get -- only which data", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const mine = await mkProject(admin, "Scoped");
    const { employeeId, username } = await mkEmployee(true, ["PROJECT_MANAGER"]);
    await put(admin, employeeId, { project_access: "ASSIGNED", project_ids: [mine], programmes: [] });

    const them = await headersFor(username, "Pass1234!");
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: them });
    expect((me.json() as { roles: string[] }).roles).toEqual(["PROJECT_MANAGER"]);
    expect((me.json() as { permissions: string[] }).permissions).toContain("projects.read");
  });

  it("refuses a restriction that restricts nothing", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(true);
    const res = await put(admin, employeeId, { project_access: "ASSIGNED", project_ids: [] });
    expect(res.statusCode).toBe(422);
  });

  it("refuses a project from another organisation", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(true);
    const res = await put(admin, employeeId, {
      project_access: "ASSIGNED", project_ids: [randomUUID()],
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses to limit somebody who has no login", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const project = await mkProject(admin, "Needs a login");
    const { employeeId } = await mkEmployee(false);
    const res = await put(admin, employeeId, {
      project_access: "ASSIGNED", project_ids: [project],
    });
    expect(res.statusCode).toBe(409);
  });

  it("will not let an administrator scope themselves out of the screen", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const project = await mkProject(admin, "Mine");
    const adminEmployee = await pool.query(
      `INSERT INTO employees (org_id, emp_no, first_name, phone, date_of_joining)
       VALUES ($1,$2,'The','+919000000001',CURRENT_DATE) RETURNING id`,
      [orgId, `ADM${randomUUID().slice(0, 6)}`]);
    await pool.query("UPDATE users SET employee_id = $1 WHERE username = $2",
      [adminEmployee.rows[0].id, ADMIN_USERNAME]);
    const res = await put(admin, adminEmployee.rows[0].id, {
      project_access: "ASSIGNED", project_ids: [project],
    });
    expect(res.statusCode).toBe(409);
  });

  it("leaves a district limit set elsewhere alone", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const project = await mkProject(admin, "Both");
    const { employeeId, userId } = await mkEmployee(true, ["TEAM_LEAD"]);
    const unit = await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: admin,
      payload: { type: "district", code: `D${Date.now()}`, name: "Kurnool" },
    });
    const role = await pool.query("SELECT id FROM roles WHERE code = 'TEAM_LEAD'");
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'district',$3)",
      [userId, role.rows[0].id, (unit.json() as { id: string }).id]);

    await put(admin, employeeId, { project_access: "ASSIGNED", project_ids: [project] });

    const rows = await pool.query(
      "SELECT scope_type FROM user_roles WHERE user_id = $1 AND scope_type = 'district'", [userId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe("survey programmes", () => {
  it("puts them on, and takes them off by releasing rather than deleting", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const a = await mkProgramme("Kurnool resurvey");
    const b = await mkProgramme("Anantapur resurvey");
    const { employeeId } = await mkEmployee(true);

    let res = await put(admin, employeeId, {
      project_access: "ORGANISATION",
      programmes: [
        { survey_project_id: a, project_role: "GT_USER" },
        { survey_project_id: b, project_role: "QC_USER" },
      ],
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    res = await put(admin, employeeId, {
      project_access: "ORGANISATION",
      programmes: [{ survey_project_id: a, project_role: "TEAM_LEAD" }],
    });
    expect(res.statusCode).toBe(200);

    const rows = await pool.query(
      `SELECT survey_project_id, project_role, released_on
         FROM survey_project_employees WHERE employee_id = $1 ORDER BY released_on NULLS FIRST`,
      [employeeId]);
    expect(rows.rowCount).toBe(2);
    // Somebody worked those days; the row stays, marked as ended.
    const released = rows.rows.find((r) => r.released_on);
    expect(released?.survey_project_id).toBe(b);
    const kept = rows.rows.find((r) => !r.released_on);
    expect(kept?.project_role).toBe("TEAM_LEAD");
  });

  it("works for somebody with no login -- a chainman is on the crew all the same", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const programme = await mkProgramme("Nandyal resurvey");
    const { employeeId } = await mkEmployee(false);
    const res = await put(admin, employeeId, {
      project_access: "ORGANISATION",
      programmes: [{ survey_project_id: programme, project_role: "GT_USER" }],
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a programme from another organisation", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(true);
    const res = await put(admin, employeeId, {
      project_access: "ORGANISATION",
      programmes: [{ survey_project_id: randomUUID(), project_role: "GT_USER" }],
    });
    expect(res.statusCode).toBe(422);
  });

  it("needs survey.assign to change a programme, but not to leave one alone", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const programme = await mkProgramme("HR cannot touch this");
    const { employeeId } = await mkEmployee(true);
    await put(admin, employeeId, {
      project_access: "ORGANISATION",
      programmes: [{ survey_project_id: programme, project_role: "GT_USER" }],
    });

    const hrName = `hr_${randomUUID().slice(0, 8)}`;
    const hash = await bcrypt.hash("Pass1234!", 4);
    const hrUser = await pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`, [orgId, hrName, hash]);
    const role = await pool.query("SELECT id FROM roles WHERE code = 'HR_MANAGER'");
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)",
      [hrUser.rows[0].id, role.rows[0].id]);
    const hr = await headersFor(hrName, "Pass1234!");

    // Leaving the programmes as they are is fine.
    const unchanged = await put(hr, employeeId, {
      project_access: "ORGANISATION",
      programmes: [{ survey_project_id: programme, project_role: "GT_USER" }],
    });
    expect(unchanged.statusCode).toBe(200);

    // Changing one is not.
    const changed = await put(hr, employeeId, { project_access: "ORGANISATION", programmes: [] });
    expect(changed.statusCode).toBe(403);
  });
});

describe("who may do this at all", () => {
  it("is closed to somebody without users.manage", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const { employeeId } = await mkEmployee(true);
    const tlName = `tl_${randomUUID().slice(0, 8)}`;
    const hash = await bcrypt.hash("Pass1234!", 4);
    const u = await pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status)
       VALUES ($1,$2,$3,'ACTIVE') RETURNING id`, [orgId, tlName, hash]);
    const role = await pool.query("SELECT id FROM roles WHERE code = 'TEAM_LEAD'");
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)", [u.rows[0].id, role.rows[0].id]);
    const tl = await headersFor(tlName, "Pass1234!");
    expect((await put(tl, employeeId, { project_access: "ORGANISATION" })).statusCode).toBe(403);
    void admin;
  });
});
