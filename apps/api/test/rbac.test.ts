import {testDatabaseUrl} from "./database.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import {
  expandGeoScope,
  resolveScopes,
  villagesInScope,
} from "../src/common/scopes.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  seedDatabase,
} from "../src/database/seed.js";

/**
 * RBAC contract tests (PRD §4 Table 3): 10 roles × representative endpoints,
 * scope-filtered reads (village / project / team), the attendance
 * self-decision guard, and unit tests for the pure scope helpers.
 */

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let seq = 0;

function tag(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE roster_entries, work_shifts, resource_allocations, stock_count_lines, stock_counts, stock_reservations, bank_transactions, payment_allocations, payments, financial_periods, project_categories, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, stock_locations, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, geo_fence_employee_assignments, device_registrations, audit_events, sessions, idempotency_keys, user_roles,
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
  /** [role, scopeType, scopeId][] — a missing scope entry = global row. */
  roles?: Array<{ role: string; scopeType?: string; scopeId?: string }>;
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, opts.username, hash],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const r of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [
      r.role,
    ]);
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4)",
      [id, (role.rows[0] as { id: string }).id, r.scopeType ?? null, r.scopeId ?? null],
    );
  }
  return id;
}

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}

async function adminHeaders() {
  return headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
}

async function mkUser(
  roles: Array<{ role: string; scopeType?: string; scopeId?: string }>,
  prefix: string,
): Promise<{ id: string; headers: Record<string, string> }> {
  const u = tag(`rbac_${prefix}`);
  const id = await createUser({ username: u, password: "Pass1234!", roles });
  return { id, headers: await headersFor(u, "Pass1234!") };
}

async function mkUnit(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/org/units",
    headers,
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/** district → mandal → two villages; returns all four ids. */
async function geoFixture(headers: Record<string, string>) {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const district = await mkUnit(headers, {
    type: "district",
    code: `RBD${suffix}`,
    name: "RBAC District",
  });
  const mandal = await mkUnit(headers, {
    type: "mandal",
    code: `RBM${suffix}`,
    name: "RBAC Mandal",
    parent_id: district,
  });
  const villageA = await mkUnit(headers, {
    type: "village",
    code: `RBVA${suffix}`,
    name: "RBAC Village A",
    parent_id: mandal,
  });
  const villageB = await mkUnit(headers, {
    type: "village",
    code: `RBVB${suffix}`,
    name: "RBAC Village B",
    parent_id: mandal,
  });
  return { district, mandal, villageA, villageB };
}

async function mkEmployee(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const n = tag("E").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers,
    payload: {
      emp_no: `RB${n}`,
      first_name: "Rbac",
      last_name: "User",
      phone: `+9170${String(1000000 + seq).slice(-7)}${String(Math.floor(Math.random() * 90) + 10)}`,
      date_of_joining: "2024-01-15",
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function activateEmployee(employeeId: string): Promise<void> {
  await pool.query("UPDATE employees SET status = 'ACTIVE' WHERE id = $1::uuid", [
    employeeId,
  ]);
}

async function linkUser(userId: string, employeeId: string): Promise<void> {
  await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [
    employeeId,
    userId,
  ]);
}

async function mkWorkspace(headers: Record<string, string>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers,
    payload: { name: tag("RBWS") },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function mkProject(
  headers: Record<string, string>,
  workspaceId: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: {
      workspace_id: workspaceId,
      code: tag("RBPC").replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
      name: tag("RBAC Project"),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function mkTask(
  headers: Record<string, string>,
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers,
    payload: { project_id: projectId, title: tag("RBAC Task"), ...over },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; version: number };
}

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function leaveTypeId(headers: Record<string, string>, code: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/leave/types",
    headers,
  });
  expect(res.statusCode).toBe(200);
  const rows = (res.json() as { data: Array<{ id: string; code: string }> }).data;
  return (rows.find((r) => r.code === code) as { id: string }).id;
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
// Pure scope helpers
// ---------------------------------------------------------------------------

describe("resolveScopes", () => {
  it("is global on an empty assignment list or any null-scope row", () => {
    expect(resolveScopes([]).global).toBe(true);
    expect(
      resolveScopes([{ scope_type: null, scope_id: null }]).global,
    ).toBe(true);
    expect(
      resolveScopes([
        { scope_type: "village", scope_id: "11111111-1111-1111-1111-111111111111" },
        { scope_type: null, scope_id: null },
      ]).global,
    ).toBe(true);
    // Null id with a set type is also unscoped (cannot restrict to nothing).
    expect(resolveScopes([{ scope_type: "team", scope_id: null }]).global).toBe(
      true,
    );
  });

  it("buckets ids by scope type, deduped, and unions across rows", () => {
    const v = "11111111-1111-1111-1111-111111111111";
    const p = "22222222-2222-2222-2222-222222222222";
    const t = "33333333-3333-3333-3333-333333333333";
    const out = resolveScopes([
      { scope_type: "village", scope_id: v },
      { scope_type: "village", scope_id: v },
      { scope_type: "project", scope_id: p },
      { scope_type: "team", scope_id: t },
      { scope_type: "district", scope_id: v },
      { scope_type: "mandal", scope_id: v },
      { scope_type: "unknown-future", scope_id: v },
    ]);
    expect(out.global).toBe(false);
    expect(out.villages).toEqual([v]);
    expect(out.projects).toEqual([p]);
    expect(out.teams).toEqual([t]);
    expect(out.districts).toEqual([v]);
    expect(out.mandals).toEqual([v]);
  });
});

describe("expandGeoScope", () => {
  const units = [
    { id: "d1", type: "district", parent_id: null },
    { id: "m1", type: "mandal", parent_id: "d1" },
    { id: "m2", type: "mandal", parent_id: "d1" },
    { id: "v1", type: "village", parent_id: "m1" },
    { id: "v2", type: "village", parent_id: "m1" },
    { id: "v3", type: "village", parent_id: "m2" },
  ];
  it("rolls villages up and districts down the ancestry", () => {
    // Village scope sees its mandal + district siblings for partial-FK rows.
    expect(
      expandGeoScope(units, { districts: [], mandals: [], villages: ["v1"] }),
    ).toEqual({ districts: ["d1"], mandals: ["m1"], villages: ["v1"] });
    // District scope fans out to every mandal/village below it.
    expect(
      expandGeoScope(units, { districts: ["d1"], mandals: [], villages: [] }),
    ).toEqual({
      districts: ["d1"],
      mandals: expect.arrayContaining(["m1", "m2"]),
      villages: expect.arrayContaining(["v1", "v2", "v3"]),
    });
    // Unknown unit ids contribute nothing.
    expect(
      expandGeoScope(units, { districts: ["nope"], mandals: [], villages: [] }),
    ).toEqual({ districts: [], mandals: [], villages: [] });
  });

  it("villagesInScope resolves mandal/district scopes to villages", () => {
    expect(
      villagesInScope(units, { districts: [], mandals: ["m1"], villages: [] }).sort(),
    ).toEqual(["v1", "v2"]);
    expect(
      villagesInScope(units, { districts: ["d1"], mandals: [], villages: [] }).sort(),
    ).toEqual(["v1", "v2", "v3"]);
  });
});

// ---------------------------------------------------------------------------
// Permission matrix: 10 roles × representative endpoints
// ---------------------------------------------------------------------------

describe("RBAC matrix", () => {
  it("PAYROLL_OFFICER: payroll-only (POST /employees 403, GET /payroll/policy 200)", async () => {
    const officer = await mkUser([{ role: "PAYROLL_OFFICER" }], "pay");
    const adminH = await adminHeaders();
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: officer.headers,
      payload: {
        emp_no: tag("X").replace(/[^A-Za-z0-9]/g, ""),
        first_name: "No",
        phone: "+919999999999",
        date_of_joining: "2024-01-15",
      },
    });
    expect(denied.statusCode).toBe(403);
    // No attendance reads either (S0 attendance.read removed).
    const attDenied = await app.inject({
      method: "GET",
      url: "/api/v1/attendance/records",
      headers: officer.headers,
    });
    expect(attDenied.statusCode).toBe(403);
    const policy = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/policy",
      headers: officer.headers,
    });
    expect(policy.statusCode).toBe(200);
    // And payroll runs are creatable (payroll.generate held).
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: officer.headers,
      payload: { period_start: "2026-01-01", period_end: "2026-01-31" },
    });
    expect(run.statusCode).toBe(201);
    void adminH;
  });

  it("INVENTORY_MANAGER: no business perms (GET /employees 403)", async () => {
    const inv = await mkUser([{ role: "INVENTORY_MANAGER" }], "inv");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: inv.headers,
    });
    expect(list.statusCode).toBe(403);
    const tasks = await app.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: inv.headers,
    });
    expect(tasks.statusCode).toBe(403);
    const runs = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/runs",
      headers: inv.headers,
    });
    expect(runs.statusCode).toBe(403);
  });

  it("CLIENT_VIEWER: project/task/board reads only", async () => {
    const viewer = await mkUser([{ role: "CLIENT_VIEWER" }], "viewer");
    const employees = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: viewer.headers,
    });
    expect(employees.statusCode).toBe(403);
    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: viewer.headers,
    });
    expect(projects.statusCode).toBe(200);
    const boards = await app.inject({
      method: "GET",
      url: "/api/v1/boards",
      headers: viewer.headers,
    });
    expect(boards.statusCode).toBe(200);
    const runs = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/runs",
      headers: viewer.headers,
    });
    expect(runs.statusCode).toBe(403);
    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: viewer.headers,
    });
    expect(audit.statusCode).toBe(403);
    const createTask = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: viewer.headers,
      payload: { project_id: randomUUID(), title: "nope" },
    });
    expect(createTask.statusCode).toBe(403);
  });

  it("AUDITOR: read-only evidence (POST /tasks 403, GET /audit 200)", async () => {
    const auditor = await mkUser([{ role: "AUDITOR" }], "auditor");
    const createTask = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: auditor.headers,
      payload: { project_id: randomUUID(), title: "nope" },
    });
    expect(createTask.statusCode).toBe(403);
    const decideLeave = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${randomUUID()}/decision`,
      headers: { ...auditor.headers, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    // Not the current approver (and no decide path): never a 2xx.
    expect([403, 404]).toContain(decideLeave.statusCode);
    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: auditor.headers,
    });
    expect(audit.statusCode).toBe(200);
    const employees = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: auditor.headers,
    });
    expect(employees.statusCode).toBe(200);
    const runs = await app.inject({
      method: "GET",
      url: "/api/v1/payroll/runs",
      headers: auditor.headers,
    });
    expect(runs.statusCode).toBe(200);
  });

  it("EMPLOYEE: self-service (POST /payroll/runs 403, task quick-add 201)", async () => {
    const adminH = await adminHeaders();
    const ws = await mkWorkspace(adminH);
    const projectId = await mkProject(adminH, ws);
    const emp = await mkUser([{ role: "EMPLOYEE" }], "emp");
    const run = await app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: emp.headers,
      payload: { period_start: "2026-02-01", period_end: "2026-02-28" },
    });
    expect(run.statusCode).toBe(403);
    const quickAdd = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: emp.headers,
      payload: { project_id: projectId, title: "Employee quick-add" },
    });
    expect(quickAdd.statusCode).toBe(201);
  });

  it("EMPLOYEE updates own assigned task (200) but not others' (403)", async () => {
    const adminH = await adminHeaders();
    const ws = await mkWorkspace(adminH);
    const projectId = await mkProject(adminH, ws);
    const emp = await mkUser([{ role: "EMPLOYEE" }], "selfsvc");
    const stranger = await mkUser([{ role: "EMPLOYEE" }], "other");
    const mine = await mkTask(adminH, projectId, { assignee_id: emp.id });
    const theirs = await mkTask(adminH, projectId, { assignee_id: stranger.id });
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${mine.id}`,
      headers: { ...emp.headers, "If-Match": String(mine.version) },
      payload: { title: "Renamed by owner" },
    });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${theirs.id}`,
      headers: { ...emp.headers, "If-Match": String(theirs.version) },
      payload: { title: "Hijack attempt" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("TEAM_LEAD decides leave as current approver (200)", async () => {
    const adminH = await adminHeaders();
    const lopId = await leaveTypeId(adminH, "LOP");
    const tl = await mkUser([{ role: "TEAM_LEAD" }], "tl");
    const emp = await mkUser([{ role: "EMPLOYEE" }], "req");
    const mId = await mkEmployee(adminH);
    await activateEmployee(mId);
    await linkUser(tl.id, mId);
    const eId = await mkEmployee(adminH, { reports_to: mId });
    await activateEmployee(eId);
    await linkUser(emp.id, eId);
    const filed = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...emp.headers, "Idempotency-Key": randomUUID() },
      payload: {
        leave_type_id: lopId,
        from_date: plusDays(30),
        to_date: plusDays(31),
      },
    });
    expect(filed.statusCode).toBe(201);
    const reqId = (filed.json() as { id: string }).id;
    const decide = await app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${reqId}/decision`,
      headers: { ...tl.headers, "If-Match": "1" },
      payload: { decision: "APPROVE", note: "covered" },
    });
    expect(decide.statusCode).toBe(200);
  });

  it("PROJECT_MANAGER closes a project (200)", async () => {
    const pm = await mkUser([{ role: "PROJECT_MANAGER" }], "pm");
    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: pm.headers,
      payload: { name: tag("PM Workspace") },
    });
    expect(wsRes.statusCode).toBe(201);
    const wsId = (wsRes.json() as { id: string }).id;
    const projectId = await mkProject(pm.headers, wsId);
    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/close`,
      headers: pm.headers,
      payload: { reason: "done" },
    });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe("CLOSED");
  });

  it("HR_MANAGER keeps employee master + leave admin (create 201, balances 201)", async () => {
    const hr = await mkUser([{ role: "HR_MANAGER" }], "hr");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: hr.headers,
      payload: {
        emp_no: tag("HR").replace(/[^A-Za-z0-9]/g, ""),
        first_name: "Hr",
        phone: `+9180${String(1000000 + seq).slice(-7)}${String(Math.floor(Math.random() * 90) + 10)}`,
        date_of_joining: "2024-01-15",
      },
    });
    expect(created.statusCode).toBe(201);
    const empId = (created.json() as { id: string }).id;
    const lopId = await leaveTypeId(hr.headers, "LOP");
    const up = await app.inject({
      method: "POST",
      url: "/api/v1/leave/balances",
      headers: hr.headers,
      payload: {
        employee_id: empId,
        leave_type_id: lopId,
        period_year: 2026,
        opening_balance: 3,
      },
    });
    expect([200, 201]).toContain(up.statusCode);
  });

  it("SUPER_ADMIN and ADMIN stay full (seed parity)", async () => {
    const adminH = await adminHeaders();
    const superRow = await pool.query(
      `SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'SUPER_ADMIN'`,
    );
    const adminRow = await pool.query(
      `SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ADMIN'`,
    );
    const permRow = await pool.query("SELECT COUNT(*) AS n FROM permissions");
    const total = Number((permRow.rows[0] as { n: string }).n);
    expect(Number((superRow.rows[0] as { n: string }).n)).toBe(total);

    // Admin is full apart from the permissions §4.1 reserves for Super Admin as
    // "final escalation / exceptional overrides". Admin's own row in §4 is
    // "operational/admin approvals", which is a different authority — so this
    // asserts the reserved set explicitly rather than asserting parity and
    // quietly handing Admin every escape hatch a future module adds.
    const reserved = await pool.query(
      `SELECT code FROM permissions WHERE code NOT IN (
         SELECT permission_code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ADMIN')
       ORDER BY code`,
    );
    // Each is an emergency override of a control, which §4.1 places with Super
    // Admin as "final escalation". Adding to this list is a deliberate act:
    // the assertion fails loudly rather than accepting a larger count.
    //
    // period.override is the newest and the sharpest: closing a month is a
    // statement that its figures are final, and posting into it afterwards
    // undoes the only guarantee the close provides.
    expect(reserved.rows.map((r: { code: string }) => r.code)).toEqual([
      "approval.self_approve",  // bypasses maker-checker
      "match.override",         // releases payment against a mismatched invoice
      "period.override",        // posts into a closed accounting period
      "stock.negative_override", // issues stock a location does not have
      "tender.override",        // bypasses the eligibility checklist
    ]);
    expect(Number((adminRow.rows[0] as { n: string }).n)).toBe(total - reserved.rowCount);
    // Spot-check: admin still passes a write gate in every module.
    const ws = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: adminH,
      payload: { name: tag("Admin WS") },
    });
    expect(ws.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Scope-filtered reads
// ---------------------------------------------------------------------------

describe("scope enforcement", () => {
  it("village-scoped TL sees only own-village employees", async () => {
    const adminH = await adminHeaders();
    const geo = await geoFixture(adminH);
    const inA = await mkEmployee(adminH, { village_id: geo.villageA });
    const inB = await mkEmployee(adminH, { village_id: geo.villageB });
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "village", scopeId: geo.villageA }],
      "scopedtl",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(inA);
    expect(ids).not.toContain(inB);
  });

  it("village scope does NOT fan out via district/mandal FKs (coarsest-match-wins)", async () => {
    const adminH = await adminHeaders();
    const geo = await geoFixture(adminH);
    // Employees carrying the FULL FK chain in the same district+mandal but
    // different villages: a village scope must return only its own village.
    const inA = await mkEmployee(adminH, {
      district_id: geo.district,
      mandal_id: geo.mandal,
      village_id: geo.villageA,
    });
    const inB = await mkEmployee(adminH, {
      district_id: geo.district,
      mandal_id: geo.mandal,
      village_id: geo.villageB,
    });
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "village", scopeId: geo.villageA }],
      "novillagefanout",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(inA);
    expect(ids).not.toContain(inB);
  });

  it("mandal-scoped TL sees both villages under the mandal", async () => {
    const adminH = await adminHeaders();
    const geo = await geoFixture(adminH);
    const inA = await mkEmployee(adminH, { village_id: geo.villageA });
    const inB = await mkEmployee(adminH, { village_id: geo.villageB });
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "mandal", scopeId: geo.mandal }],
      "mandaltl",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(inA);
    expect(ids).toContain(inB);
  });

  it("project-scoped PM sees only own-project tasks", async () => {
    const adminH = await adminHeaders();
    const ws = await mkWorkspace(adminH);
    const p1 = await mkProject(adminH, ws);
    const p2 = await mkProject(adminH, ws);
    const t1 = await mkTask(adminH, p1);
    const t2 = await mkTask(adminH, p2);
    const pm = await mkUser(
      [{ role: "PROJECT_MANAGER", scopeType: "project", scopeId: p1 }],
      "scopedpm",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?limit=100",
      headers: pm.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(t1.id);
    expect(ids).not.toContain(t2.id);
  });

  it("self-scoped task query bypasses geo scope (own work always visible)", async () => {
    const adminH = await adminHeaders();
    const geo = await geoFixture(adminH);
    const ws = await mkWorkspace(adminH);
    const p = await mkProject(adminH, ws);
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "village", scopeId: geo.villageA }],
      "selfscopetl",
    );
    // Villageless task assigned to the scoped user: invisible to the plain
    // project list (nothing to match the village scope)…
    const t = await mkTask(adminH, p, { assignee_id: tl.id });
    const all = await app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${p}&limit=100`,
      headers: tl.headers,
    });
    expect(all.statusCode).toBe(200);
    const allIds = (all.json() as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(allIds).not.toContain(t.id);
    // …but always visible through the explicitly self-scoped query.
    const mine = await app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${p}&assignee_me=true&limit=100`,
      headers: tl.headers,
    });
    expect(mine.statusCode).toBe(200);
    const mineIds = (mine.json() as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(mineIds).toContain(t.id);
  });

  it("team-scoped TL sees the reports_to subtree (root included)", async () => {    const adminH = await adminHeaders();
    const mId = await mkEmployee(adminH);
    await activateEmployee(mId);
    const aId = await mkEmployee(adminH, { reports_to: mId });
    await activateEmployee(aId);
    const bId = await mkEmployee(adminH, { reports_to: aId });
    const outsider = await mkEmployee(adminH);
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "team", scopeId: mId }],
      "teamtl",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(mId);
    expect(ids).toContain(aId);
    expect(ids).toContain(bId);
    expect(ids).not.toContain(outsider);
  });

  it("team-scoped TL sees only subtree-linked tasks", async () => {
    const adminH = await adminHeaders();
    const ws = await mkWorkspace(adminH);
    const projectId = await mkProject(adminH, ws);
    const mId = await mkEmployee(adminH);
    await activateEmployee(mId);
    const aId = await mkEmployee(adminH, { reports_to: mId });
    await activateEmployee(aId);
    const oId = await mkEmployee(adminH);
    await activateEmployee(oId);
    const member = await mkUser([{ role: "EMPLOYEE" }], "member");
    await linkUser(member.id, aId);
    const stranger = await mkUser([{ role: "EMPLOYEE" }], "stranger");
    await linkUser(stranger.id, oId);
    const inTask = await mkTask(adminH, projectId, { assignee_id: member.id });
    const outTask = await mkTask(adminH, projectId, { assignee_id: stranger.id });
    const tl = await mkUser(
      [{ role: "TEAM_LEAD", scopeType: "team", scopeId: mId }],
      "teamtltasks",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(inTask.id);
    expect(ids).not.toContain(outTask.id);
  });

  it("a global employee role does not widen the scoped team-lead permission", async () => {
    const adminH = await adminHeaders();
    const geo = await geoFixture(adminH);
    const inA = await mkEmployee(adminH, { village_id: geo.villageA });
    const inB = await mkEmployee(adminH, { village_id: geo.villageB });
    // Only roles granting employee.read contribute to that permission scope.
    const tl = await mkUser(
      [
        { role: "TEAM_LEAD", scopeType: "village", scopeId: geo.villageA },
        { role: "EMPLOYEE" },
      ],
      "uniontl",
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers: tl.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toContain(inA);
    expect(ids).not.toContain(inB);
  });
});

// ---------------------------------------------------------------------------
// Attendance self-decision guard
// ---------------------------------------------------------------------------

describe("attendance self-decision", () => {
  async function submitAs(
    headers: Record<string, string>,
    employeeId: string,
  ): Promise<{ id: string; version: number }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/exceptions",
      headers,
      payload: {
        employee_id: employeeId,
        exception_type: "MISSED_PUNCH",
        reason: "forgot",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; version: number };
  }

  it("403 SELF_DECISION when the decider submitted it; users.manage overrides", async () => {
    const adminH = await adminHeaders();
    const tl = await mkUser([{ role: "TEAM_LEAD" }], "selftl");
    const tlEmp = await mkEmployee(adminH);
    await activateEmployee(tlEmp);
    await linkUser(tl.id, tlEmp);
    const exc = await submitAs(tl.headers, tlEmp);
    const selfDecide = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...tl.headers, "If-Match": String(exc.version) },
      payload: { decision: "APPROVE", note: "trust me" },
    });
    expect(selfDecide.statusCode).toBe(403);
    expect((selfDecide.json() as { code: string }).code).toBe("SELF_DECISION");

    // HR_MANAGER holds users.manage: emergency override succeeds and the
    // note is audited as the reason.
    const hr = await mkUser([{ role: "HR_MANAGER" }], "selfhr");
    const hrEmp = await mkEmployee(adminH);
    await activateEmployee(hrEmp);
    await linkUser(hr.id, hrEmp);
    const hrExc = await submitAs(hr.headers, hrEmp);
    const override = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${hrExc.id}/decision`,
      headers: { ...hr.headers, "If-Match": String(hrExc.version) },
      payload: { decision: "APPROVE", note: "emergency cover" },
    });
    expect(override.statusCode).toBe(200);
    const audit = await pool.query(
      "SELECT reason FROM audit_events WHERE action = 'attendance.exception.decide' AND entity_id = $1::uuid",
      [hrExc.id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe("emergency cover");
  });

  it("a different decider is unaffected", async () => {
    const adminH = await adminHeaders();
    const emp = await mkUser([{ role: "EMPLOYEE" }], "subm");
    const empId = await mkEmployee(adminH);
    await activateEmployee(empId);
    await linkUser(emp.id, empId);
    const exc = await submitAs(emp.headers, empId);
    const tl = await mkUser([{ role: "TEAM_LEAD" }], "othertl");
    const decide = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...tl.headers, "If-Match": String(exc.version) },
      payload: { decision: "APPROVE", note: "verified" },
    });
    expect(decide.statusCode).toBe(200);
  });
});
