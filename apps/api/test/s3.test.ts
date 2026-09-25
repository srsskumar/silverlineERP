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
import { runLeaveYearOpen } from "../src/modules/jobs/leaveYearOpen.js";

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

/**
 * `plusDays(n)`, nudged forward a day at a time until it is a working day.
 * A single-day *paid* request on a Sunday is refused outright (422
 * ALL_DAYS_EXCLUDED, D-012), so probes that only care about chains,
 * decisions, overlap or idempotency must not land their lone day on one by
 * accident of the run's calendar. Holidays need no check here: beforeEach
 * truncates them and the seed creates none, so any holiday a test adds is
 * one it placed deliberately, after picking its dates.
 */
function workingPlusDays(n: number): string {
  let d = n;
  let date = plusDays(d);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) {
    d += 1;
    date = plusDays(d);
  }
  return date;
}

function minusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

function yr(day: string): number {
  return Number(day.slice(0, 4));
}

/** The server buckets leave years by IST; this mirrors it for open-year tests. */
function currentTestYear(): number {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(
      new Date(),
    ),
  );
}

/**
 * Calendar days in [from, to] that are not a Sunday (D-012 sandwich rule for
 * PAID leave; these fixtures configure no holidays, so Sunday is the only
 * exclusion). Used instead of a hardcoded day count so these tests do not
 * depend on which day of the week "today + N" happens to land on.
 */
function workingDaysCount(from: string, to: string): number {
  let n = 0;
  let cur = from;
  while (cur <= to) {
    if (new Date(`${cur}T00:00:00Z`).getUTCDay() !== 0) n += 1;
    cur = isoDay(new Date(new Date(`${cur}T00:00:00Z`).getTime() + 86_400_000));
  }
  return n;
}

/** The next date on/after `anchor` that falls on UTC weekday `dow` (0=Sun..6=Sat). */
function nextWeekday(anchor: string, dow: number): string {
  let d = anchor;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== dow) {
    d = isoDay(new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000));
  }
  return d;
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

/** The create response doesn't carry `approval_chain` (only the detail
 * GET does) -- this fetches it directly. */
async function chainOfRequest(
  id: string,
  headers: Record<string, string>,
): Promise<Array<{ step: number; approver_user_id: string; status: string }>> {
  const res = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${id}`, headers });
  return (res.json() as { approval_chain: Array<{ step: number; approver_user_id: string; status: string }> })
    .approval_chain;
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
    const from = workingPlusDays(30);
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
    const from = workingPlusDays(30);
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
      from_date: workingPlusDays(40),
      to_date: workingPlusDays(40),
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
      from_date: workingPlusDays(40),
      to_date: workingPlusDays(40),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("EMPLOYEE_INACTIVE");
  });

  it("rejects upserts without leave.admin (403 EMPLOYEE)", async () => {
    const { emp, eId, types } = await chainFixture();
    const res = await setBalance(emp.headers, eId, types["CL"] as string, yr(workingPlusDays(30)), 5);
    expect(res.statusCode).toBe(403);
  });

  it("lets anyone read OWN balances but gates others behind leave.read", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const other = await mkUser(["EMPLOYEE"], "other");
    const otherEmp = await mkEmployee(adminH);
    await linkUser(other.id, otherEmp);
    const from = workingPlusDays(30);
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
    const probe = workingPlusDays(30);
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

// ------------------------------------------------------------- open-year

function openYear(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  query = "",
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/leave-balances/open-year${query}`,
    headers,
    payload: body,
  });
}

describe("leave balances: open-year (R5-008)", () => {
  it("creates a balance row for every active employee x balance-requiring type, at the type's entitlement", async () => {
    const { adminH, eId, mId, types } = await chainFixture();
    const nextYear = currentTestYear() + 1;
    const res = await openYear(adminH, { year: nextYear });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: { year: number; created: number; skipped: number; total: number } }).data;
    // 2 active employees (mId, eId) x 3 balance-requiring types (CL, SL, EL) = 6.
    expect(body.year).toBe(nextYear);
    expect(body.total).toBe(6);
    expect(body.created).toBe(6);
    expect(body.skipped).toBe(0);
    void types;

    const rows = await pool.query(
      `SELECT b.opening_balance, t.code FROM leave_balances b
       JOIN leave_types t ON t.id = b.leave_type_id
       WHERE b.employee_id = $1::uuid AND b.period_year = $2 ORDER BY t.code`,
      [eId, nextYear],
    );
    expect(rows.rows.map((r: any) => r.code)).toEqual(["CL", "EL", "SL"]);
    const byCode = Object.fromEntries(rows.rows.map((r: any) => [r.code, Number(r.opening_balance)]));
    expect(byCode["CL"]).toBe(12);
    expect(byCode["EL"]).toBe(15);
    expect(byCode["SL"]).toBe(12);

    // LOP does not require a balance -- it must not get a row.
    const lop = await pool.query(
      `SELECT 1 FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id
       WHERE b.employee_id = $1::uuid AND b.period_year = $2 AND t.code = 'LOP'`,
      [eId, nextYear],
    );
    expect(lop.rowCount).toBe(0);
    void mId;
  });

  it("is idempotent: a second run creates nothing and leaves existing rows untouched", async () => {
    const { adminH, eId, types } = await chainFixture();
    const nextYear = currentTestYear() + 1;
    // Manually adjust one balance first, as if HR had already opened it.
    await setBalance(adminH, eId, types["CL"] as string, nextYear, 999);

    const res = await openYear(adminH, { year: nextYear });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: { created: number; skipped: number; total: number } }).data;
    expect(body.total).toBe(6);
    expect(body.skipped).toBe(1); // the CL row already existed
    expect(body.created).toBe(5);

    // The pre-existing row was left alone (not overwritten to the standard 12).
    const bal = await pool.query(
      `SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3`,
      [eId, types["CL"], nextYear],
    );
    expect(Number((bal.rows[0] as { opening_balance: number }).opening_balance)).toBe(999);

    // Running it again a second time creates nothing at all.
    const again = await openYear(adminH, { year: nextYear });
    expect((again.json() as { data: { created: number } }).data.created).toBe(0);
  });

  it("filters by leave_type_ids and employee_ids", async () => {
    const { adminH, eId, mId, types } = await chainFixture();
    const nextYear = currentTestYear() + 1;
    const res = await openYear(adminH, {
      year: nextYear,
      employee_ids: [eId],
      leave_type_ids: [types["CL"]],
    });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: { created: number; total: number } }).data;
    expect(body.total).toBe(1);
    expect(body.created).toBe(1);

    const eRows = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, nextYear],
    );
    expect((eRows.rows[0] as { n: number }).n).toBe(1);
    const mRows = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [mId, nextYear],
    );
    expect((mRows.rows[0] as { n: number }).n).toBe(0);
  });

  it("dry-run reports counts but writes nothing", async () => {
    const { adminH, eId } = await chainFixture();
    const nextYear = currentTestYear() + 1;
    const res = await openYear(adminH, { year: nextYear }, "?dry_run=1");
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: { created: number; filled: number; total: number; dry_run: boolean } }).data;
    expect(body.dry_run).toBe(true);
    expect(body.total).toBe(6);
    // Fix round 1: dry-run now reports the real would-be classification
    // counts (created/filled/skipped), not a placeholder 0 the UI had to
    // derive total-skipped from -- 6 fresh pairs would all be created.
    expect(body.created).toBe(6);
    expect(body.filled).toBe(0);
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, nextYear],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("rejects a year outside current/next (422)", async () => {
    const { adminH } = await chainFixture();
    const res = await openYear(adminH, { year: currentTestYear() + 5 });
    expect(res.statusCode).toBe(422);
  });

  it("fix round 1, item 5: resolves 'current year' from the org's own timezone, not a fixed IST", async () => {
    const { adminH } = await chainFixture();
    // Any valid IANA zone that is not Asia/Kolkata -- this only has to prove
    // the query actually reads organizations.settings->>'timezone' instead
    // of a hardcoded one, not that the year value itself differs today.
    await pool.query(
      "UPDATE organizations SET settings = jsonb_set(settings, '{timezone}', '\"Pacific/Kiritimati\"') WHERE id = $1",
      [orgId],
    );
    const expectedYear = Number(
      (
        await pool.query(
          "SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Pacific/Kiritimati'))::int AS y",
        )
      ).rows[0].y,
    );
    const outOfRange = await openYear(adminH, { year: expectedYear + 5 });
    expect(outOfRange.statusCode).toBe(422);
    expect((outOfRange.json() as { message: string }).message).toContain(String(expectedYear));
  });

  it("fix round 1, item 5: defaults the omitted year to the org's own next year", async () => {
    const { adminH } = await chainFixture();
    await pool.query(
      "UPDATE organizations SET settings = jsonb_set(settings, '{timezone}', '\"Pacific/Kiritimati\"') WHERE id = $1",
      [orgId],
    );
    const expectedYear = Number(
      (
        await pool.query(
          "SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Pacific/Kiritimati'))::int AS y",
        )
      ).rows[0].y,
    );
    const res = await openYear(adminH, {}, "?dry_run=1");
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { year: number } }).data.year).toBe(expectedYear + 1);
  });

  it("requires leave.admin, not just leave.read (403)", async () => {
    const { emp } = await chainFixture();
    const res = await openYear(emp.headers, { year: currentTestYear() + 1 });
    expect(res.statusCode).toBe(403);
  });

  it("never creates balances for another organisation's employees or types", async () => {
    const { adminH, eId } = await chainFixture();
    const nextYear = currentTestYear() + 1;
    const other = await pool.query(
      "INSERT INTO organizations (name) VALUES ('R5-008 other org') RETURNING id",
    );
    const otherOrgId = (other.rows[0] as { id: string }).id;
    const otherEmp = await pool.query(
      `INSERT INTO employees (org_id, emp_no, first_name, phone, date_of_joining, status)
       VALUES ($1, 'OTHR001', 'Other', '+911234567890', '2024-01-01', 'ACTIVE') RETURNING id`,
      [otherOrgId],
    );
    const otherEmpId = (otherEmp.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO leave_types (org_id, code, name, is_paid, annual_entitlement, requires_balance, active)
       VALUES ($1, 'CL', 'Casual Leave', true, 12, true, true)`,
      [otherOrgId],
    );

    const res = await openYear(adminH, { year: nextYear });
    expect(res.statusCode).toBe(200);

    const otherRows = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid",
      [otherEmpId],
    );
    expect((otherRows.rows[0] as { n: number }).n).toBe(0);
    void eId;
  });
});

describe("R5-008 fix round 1, item 1: a year touched for zero days gets no empty row", () => {
  it("files no row for a year a paid request costs nothing in, and open-year opens it properly afterward", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const y = currentTestYear();
    // Two holidays, not an incidental Sunday, so this reproduces regardless
    // of what weekday 31 Dec happens to fall on in the year the suite runs.
    await mkHoliday(adminH, `${y + 1}-01-01`, "New Year");
    await mkHoliday(adminH, `${y + 1}-01-02`, "Bank holiday");
    await setBalance(adminH, eId, types["CL"] as string, y, 10);

    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: `${y}-12-31`,
      to_date: `${y + 1}-01-02`,
      reason: "year-end zero-share check",
    });
    expect(filed.statusCode).toBe(201);
    // Only 31 Dec counts; both days of y+1 are holidays.
    expect((filed.json() as { total_days: number }).total_days).toBe(1);
    const reqId = (filed.json() as { id: string }).id;

    const noRowYet = await pool.query(
      "SELECT 1 FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [eId, types["CL"], y + 1],
    );
    expect(noRowYet.rowCount).toBe(0);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);

    // Still no row for y+1 after approval -- the debit loop skips a
    // zero-day year too, not just the balance-check loop at filing.
    const stillNoRow = await pool.query(
      "SELECT 1 FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [eId, types["CL"], y + 1],
    );
    expect(stillNoRow.rowCount).toBe(0);

    // Open-year for y+1 creates a fresh row at full entitlement -- it must
    // not find a leftover empty row and skip it as "already open".
    const opened = await openYear(adminH, {
      year: y + 1,
      employee_ids: [eId],
      leave_type_ids: [types["CL"] as string],
    });
    expect(opened.statusCode).toBe(200);
    const openedBody = (opened.json() as { data: { created: number; filled: number; skipped: number } }).data;
    expect(openedBody).toMatchObject({ created: 1, filled: 0, skipped: 0 });

    const finalBal = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [eId, types["CL"], y + 1],
    );
    expect(Number((finalBal.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);
  });

  it("open-year fills a leftover self-healed empty row instead of skipping it, but never touches a manually-set 0", async () => {
    const { adminH, eId, types } = await chainFixture();
    const y = currentTestYear() + 1;
    // Simulate the historical bug (or any other path) leaving a genuinely
    // empty, untouched row behind for one employee...
    const selfHealed = await pool.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, period_year)
       VALUES ($1::uuid, $2::uuid, $3) RETURNING id`,
      [eId, types["CL"], y],
    );
    const selfHealedId = (selfHealed.rows[0] as { id: string }).id;

    // ...and a second employee whose row is *also* all-zero, but was set
    // that way deliberately through the manual adjust dialog.
    const other = await mkEmployee(adminH);
    await activateEmployee(other);
    await setBalance(adminH, other, types["CL"] as string, y, 0);

    const opened = await openYear(adminH, { year: y });
    expect(opened.statusCode).toBe(200);
    const body = (opened.json() as { data: { created: number; filled: number; skipped: number; total: number } }).data;
    expect(body.filled).toBe(1);
    // The manually-set-to-0 row must count as already open, not fillable.
    expect(body.skipped).toBeGreaterThanOrEqual(1);

    const healedNow = await pool.query("SELECT opening_balance FROM leave_balances WHERE id = $1::uuid", [
      selfHealedId,
    ]);
    expect(Number((healedNow.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);

    const manualStillZero = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [other, types["CL"], y],
    );
    expect(Number((manualStillZero.rows[0] as { opening_balance: number }).opening_balance)).toBe(0);

    // Running it again does not re-fill the now-legitimately-open row.
    const again = await openYear(adminH, { year: y });
    expect((again.json() as { data: { filled: number } }).data.filled).toBe(0);
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
    // The person, not only their id: the list and the detail print the name.
    expect((body as { employee_name?: string }).employee_name).toBe("S3 User");
    expect((body as { employee_emp_no?: string }).employee_emp_no).toMatch(/^S3E/);
    expect(body.from_date).toBe(from);
    expect(body.to_date).toBe(to);
    // CL is paid: a Sunday inside the range (D-012 sandwich rule) is not debited.
    expect(body.total_days).toBe(workingDaysCount(from, to));
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
    expect((detail.json() as { employee_name?: string }).employee_name).toBe("S3 User");
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
      from_date: workingPlusDays(33),
      to_date: workingPlusDays(33),
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
    await activateEmployee(tId);
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
        from_date: workingPlusDays(30),
        to_date: workingPlusDays(30),
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
        from_date: workingPlusDays(30),
        to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const key = randomUUID();
    const body = {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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

// --------------------------------------------------------- D-012 sandwich

async function mkHoliday(
  headers: Record<string, string>,
  date: string,
  name = "Sandwich-rule test holiday",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/holidays",
    headers,
    payload: { date, name, type: "national" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

function previewLeave(
  headers: Record<string, string>,
  params: { leave_type_id: string; from_date: string; to_date: string; employee_id?: string },
) {
  const q = new URLSearchParams({
    leave_type_id: params.leave_type_id,
    from_date: params.from_date,
    to_date: params.to_date,
    ...(params.employee_id ? { employee_id: params.employee_id } : {}),
  });
  return app.inject({
    method: "GET",
    url: `/api/v1/leave/preview?${q.toString()}`,
    headers,
  });
}

describe("GET /leave/preview (fix round 1, item 2)", () => {
  it("returns exactly what filing would charge, matching daysByYear + the sandwich rule", async () => {
    const { emp, types } = await chainFixture();
    const friday = nextWeekday(plusDays(60), 5);
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    const res = await previewLeave(emp.headers, {
      leave_type_id: types["CL"] as string,
      from_date: friday,
      to_date: monday,
    });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as {
      data: { total_days: number; is_paid: boolean; years: Array<{ year: number; days: number }> };
    }).data;
    expect(body.is_paid).toBe(true);
    expect(body.total_days).toBe(3);
    expect(body.years).toEqual([{ year: yr(friday), days: 3 }]);
  });

  it("matches what filing actually charges for the same range (no separate opinion)", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    const friday = nextWeekday(plusDays(60), 5);
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    await setBalance(adminH, eId, types["CL"] as string, yr(friday), 10);
    const preview = await previewLeave(emp.headers, {
      leave_type_id: types["CL"] as string,
      from_date: friday,
      to_date: monday,
    });
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: friday,
      to_date: monday,
    });
    expect((preview.json() as { data: { total_days: number } }).data.total_days).toBe(
      (filed.json() as { total_days: number }).total_days,
    );
  });

  it("counts every calendar day for an unpaid type, ignoring holidays", async () => {
    const { emp, types } = await chainFixture();
    const friday = nextWeekday(plusDays(60), 5);
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    const res = await previewLeave(emp.headers, {
      leave_type_id: types["LOP"] as string,
      from_date: friday,
      to_date: monday,
    });
    expect((res.json() as { data: { total_days: number; is_paid: boolean } }).data).toMatchObject({
      total_days: 4,
      is_paid: false,
    });
  });

  it("requires auth (401 anon)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/leave/preview" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects to_date before from_date (422 DATE_RANGE)", async () => {
    const { emp, types } = await chainFixture();
    const res = await previewLeave(emp.headers, {
      leave_type_id: types["CL"] as string,
      from_date: plusDays(34),
      to_date: plusDays(30),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("DATE_RANGE");
  });

  it("404s an unknown leave type", async () => {
    const { emp } = await chainFixture();
    const res = await previewLeave(emp.headers, {
      leave_type_id: randomUUID(),
      from_date: plusDays(30),
      to_date: plusDays(31),
    });
    expect(res.statusCode).toBe(404);
  });

  it("blocks previewing somebody else's leave without leave.admin (403)", async () => {
    const { emp, types } = await chainFixture();
    const otherEmp = await mkEmployee(await adminHeaders());
    const res = await previewLeave(emp.headers, {
      leave_type_id: types["CL"] as string,
      from_date: plusDays(30),
      to_date: plusDays(31),
      employee_id: otherEmp,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets leave.admin preview on behalf of someone else, using their holiday scope", async () => {
    const { adminH, eId, types } = await chainFixture();
    const res = await previewLeave(adminH, {
      leave_type_id: types["CL"] as string,
      from_date: plusDays(30),
      to_date: plusDays(31),
      employee_id: eId,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("D-012 sandwich rule: paid leave does not debit Sundays/holidays", () => {
  it("excludes only the Sunday from a Fri-Mon paid range with no holiday configured (3 of 4 days)", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const friday = nextWeekday(plusDays(60), 5);
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    await setBalance(adminH, eId, types["CL"] as string, yr(friday), 10);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: friday,
      to_date: monday,
    });
    expect(filed.statusCode).toBe(201);
    const reqId = (filed.json() as { id: string; total_days: number }).id;
    expect((filed.json() as { total_days: number }).total_days).toBe(3);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);
    const bal = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, yr(friday)],
    );
    expect(Number((bal.rows[0] as { consumed: string }).consumed)).toBe(3);
  });

  it("also excludes a holiday inside the range (Fri-Mon with a Saturday holiday debits 2)", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const friday = nextWeekday(plusDays(60), 5);
    const saturday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 86_400_000));
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    await mkHoliday(adminH, saturday);
    await setBalance(adminH, eId, types["CL"] as string, yr(friday), 10);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: friday,
      to_date: monday,
    });
    expect(filed.statusCode).toBe(201);
    expect((filed.json() as { total_days: number }).total_days).toBe(2);
    const reqId = (filed.json() as { id: string }).id;

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);
    const bal = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, yr(friday)],
    );
    expect(Number((bal.rows[0] as { consumed: string }).consumed)).toBe(2);
  });

  it("counts every calendar day for the identical range as unpaid LOP (4 of 4)", async () => {
    const { emp, eId, types } = await chainFixture();
    void eId;
    const friday = nextWeekday(plusDays(60), 5);
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    // LOP requires no balance row at all.
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["LOP"],
      from_date: friday,
      to_date: monday,
    });
    expect(filed.statusCode).toBe(201);
    expect((filed.json() as { total_days: number }).total_days).toBe(4);
  });

  it("does not exclude an inactive (withdrawn) holiday", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const friday = nextWeekday(plusDays(60), 5);
    const saturday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 86_400_000));
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    const holidayId = await mkHoliday(adminH, saturday);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/holidays/${holidayId}`,
      headers: adminH,
      payload: { active: false, reason: "wrongly declared" },
    });
    await setBalance(adminH, eId, types["CL"] as string, yr(friday), 10);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: friday,
      to_date: monday,
    });
    expect(filed.statusCode).toBe(201);
    // Withdrawn holiday no longer excludes its date -- back to Sunday-only (3).
    expect((filed.json() as { total_days: number }).total_days).toBe(3);
  });

  it("splits a year-crossing paid request by year, each year's own Sundays excluded (D-011 + D-012)", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const y = currentTestYear() + 1; // stay clear of any other test's balance rows for "this" year
    const from = `${y}-12-28`;
    const to = `${y + 1}-01-03`;
    const decDays = workingDaysCount(from, `${y}-12-31`);
    const janDays = workingDaysCount(`${y + 1}-01-01`, to);
    await setBalance(adminH, eId, types["CL"] as string, y, 10);
    await setBalance(adminH, eId, types["CL"] as string, y + 1, 10);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: to,
      reason: "year-end sandwich check",
    });
    expect(filed.statusCode).toBe(201);
    expect((filed.json() as { total_days: number }).total_days).toBe(decDays + janDays);
    const reqId = (filed.json() as { id: string }).id;

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);
    const rows = await pool.query(
      `SELECT period_year, consumed::float8 AS consumed FROM leave_balances
       WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid ORDER BY period_year`,
      [eId, types["CL"]],
    );
    expect(rows.rows).toEqual([
      { period_year: y, consumed: decDays },
      { period_year: y + 1, consumed: janDays },
    ]);
    // Both years actually have at least one Sunday excluded, or this test
    // proves nothing: 4 calendar days in Dec, 3 in Jan, 7 total, and any
    // 7-day span has exactly one Sunday.
    expect(decDays + janDays).toBe(6);
  });

  it("fix round 1, item 4: a paid range that is entirely Sundays/holidays is refused, not filed as 0 days", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const saturday = nextWeekday(plusDays(60), 6);
    const sunday = isoDay(new Date(new Date(`${saturday}T00:00:00Z`).getTime() + 86_400_000));
    await mkHoliday(adminH, saturday);
    await setBalance(adminH, eId, types["CL"] as string, yr(saturday), 10);
    const res = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: saturday,
      to_date: sunday,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("ALL_DAYS_EXCLUDED");
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((count.rows[0] as { n: number }).n).toBe(0);
  });

  it("fix round 2, item 3: refuses to approve a request holidays have reduced to zero days since filing", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const day = nextWeekday(plusDays(60), 3);
    await setBalance(adminH, eId, types["CL"] as string, yr(day), 10);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: day, to_date: day });
    expect(filed.statusCode).toBe(201);
    expect((filed.json() as { total_days: number }).total_days).toBe(1);
    const reqId = (filed.json() as { id: string }).id;

    // A holiday lands on that exact day before anyone decides it.
    await mkHoliday(adminH, day);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(422);
    expect((decided.json() as { code: string }).code).toBe("ALL_DAYS_EXCLUDED");

    const stillPending = await pool.query(
      "SELECT status, total_days, version FROM leave_requests WHERE id = $1::uuid",
      [reqId],
    );
    const row = stillPending.rows[0] as { status: string; total_days: number; version: number };
    expect(row.status).toBe("PENDING");
    // Unchanged from filing -- a refused approval does not touch the row.
    expect(Number(row.total_days)).toBe(1);
    expect(row.version).toBe(1);

    const noDebit = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, yr(day)],
    );
    expect(Number((noDebit.rows[0] as { consumed: number }).consumed)).toBe(0);
  });
});

describe("leave step-2 approver: HR manager preferred over admin (owner decision, 2026-09-24)", () => {
  it("prefers the org's HR manager over admin when one exists", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const hr = await mkUser(["HR_MANAGER"], "hr");
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: from,
    });
    expect(filed.statusCode).toBe(201);
    const reqId = (filed.json() as { id: string }).id;
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(step1.statusCode).toBe(200);
    expect((step1.json() as { current_approver_id: string }).current_approver_id).toBe(hr.id);
  });

  it("falls back to admin when no HR manager exists in the org", async () => {
    const { emp, tl, adminId, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: from,
    });
    const reqId = (filed.json() as { id: string }).id;
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect((step1.json() as { current_approver_id: string }).current_approver_id).toBe(adminId);
  });

  it("skips the applicant's own HR-manager account for the next eligible HR manager, not admin", async () => {
    const adminH = await adminHeaders();
    const hrA = await mkUser(["HR_MANAGER"], "hrA");
    const hrB = await mkUser(["HR_MANAGER"], "hrB");
    // UUIDs are not creation-ordered; determine the actual lowest-id one so
    // this deterministically exercises the applicant-exclusion path rather
    // than happening to pass either way.
    const ordered = (
      await pool.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id ASC", [
        [hrA.id, hrB.id],
      ])
    ).rows as Array<{ id: string }>;
    const applicant = ordered[0]!.id === hrA.id ? hrA : hrB;
    const expectedApprover = ordered[1]!.id;

    const empId = await mkEmployee(adminH);
    await activateEmployee(empId);
    await linkUser(applicant.id, empId);
    const types = await typeMap(adminH);
    const from = workingPlusDays(30);
    await setBalance(adminH, empId, types["CL"] as string, yr(from), 12);

    // No manager configured: single-step chain, the other HR manager decides directly.
    const filed = await fileLeave(applicant.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: from,
    });
    expect(filed.statusCode).toBe(201);
    const body = filed.json() as { current_approver_id: string };
    expect(body.current_approver_id).toBe(expectedApprover);
    expect(body.current_approver_id).not.toBe(applicant.id);
  });
});

describe("leave step-2 approver: reassigned when it becomes stale (fix round 2, item 1)", () => {
  it("reassigns a pending approval when the exiting employee was the current (step-2) approver", async () => {
    const { emp, tl, eId, adminId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const hrEmp = await mkEmployee(adminH);
    await activateEmployee(hrEmp);
    const hr = await mkUser(["HR_MANAGER"], "hrExit");
    await linkUser(hr.id, hrEmp);

    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    const reqId = (filed.json() as { id: string }).id;
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(step1.statusCode).toBe(200);
    expect((step1.json() as { current_approver_id: string }).current_approver_id).toBe(hr.id);

    const exited = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${hrEmp}/exit`,
      headers: adminH,
      payload: { exit_date: "2025-01-31", reason: "resigned" },
    });
    expect(exited.statusCode).toBe(200);
    // No other HR manager exists in this org, so the exit-flow reassignment
    // falls back to admin -- in the SAME transaction as the exit, not
    // waiting for a later read. The exit's own audit row records which
    // pending approvals it reassigned.
    const exitAudit = await pool.query(
      "SELECT after_state FROM audit_events WHERE action = 'employee.exit' AND entity_id = $1::uuid",
      [hrEmp],
    );
    const exitOffboarding = (exitAudit.rows[0] as { after_state: { offboarding: { reassigned_approval_request_ids: string[] } } })
      .after_state.offboarding;
    expect(exitOffboarding.reassigned_approval_request_ids).toContain(reqId);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${reqId}`, headers: adminH });
    expect((got.json() as { current_approver_id: string }).current_approver_id).toBe(adminId);

    const audit = await pool.query(
      "SELECT after_state, actor_id FROM audit_events WHERE action = 'leave.request.reassign_approver' AND entity_id = $1::uuid",
      [reqId],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { actor_id: string }).actor_id).toBe(
      (await pool.query("SELECT id FROM users WHERE username = $1", [ADMIN_USERNAME])).rows[0].id,
    );
  });

  it("re-resolves a disabled (not exited) approver on the next read, and the new approver can then decide", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const hrA = await mkUser(["HR_MANAGER"], "hrA");
    const hrB = await mkUser(["HR_MANAGER"], "hrB");
    const ordered = (
      await pool.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id ASC", [
        [hrA.id, hrB.id],
      ])
    ).rows as Array<{ id: string }>;
    const first = ordered[0]!.id === hrA.id ? hrA : hrB;
    const next = ordered[1]!.id === hrA.id ? hrA : hrB;

    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    const reqId = (filed.json() as { id: string }).id;
    const step1 = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect((step1.json() as { current_approver_id: string }).current_approver_id).toBe(first.id);

    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [first.id]);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${reqId}`, headers: adminH });
    const afterRead = got.json() as { current_approver_id: string; version: number };
    expect(afterRead.current_approver_id).toBe(next.id);

    // The newly-resolved approver can decide it immediately, using the
    // version GET just returned (proves the version bump was reflected).
    const decide = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...next.headers, "If-Match": String(afterRead.version) },
      payload: { decision: "APPROVE" },
    });
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { status: string }).status).toBe("APPROVED");
  });

  it("re-resolves a disabled approver directly on a decide attempt too, not only on a prior read", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const hrA = await mkUser(["HR_MANAGER"], "hrA2");
    const hrB = await mkUser(["HR_MANAGER"], "hrB2");
    const ordered = (
      await pool.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id ASC", [
        [hrA.id, hrB.id],
      ])
    ).rows as Array<{ id: string }>;
    const first = ordered[0]!.id === hrA.id ? hrA : hrB;
    const next = ordered[1]!.id === hrA.id ? hrA : hrB;

    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    const reqId = (filed.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [first.id]);

    // `next` was never told the version changed (no read happened) --
    // decides straight off the version they know from filing/step-1.
    const decide = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...next.headers, "If-Match": "2" },
      payload: { decision: "APPROVE" },
    });
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { status: string }).status).toBe("APPROVED");
  });

  it("never reassigns to the applicant, even when they are otherwise the lowest-id eligible HR manager", async () => {
    const adminH = await adminHeaders();
    const hrApplicant = await mkUser(["HR_MANAGER"], "hrSelf");
    const hrOriginal = await mkUser(["HR_MANAGER"], "hrOrig");
    const empId = await mkEmployee(adminH);
    await activateEmployee(empId);
    await linkUser(hrApplicant.id, empId);
    const types = await typeMap(adminH);
    const from = workingPlusDays(30);
    await setBalance(adminH, empId, types["CL"] as string, yr(from), 12);

    const filed = await fileLeave(hrApplicant.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: from,
    });
    expect(filed.statusCode).toBe(201);
    const body = filed.json() as { id: string; current_approver_id: string };
    // Already guaranteed by step2Approver's own exclusion at filing time --
    // confirms the fixture, not the fix under test.
    expect(body.current_approver_id).not.toBe(hrApplicant.id);
    expect(body.current_approver_id).toBe(hrOriginal.id);

    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [hrOriginal.id]);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${body.id}`, headers: adminH });
    const reassignedTo = (got.json() as { current_approver_id: string }).current_approver_id;
    expect(reassignedTo).not.toBe(hrApplicant.id);
    expect(reassignedTo).not.toBe(hrOriginal.id);
    expect(reassignedTo).toBeTruthy();
  });
});

describe("leave step-1 approver: reassigned when it becomes stale (fix round 3, item 1, controller ruling)", () => {
  it("reassigns to the exiting approver's own reporting manager", async () => {
    const adminH = await adminHeaders();
    const types = await typeMap(adminH);

    // Three-level chain: gm manages tlEmp, tlEmp manages eId (the
    // applicant). gm is a plain TEAM_LEAD (holds leave.decide, so it
    // qualifies as a step-1 fallback) but not HR/admin, so it is never in
    // the running for this request's step-2 slot -- no duplicate concern
    // to entangle with (that's the next test).
    const gm = await mkUser(["TEAM_LEAD"], "gm1");
    const gId = await mkEmployee(adminH);
    await activateEmployee(gId);
    await linkUser(gm.id, gId);

    const tl = await mkUser(["TEAM_LEAD"], "tl1");
    const tlEmp = await mkEmployee(adminH, { reports_to: gId });
    await activateEmployee(tlEmp);
    await linkUser(tl.id, tlEmp);

    const emp = await mkUser(["EMPLOYEE"], "emp1");
    const eId = await mkEmployee(adminH, { reports_to: tlEmp });
    await activateEmployee(eId);
    await linkUser(emp.id, eId);

    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    expect(filed.statusCode).toBe(201);
    const body = filed.json() as { id: string; current_approver_id: string };
    // Step 1 (tl) is current immediately after filing; step 2 fell back to
    // admin (no HR manager in this org) -- confirms the fixture.
    expect(body.current_approver_id).toBe(tl.id);
    const chainBefore = await chainOfRequest(body.id, adminH);
    const stepTwoApprover = chainBefore.find((s) => s.step === 2)?.approver_user_id;
    expect(stepTwoApprover).toBeTruthy();
    expect(stepTwoApprover).not.toBe(gm.id);

    const exited = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${tlEmp}/exit`,
      headers: adminH,
      payload: { exit_date: "2025-01-31", reason: "resigned" },
    });
    expect(exited.statusCode).toBe(200);

    const exitAudit = await pool.query(
      "SELECT after_state FROM audit_events WHERE action = 'employee.exit' AND entity_id = $1::uuid",
      [tlEmp],
    );
    const offboarding = (
      exitAudit.rows[0] as { after_state: { offboarding: { reassigned_approval_request_ids: string[] } } }
    ).after_state.offboarding;
    expect(offboarding.reassigned_approval_request_ids).toContain(body.id);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${body.id}`, headers: adminH });
    const after = got.json() as { current_approver_id: string; approval_chain: Array<{ step: number; approver_user_id: string }> };
    // Reassigned to tl's own manager, gm -- step 2's approver untouched.
    expect(after.current_approver_id).toBe(gm.id);
    expect(after.approval_chain.find((s) => s.step === 1)?.approver_user_id).toBe(gm.id);
    expect(after.approval_chain.find((s) => s.step === 2)?.approver_user_id).toBe(stepTwoApprover);
  });

  it("falls back to the org's HR manager when the exited approver had no manager of their own", async () => {
    const { emp, tl, eId, adminId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    const body = filed.json() as { id: string; current_approver_id: string };
    // No HR manager exists yet, so step 2 fell back to admin -- confirms
    // the fixture (tl's own employee record has no reports_to either).
    expect(body.current_approver_id).toBe(tl.id);

    // An HR manager appears only after filing -- available for step 1's
    // own fallback, and distinct from step 2's already-assigned admin.
    const hr = await mkUser(["HR_MANAGER"], "hrLate");

    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [tl.id]);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${body.id}`, headers: adminH });
    const after = got.json() as { current_approver_id: string };
    expect(after.current_approver_id).toBe(hr.id);
    void adminId;
  });

  it("skips an HR manager who is themselves the applicant, falling back to admin", async () => {
    const adminH = await adminHeaders();
    // Two admins: the seeded one plus a second, so a fallback that must
    // skip whichever admin already holds step 2 still has one left.
    const admin2 = await mkUser(["ADMIN"], "admin2r3");

    const hrApplicant = await mkUser(["HR_MANAGER"], "hrSelfR3");
    const tl = await mkUser(["TEAM_LEAD"], "tlR3");
    const tlEmp = await mkEmployee(adminH);
    await activateEmployee(tlEmp);
    await linkUser(tl.id, tlEmp);

    const empId = await mkEmployee(adminH, { reports_to: tlEmp });
    await activateEmployee(empId);
    await linkUser(hrApplicant.id, empId);

    const types = await typeMap(adminH);
    const from = workingPlusDays(30);
    await setBalance(adminH, empId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(hrApplicant.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: from,
    });
    expect(filed.statusCode).toBe(201);
    const body = filed.json() as { id: string; current_approver_id: string };
    // Step 1 is tl; step 2 already fell back to *an* admin at filing time,
    // since the only HR manager is the applicant themselves (excluded).
    expect(body.current_approver_id).toBe(tl.id);
    const chainBefore = await chainOfRequest(body.id, adminH);
    const stepTwoAdmin = chainBefore.find((s) => s.step === 2)?.approver_user_id;
    expect(stepTwoAdmin).toBeTruthy();

    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [tl.id]);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${body.id}`, headers: adminH });
    const after = got.json() as { current_approver_id: string };
    // Never the HR manager (they're the applicant), never the applicant,
    // never the admin already sitting at step 2 -- lands on the other admin.
    expect(after.current_approver_id).not.toBe(hrApplicant.id);
    expect(after.current_approver_id).not.toBe(stepTwoAdmin);
    expect(after.current_approver_id).toBeTruthy();
    const roleRow = await pool.query(
      `SELECT r.code FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1::uuid`,
      [after.current_approver_id],
    );
    const roleCodes3 = (roleRow.rows as Array<{ code: string }>).map((r) => r.code);
    expect(roleCodes3.some((c) => c === "ADMIN" || c === "SUPER_ADMIN")).toBe(true);
    void admin2;
  });

  it("skips a manager candidate that would duplicate the request's step-2 approver, falling further down the cascade", async () => {
    const adminH = await adminHeaders();
    // gm is both tl's own reporting manager AND the org's only HR manager
    // -- so gm is already this request's step-2 approver by the time tl
    // (step 1) needs reassigning. The naive "reassign to your manager"
    // fallback would duplicate gm onto both steps; it must be skipped.
    const gm = await mkUser(["HR_MANAGER"], "gmDup");
    const gId = await mkEmployee(adminH);
    await activateEmployee(gId);
    await linkUser(gm.id, gId);

    const tl = await mkUser(["TEAM_LEAD"], "tlDup");
    const tlEmp = await mkEmployee(adminH, { reports_to: gId });
    await activateEmployee(tlEmp);
    await linkUser(tl.id, tlEmp);

    const emp = await mkUser(["EMPLOYEE"], "empDup");
    const eId = await mkEmployee(adminH, { reports_to: tlEmp });
    await activateEmployee(eId);
    await linkUser(emp.id, eId);

    const types = await typeMap(adminH);
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(emp.headers, { leave_type_id: types["CL"], from_date: from, to_date: from });
    const body = filed.json() as { id: string; current_approver_id: string };
    expect(body.current_approver_id).toBe(tl.id);
    const chainBefore = await chainOfRequest(body.id, adminH);
    expect(chainBefore.find((s) => s.step === 2)?.approver_user_id).toBe(gm.id);

    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [tl.id]);

    const got = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${body.id}`, headers: adminH });
    const after = got.json() as { current_approver_id: string };
    // Not gm (would duplicate step 2, whether reached via "tl's manager"
    // or via the HR tier -- gm is the org's only HR manager either way);
    // falls all the way through to admin instead.
    expect(after.current_approver_id).not.toBe(gm.id);
    expect(after.current_approver_id).not.toBe(tl.id);
    expect(after.current_approver_id).toBeTruthy();
    const roleRow = await pool.query(
      `SELECT r.code FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1::uuid`,
      [after.current_approver_id],
    );
    const roleCodes4 = (roleRow.rows as Array<{ code: string }>).map((r) => r.code);
    expect(roleCodes4.some((c) => c === "ADMIN" || c === "SUPER_ADMIN")).toBe(true);
  });
});

/**
 * Fixes the job's "what is this org's current (year, month)" answer for a
 * test, since there is no way to fake Postgres's own `now()`. Round 1's
 * tests (mechanics: create/fill/skip/audit) force January of the current
 * test year, so they keep exercising the same year they always did
 * regardless of what month the suite actually runs in; round 2's gate
 * tests force whichever month each scenario needs.
 */
function forceOrgDate(year: number, month: number) {
  return async () => ({ year, month });
}

describe("automatic leave year-open (owner decision, 2026-09-24, item (b))", () => {
  it("opens the org's current year automatically, calling the same logic the manual button uses", async () => {
    const { eId, types } = await chainFixture();
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(currentTestYear(), 1) });
    expect(result.orgsOpened).toBeGreaterThanOrEqual(1);

    const y = currentTestYear();
    const runRow = await pool.query(
      "SELECT created, filled, skipped, total FROM leave_year_open_runs WHERE org_id = $1 AND year = $2",
      [orgId, y],
    );
    expect(runRow.rowCount).toBe(1);

    const bal = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [eId, types["CL"], y],
    );
    expect(Number((bal.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);

    // Audited as a system actor, not a human -- distinguishable from a
    // manual run in the trail.
    const audit = await pool.query(
      `SELECT actor_id, after_state FROM audit_events
       WHERE org_id = $1 AND action = 'leave.balance.open_year'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    );
    expect((audit.rows[0] as { actor_id: string | null }).actor_id).toBeNull();
    expect((audit.rows[0] as { after_state: { triggered_by: string } }).after_state.triggered_by).toBe(
      "scheduled_job",
    );
  });

  it("does not re-run for an org/year it has already opened", async () => {
    await chainFixture();
    const y = currentTestYear();
    const dateOverride = { resolveOrgDate: forceOrgDate(y, 1) };
    const first = await runLeaveYearOpen(pool, dateOverride);
    expect(first.orgsOpened).toBeGreaterThanOrEqual(1);
    const countBefore = (
      await pool.query("SELECT count(*)::int AS n FROM leave_balances WHERE period_year = $1", [y])
    ).rows[0] as { n: number };

    const second = await runLeaveYearOpen(pool, dateOverride);
    // This org (and every other already-opened one) is not processed again.
    const countAfter = (
      await pool.query("SELECT count(*)::int AS n FROM leave_balances WHERE period_year = $1", [y])
    ).rows[0] as { n: number };
    expect(countAfter.n).toBe(countBefore.n);
    void second;

    const runRows = await pool.query(
      "SELECT count(*)::int AS n FROM leave_year_open_runs WHERE org_id = $1 AND year = $2",
      [orgId, y],
    );
    expect((runRows.rows[0] as { n: number }).n).toBe(1);
  });

  it("opens every active org independently, each with its own tracking row", async () => {
    const { eId, types } = await chainFixture();
    const other = await pool.query(
      "INSERT INTO organizations (name) VALUES ('Leave year-open job: other org') RETURNING id",
    );
    const otherOrgId = (other.rows[0] as { id: string }).id;
    const otherEmp = await pool.query(
      `INSERT INTO employees (org_id, emp_no, first_name, phone, date_of_joining, status)
       VALUES ($1, 'JOBE001', 'Other', '+911234500000', '2024-01-01', 'ACTIVE') RETURNING id`,
      [otherOrgId],
    );
    const otherEmpId = (otherEmp.rows[0] as { id: string }).id;
    const otherType = await pool.query(
      `INSERT INTO leave_types (org_id, code, name, is_paid, annual_entitlement, requires_balance, active)
       VALUES ($1, 'CL', 'Casual Leave', true, 12, true, true) RETURNING id`,
      [otherOrgId],
    );
    const otherTypeId = (otherType.rows[0] as { id: string }).id;

    const y = currentTestYear();
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(y, 1) });
    expect(result.orgsOpened).toBeGreaterThanOrEqual(2);

    const mainBal = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [eId, types["CL"], y],
    );
    expect(Number((mainBal.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);
    const otherBal = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3",
      [otherEmpId, otherTypeId, y],
    );
    expect(Number((otherBal.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);

    const runs = await pool.query(
      "SELECT org_id FROM leave_year_open_runs WHERE year = $1 AND org_id = ANY($2::uuid[])",
      [y, [orgId, otherOrgId]],
    );
    expect(runs.rowCount).toBe(2);
  });

  it("targets only the org's current year -- a prior year already marked open does not block this year", async () => {
    // The per-(org, year) tracking is exactly that -- per year, not a
    // one-time-ever flag -- so a year already marked open never blocks a
    // *different* year, and the job never reaches past the org's own
    // current year into a different one. (The month gate itself is
    // covered separately, below -- "fix round 2, item 2".)
    const { eId } = await chainFixture();
    const y = currentTestYear();
    await pool.query(
      "INSERT INTO leave_year_open_runs (org_id, year, created, filled, skipped, total) VALUES ($1, $2, 0, 0, 0, 0)",
      [orgId, y - 1],
    );
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(y, 1) });
    expect(result.orgsOpened).toBeGreaterThanOrEqual(1);

    const thisYearRow = await pool.query(
      "SELECT 1 FROM leave_year_open_runs WHERE org_id = $1 AND year = $2",
      [orgId, y],
    );
    expect(thisYearRow.rowCount).toBe(1);

    const nextYearBal = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, y + 1],
    );
    expect((nextYearBal.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("automatic leave year-open: date gate (fix round 2, item 2, controller ruling)", () => {
  it("24 September -> no-op (deploying mid-year must not backfill the current year early)", async () => {
    const { eId } = await chainFixture();
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(2026, 9) });
    expect(result.orgsOpened).toBe(0);
    const runs = await pool.query(
      "SELECT count(*)::int AS n FROM leave_year_open_runs WHERE org_id = $1",
      [orgId],
    );
    expect((runs.rows[0] as { n: number }).n).toBe(0);
    const bal = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((bal.rows[0] as { n: number }).n).toBe(0);
  });

  it("1 January -> opens", async () => {
    const { eId, types } = await chainFixture();
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(2027, 1) });
    expect(result.orgsOpened).toBeGreaterThanOrEqual(1);
    const bal = await pool.query(
      "SELECT opening_balance FROM leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = 2027",
      [eId, types["CL"]],
    );
    expect(Number((bal.rows[0] as { opening_balance: number }).opening_balance)).toBe(12);
  });

  it("15 January -> opens once, idempotent with the (org, year) run key", async () => {
    await chainFixture();
    const first = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(2027, 1) });
    expect(first.orgsOpened).toBeGreaterThanOrEqual(1);
    const second = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(2027, 1) });
    expect(second.orgsOpened).toBe(0);
    const runs = await pool.query(
      "SELECT count(*)::int AS n FROM leave_year_open_runs WHERE org_id = $1 AND year = 2027",
      [orgId],
    );
    expect((runs.rows[0] as { n: number }).n).toBe(1);
  });

  it("1 February -> no-op (the window has closed)", async () => {
    const { eId } = await chainFixture();
    const result = await runLeaveYearOpen(pool, { resolveOrgDate: forceOrgDate(2027, 2) });
    expect(result.orgsOpened).toBe(0);
    const runs = await pool.query(
      "SELECT count(*)::int AS n FROM leave_year_open_runs WHERE org_id = $1",
      [orgId],
    );
    expect((runs.rows[0] as { n: number }).n).toBe(0);
    const bal = await pool.query(
      "SELECT count(*)::int AS n FROM leave_balances WHERE employee_id = $1::uuid",
      [eId],
    );
    expect((bal.rows[0] as { n: number }).n).toBe(0);
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const to = plusDays(34);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: to,
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
    // CL is paid: a Sunday inside the range (D-012 sandwich rule) is not debited.
    const debited = workingDaysCount(from, to);
    expect(Number((post.rows[0] as { consumed: string }).consumed)).toBe(debited);
    expect(Number((post.rows[0] as { current_balance: string }).current_balance)).toBe(12 - debited);
  });

  it("closes on decide: double-decide is 422 with no double debit", async () => {
    const { emp, eId, types } = await chainFixture();
    // Single-step chain (no reports_to → admin only).
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [
      eId,
    ]);
    const adminH = await adminHeaders();
    const from = plusDays(30);
    const to = plusDays(34);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: to,
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
    expect(Number((bal.rows[0] as { consumed: string }).consumed)).toBe(workingDaysCount(from, to));
  });

  it("requires a note to reject (422 NOTE_REQUIRED), then rejects", async () => {
    const { emp, tl, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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

  it("fix round 1, item 3: recomputes total_days/debited_days at approval when a holiday was added since filing", async () => {
    const { adminH, emp, eId, types } = await chainFixture();
    await pool.query("UPDATE employees SET reports_to = NULL WHERE id = $1::uuid", [eId]);
    const friday = nextWeekday(plusDays(60), 5);
    const saturday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 86_400_000));
    const monday = isoDay(new Date(new Date(`${friday}T00:00:00Z`).getTime() + 3 * 86_400_000));
    await setBalance(adminH, eId, types["CL"] as string, yr(friday), 10);

    // Filed before any holiday exists: only the Sunday is excluded (3 of 4).
    const filed = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: friday,
      to_date: monday,
    });
    expect(filed.statusCode).toBe(201);
    expect((filed.json() as { total_days: number }).total_days).toBe(3);
    expect((filed.json() as { debited_days: unknown }).debited_days).toEqual([]);
    const reqId = (filed.json() as { id: string }).id;

    // A holiday lands on the Saturday before anyone gets to approve it.
    await mkHoliday(adminH, saturday);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...adminH, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(decided.statusCode).toBe(200);
    const decidedBody = decided.json() as { total_days: number; debited_days: Array<{ year: number; days: number }> };
    // total_days is now 2 (Fri+Mon), not the 3 stored at filing -- one
    // source of truth, matching what was actually debited.
    expect(decidedBody.total_days).toBe(2);
    expect(decidedBody.debited_days).toEqual([{ year: yr(friday), days: 2 }]);

    const bal = await pool.query(
      "SELECT consumed FROM leave_balances WHERE employee_id = $1::uuid AND period_year = $2",
      [eId, yr(friday)],
    );
    expect(Number((bal.rows[0] as { consumed: string }).consumed)).toBe(2);

    // The detail view shows the same, corrected figure -- not the one
    // originally quoted at filing.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${reqId}`,
      headers: adminH,
    });
    expect((got.json() as { total_days: number }).total_days).toBe(2);
  });
});

// ------------------------------------------------------------------ cancel

describe("leave cancel", () => {
  it("lets the requester cancel a PENDING request", async () => {
    const { emp, eId, types } = await chainFixture();
    const adminH = await adminHeaders();
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    await setBalance(adminH, mId, types["CL"] as string, yr(from), 30);
    await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
    });
    // TEAM_LEAD carries leave.request (field-lead self-service) in addition
    // to leave.read/decide, so a TL can file their OWN leave.
    const tlFiling = await fileLeave(tl.headers, {
      leave_type_id: types["CL"],
      from_date: workingPlusDays(40),
      to_date: workingPlusDays(40),
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
    const mineRows = (mine.json() as { data: Array<{ employee_id: string; employee_name?: string }> }).data;
    expect(mineRows.length).toBe(1);
    expect(mineRows[0]?.employee_id).toBe(eId);
    expect(mineRows[0]?.employee_name).toBe("S3 User");

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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 30);
    for (const day of [30, 40, 50]) {
      const r = await fileLeave(emp.headers, {
        leave_type_id: types["CL"],
        from_date: workingPlusDays(day),
        to_date: workingPlusDays(day),
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
    const from = workingPlusDays(30);
    await setBalance(adminH, eId, types["CL"] as string, yr(from), 12);
    const created = await fileLeave(emp.headers, {
      leave_type_id: types["CL"],
      from_date: from,
      to_date: workingPlusDays(30),
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

describe("leave: the next step's approver is re-checked when the request advances (review A, items 3 and 4)", () => {
  async function stepOneFiled() {
    const fx = await chainFixture();
    const adminH = await adminHeaders();
    const hrEmp = await mkEmployee(adminH);
    await activateEmployee(hrEmp);
    const hr = await mkUser(["HR_MANAGER"], "hrNext");
    await linkUser(hr.id, hrEmp);
    const from = workingPlusDays(30);
    await setBalance(adminH, fx.eId, fx.types["CL"] as string, yr(from), 12);
    const filed = await fileLeave(fx.emp.headers, { leave_type_id: fx.types["CL"], from_date: from, to_date: from });
    expect(filed.statusCode).toBe(201);
    const body = filed.json() as { id: string; approval_chain?: Array<{ approver_user_id: string }> };
    const chain = (await pool.query("SELECT approval_chain FROM leave_requests WHERE id = $1::uuid", [body.id]))
      .rows[0].approval_chain as Array<{ approver_user_id: string }>;
    expect(chain[1]?.approver_user_id).toBe(hr.id);
    return { ...fx, adminH, hr, hrEmp, reqId: body.id };
  }

  async function approveStep1(tlHeaders: Record<string, string>, reqId: string) {
    // An exit-time reassignment bumps the version, so read it rather than assume 1.
    const v = (await pool.query("SELECT version FROM leave_requests WHERE id = $1::uuid", [reqId])).rows[0].version;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tlHeaders, "If-Match": String(v) },
      payload: { decision: "APPROVE" },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { current_approver_id: string; status: string };
  }

  it("hands step 2 to the next eligible person when its named approver was disabled while step 1 was pending", async () => {
    const { tl, adminId, hr, reqId } = await stepOneFiled();
    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [hr.id]);
    const advanced = await approveStep1(tl.headers, reqId);
    expect(advanced.status).toBe("PENDING");
    expect(advanced.current_approver_id).toBe(adminId);
    // Review A, 4(b): the new approver is told.
    const told = await pool.query(
      `SELECT 1 FROM notifications WHERE recipient_id = $1::uuid AND type = 'LEAVE_APPROVER_ASSIGNED'
          AND entity_id = $2::uuid`, [adminId, reqId]);
    expect(told.rowCount).toBe(1);
  });

  it("an HR exit while step 1 is pending moves step 2 off them, and the request reaches the next approver's list", async () => {
    const { tl, adminId, adminH, hrEmp, reqId, eId } = await stepOneFiled();
    const exited = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${hrEmp}/exit`,
      headers: adminH,
      payload: { exit_date: "2025-01-31", reason: "resigned" },
    });
    expect(exited.statusCode, exited.body).toBe(200);
    const exitAudit = await pool.query(
      "SELECT after_state FROM audit_events WHERE action = 'employee.exit' AND entity_id = $1::uuid",
      [hrEmp],
    );
    expect((exitAudit.rows[0] as { after_state: { offboarding: { reassigned_approval_request_ids: string[] } } })
      .after_state.offboarding.reassigned_approval_request_ids).toContain(reqId);
    const chain = (await pool.query("SELECT approval_chain FROM leave_requests WHERE id = $1::uuid", [reqId]))
      .rows[0].approval_chain as Array<{ approver_user_id: string; status: string }>;
    expect(chain[1]).toMatchObject({ approver_user_id: adminId, status: "PENDING" });

    const advanced = await approveStep1(tl.headers, reqId);
    expect(advanced.current_approver_id).toBe(adminId);
    const queue = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests?approver_me=true",
      headers: adminH,
    });
    expect(queue.statusCode).toBe(200);
    const rows = (queue.json() as { data: Array<{ id: string; employee_id: string }> }).data;
    expect(rows.some((r) => r.id === reqId && r.employee_id === eId)).toBe(true);
  });

  it("GET :id refuses a caller who may not see the request before re-resolving anything (4(a))", async () => {
    const { tl, hr, reqId } = await stepOneFiled();
    await approveStep1(tl.headers, reqId);
    await pool.query("UPDATE users SET auth_status = 'DISABLED' WHERE id = $1::uuid", [hr.id]);
    const before = (await pool.query("SELECT version, current_approver_id FROM leave_requests WHERE id = $1::uuid", [reqId])).rows[0];
    const stranger = await mkUser(["CLIENT_VIEWER"], "nosyStale");
    const denied = await app.inject({ method: "GET", url: `/api/v1/leave/requests/${reqId}`, headers: stranger.headers });
    expect(denied.statusCode).toBe(403);
    const after = (await pool.query("SELECT version, current_approver_id FROM leave_requests WHERE id = $1::uuid", [reqId])).rows[0];
    expect(after).toEqual(before);
    const audit = await pool.query(
      "SELECT 1 FROM audit_events WHERE action = 'leave.request.reassign_approver' AND entity_id = $1::uuid", [reqId]);
    expect(audit.rowCount).toBe(0);
  });
});
