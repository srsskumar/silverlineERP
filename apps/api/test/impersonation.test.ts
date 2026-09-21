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
import { IMPERSONATION_FORBIDDEN_PATHS } from "@silverline/shared";

/**
 * §075 -- viewing the application as another user.
 *
 * The thing worth testing is not that the endpoint returns a token. It is
 * that the token is *weaker* than the one that asked for it: an
 * administrator holding an employee's session must be able to do exactly
 * what that employee can do and nothing else, every write must be
 * attributable to both of them, and stopping must take effect at once
 * rather than whenever the token would have expired.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";

const REASON = "Checking what the Kurnool team lead can reach";

async function createUser(username: string, roles: string[]): Promise<string> {
  const hash = await bcrypt.hash("Pass1234!", 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, username, hash],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const code of roles) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
      [id, (role.rows[0] as { id: string }).id],
    );
  }
  return id;
}

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return { authorization: `Bearer ${(res.json() as { access_token: string }).access_token}` };
}

async function viewAs(
  headers: Record<string, string>,
  userId: string,
  body: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST", url: "/api/v1/auth/impersonate", headers,
    payload: { user_id: userId, reason: REASON, ...body },
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

describe("starting a view-as session", () => {
  it("hands back a token that is the subject, not the administrator", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_emp_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);

    const started = await viewAs(admin, employeeId);
    expect(started.statusCode).toBe(201);
    const token = (started.json() as { access_token: string }).access_token;

    const me = await app.inject({
      method: "GET", url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      user: { id: string }; roles: string[];
      impersonation: { actor_username: string } | null;
    };
    expect(body.user.id).toBe(employeeId);
    expect(body.roles).toEqual(["EMPLOYEE"]);
    // ...and it says so, which is what the banner is drawn from.
    expect(body.impersonation?.actor_username).toBe(ADMIN_USERNAME);
  });

  it("says nothing about impersonation on an ordinary session", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: admin });
    expect((me.json() as { impersonation: unknown }).impersonation).toBeNull();
  });

  it("leaves a register row carrying the reason", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_reg_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    await viewAs(admin, employeeId);
    const row = await pool.query(
      "SELECT reason, ended_at, expires_at FROM impersonation_sessions WHERE subject_id = $1",
      [employeeId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].reason).toBe(REASON);
    expect(row.rows[0].ended_at).toBeNull();
    expect(new Date(row.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("insists on a reason worth reading", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_why_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/impersonate", headers: admin,
      payload: { user_id: employeeId, reason: "test" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("warns that the account holds no roles rather than letting the screen come up empty", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const nobody = await createUser(`imp_bare_${randomUUID().slice(0, 8)}`, []);
    const res = await viewAs(admin, nobody);
    expect(res.statusCode).toBe(201);
    expect((res.json() as { notices: string[] }).notices.join(' ')).toMatch(/no roles/i);
  });

  it("is the same answer for a user who does not exist and one in another organisation", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const ghost = await viewAs(admin, randomUUID());
    expect(ghost.statusCode).toBe(404);

    const other = await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [`Other ${randomUUID()}`]);
    const stranger = await pool.query(
      `INSERT INTO users (org_id, username, password_hash, auth_status)
       VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [other.rows[0].id, `stranger_${randomUUID().slice(0, 8)}`],
    );
    const elsewhere = await viewAs(admin, stranger.rows[0].id);
    expect(elsewhere.statusCode).toBe(404);
  });

  it("refuses an account that has been switched off", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const gone = await createUser(`imp_off_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1", [gone]);
    expect((await viewAs(admin, gone)).statusCode).toBe(409);
  });
});

describe("what the borrowed session may do", () => {
  it("cannot reach what the subject cannot reach, even though an administrator asked for it", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_rbac_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, employeeId)).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };

    // The administrator's own session can read the staff register.
    expect((await app.inject({ method: "GET", url: "/api/v1/employees", headers: admin })).statusCode).toBe(200);
    // Holding the employee's session, it cannot -- which is the entire point.
    expect((await app.inject({ method: "GET", url: "/api/v1/employees", headers: borrowed })).statusCode).toBe(403);
  });

  it("cannot start a second view-as from inside the first", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const a = await createUser(`imp_chain_a_${randomUUID().slice(0, 8)}`, ["ADMIN"]);
    const b = await createUser(`imp_chain_b_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, a)).json() as { access_token: string };
    const res = await viewAs({ authorization: `Bearer ${token.access_token}` }, b);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("IMPERSONATION_FORBIDDEN");
  });

  it("cannot change the account holder's password or authenticator", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_creds_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, employeeId)).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };

    for (const url of ["/api/v1/auth/password", "/api/v1/auth/mfa/setup"]) {
      const res = await app.inject({ method: "POST", url, headers: borrowed, payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
  });

  /*
   * Belt and braces. The refresh secret behind a borrowed session is
   * generated, hashed and discarded, so there is nothing anybody could
   * present -- this asserts the session cannot be extended, by any route.
   */
  it("cannot be refreshed into a longer session", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_refresh_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    await viewAs(admin, employeeId);
    const family = await pool.query(
      "SELECT session_family FROM impersonation_sessions WHERE subject_id = $1", [employeeId],
    );
    const session = await pool.query("SELECT refresh_hash FROM sessions WHERE family = $1", [family.rows[0].session_family]);
    expect(session.rowCount).toBe(1);
    // The plaintext of that hash was never returned to anybody.
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/refresh", payload: { refresh_token: session.rows[0].refresh_hash },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("who the audit trail says did it", () => {
  it("records the subject as the actor and the administrator as the impersonator", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const pmId = await createUser(`imp_write_${randomUUID().slice(0, 8)}`, ["ADMIN"]);
    const token = (await viewAs(admin, pmId)).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };

    const created = await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: borrowed,
      payload: { type: "district", code: `IMP${Date.now()}`, name: "Impersonated District" },
    });
    expect(created.statusCode).toBe(201);

    const audit = await pool.query(
      `SELECT actor_id, impersonator_id FROM audit_events
        WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [(created.json() as { id: string }).id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(pmId);
    expect(audit.rows[0].impersonator_id).not.toBeNull();
  });

  it("leaves impersonator_id null on ordinary work", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const created = await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: admin,
      payload: { type: "district", code: `ORD${Date.now()}`, name: "Ordinary District" },
    });
    expect(created.statusCode).toBe(201);
    const audit = await pool.query(
      "SELECT impersonator_id FROM audit_events WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1",
      [(created.json() as { id: string }).id],
    );
    expect(audit.rows[0].impersonator_id).toBeNull();
  });
});

describe("stopping", () => {
  it("kills the borrowed token on the spot, not at its expiry", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_stop_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, employeeId, { minutes: 120 })).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: borrowed })).statusCode).toBe(200);

    // Stopping from inside the borrowed session -- the banner's button.
    const stopped = await app.inject({ method: "POST", url: "/api/v1/auth/impersonate/stop", headers: borrowed });
    expect(stopped.statusCode).toBe(200);
    expect((stopped.json() as { ended: boolean }).ended).toBe(true);

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: borrowed });
    expect(after.statusCode).toBe(401);
  });

  it("can also be stopped from the administrator's own session", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_stop2_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, employeeId)).json() as { access_token: string };
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/impersonate/stop", headers: admin })).statusCode).toBe(200);
    const after = await app.inject({
      method: "GET", url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("is quiet when there is nothing to stop", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/impersonate/stop", headers: admin });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ended: boolean }).ended).toBe(false);
  });

  it("starting a second session closes the first, so one administrator is never two people", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const a = await createUser(`imp_one_a_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const b = await createUser(`imp_one_b_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const first = (await viewAs(admin, a)).json() as { access_token: string };
    const second = await viewAs(admin, b);
    expect(second.statusCode).toBe(201);

    const stale = await app.inject({
      method: "GET", url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${first.access_token}` },
    });
    expect(stale.statusCode).toBe(401);

    const live = await pool.query(
      "SELECT count(*)::int AS n FROM impersonation_sessions WHERE ended_at IS NULL",
    );
    expect(live.rows[0].n).toBe(1);
  });

  it("an expired session is over whether or not anybody pressed stop", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeId = await createUser(`imp_exp_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    const token = (await viewAs(admin, employeeId, { minutes: 120 })).json() as { access_token: string };
    // Backdate the whole window: the table refuses a session that ends
    // before it began, which is a constraint worth keeping.
    await pool.query(
      `UPDATE impersonation_sessions
          SET started_at = now() - interval '3 hours', expires_at = now() - interval '1 minute'
        WHERE subject_id = $1`,
      [employeeId],
    );
    const res = await app.inject({
      method: "GET", url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the picker", () => {
  it("shows the accounts you may not hold, with the reason, rather than hiding them", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const employeeName = `imp_pick_${randomUUID().slice(0, 8)}`;
    await createUser(employeeName, ["EMPLOYEE"]);

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/impersonate/targets", headers: admin });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { data: Array<{ username: string; allowed: boolean; roles: string[] }> }).data;
    const employee = rows.find((r) => r.username === employeeName);
    expect(employee?.allowed).toBe(true);
    expect(employee?.roles).toEqual(["EMPLOYEE"]);
    // The administrator themself is never in their own list.
    expect(rows.some((r) => r.username === ADMIN_USERNAME)).toBe(false);
  });

  it("is not open to anybody without the permission", async () => {
    const pmName = `imp_nopick_${randomUUID().slice(0, 8)}`;
    await createUser(pmName, ["PROJECT_MANAGER"]);
    const pm = await headersFor(pmName, "Pass1234!");
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/impersonate/targets", headers: pm })).statusCode).toBe(403);
    const employeeId = await createUser(`imp_target_${randomUUID().slice(0, 8)}`, ["EMPLOYEE"]);
    expect((await viewAs(pm, employeeId)).statusCode).toBe(403);
  });
});

/*
 * Written because the list shipped with a path that did not exist:
 * "/api/v1/auth/change-password" was guarded, the real route is
 * "/api/v1/auth/password", and the guard therefore protected nothing. A
 * deny-list whose entries are never checked against the routing table is a
 * comment with a type signature.
 */
describe("the forbidden list names real routes", () => {
  it("every path on it is actually registered", () => {
    const table = app.printRoutes({ commonPrefix: false });
    for (const path of IMPERSONATION_FORBIDDEN_PATHS) {
      // printRoutes draws a tree; the leaf segment plus its parents appear in order.
      const segments = path.split("/").filter(Boolean);
      let cursor = 0;
      for (const segment of segments) {
        const at = table.indexOf(segment, cursor);
        expect(at, `${path} (missing "${segment}")`).toBeGreaterThan(-1);
        cursor = at + segment.length;
      }
    }
  });
});

/*
 * The register and the trail are the accountability half of this feature.
 * Written because they shipped invisible: impersonator_id was recorded on
 * every mutation and selected by nothing, and impersonation_sessions had no
 * endpoint at all, so the only way to read either was psql.
 */
describe("reading it back", () => {
  it("names the administrator on the trail, next to whoever the system thought was acting", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const subjectId = await createUser(`imp_trail_${randomUUID().slice(0, 8)}`, ["ADMIN"]);
    const token = (await viewAs(admin, subjectId)).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };

    const created = await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: borrowed,
      payload: { type: "district", code: `TRL${Date.now()}`, name: "Trail District" },
    });
    expect(created.statusCode).toBe(201);

    const trail = await app.inject({ method: "GET", url: "/api/v1/audit?limit=50", headers: admin });
    expect(trail.statusCode).toBe(200);
    const entry = (trail.json() as { data: Array<Record<string, unknown>> }).data
      .find((r) => r.entity_id === (created.json() as { id: string }).id);
    expect(entry?.actor_id).toBe(subjectId);
    expect(entry?.impersonator_username).toBe(ADMIN_USERNAME);
  });

  it("leaves the impersonator blank on ordinary work", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const created = await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: admin,
      payload: { type: "district", code: `PLN${Date.now()}`, name: "Plain District" },
    });
    const trail = await app.inject({ method: "GET", url: "/api/v1/audit?limit=50", headers: admin });
    const entry = (trail.json() as { data: Array<Record<string, unknown>> }).data
      .find((r) => r.entity_id === (created.json() as { id: string }).id);
    expect(entry?.impersonator_id).toBeNull();
    expect(entry?.impersonator_username).toBeNull();
  });

  it("keeps the audit filters working now that the query carries a join", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    await app.inject({
      method: "POST", url: "/api/v1/org/units", headers: admin,
      payload: { type: "district", code: `FLT${Date.now()}`, name: "Filter District" },
    });
    const filtered = await app.inject({
      method: "GET", url: "/api/v1/audit?limit=10&entity=org_unit", headers: admin,
    });
    expect(filtered.statusCode).toBe(200);
    const rows = (filtered.json() as { data: Array<{ entity_type: string }> }).data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entity_type === "org_unit")).toBe(true);
  });

  it("serves the register, with the reason and whether anything was changed", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const subjectName = `imp_reg2_${randomUUID().slice(0, 8)}`;
    const subjectId = await createUser(subjectName, ["EMPLOYEE"]);
    await viewAs(admin, subjectId);

    const open = await app.inject({ method: "GET", url: "/api/v1/audit/view-as", headers: admin });
    expect(open.statusCode).toBe(200);
    const live = (open.json() as { data: Array<Record<string, unknown>> }).data
      .find((r) => r.subject_username === subjectName);
    expect(live?.actor_username).toBe(ADMIN_USERNAME);
    expect(live?.reason).toBe(REASON);
    expect(live?.live).toBe(true);
    expect(live?.writes).toBe(0);

    await app.inject({ method: "POST", url: "/api/v1/auth/impersonate/stop", headers: admin });
    const closed = await app.inject({ method: "GET", url: "/api/v1/audit/view-as", headers: admin });
    const done = (closed.json() as { data: Array<Record<string, unknown>> }).data
      .find((r) => r.subject_username === subjectName);
    expect(done?.live).toBe(false);
    expect(done?.ended_at).not.toBeNull();
  });

  it("counts what was changed during the session", async () => {
    const admin = await headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
    const subjectName = `imp_cnt_${randomUUID().slice(0, 8)}`;
    const subjectId = await createUser(subjectName, ["ADMIN"]);
    const token = (await viewAs(admin, subjectId)).json() as { access_token: string };
    const borrowed = { authorization: `Bearer ${token.access_token}` };
    for (const n of [1, 2]) {
      const res = await app.inject({
        method: "POST", url: "/api/v1/org/units", headers: borrowed,
        payload: { type: "district", code: `CNT${n}${Date.now()}`, name: `Counted ${n}` },
      });
      expect(res.statusCode).toBe(201);
    }
    const reg = await app.inject({ method: "GET", url: "/api/v1/audit/view-as", headers: admin });
    const row = (reg.json() as { data: Array<Record<string, unknown>> }).data
      .find((r) => r.subject_username === subjectName);
    expect(row?.writes).toBe(2);
  });

  it("is not open to somebody who cannot read the trail", async () => {
    const name = `imp_noaudit_${randomUUID().slice(0, 8)}`;
    await createUser(name, ["EMPLOYEE"]);
    const employee = await headersFor(name, "Pass1234!");
    expect((await app.inject({ method: "GET", url: "/api/v1/audit/view-as", headers: employee })).statusCode).toBe(403);
  });
});
