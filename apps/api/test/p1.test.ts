import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
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
let seq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const username = `p1_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const id = await createUser({ username, password: "Pass1234!", roles });
  return { id, headers: await headersFor(username, "Pass1234!") };
}

async function mkEmployee(
  over: Record<string, unknown> = {},
): Promise<string> {
  seq += 1;
  const res = await pool.query(
    `INSERT INTO employees
       (org_id, emp_no, first_name, last_name, phone, date_of_joining,
        status, designation, salary_basic, date_of_exit)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)
     RETURNING id`,
    [
      orgId,
      over["emp_no"] ?? `P1E${String(seq).padStart(5, "0")}`,
      over["first_name"] ?? "P1",
      over["last_name"] ?? "Fixture",
      over["phone"] ?? `+9184100${String(10000 + seq)}`,
      over["date_of_joining"] ?? "2024-01-15",
      over["designation"] ?? "Field Staff",
      over["salary_basic"] !== undefined ? over["salary_basic"] : 30000,
      over["date_of_exit"] ?? null,
    ],
  );
  return (res.rows[0] as { id: string }).id;
}

async function linkUser(userId: string, employeeId: string): Promise<void> {
  await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [
    employeeId,
    userId,
  ]);
}

async function addRecords(
  employeeId: string,
  days: Array<{ date: string; status: "COMPLETE" | "PARTIAL" }>,
): Promise<void> {
  for (const d of days) {
    await pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status)
       VALUES ($1::uuid, $2::date, $3)`,
      [employeeId, d.date, d.status],
    );
  }
}

async function leaveTypeId(code: string): Promise<string> {
  const res = await pool.query(
    "SELECT id FROM leave_types WHERE org_id = $1 AND code = $2",
    [orgId, code],
  );
  return (res.rows[0] as { id: string }).id;
}

async function addApprovedLeave(
  employeeId: string,
  typeCode: string,
  from: string,
  to: string,
  totalDays: number,
): Promise<void> {
  const typeId = await leaveTypeId(typeCode);
  await pool.query(
    `INSERT INTO leave_requests
       (org_id, employee_id, leave_type_id, from_date, to_date, total_days,
        status, approval_chain)
     VALUES ($1, $2::uuid, $3::uuid, $4::date, $5::date, $6, 'APPROVED', '[]')`,
    [orgId, employeeId, typeId, from, to, totalDays],
  );
}

async function mkRun(
  headers: Record<string, string>,
  start: string,
  end: string,
  key?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/payroll/runs",
    headers: key ? { ...headers, "Idempotency-Key": key } : headers,
    payload: { period_start: start, period_end: end },
  });
}

async function toStatus(
  headers: Record<string, string>,
  runId: string,
  action: "submit-review" | "approve" | "lock" | "reopen" | "calculate",
  payload?: unknown,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/payroll/runs/${runId}/${action}`,
    headers,
    payload: payload ?? {},
  });
}

async function lockChain(
  headers: Record<string, string>,
  runId: string,
  note?: string,
): Promise<void> {
  let res = await toStatus(headers, runId, "submit-review");
  expect(res.statusCode).toBe(200);
  res = await toStatus(headers, runId, "approve", note ? { note } : {});
  expect(res.statusCode).toBe(200);
  res = await toStatus(headers, runId, "lock");
  expect(res.statusCode).toBe(200);
  expect((res.json() as { status: string }).status).toBe("LOCKED");
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
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("payroll policy", () => {
  it("GET returns the seeded default {per_day_divisor:30, pf_pct:12}", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/policy",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ per_day_divisor: 30, pf_pct: 12 });
  });

  it("PATCH updates the policy (payroll.configure) and GET reflects it", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/payroll/policy",
      headers: officer.headers,
      payload: { per_day_divisor: 26, pf_pct: 10 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ per_day_divisor: 26, pf_pct: 10 });
    const get = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/policy",
      headers: officer.headers,
    });
    expect(get.json()).toEqual({ per_day_divisor: 26, pf_pct: 10 });
  });

  it("PATCH rejects divisor 0 (422)", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/payroll/policy",
      headers: h,
      payload: { per_day_divisor: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("PATCH rejects pf_pct 101 (422)", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/payroll/policy",
      headers: h,
      payload: { pf_pct: 101 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("PATCH is 403 without payroll.configure (EMPLOYEE)", async () => {
    const emp = await mkUser(["EMPLOYEE"], "emp");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/payroll/policy",
      headers: emp.headers,
      payload: { per_day_divisor: 26 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET is 403 without payroll.read (EMPLOYEE)", async () => {
    const emp = await mkUser(["EMPLOYEE"], "emp");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/policy",
      headers: emp.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Run creation + validation
// ---------------------------------------------------------------------------

describe("payroll run creation", () => {
  it("POST creates an OPEN run (201, bare shape)", async () => {
    const h = await adminHeaders();
    const res = await mkRun(h, "2026-08-01", "2026-08-05");
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      period_start: "2026-08-01",
      period_end: "2026-08-05",
      status: "OPEN",
      employee_count: 0,
    });
    expect(typeof body["id"]).toBe("string");
    expect(body["warnings"]).toEqual([]);
  });

  it("replays the same Idempotency-Key to the same run", async () => {
    const h = await adminHeaders();
    const key = randomUUID();
    const first = await mkRun(h, "2026-08-01", "2026-08-05", key);
    expect(first.statusCode).toBe(201);
    const second = await mkRun(h, "2026-08-01", "2026-08-05", key);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id,
    );
  });

  it("rejects start > end (422 DATE_RANGE)", async () => {
    const h = await adminHeaders();
    const res = await mkRun(h, "2026-08-10", "2026-08-01");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("DATE_RANGE");
  });

  it("rejects malformed dates (422)", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: h,
      payload: { period_start: "08/01/2026", period_end: "2026-08-05" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects spans over 62 days (422 PERIOD_TOO_LONG)", async () => {
    const h = await adminHeaders();
    const res = await mkRun(h, "2026-01-01", "2026-03-05");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("PERIOD_TOO_LONG");
  });

  it("rejects overlapping periods (422 OVERLAPPING_RUN)", async () => {
    const h = await adminHeaders();
    const first = await mkRun(h, "2026-08-01", "2026-08-10");
    expect(first.statusCode).toBe(201);
    const res = await mkRun(h, "2026-08-05", "2026-08-15");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("OVERLAPPING_RUN");
  });

  it("rejects overlap with a LOCKED run (no cancelled state exists)", async () => {
    const h = await adminHeaders();
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const emp = await mkEmployee({});
    await addRecords(emp, [{ date: "2026-07-02", status: "COMPLETE" }]);
    const run = await mkRun(officer.headers, "2026-07-01", "2026-07-10");
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { id: string }).id;
    let calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    await lockChain(officer.headers, runId);

    const overlap = await mkRun(h, "2026-07-05", "2026-07-15");
    expect(overlap.statusCode).toBe(422);
    expect((overlap.json() as { code: string }).code).toBe("OVERLAPPING_RUN");

    // Adjacent (non-overlapping) periods are still allowed.
    const next = await mkRun(h, "2026-07-11", "2026-07-20");
    expect(next.statusCode).toBe(201);
    void calc;
  });
});

// ---------------------------------------------------------------------------
// Listing + detail
// ---------------------------------------------------------------------------

describe("payroll run listing/detail", () => {
  it("lists with status filter and cursor envelope", async () => {
    const h = await adminHeaders();
    await mkRun(h, "2026-08-01", "2026-08-05");
    await mkRun(h, "2026-09-01", "2026-09-05");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/runs?status=OPEN&limit=1",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: unknown[];
      next_cursor: string | null;
      has_more: boolean;
    };
    expect(body.data.length).toBe(1);
    expect(body.has_more).toBe(true);
    expect(typeof body.next_cursor).toBe("string");
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/payroll/runs?status=OPEN&limit=1&cursor=${body.next_cursor}`,
      headers: h,
    });
    expect((page2.json() as { data: unknown[] }).data.length).toBe(1);
  });

  it("GET :id returns bare run + totals + warnings[]", async () => {
    const h = await adminHeaders();
    const run = await mkRun(h, "2026-08-01", "2026-08-05");
    const id = (run.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/payroll/runs/${id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id,
      status: "OPEN",
      total_gross: 0,
      total_deductions: 0,
      total_net: 0,
    });
    expect(body["warnings"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

describe("payroll calculate", () => {
  async function happyFixtures() {
    const empA = await mkEmployee({ emp_no: "P1A01", salary_basic: 30000 });
    await addRecords(empA, [
      { date: "2026-08-01", status: "COMPLETE" },
      { date: "2026-08-02", status: "COMPLETE" },
      { date: "2026-08-03", status: "COMPLETE" },
      { date: "2026-08-04", status: "COMPLETE" },
      { date: "2026-08-05", status: "COMPLETE" },
    ]);
    const empB = await mkEmployee({ emp_no: "P1B01", salary_basic: 30000 });
    await addRecords(empB, [
      { date: "2026-08-01", status: "COMPLETE" },
      { date: "2026-08-02", status: "COMPLETE" },
      { date: "2026-08-03", status: "PARTIAL" },
    ]);
    await addApprovedLeave(empB, "CL", "2026-08-04", "2026-08-05", 2);
    // Zero records, zero salary → both warnings.
    const empC = await mkEmployee({ emp_no: "P1C01", salary_basic: null });
    return { empA, empB, empC };
  }

  it("computes exact paise math over mixed fixtures", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const { empA, empB, empC } = await happyFixtures();
    const run = await mkRun(officer.headers, "2026-08-01", "2026-08-05");
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { id: string }).id;

    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    const body = calc.json() as {
      status: string;
      employee_count: number;
      total_gross: number;
      total_deductions: number;
      total_net: number;
      warnings: Array<{ type: string; employee_id: string }>;
    };
    expect(body.status).toBe("CALCULATED");
    expect(body.employee_count).toBe(3);
    // Gross 5000 + 4500 + 0; deductions are PF only, 600 + 540; net 4400 +
    // 3960. (Before the fix B's 500 of LOP came off twice: 1640 / 7860.)
    expect(body.total_gross).toBe(9500);
    expect(body.total_deductions).toBe(1140);
    expect(body.total_net).toBe(8360);
    expect(body.warnings).toHaveLength(2);
    expect(
      body.warnings.filter((w) => w.employee_id === empC).map((w) => w.type).sort(),
    ).toEqual(["NO_RECORDS", "NO_SALARY"]);

    const slips = await app.inject({
      method: "GET",
      url: `/api/v1/payroll/runs/${runId}/payslips?limit=10`,
      headers: officer.headers,
    });
    expect(slips.statusCode).toBe(200);
    const rows = (slips.json() as { data: Array<{ employee_id: string }> }).data;
    expect(rows).toHaveLength(3);

    // 1-5 Aug 2026 is Sat, Sun, Mon, Tue, Wed. Full-present slip: four working
    // days present plus Sunday the 2nd paid as a day off (the punch on it adds
    // nothing) = 5 payable; part month, so 5 x 1000 = 5000; pf 600, net 4400.
    const meA = await mkUser(["EMPLOYEE"], "empA");
    await linkUser(meA.id, empA);
    const slipA = await app.inject({
      method: "GET",
      url: "/api/v1/payslips/me?period_start=2026-08-01&period_end=2026-08-05",
      headers: meA.headers,
    });
    expect(slipA.statusCode).toBe(200);
    const a = slipA.json() as {
      earnings: Record<string, number>;
      deductions: Record<string, number>;
      gross: number;
      total_deductions: number;
      net_pay: number;
    };
    expect(a.earnings).toMatchObject({
      basic: 30000,
      per_day: 1000,
      payable_days: 5,
      present_days: 4,
      paid_leave_days: 0,
      paid_off_days: 1,
      lop_leave_days: 0,
    });
    expect(a.deductions).toMatchObject({ lop_days: 0, lop_amount: 0, pf: 600 });
    expect(a.gross).toBe(5000);
    expect(a.total_deductions).toBe(600);
    expect(a.net_pay).toBe(4400);

    // Half + CL slip. Working days 1, 3, 4, 5: present 1 (Sat) + 0.5 (Mon
    // PARTIAL), CL Tue-Wed = 2, the other half of Monday is LOP. Sunday the
    // 2nd is a paid day off. Payable 1.5 + 2 + 1 = 4.5.
    // Entitlement 5 x 1000 = 5000, lop 0.5 x 1000 = 500 -> gross 4500;
    // pf 12% of 4500 = 540; net 4500 - 540 = 3960. lop_amount is shown but
    // is already out of gross, so total_deductions is the PF alone.
    const meB = await mkUser(["EMPLOYEE"], "empB");
    await linkUser(meB.id, empB);
    const slipB = await app.inject({
      method: "GET",
      url: "/api/v1/payslips/me?period_start=2026-08-01&period_end=2026-08-05",
      headers: meB.headers,
    });
    expect(slipB.statusCode).toBe(200);
    const b = slipB.json() as {
      earnings: Record<string, number>;
      deductions: Record<string, number>;
      gross: number;
      total_deductions: number;
      net_pay: number;
    };
    expect(b.earnings).toMatchObject({
      payable_days: 4.5,
      present_days: 1.5,
      paid_leave_days: 2,
      paid_off_days: 1,
      lop_leave_days: 0,
    });
    expect(b.deductions).toMatchObject({ lop_days: 0.5, lop_amount: 500, pf: 540 });
    expect(b.gross).toBe(4500);
    expect(b.total_deductions).toBe(540);
    expect(b.net_pay).toBe(3960);
  });

  it("returns 422 NO_ATTENDANCE_DATA and leaves the run OPEN", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    await mkEmployee({ salary_basic: 30000 });
    const run = await mkRun(officer.headers, "2026-08-01", "2026-08-05");
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(422);
    expect((calc.json() as { code: string }).code).toBe("NO_ATTENDANCE_DATA");
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/payroll/runs/${runId}`,
      headers: officer.headers,
    });
    expect((get.json() as { status: string }).status).toBe("OPEN");
  });

  it("rejects a second calculate (422 RUN_SEALED)", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const emp = await mkEmployee({});
    await addRecords(emp, [{ date: "2026-08-01", status: "COMPLETE" }]);
    const run = await mkRun(officer.headers, "2026-08-01", "2026-08-05");
    const runId = (run.json() as { id: string }).id;
    const first = await toStatus(officer.headers, runId, "calculate");
    expect(first.statusCode).toBe(200);
    const second = await toStatus(officer.headers, runId, "calculate");
    expect(second.statusCode).toBe(422);
    expect((second.json() as { code: string }).code).toBe("RUN_SEALED");
  });
});

// ---------------------------------------------------------------------------
// The pay rule: LOP once, Sundays and holidays paid, employed days only
// ---------------------------------------------------------------------------

describe("payroll calculate: days that are paid", () => {
  /** Every non-Sunday date in [from, to] (August 2026 Sundays: 2, 9, 16, 23, 30). */
  function workdays(from: string, to: string): string[] {
    const out: string[] = [];
    for (
      let t = Date.parse(`${from}T00:00:00Z`);
      t <= Date.parse(`${to}T00:00:00Z`);
      t += 86_400_000
    ) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  async function presentOn(employeeId: string, dates: string[]): Promise<void> {
    await addRecords(
      employeeId,
      dates.map((date) => ({ date, status: "COMPLETE" as const })),
    );
  }

  async function calculate(start: string, end: string) {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const run = await mkRun(officer.headers, start, end);
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    return { officer, runId };
  }

  async function slipOf(runId: string, employeeId: string) {
    const res = await pool.query(
      `SELECT earnings, deductions, gross, total_deductions, net_pay, version
         FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2`,
      [runId, employeeId],
    );
    const row = res.rows[0] as
      | {
          earnings: Record<string, number>;
          deductions: Record<string, number>;
          gross: string;
          total_deductions: string;
          net_pay: string;
          version: number;
        }
      | undefined;
    return row
      ? {
          ...row,
          gross: Number(row.gross),
          total_deductions: Number(row.total_deductions),
          net_pay: Number(row.net_pay),
        }
      : undefined;
  }

  it("pays a Sunday and the employee's holiday, and counts another district's holiday as absence", async () => {
    const emp = await mkEmployee({ salary_basic: 30000 });
    // Mon 10 - Thu 13 present. Fri 14 is a holiday only for some other
    // district, so for this employee it is an unattended working day.
    await presentOn(emp, ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"]);
    await pool.query(
      `INSERT INTO holidays (org_id, date, name, type)
       VALUES ($1, '2026-08-15', 'Independence Day', 'national')`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO holidays (org_id, date, name, type, scope_type, scope_id)
       VALUES ($1, '2026-08-14', 'Elsewhere', 'local', 'district', $2::uuid)`,
      [orgId, randomUUID()],
    );

    const { runId } = await calculate("2026-08-10", "2026-08-16");
    const s = await slipOf(runId, emp);
    // 7 days: 4 present, Sat 15 (holiday) + Sun 16 paid off, Fri 14 LOP.
    // Part month: 7 x 1000 = 7000 - 1000 LOP = 6000; pf 720; net 5280.
    expect(s?.earnings).toMatchObject({
      present_days: 4,
      paid_off_days: 2,
      payable_days: 6,
    });
    expect(s?.deductions).toMatchObject({ lop_days: 1, lop_amount: 1000, pf: 720 });
    expect(s?.gross).toBe(6000);
    expect(s?.total_deductions).toBe(720);
    expect(s?.net_pay).toBe(5280);
  });

  it("pays someone who left mid-period for the days they were employed", async () => {
    const leaver = await mkEmployee({ salary_basic: 30000, date_of_exit: "2026-08-20" });
    const gone = await mkEmployee({ salary_basic: 30000, date_of_exit: "2026-07-31" });
    await pool.query(
      "UPDATE employees SET status = 'EXITED' WHERE id = ANY($1::uuid[])",
      [[leaver, gone]],
    );
    await presentOn(leaver, workdays("2026-08-01", "2026-08-20"));

    const { runId } = await calculate("2026-08-01", "2026-08-31");
    const s = await slipOf(runId, leaver);
    // 1-20 Aug: 17 working days present, Sundays 2, 9, 16 paid; nothing after
    // the exit is LOP. Part month: 20 x 1000 = 20000; pf 2400; net 17600.
    expect(s?.earnings).toMatchObject({ payable_days: 20, present_days: 17, paid_off_days: 3 });
    expect(s?.deductions).toMatchObject({ lop_days: 0, lop_amount: 0 });
    expect(s?.gross).toBe(20000);
    expect(s?.net_pay).toBe(17600);
    // Someone who left before the period is not on it at all.
    expect(await slipOf(runId, gone)).toBeUndefined();
  });

  it("pays a joiner from the joining date, not LOP for the days before it", async () => {
    const joiner = await mkEmployee({ salary_basic: 30000, date_of_joining: "2026-08-17" });
    await presentOn(joiner, workdays("2026-08-17", "2026-08-31"));

    const { runId } = await calculate("2026-08-01", "2026-08-31");
    const s = await slipOf(runId, joiner);
    // 17-31 Aug: 15 days, Sundays 23 and 30 among them; 15 x 1000 = 15000.
    expect(s?.earnings).toMatchObject({ payable_days: 15, present_days: 13, paid_off_days: 2 });
    expect(s?.deductions).toMatchObject({ lop_days: 0, lop_amount: 0, pf: 1800 });
    expect(s?.gross).toBe(15000);
    expect(s?.net_pay).toBe(13200);
  });

  it("pays a full month of attendance the monthly basic, with no LOP", async () => {
    const emp = await mkEmployee({ salary_basic: 30000 });
    await presentOn(emp, workdays("2026-08-01", "2026-08-31"));
    const { runId } = await calculate("2026-08-01", "2026-08-31");
    const s = await slipOf(runId, emp);
    // 31 days at 1000 would be 31000; a whole month is the basic, 30000.
    expect(s?.earnings).toMatchObject({ payable_days: 31, present_days: 26, paid_off_days: 5 });
    expect(s?.gross).toBe(30000);
    expect(s?.total_deductions).toBe(3600);
    expect(s?.net_pay).toBe(26400);
  });

  it("pays a day with both attendance and approved leave once", async () => {
    const emp = await mkEmployee({ salary_basic: 30000 });
    await presentOn(emp, ["2026-08-03"]);
    await addApprovedLeave(emp, "CL", "2026-08-03", "2026-08-04", 2);

    const { runId } = await calculate("2026-08-03", "2026-08-04");
    const s = await slipOf(runId, emp);
    // Monday: present (the leave adds nothing). Tuesday: CL. 2 x 1000.
    expect(s?.earnings).toMatchObject({ payable_days: 2, present_days: 1, paid_leave_days: 1 });
    expect(s?.gross).toBe(2000);
  });

  it("leaves a LOCKED run's figures alone: recalculation is refused", async () => {
    const emp = await mkEmployee({ salary_basic: 30000 });
    await presentOn(emp, ["2026-08-03"]);
    const { officer, runId } = await calculate("2026-08-03", "2026-08-05");
    await lockChain(officer.headers, runId);
    const before = await slipOf(runId, emp);

    await presentOn(emp, ["2026-08-04", "2026-08-05"]);
    const again = await toStatus(officer.headers, runId, "calculate");
    expect(again.statusCode).toBe(422);
    expect((again.json() as { code: string }).code).toBe("RUN_SEALED");
    expect(await slipOf(runId, emp)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("payroll transitions", () => {
  async function calculatedRun(
    headers: Record<string, string>,
  ): Promise<string> {
    const emp = await mkEmployee({});
    await addRecords(emp, [{ date: "2026-08-01", status: "COMPLETE" }]);
    const run = await mkRun(headers, "2026-08-01", "2026-08-05");
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    return runId;
  }

  it("chains submit → approve → lock with lock stamps", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const runId = await calculatedRun(officer.headers);
    const sub = await toStatus(officer.headers, runId, "submit-review");
    expect(sub.statusCode).toBe(200);
    expect((sub.json() as { status: string }).status).toBe("REVIEW");
    const appr = await toStatus(officer.headers, runId, "approve", {
      note: "looks good",
    });
    expect(appr.statusCode).toBe(200);
    const apprBody = appr.json() as {
      status: string;
      approved_by: string;
      approved_at: string;
    };
    expect(apprBody.status).toBe("APPROVED");
    expect(apprBody.approved_by).toBe(officer.id);
    expect(typeof apprBody.approved_at).toBe("string");
    const lock = await toStatus(officer.headers, runId, "lock");
    expect(lock.statusCode).toBe(200);
    const lockBody = lock.json() as {
      status: string;
      locked_by: string;
      locked_at: string;
    };
    expect(lockBody.status).toBe("LOCKED");
    expect(lockBody.locked_by).toBe(officer.id);
    expect(typeof lockBody.locked_at).toBe("string");
  });

  it("rejects wrong-order transitions with RUN_SEALED naming the expected state", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const runId = await calculatedRun(officer.headers);

    // approve from CALCULATED names REVIEW.
    const badApprove = await toStatus(officer.headers, runId, "approve");
    expect(badApprove.statusCode).toBe(422);
    const badApproveBody = badApprove.json() as { code: string; message: string };
    expect(badApproveBody.code).toBe("RUN_SEALED");
    expect(badApproveBody.message).toContain("REVIEW");

    // lock from CALCULATED names APPROVED.
    const badLock = await toStatus(officer.headers, runId, "lock");
    expect(badLock.statusCode).toBe(422);
    expect((badLock.json() as { message: string }).message).toContain("APPROVED");

    // submit from OPEN names CALCULATED.
    const fresh = await mkRun(officer.headers, "2026-09-01", "2026-09-05");
    const freshId = (fresh.json() as { id: string }).id;
    const badSubmit = await toStatus(officer.headers, freshId, "submit-review");
    expect(badSubmit.statusCode).toBe(422);
    expect((badSubmit.json() as { message: string }).message).toContain("CALCULATED");
  });

  it("reopen requires a reason, then works and audits", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const runId = await calculatedRun(officer.headers);
    await lockChain(officer.headers, runId);

    const noReason = await toStatus(officer.headers, runId, "reopen", {});
    expect(noReason.statusCode).toBe(422);
    expect((noReason.json() as { code: string }).code).toBe("REASON_REQUIRED");

    const blank = await toStatus(officer.headers, runId, "reopen", {
      reason: "   ",
    });
    expect(blank.statusCode).toBe(422);

    const reopen = await toStatus(officer.headers, runId, "reopen", {
      reason: "correction needed",
    });
    expect(reopen.statusCode).toBe(200);
    expect((reopen.json() as { status: string }).status).toBe("APPROVED");

    const audit = await pool.query(
      `SELECT action, reason FROM audit_events
        WHERE entity_type = 'payroll_run' AND entity_id = $1::uuid
        ORDER BY created_at ASC`,
      [runId],
    );
    const actions = (audit.rows as Array<{ action: string; reason: string | null }>)
      .map((r) => r.action);
    expect(actions).toContain("payroll.run.approve");
    expect(actions).toContain("payroll.run.lock");
    expect(actions).toContain("payroll.run.reopen");
    const reopenRow = (audit.rows as Array<{ action: string; reason: string | null }>)
      .find((r) => r.action === "payroll.run.reopen");
    expect(reopenRow?.reason).toBe("correction needed");
  });
});

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

describe("payslips", () => {
  async function calculatedWithSlip(): Promise<{
    runId: string;
    empId: string;
    officer: { id: string; headers: Record<string, string> };
  }> {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const empId = await mkEmployee({ emp_no: "P1M01", salary_basic: 30000 });
    await addRecords(empId, [{ date: "2026-08-02", status: "COMPLETE" }]);
    const run = await mkRun(officer.headers, "2026-08-01", "2026-08-05");
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    return { runId, empId, officer };
  }

  it("lists slips with emp_no / name / money fields", async () => {
    const { runId, empId, officer } = await calculatedWithSlip();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/payroll/runs/${runId}/payslips`,
      headers: officer.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        employee_id: string;
        emp_no: string;
        employee_name: string;
        gross: number;
        total_deductions: number;
        net_pay: number;
      }>;
      next_cursor: null;
      has_more: boolean;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      employee_id: empId,
      emp_no: "P1M01",
    });
    expect(typeof body.data[0]?.employee_name).toBe("string");
    expect(typeof body.data[0]?.gross).toBe("number");
    expect(body.has_more).toBe(false);
  });

  it("me returns the full slip detail with no pdf_url", async () => {
    const { empId } = await calculatedWithSlip();
    const me = await mkUser(["EMPLOYEE"], "me");
    await linkUser(me.id, empId);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payslips/me?period_start=2026-08-01&period_end=2026-08-31",
      headers: me.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      period: { start: "2026-08-01", end: "2026-08-05" },
      run_status: "CALCULATED",
    });
    expect(body["employee"]).toMatchObject({ emp_no: "P1M01" });
    for (const key of [
      "id",
      "period",
      "run_status",
      "employee",
      "earnings",
      "deductions",
      "gross",
      "total_deductions",
      "net_pay",
      "version",
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body).not.toHaveProperty("pdf_url");
  });

  it("me is 404 NO_EMPLOYEE_LINK when no employee is linked", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payslips/me",
      headers: h,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("NO_EMPLOYEE_LINK");
  });

  it("me is 404 NO_PAYSLIP for a window with no slips", async () => {
    const { empId } = await calculatedWithSlip();
    const me = await mkUser(["EMPLOYEE"], "me");
    await linkUser(me.id, empId);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payslips/me?period_start=2020-01-01&period_end=2020-01-31",
      headers: me.headers,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("NO_PAYSLIP");
  });
});

// ---------------------------------------------------------------------------
// Payroll lock guard on attendance exception decisions
// ---------------------------------------------------------------------------

describe("payroll lock guard", () => {
  it("blocks linked-record decisions in a locked period, spares unlinked ones", async () => {
    const h = await adminHeaders();
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const emp = await mkEmployee({});
    const recRes = await pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status)
       VALUES ($1::uuid, '2026-09-10', 'PARTIAL') RETURNING id`,
      [emp],
    );
    const recordId = (recRes.rows[0] as { id: string }).id;
    const adminRow = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [ADMIN_USERNAME],
    );
    const adminId = (adminRow.rows[0] as { id: string }).id;

    const linkedRes = await pool.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, source, status, submitted_by)
       VALUES ($1::uuid, $2::uuid, 'MISSED_PUNCH', 'forgot punch', 'USER', 'PENDING', $3::uuid)
       RETURNING id`,
      [emp, recordId, adminId],
    );
    const linkedId = (linkedRes.rows[0] as { id: string }).id;
    const freeRes = await pool.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, source, status, submitted_by)
       VALUES ($1::uuid, NULL, 'MISSED_PUNCH', 'regularize me', 'USER', 'PENDING', $2::uuid)
       RETURNING id`,
      [emp, adminId],
    );
    const freeId = (freeRes.rows[0] as { id: string }).id;

    const run = await mkRun(officer.headers, "2026-09-01", "2026-09-30");
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    await lockChain(officer.headers, runId);

    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${linkedId}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(blocked.statusCode).toBe(422);
    const blockedBody = blocked.json() as { code: string; message: string };
    expect(blockedBody.code).toBe("PAYROLL_LOCKED");
    expect(blockedBody.message).toContain("contact payroll");

    // No record link → date unknown → guard does not apply.
    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${freeId}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("payroll RBAC", () => {
  it("EMPLOYEE cannot generate runs (403)", async () => {
    const emp = await mkUser(["EMPLOYEE"], "emp");
    const res = await mkRun(emp.headers, "2026-08-01", "2026-08-05");
    expect(res.statusCode).toBe(403);
  });

  it("TEAM_LEAD cannot approve runs (403)", async () => {
    const officer = await mkUser(["PAYROLL_OFFICER"], "officer");
    const emp = await mkEmployee({});
    await addRecords(emp, [{ date: "2026-08-01", status: "COMPLETE" }]);
    const run = await mkRun(officer.headers, "2026-08-01", "2026-08-05");
    const runId = (run.json() as { id: string }).id;
    const calc = await toStatus(officer.headers, runId, "calculate");
    expect(calc.statusCode).toBe(200);
    const sub = await toStatus(officer.headers, runId, "submit-review");
    expect(sub.statusCode).toBe(200);
    const tl = await mkUser(["TEAM_LEAD"], "tl");
    const appr = await toStatus(tl.headers, runId, "approve");
    expect(appr.statusCode).toBe(403);
  });
});
