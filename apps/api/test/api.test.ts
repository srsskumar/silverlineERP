import {testDatabaseUrl} from "./database.js";
import { decryptPii } from "../src/common/crypto.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  seedDatabase,
} from "../src/database/seed.js";

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";

async function truncateVolatile(): Promise<void> {
  // S1 tables included: employees/org_units reference users and vice versa
  // (users.employee_id), so every FK pair must be truncated together.
  await pool.query(
    `TRUNCATE TABLE invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, geo_fence_employee_assignments, device_registrations, audit_events, sessions, user_roles, idempotency_keys,
      users, employee_documents, employees, org_units, holidays,
      attendance_exceptions, attendance_records, attendance_events, geo_fences,
      leave_requests, leave_balances, leave_types,
      mentions, comments, task_evidence, task_dependencies, tasks,
      projects, project_workflows, project_types, workspaces,
      notifications, task_labels, labels, saved_filters, board_columns, boards,
      payslips, payroll_runs, payroll_policies`,
  );
}

async function createUser(opts: {
  username: string;
  password: string;
  roles?: string[];
  status?: string;
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, opts.username, hash, opts.status ?? "ACTIVE"],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const code of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      id,
      (role.rows[0] as { id: string }).id,
    ]);
  }
  return id;
}

async function loginBody(username: string, password: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password, ...extra },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, headers: res.headers };
}

async function authHeader(username: string, password: string): Promise<Record<string, string>> {
  const { body } = await loginBody(username, password);
  return { authorization: `Bearer ${body["access_token"] as string}` };
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB,
    jwtSecret: JWT_SECRET,
    // Keep the limiter wired but out of the way of functional tests.
    loginRateLimitMax: 1000,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateVolatile();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
});

describe("health", () => {
  it("GET /health returns 200 with status ok and a request id", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});

describe("login", () => {
  it("succeeds with the token-pair shape", async () => {
    const { status, body } = await loginBody(ADMIN_USERNAME, ADMIN_PASSWORD);
    expect(status).toBe(200);
    expect(body["token_type"]).toBe("Bearer");
    expect(body["expires_in"]).toBe(900);
    expect(body["mfa_required"]).toBe(false);
    expect(typeof body["access_token"]).toBe("string");
    expect(typeof body["refresh_token"]).toBe("string");
    expect((body["user"] as { username: string }).username).toBe(ADMIN_USERNAME);
  });

  it("wrong password returns the 401 envelope", async () => {
    const { status, body, headers } = await loginBody(ADMIN_USERNAME, "nope-nope-nope");
    expect(status).toBe(401);
    expect(body["code"]).toBe("INVALID_CREDENTIALS");
    expect(typeof body["message"]).toBe("string");
    expect(body["field_errors"]).toEqual([]);
    expect(typeof body["request_id"]).toBe("string");
    expect(body["retryable"]).toBe(false);
    expect(headers["x-request-id"]).toBe(body["request_id"]);
  });

  it("unknown user returns the identical 401 (no existence leak)", async () => {
    const wrong = await loginBody(ADMIN_USERNAME, "nope-nope-nope");
    const unknown = await loginBody("ghost-user-xyz", "nope-nope-nope");
    expect(unknown.status).toBe(401);
    expect(unknown.body["code"]).toBe(wrong.body["code"]);
    expect(unknown.body["message"]).toBe(wrong.body["message"]);
    expect(unknown.body["field_errors"]).toEqual(wrong.body["field_errors"]);
  });

  it("locks the account after 5 failures and returns 423", async () => {
    await createUser({ username: "locku", password: "RightPass1!" });
    for (let i = 0; i < 4; i++) {
      const r = await loginBody("locku", "wrong");
      expect(r.status).toBe(401);
    }
    const fifth = await loginBody("locku", "wrong");
    expect(fifth.status).toBe(423);
    expect(fifth.body["code"]).toBe("ACCOUNT_LOCKED");
    const correct = await loginBody("locku", "RightPass1!");
    expect(correct.status).toBe(423);
  });

  it("bad body returns the 422 envelope with field_errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as Record<string, unknown>;
    expect(body["code"]).toBe("VALIDATION_ERROR");
    const fields = body["field_errors"] as Array<{ field: string }>;
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.map((f) => f.field)).toContain("password");
    expect(typeof body["request_id"]).toBe("string");
  });
});

describe("refresh rotation", () => {
  it("returns a new pair on valid refresh", async () => {
    const first = await loginBody(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
    expect(typeof body["refresh_token"]).toBe("string");
    expect(body["refresh_token"]).not.toBe(first.body["refresh_token"]);
  });

  it("reuse of a rotated token revokes the whole family", async () => {
    const first = await loginBody(ADMIN_USERNAME, ADMIN_PASSWORD);
    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = rotated.json() as Record<string, unknown>;

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(reuse.statusCode).toBe(401);

    // Family revoked: even the newest token is dead.
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: rotatedBody["refresh_token"] },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("me", () => {
  it("returns user+roles+permissions when authed", async () => {
    const headers = await authHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: { username: string };
      roles: string[];
      permissions: string[];
    };
    expect(body.user.username).toBe(ADMIN_USERNAME);
    expect(body.roles).toContain("SUPER_ADMIN");
    expect(body.permissions).toContain("audit.read");
  });

  it("returns 401 anonymously", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe("UNAUTHENTICATED");
  });
});

describe("audit", () => {
  it("forbids EMPLOYEE with a 403 envelope", async () => {
    await createUser({ username: "emp1", password: "EmpPass1!", roles: ["EMPLOYEE"] });
    const headers = await authHeader("emp1", "EmpPass1!");
    const res = await app.inject({ method: "GET", url: "/api/v1/audit", headers });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("FORBIDDEN");
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("writes an audit row on login and lists it with filters", async () => {
    await loginBody(ADMIN_USERNAME, ADMIN_PASSWORD);
    const dbRows = await pool.query(
      "SELECT action, actor_id FROM audit_events WHERE action = 'auth.login'",
    );
    expect(dbRows.rowCount).toBeGreaterThan(0);

    const headers = await authHeader(ADMIN_USERNAME, ADMIN_PASSWORD);
    const list = await app.inject({ method: "GET", url: "/api/v1/audit", headers });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      data: Array<{ action: string }>;
      next_cursor: string | null;
      has_more: boolean;
    };
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.some((r) => r.action === "auth.login")).toBe(true);

    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/audit?action=auth.login&limit=5",
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    const fpage = filtered.json() as { data: Array<{ action: string }> };
    expect(fpage.data.length).toBeGreaterThan(0);
    expect(fpage.data.every((r) => r.action === "auth.login")).toBe(true);
  });
});

describe("mfa", () => {
  it("setup -> verify -> login challenges -> totp login succeeds", async () => {
    await createUser({ username: "mfa1", password: "MfaPass1!" });
    const headers = await authHeader("mfa1", "MfaPass1!");

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/setup",
      headers,
    });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauth_url } = setup.json() as {
      secret: string;
      otpauth_url: string;
    };
    expect(typeof secret).toBe("string");
    expect(otpauth_url).toContain("otpauth://");

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/verify",
      headers,
      payload: { code: authenticator.generate(secret) },
    });
    expect(verify.statusCode).toBe(200);

    const challenged = await loginBody("mfa1", "MfaPass1!");
    expect(challenged.status).toBe(200);
    expect(challenged.body["mfa_required"]).toBe(true);
    expect(challenged.body["access_token"]).toBeUndefined();

    const idRow = await pool.query("SELECT mfa_secret FROM users WHERE username = 'mfa1'");
    const storedSecret = (idRow.rows[0] as { mfa_secret: string }).mfa_secret;
    expect(storedSecret).toMatch(/^gcm1\./);
    const liveSecret = decryptPii(storedSecret);
    // Enrolment already spent this step's code, and codes are single-use
    // (§14.1 replay policy), so a real user waits for their authenticator to
    // roll before logging in. Rewinding the spent counter by one step is the
    // same state as that wait, without costing the suite 30 seconds.
    await pool.query(
      "UPDATE users SET mfa_last_counter = mfa_last_counter - 1 WHERE username = 'mfa1'",
    );
    const full = await loginBody("mfa1", "MfaPass1!", {
      totp_code: authenticator.generate(liveSecret),
    });
    expect(full.status).toBe(200);
    expect(full.body["mfa_required"]).toBe(false);
    expect(typeof full.body["access_token"]).toBe("string");
  });

  it("refuses a code that has already been spent", async () => {
    await createUser({ username: "mfa_replay", password: "MfaPass1!" });
    const headers = await authHeader("mfa_replay", "MfaPass1!");
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/setup",
      headers,
    });
    const { secret } = setup.json() as { secret: string };
    const code = authenticator.generate(secret);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/mfa/verify",
          headers,
          payload: { code },
        })
      ).statusCode,
    ).toBe(200);

    // Same code, same window: a shoulder-surfer's replay must not authenticate.
    const replay = await loginBody("mfa_replay", "MfaPass1!", { totp_code: code });
    expect(replay.status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the refresh token and is idempotent", async () => {
    const first = await loginBody(ADMIN_USERNAME, ADMIN_PASSWORD);
    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(out.statusCode).toBe(200);

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(retry.statusCode).toBe(401);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      payload: { refresh_token: first.body["refresh_token"] },
    });
    expect(again.statusCode).toBe(200);
  });
});

describe("misc", () => {
  it("unknown routes return the 404 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("NOT_FOUND");
  });

  it("malformed UUID path params return 422, never 500", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    const token = (login.json() as { access_token: string }).access_token;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees/not-a-uuid",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("VALIDATION_ERROR");
  });
});
