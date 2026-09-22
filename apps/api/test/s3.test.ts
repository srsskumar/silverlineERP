import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { assembleApprovalChain } from "@silverline/shared";
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
let seq = 0;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

function minusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

function yr(day: string): number {
  return Number(day.slice(0, 4));
}

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
}

async function createUser(opts: {
  username: string;
  password: string;
  roles?: string[];
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, opts.username, hash],
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

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}

async function adminHeaders() {
  return headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
}

async function mkUser(
  roles: string[],
  tag: string,
): Promise<{ id: string; headers: Record<string, string> }> {
  const u = `s3_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const id = await createUser({ username: u, password: "Pass1234!", roles });
  return { id, headers: await headersFor(u, "Pass1234!") };
}

function empPayload(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    emp_no: `S3E${String(seq).padStart(4, "0")}`,
    first_name: "S3",
    last_name: "User",
    phone: `+9181000${String(10000 + seq)}`,
    date_of_joining: "2024-01-15",
    ...over,
  };
}

async function mkEmployee(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers,
    payload: empPayload(over),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function linkUser(userId: string, employeeId: string): Promise<void> {
  await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [
    employeeId,
    userId,
  ]);
}

/** `reports_to` validation requires an ACTIVE manager — flip it directly. */
async function activateEmployee(employeeId: string): Promise<void> {
  await pool.query("UPDATE employees SET status = 'ACTIVE' WHERE id = $1::uuid", [
    employeeId,
  ]);
}

async function typeMap(headers: Record<string, string>) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/leave/types",
    headers,
  });
  expect(res.statusCode).toBe(200);
  const rows = (res.json() as { data: Array<{ id: string; code: string }> }).data;
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

async function setBalance(
  headers: Record<string, string>,
  employeeId: string,
  leaveTypeId: string,
  year: number,
  opening: number,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/leave/balances",
    headers,
    payload: {
      employee_id: employeeId,
      leave_type_id: leaveTypeId,
      period_year: year,
      opening_balance: opening,
    },
  });
}

function fileLeave(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { ...headers, "Idempotency-Key": key ?? randomUUID() },
    payload: body,
  });
}

/**
 * Standard chain fixture: manager employee M linked to a TEAM_LEAD user,
 * employee E (linked to an EMPLOYEE user) reporting to M. Returns ids +
 * authed headers for the requester (E) and the step-1 approver (TL).
 */
async function chainFixture() {
  const adminH = await adminHeaders();
  const types = await typeMap(adminH);
  const tl = await mkUser(["TEAM_LEAD"], "tl");
  const emp = await mkUser(["EMPLOYEE"], "emp");
  const mId = await mkEmployee(adminH);
  await activateEmployee(mId);
  await linkUser(tl.id, mId);
  const eId = await mkEmployee(adminH, { reports_to: mId });
  await activateEmployee(eId);
  await linkUser(emp.id, eId);
  const adminRow = await pool.query(
    "SELECT id FROM users WHERE username = $1",
    [ADMIN_USERNAME],
  );
  const adminId = (adminRow.rows[0] as { id: string }).id;
  const adminH2 = await adminHeaders();
  return { adminH, adminH2, adminId, types, tl, emp, mId, eId };
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB,
    jwtSecret: JWT_SECRET,
    loginRateLimitMax: 1000,
  });
});

afterAll(async () => {
  // Leave our tables clean so file ordering never affects other suites.
  await pool.query(
    "TRUNCATE TABLE payslip_revisions, leave_requests, leave_balances, leave_types",
  );
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ------------------------------------------------------------------ types

describe("leave types", () => {
  it("lists the 4 seeded types with the frozen shape", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/types",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        code: string;
        name: string;
        is_paid: boolean;
        annual_entitlement: number;
        requires_balance: boolean;
      }>;
    };
    expect(body.data.map((t) => t.code)).toEqual(["CL", "EL", "LOP", "SL"]);
    const byCode = Object.fromEntries(body.data.map((t) => [t.code, t]));
    expect(byCode["CL"]).toMatchObject({
      is_paid: true,
      annual_entitlement: 12,
      requires_balance: true,
    });
    expect(byCode["SL"]).toMatchObject({
      is_paid: true,
      annual_entitlement: 12,
      requires_balance: true,
    });
    expect(byCode["EL"]).toMatchObject({
      is_paid: true,
      annual_entitlement: 15,
      requires_balance: true,
    });
    expect(byCode["LOP"]).toMatchObject({
      is_paid: false,
      requires_balance: false,
    });
  });

  it("requires auth (401 anon)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/leave/types" });
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ balances

describe("leave balances", () => {
  it("upserts an opening balance (201) and reads computed current_balance", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const from = plusDays(30);
    const up = await setBalance(adminH, eId, types["CL"] as string, yr(from), 10);
    expect(up.statusCode).toBe(201);
    // Ledger math: opening + credits - consumed + adjustments.
    await pool.query(
      `UPDATE leave_balances SET credits = 2, consumed = 3, adjustments = 1
       WHERE employee_id = $1::uuid`,
      [eId],
    );
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/leave/balances?employee_id=${eId}&period_year=${yr(from)}`,
      headers: adminH,
    });
    expect(got.statusCode).toBe(200);
    const rows = (
      got.json() as {
        data: Array<{
          employee_id: string;
          leave_code: string;
          period_year: number;
          opening_balance: number;
          credits: number;
          consumed: number;
          adjustments: number;
          current_balance: number;
        }>;
      }
    ).data;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      employee_id: eId,
      leave_code: "CL",
      period_year: yr(from),
      opening_balance: 10,
      credits: 2,
      consumed: 3,
      adjustments: 1,
      current_balance: 10,
    });
    void emp;
  });

  it("updates the opening on re-upsert (200)", async () => {
    const { adminH, eId, types } = await chainFixture();
    const from = plusDays(30);
    const first = await setBalance(adminH, eId, types["SL"] as string, yr(from), 12);
    expect(first.statusCode).toBe(201);
    const second = await setBalance(adminH, eId, types["SL"] as string, yr(from), 4);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { opening_balance: number }).opening_balance).toBe(4);
  });

  it("names the right action when an employee files leave for somebody else", async () => {
    // The refusal used to talk about adjusting balances, which is not what
    // was attempted; the person then went looking for the wrong screen.
    const { adminH, emp, types } = await chainFixture();
    const otherEmp = await mkEmployee(adminH);
    const res = await fileLeave(emp.headers, {
      employee_id: otherEmp,
      leave_type_id: types["CL"],
      from_date: plusDays(40),
      to_date: plusDays(40),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).toMatch(/filing leave for somebody else/i);
    expect(body.message).toMatch(/leave\.admin/);
  });

  it("refuses leave for somebody who has left (422 EMPLOYEE_INACTIVE)", async () => {
    // It used to answer "insufficient balance", which is the wrong problem.
    const { adminH, types } = await chainFixture();
    const gone = await mkEmployee(adminH);
    await activateEmployee(gone);
    const exit = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${gone}/exit`,
      headers: adminH,
      payload: { exit_date: "2025-01-31", reason: "resigned" },
    });
    expect(exit.statusCode).toBe(200);
    const res = await fileLeave(adminH, {
      employee_id: gone,
      leave_type_id: types["CL"],
      from_date: plusDays(40),
      to_date: plusDays(40),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("EMPLOYEE_INACTIVE");
  });

  it("rejects upserts without leave.admin (403 EMPLOYEE)", async () => {
    const { emp, eId, types } = await chainFixture();
    const res = await setBalance(emp.headers, eId, types["CL"] as string, yr(plusDays(30)), 5);
    expect(res.statusCode).toBe(403);
  });

  it("lets anyone read OWN balances but gates others behind leave.read", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const other = await mkUser(["EMPLOYEE"], "other");
    const otherEmp = await mkEmployee(adminH);
    await linkUser(other.id, otherEmp);
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 9);

    // Own (no employee_id param, no leave.read needed) → 200.
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/leave/balances?period_year=${yr(from)}`,
      headers: emp.headers,
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { data: unknown[] }).data.length).toBe(1);

    // Other's → 403 for a role with no leave grants at all.
    // (NOTE: the S0 seed grants every EMPLOYEE the legacy `leave.read`
    // code, so EMPLOYEEs pass `leave.read` gates; CLIENT_VIEWER — granted
    // nothing in S0/S1/S2/S3 — is the true negative here.)
    const outsider = await mkUser(["CLIENT_VIEWER"], "outsider");
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/leave/balances?employee_id=${otherEmp}&period_year=${yr(from)}`,
      headers: outsider.headers,
    });
    expect(denied.statusCode).toBe(403);

    // AUDITOR carries leave.read → 200.
    const auditor = await mkUser(["AUDITOR"], "aud");
    const allowed = await app.inject({
      method: "GET",
      url: `/api/v1/leave/balances?employee_id=${otherEmp}&period_year=${yr(from)}`,
      headers: auditor.headers,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("defaults period_year to the current IST year", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const probe = plusDays(30);
    await setBalance(adminH, eId, types["EL"] as string, yr(probe), 7);
    const got = await app.inject({
      method: "GET",
      url: "/api/v1/leave/balances",
      headers: emp.headers,
    });
    expect(got.statusCode).toBe(200);
    const rows = (got.json() as { data: Array<{ period_year: number }> }).data;
    expect(rows.length).toBe(1);
    expect(rows[0]?.period_year).toBe(yr(probe));
  });
});

// ------------------------------------------------------------------ create

describe("leave request create", () => {
  it("creates happy-path with TL step1 + admin step2 chain", async () => {
    const { emp, tl, adminId, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    const to = plusDays(34);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: to,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      employee_id: string;
      leave_type_id: string;
      from_date: string;
      to_date: string;
      total_days: number;
      status: string;
      current_approver_id: string;
      version: number;
    };
    expect(body.employee_id).toBe(eId);
    expect(body.from_date).toBe(from);
    expect(body.to_date).toBe(to);
    expect(body.total_days).toBe(5);
    expect(body.status).toBe("PENDING");
    expect(body.version).toBe(1);
    expect(body.current_approver_id).toBe(tl.id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${body.id}`,
      headers: emp.headers,
    });
    const chain = (
      detail.json() as {
        approval_chain: Array<{ step: number; approver_user_id: string; status: string }>;
      }
    ).approval_chain;
    expect(chain.length).toBe(2);
    expect(chain[0]).toMatchObject({ step: 1, approver_user_id: tl.id, status: "PENDING" });
    expect(chain[1]).toMatchObject({ step: 2, approver_user_id: adminId, status: "PENDING" });
  });

  it("rejects from > to (422 DATE_RANGE)", async () => {
    const { emp, types } = await chainFixture();
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: plusDays(34),
      to_date: plusDays(30),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("DATE_RANGE");
  });

  it("requires a reason for past dates (422 REASON_REQUIRED)", async () => {
    const { emp, types } = await chainFixture();
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: minusDays(10),
      to_date: minusDays(8),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("REASON_REQUIRED");
  });

  it("accepts past dates with a reason", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = minusDays(10);
    await setBalance(adminH, eId, types["SL"] as string, yr(from), 10);
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["SL"],
      from_date: from,
      to_date: minusDays(8),
      reason: "was sick, filing late",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { total_days: number }).total_days).toBe(3);
  });

  it("rejects over-balance requests with the exact available (422 INSUFFICIENT_BALANCE)", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 2);
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; available: number };
    expect(body.code).toBe("INSUFFICIENT_BALANCE");
    expect(body.available).toBe(2);
  });

  it("rejects overlap with a PENDING request (422 LEAVE_OVERLAP)", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    const first = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    const clash = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: plusDays(32),
      to_date: plusDays(36),
    });
    expect(clash.statusCode).toBe(422);
    const body = clash.json() as {
      code: string;
      conflicting_request_ids: string[];
    };
    expect(body.code).toBe("LEAVE_OVERLAP");
    expect(body.conflicting_request_ids).toContain(firstId);
  });

  it("rejects overlap with an APPROVED request", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    const first = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    const reqId = (first.json() as { id: string }).id;
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(step1.statusCode).toBe(200);
    const step2 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    expect((step2.json() as { status: string }).status).toBe("APPROVED");
    const clash = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: plusDays(33),
      to_date: plusDays(33),
    });
    expect(clash.statusCode).toBe(422);
    expect((clash.json() as { code: string }).code).toBe("LEAVE_OVERLAP");
  });

  it("rejects dates covered by attendance records (422 ATTENDANCE_CONFLICT)", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    await pool.query(
      "INSERT INTO attendance_records (employee_id, work_date) VALUES ($1::uuid, $2::date)",
      [eId, plusDays(31)],
    );
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      code: string;
      message: string;
      conflicting_dates: string[];
    };
    expect(body.code).toBe("ATTENDANCE_CONFLICT");
    expect(body.message).toMatch(/regularize/i);
    expect(body.conflicting_dates).toContain(plusDays(31));
  });

  it("skips self-approval: a TL requester gets a chain starting at HR/admin", async () => {
    const adminH = await adminHeaders();
    const types = await typeMap(adminH);
    const adminRow = await pool.query("SELECT id FROM users WHERE username = $1", [
      ADMIN_USERNAME,
    ]);
    const adminId = (adminRow.rows[0] as { id: string }).id;
    const lead = await mkUser(["TEAM_LEAD", "EMPLOYEE"], "leadself");
    const tId = await mkEmployee(adminH); // reports_to null → no step1
    await linkUser(lead.id, tId);
    const from = plusDays(30);
    await setBalance(adminH, tId, types["EL"] as string, yr(from), 15);
    const res = await fileLeave(lead.headers, {
      leave_type_id: types["EL"],
      from_date: from,
      to_date: plusDays(31),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { current_approver_id: string };
    expect(body.current_approver_id).toBe(adminId);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${(res.json() as { id: string }).id}`,
      headers: lead.headers,
    });
    const chain = (
      detail.json() as {
        approval_chain: Array<{ approver_user_id: string }>;
      }
    ).approval_chain;
    expect(chain.length).toBe(1);
    expect(chain[0]?.approver_user_id).toBe(adminId);
  });

  it("requires a UUID Idempotency-Key (422 MISSING_IDEMPOTENCY_KEY)", async () => {
    const { emp, types } = await chainFixture();
    const noKey = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: emp.headers,
      payload: {
        leave_type_id: types["CL"],
        from_date: plusDays(30),
        to_date: plusDays(30),
      },
    });
    expect(noKey.statusCode).toBe(422);
    expect((noKey.json() as { code: string }).code).toBe(
      "MISSING_IDEMPOTENCY_KEY",
    );
  });

  it("rejects a non-UUID Idempotency-Key", async () => {
    const { emp, types } = await chainFixture();
    const res = await fileLeave(
      emp.headers,
      {
        leave_type_id: types["CL"],
        from_date: plusDays(30),
        to_date: plusDays(30),
      },
      "not-a-uuid",
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe(
      "MISSING_IDEMPOTENCY_KEY",
    );
  });

  it("replays a duplicate Idempotency-Key (200 applied, same request, one row)", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const key = randomUUID();
    const body = {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    };
    const first = await fileLeave(emp.headers, body, key);
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { id: string }).id;
    const replay = await fileLeave(emp.headers, body, key);
    expect(replay.statusCode).toBe(200);
    const replayBody = replay.json() as {
      applied: boolean;
      request: { id: string };
    };
    expect(replayBody.applied).toBe(true);
    expect(replayBody.request.id).toBe(firstId);
    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM leave_requests WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("skips the balance check for LOP", async () => {
    const { emp, eId, types } = await chainFixture();
    const from = plusDays(30);
    // No balance row at all — LOP must still file.
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["LOP"],
      from_date: from,
      to_date: plusDays(32),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { total_days: number }).total_days).toBe(3);
    const rows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});

// ------------------------------------------------------------------ chain unit

describe("assembleApprovalChain", () => {
  it("returns null when every step is skipped (NO_APPROVER)", () => {
    expect(
      assembleApprovalChain({
        requesterUserId: "u1",
        step1UserId: "u1",
        step2UserId: null,
      }),
    ).toBeNull();
    expect(
      assembleApprovalChain({
        requesterUserId: "u1",
        step1UserId: null,
        step2UserId: null,
      }),
    ).toBeNull();
  });

  it("skips self steps and dedupes a repeated approver", () => {
    const chain = assembleApprovalChain({
      requesterUserId: "u1",
      step1UserId: "u1",
      step2UserId: "u2",
    });
    expect(chain?.length).toBe(1);
    expect(chain?.[0]).toMatchObject({ step: 1, approver_user_id: "u2" });
    const dup = assembleApprovalChain({
      requesterUserId: "u9",
      step1UserId: "u2",
      step2UserId: "u2",
    });
    expect(dup?.length).toBe(1);
  });
});

// ------------------------------------------------------------------ decisions

describe("leave decisions", () => {
  it("rejects a decision without approval permission before loading the request", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    const stranger = await mkUser(["EMPLOYEE"], "stranger");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...stranger.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("FORBIDDEN");
  });

  it("advances the chain on step-1 approve and debits the ledger on final approve", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    const reqId = (created.json() as { id: string }).id;
    const adminRow = await pool.query("SELECT id FROM users WHERE username = $1", [
      ADMIN_USERNAME,
    ]);
    const adminId = (adminRow.rows[0] as { id: string }).id;

    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE", note: "looks fine" },
    });
    expect(step1.statusCode).toBe(200);
    const mid = step1.json() as {
      status: string;
      current_approver_id: string;
      version: number;
    };
    expect(mid.status).toBe("PENDING");
    expect(mid.current_approver_id).toBe(adminId);
    expect(mid.version).toBe(2);
    // No debit until final approval.
    const pre = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect(Number((pre.rows[0] as { consumed: string }).consumed)).toBe(0);

    const step2 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    expect(step2.statusCode).toBe(200);
    const done = step2.json() as {
      status: string;
      current_approver_id: string | null;
      version: number;
    };
    expect(done.status).toBe("APPROVED");
    expect(done.current_approver_id).toBeNull();
    expect(done.version).toBe(3);
    const post = await pool.query(
      `SELECT consumed, (opening_balance + credits - consumed + adjustments) AS current_balance
       FROM leave_balances WHERE employee_id = $1::uuid`,
      [eId],
    );
    expect(Number((post.rows[0] as { consumed: string }).consumed)).toBe(5);
    expect(Number((post.rows[0] as { current_balance: string }).current_balance)).toBe(7);
  });

  it("closes on decide: double-decide is 422 with no double debit", async () => {
    const { emp, eId, types } = await chainFixture();
    // Single-step chain (no reports_to → admin only).
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [
      eId,
    ]);
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(34),
    });
    const reqId = (created.json() as { id: string }).id;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect((first.json() as { status: string }).status).toBe("APPROVED");
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    expect(again.statusCode).toBe(422);
    expect((again.json() as { code: string }).code).toBe("REQUEST_CLOSED");
    const bal = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect(Number((bal.rows[0] as { consumed: string }).consumed)).toBe(5);
  });

  it("requires a note to reject (422 NOTE_REQUIRED), then rejects", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    const bare = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "REJECT" },
    });
    expect(bare.statusCode).toBe(422);
    expect((bare.json() as { code: string }).code).toBe("NOTE_REQUIRED");
    const noted = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "REJECT", note: "sprint lockdown" },
    });
    expect(noted.statusCode).toBe(200);
    expect((noted.json() as { status: string }).status).toBe("REJECTED");
  });

  it("409s a stale If-Match version", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "999" },
      payload: { decision: "APPROVE" },
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { code: string }).code).toBe("VERSION_CONFLICT");
  });

  it("writes audit rows for decisions (with note)", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE", note: "enjoy!" },
    });
    const audit = await pool.query(
      `SELECT reason, action FROM audit_events
       WHERE action = 'leave.request.decide' AND entity_id = $1::uuid`,
      [reqId],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe("enjoy!");
  });

  it("never debits LOP on final approval", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["LOP"],
      from_date: from,
      to_date: plusDays(31),
    });
    const reqId = (created.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    const fin = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    expect((fin.json() as { status: string }).status).toBe("APPROVED");
    const rows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});

// ------------------------------------------------------------------ cancel

describe("leave cancel", () => {
  it("lets the requester cancel a PENDING request", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/cancel`,
      headers: emp.headers,
      payload: { reason: "plans changed" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("CANCELLED");
  });

  it("refuses to cancel an APPROVED request (422)", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/cancel`,
      headers: emp.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("blocks other users (403) but lets leave.admin cancel", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;
    const stranger = await mkUser(["EMPLOYEE"], "cancelstranger");
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/cancel`,
      headers: stranger.headers,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    const byAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/cancel`,
      headers: adminH,
      payload: { reason: "admin override" },
    });
    expect(byAdmin.statusCode).toBe(200);
    expect((byAdmin.json() as { status: string }).status).toBe("CANCELLED");
  });
});

// ------------------------------------------------------------------ list/get

describe("leave request list + get", () => {
  it("defaults to own (+ approver queue for deciders); mine/approver_me narrow it", async () => {
    const { emp, tl, eId, mId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    await setBalance(adminH, mId, types["CL"] as string, yr(from), 30);
    await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    // TEAM_LEAD carries leave.request (field-lead self-service) in addition
    // to leave.read/decide, so a TL can file their OWN leave.
    const tlFiling = await fileLeave(tl.headers, {
      leave_type_id: types["CL"],
      from_date: plusDays(40),
      to_date: plusDays(40),
    });
    expect(tlFiling.statusCode).toBe(201);
    expect((tlFiling.json() as { status: string }).status).toBe("PENDING");

    // Requester default: only own.
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: emp.headers,
    });
    expect(mine.statusCode).toBe(200);
    const mineRows = (mine.json() as { data: Array<{ employee_id: string }> }).data;
    expect(mineRows.length).toBe(1);
    expect(mineRows[0]?.employee_id).toBe(eId);

    // TL default: approver queue includes the subordinate's request.
    const queue = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: tl.headers,
    });
    const queueRows = (queue.json() as { data: Array<{ employee_id: string }> }).data;
    expect(queueRows.some((r) => r.employee_id === eId)).toBe(true);

    // approver_me narrows to the queue.
    const onlyQueue = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests?approver_me=true",
      headers: tl.headers,
    });
    const onlyQueueRows = (
      onlyQueue.json() as { data: Array<{ employee_id: string }> }
    ).data;
    expect(onlyQueueRows.length).toBeGreaterThan(0);
    expect(onlyQueueRows.every((r) => r.employee_id === eId)).toBe(true);
  });

  it("gates employee_id + status filters and paginates with cursors", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    for (const day of [30, 40, 50]) {
      const r = await fileLeave(emp.headers, {
        leave_type_id: types["CL"],
        from_date: plusDays(day),
        to_date: plusDays(day),
      });
      expect(r.statusCode).toBe(201);
    }
    // A role with no leave grants cannot filter by another employee.
    const other = await mkUser(["CLIENT_VIEWER"], "filterother");
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employee_id=${eId}`,
      headers: other.headers,
    });
    expect(denied.statusCode).toBe(403);
    // leave.read (admin) can, with status + cursor pagination.
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employee_id=${eId}&status=PENDING&limit=2`,
      headers: adminH,
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json() as {
      data: unknown[];
      next_cursor: string | null;
      has_more: boolean;
    };
    expect(p1.data.length).toBe(2);
    expect(p1.has_more).toBe(true);
    expect(typeof p1.next_cursor).toBe("string");
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employee_id=${eId}&status=PENDING&limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`,
      headers: adminH,
    });
    const p2 = page2.json() as { data: unknown[]; has_more: boolean };
    expect(p2.data.length).toBe(1);
    expect(p2.has_more).toBe(false);
    const approved = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests?employee_id=${eId}&status=APPROVED`,
      headers: adminH,
    });
    expect((approved.json() as { data: unknown[] }).data.length).toBe(0);
  });

  it("scopes GET :id to own/decide/read", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = plusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: plusDays(30),
    });
    const reqId = (created.json() as { id: string }).id;

    const own = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${reqId}`,
      headers: emp.headers,
    });
    expect(own.statusCode).toBe(200);
    const detail = own.json() as {
      approval_chain: Array<{
        step: number;
        approver_user_id: string;
        status: string;
        decided_at: string | null;
        note: string | null;
      }>;
    };
    expect(detail.approval_chain.length).toBe(2);
    expect(detail.approval_chain[0]).toMatchObject({
      step: 1,
      status: "PENDING",
      decided_at: null,
      note: null,
    });

    const stranger = await mkUser(["CLIENT_VIEWER"], "nosy");
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${reqId}`,
      headers: stranger.headers,
    });
    expect(denied.statusCode).toBe(403);

    const auditor = await mkUser(["AUDITOR"], "seer");
    const seen = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${reqId}`,
      headers: auditor.headers,
    });
    expect(seen.statusCode).toBe(200);

    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${reqId}`,
    });
    expect(anon.statusCode).toBe(401);
  });
});
