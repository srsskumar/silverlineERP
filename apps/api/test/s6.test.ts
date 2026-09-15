import {testDatabaseUrl} from "./database.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { encryptPii } from "../src/common/crypto.js";
import { createRateLimiter } from "../src/common/rateLimit.js";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import { clearDashboardCache, clearReportRegistry } from "../src/modules/s6/routes.js";
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
// Helpers (mirroring the s5 suite)
// ---------------------------------------------------------------------------

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE project_categories, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, geo_fence_employee_assignments, device_registrations, audit_events, sessions, idempotency_keys, user_roles,
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

async function adminId(): Promise<string> {
  const res = await pool.query(
    "SELECT id FROM users WHERE org_id = $1 AND username = $2",
    [orgId, ADMIN_USERNAME],
  );
  return (res.rows[0] as { id: string }).id;
}

async function mkUser(
  roles: string[],
  tag: string,
): Promise<{ id: string; username: string; headers: Record<string, string> }> {
  const username = `s6_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const id = await createUser({ username, password: "Pass1234!", roles });
  return { id, username, headers: await headersFor(username, "Pass1234!") };
}

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function istPlusDays(n: number): string {
  const ms = Date.parse(`${istToday()}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function mkActiveEmployee(
  over: Record<string, unknown> = {},
): Promise<string> {
  seq += 1;
  const res = await pool.query(
    `INSERT INTO employees
       (org_id, emp_no, first_name, last_name, phone, date_of_joining,
        status, aadhaar_encrypted, pan_encrypted, bank_account_encrypted,
        phonepe_number, salary_basic)
     VALUES ($1, $2, 'S6', 'Fixture', $3, '2024-01-15', 'ACTIVE',
       $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      over["org_id"] ?? orgId,
      over["emp_no"] ?? `S6E${String(seq).padStart(5, "0")}`,
      over["phone"] ?? `+9183100${String(10000 + seq)}`,
      over["aadhaar"] ? encryptPii(over["aadhaar"] as string) : null,
      over["pan"] ? encryptPii(over["pan"] as string) : null,
      over["bank_account"] ? encryptPii(over["bank_account"] as string) : null,
      (over["phonepe_number"] as string | undefined) ?? null,
      (over["salary_basic"] as number | undefined) ?? null,
    ],
  );
  const id = (res.rows[0] as { id: string }).id;
  if (over["reports_to"]) {
    await pool.query("UPDATE employees SET reports_to = $2::uuid WHERE id = $1::uuid", [
      id,
      over["reports_to"] as string,
    ]);
  }
  return id;
}

async function linkUser(userId: string, employeeId: string): Promise<void> {
  await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [
    employeeId,
    userId,
  ]);
}

async function leaveTypeId(code: string): Promise<string> {
  const res = await pool.query(
    "SELECT id FROM leave_types WHERE org_id = $1 AND code = $2",
    [orgId, code],
  );
  return (res.rows[0] as { id: string }).id;
}

async function mkWorkspaceAndProject(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<{ workspaceId: string; projectId: string }> {
  seq += 1;
  const ws = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers,
    payload: { name: `S6WS-${seq}` },
  });
  expect(ws.statusCode).toBe(201);
  const workspaceId = (ws.json() as { id: string }).id;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: {
      workspace_id: workspaceId,
      code: `S6P${String(seq).padStart(5, "0")}`,
      name: `S6 Project ${seq}`,
      ...over,
    },
  });
  expect(p.statusCode).toBe(201);
  return { workspaceId, projectId: (p.json() as { id: string }).id };
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
    payload: { project_id: projectId, title: `S6 task ${randomUUID().slice(0, 8)}`, ...over },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; version: number };
  return { id: body.id, version: body.version };
}

async function moveTask(
  headers: Record<string, string>,
  id: string,
  version: number,
  status: string,
): Promise<number> {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/tasks/${id}/status`,
    headers: { ...headers, "If-Match": String(version) },
    payload: { status },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { version: number }).version;
}

interface DashboardBody {
  template: string;
  generated_at: string;
  widgets: Array<{ key: string; title: string; value: number; link?: string }>;
  scope_note?: string;
}

async function getDashboard(
  headers: Record<string, string>,
  role: string,
) {
  return app.inject({
    method: "GET",
    url: `/api/v1/dashboards/role/${role}`,
    headers,
  });
}

function widgetMap(body: DashboardBody): Map<string, number> {
  return new Map(body.widgets.map((w) => [w.key, w.value]));
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
  await pool.query(
    `TRUNCATE TABLE project_categories, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, geo_fence_employee_assignments, device_registrations, notifications, task_labels, labels, saved_filters,
      board_columns, boards, mentions, comments, task_evidence,
      task_dependencies, tasks, projects, project_workflows, project_types,
      workspaces`,
  );
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  clearDashboardCache();
  clearReportRegistry();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ---------------------------------------------------------------------------
// Dashboards: gating
// ---------------------------------------------------------------------------

describe("dashboards gating", () => {
  it("rejects anonymous dashboard access (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/dashboards/role/admin" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 422 UNKNOWN_TEMPLATE for an unknown template", async () => {
    const h = await adminHeaders();
    const res = await getDashboard(h, "boss");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("UNKNOWN_TEMPLATE");
  });

  it("returns 403 NOT_YOUR_ROLE when the caller lacks the matching role", async () => {
    const emp = await mkUser(["EMPLOYEE"], "emp403");
    const res = await getDashboard(emp.headers, "admin");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("NOT_YOUR_ROLE");
  });

  it("returns 403 NOT_YOUR_ROLE for super_admin template held by ADMIN only", async () => {
    const adm = await mkUser(["ADMIN"], "adm403");
    const res = await getDashboard(adm.headers, "super_admin");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("NOT_YOUR_ROLE");
  });
});

// ---------------------------------------------------------------------------
// Dashboards: widget sets over seeded fixtures
// ---------------------------------------------------------------------------

describe("dashboards widgets", () => {
  async function seedOrgFixtures() {
    const h = await adminHeaders();
    const empA = await mkActiveEmployee({
      aadhaar: "123456789012",
      pan: "ABCDE1234F",
      bank_account: "987654321098",
      phonepe_number: "+919876543210",
      salary_basic: 50000,
    });
    const empB = await mkActiveEmployee({});
    await pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status)
       VALUES ($1::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date, 'PARTIAL')`,
      [empA],
    );
    await pool.query(
      `INSERT INTO attendance_exceptions (employee_id, exception_type, reason, source, status)
       VALUES ($1::uuid, 'MISSED_PUNCH', 'forgot', 'USER', 'PENDING')`,
      [empA],
    );
    const lop = await leaveTypeId("LOP");
    await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days, status, approval_chain)
       VALUES ($1, $2::uuid, $3::uuid,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1), 2, 'PENDING', '[]')`,
      [orgId, empB, lop],
    );
    await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days, status, approval_chain)
       VALUES ($1, $2::uuid, $3::uuid,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         (now() AT TIME ZONE 'Asia/Kolkata')::date, 1, 'APPROVED', '[]')`,
      [orgId, empA, lop],
    );
    const { projectId } = await mkWorkspaceAndProject(h);
    await mkTask(h, projectId, { title: "open one" });
    await mkTask(h, projectId, { title: "overdue one", planned_end_date: istPlusDays(-2) });
    const blocked = await mkTask(h, projectId, { title: "blocked one" });
    let v = await moveTask(h, blocked.id, blocked.version, "IN_PROGRESS");
    await moveTask(h, blocked.id, v, "BLOCKED");
    const done = await mkTask(h, projectId, { title: "done one" });
    v = done.version;
    for (const s of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
      v = await moveTask(h, done.id, v, s);
    }
    return { empA, empB, projectId };
  }

  it("super_admin template returns 6 live widgets with numbers", async () => {
    await seedOrgFixtures();
    const h = await adminHeaders();
    const res = await getDashboard(h, "super_admin");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    expect(body.template).toBe("super_admin");
    expect(typeof body.generated_at).toBe("string");
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    for (const w of body.widgets) {
      expect(typeof w.value).toBe("number");
    }
    expect(m.get("headcount_active")).toBe(2);
    expect(m.get("attendance_today_pct")).toBe(50);
    expect(m.get("pending_exceptions")).toBe(1);
    expect(m.get("open_tasks")).toBe(3);
    expect(m.get("overdue_tasks")).toBe(1);
    expect(m.get("pending_leave")).toBe(1);
    expect(body.scope_note).toBeUndefined();
  });

  it("admin template returns the same admin widget set", async () => {
    await seedOrgFixtures();
    const adm = await mkUser(["ADMIN"], "adminT");
    const res = await getDashboard(adm.headers, "admin");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    expect(m.get("headcount_active")).toBe(2);
    expect(m.get("open_tasks")).toBe(3);
    expect(m.get("overdue_tasks")).toBe(1);
    expect(m.get("pending_leave")).toBe(1);
  });

  it("hr_manager template returns leave/exception widgets", async () => {
    await seedOrgFixtures();
    const hr = await mkUser(["HR_MANAGER"], "hrT");
    const res = await getDashboard(hr.headers, "hr_manager");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    expect(m.get("headcount_active")).toBe(2);
    expect(m.get("on_leave_today")).toBe(1);
    expect(m.get("pending_leave")).toBe(1);
    expect(m.get("pending_exceptions")).toBe(1);
  });

  it("project_manager template scopes counts to managed projects", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pmT");
    const { projectId } = await mkWorkspaceAndProject(h, {
      project_manager_id: pm.id,
    });
    await mkTask(h, projectId, { title: "mine open" });
    await mkTask(h, projectId, { title: "mine overdue", planned_end_date: istPlusDays(-3) });
    const blocked = await mkTask(h, projectId, { title: "mine blocked" });
    const v = await moveTask(h, blocked.id, blocked.version, "IN_PROGRESS");
    await moveTask(h, blocked.id, v, "BLOCKED");
    // Unmanaged project noise must not leak in.
    const other = await mkWorkspaceAndProject(h);
    await mkTask(h, other.projectId, { title: "not mine" });
    const res = await getDashboard(pm.headers, "project_manager");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    expect(m.get("my_projects")).toBe(1);
    expect(m.get("open_tasks")).toBe(3);
    expect(m.get("overdue_tasks")).toBe(1);
    expect(m.get("blocked_tasks")).toBe(1);
    expect(body.scope_note).toBeUndefined();
  });

  it("project_manager with no managed projects returns zeros + scope_note", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pmEmpty");
    const { projectId } = await mkWorkspaceAndProject(h);
    await mkTask(h, projectId, { title: "org noise" });
    const res = await getDashboard(pm.headers, "project_manager");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(m.get("my_projects")).toBe(0);
    expect(m.get("open_tasks")).toBe(0);
    expect(m.get("overdue_tasks")).toBe(0);
    expect(m.get("blocked_tasks")).toBe(0);
    expect(body.scope_note).toBe("no managed projects");
  });

  it("team_lead template scopes to direct reports", async () => {
    const tl = await mkUser(["TEAM_LEAD"], "tlT");
    const lead = await mkActiveEmployee({});
    await linkUser(tl.id, lead);
    const m1 = await mkActiveEmployee({ reports_to: lead });
    await mkActiveEmployee({ reports_to: lead });
    await pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status)
       VALUES ($1::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date, 'COMPLETE')`,
      [m1],
    );
    await pool.query(
      `INSERT INTO attendance_exceptions (employee_id, exception_type, reason, source, status)
       VALUES ($1::uuid, 'LATE_CHECKIN', 'traffic', 'USER', 'PENDING')`,
      [m1],
    );
    const lop = await leaveTypeId("LOP");
    await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days,
          status, approval_chain, current_approver_id)
       VALUES ($1, $2::uuid, $3::uuid,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1), 2,
         'PENDING', '[]', $4::uuid)`,
      [orgId, m1, lop, tl.id],
    );
    const res = await getDashboard(tl.headers, "team_lead");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    expect(m.get("team_size")).toBe(2);
    expect(m.get("attendance_today_pct")).toBe(50);
    expect(m.get("pending_leave")).toBe(1);
    expect(m.get("pending_exceptions")).toBe(1);
    expect(body.scope_note).toBeUndefined();
  });

  it("team_lead without a linked employee returns zeros + scope_note", async () => {
    const tl = await mkUser(["TEAM_LEAD"], "tlNolink");
    await mkActiveEmployee({});
    const res = await getDashboard(tl.headers, "team_lead");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(m.get("team_size")).toBe(0);
    expect(m.get("attendance_today_pct")).toBe(0);
    expect(m.get("pending_leave")).toBe(0);
    expect(m.get("pending_exceptions")).toBe(0);
    expect(typeof body.scope_note).toBe("string");
    expect((body.scope_note ?? "").length).toBeGreaterThan(0);
  });

  it("employee template returns caller-scoped widgets", async () => {
    const h = await adminHeaders();
    const emp = await mkUser(["EMPLOYEE"], "empT");
    const empRow = await mkActiveEmployee({});
    await linkUser(emp.id, empRow);
    const { projectId } = await mkWorkspaceAndProject(h);
    await mkTask(h, projectId, { title: "mine", assignee_id: emp.id });
    await mkTask(h, projectId, {
      title: "mine late",
      assignee_id: emp.id,
      planned_end_date: istPlusDays(-1),
    });
    await mkTask(h, projectId, { title: "someone else" });
    const lop = await leaveTypeId("LOP");
    await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days, status, approval_chain)
       VALUES ($1, $2::uuid, $3::uuid,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         (now() AT TIME ZONE 'Asia/Kolkata')::date, 1, 'PENDING', '[]')`,
      [orgId, empRow, lop],
    );
    await pool.query(
      `INSERT INTO attendance_exceptions
         (employee_id, exception_type, reason, source, status, submitted_by)
       VALUES ($1::uuid, 'MISSED_PUNCH', 'forgot', 'USER', 'PENDING', $2::uuid)`,
      [empRow, emp.id],
    );
    await pool.query(
      `INSERT INTO notifications (org_id, recipient_id, type, title, body)
       VALUES ($1, $2::uuid, 'MENTION', 'hi', 'you were mentioned')`,
      [orgId, emp.id],
    );
    const res = await getDashboard(emp.headers, "employee");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    expect(m.get("my_open_tasks")).toBe(2);
    expect(m.get("my_overdue")).toBe(1);
    expect(m.get("my_pending_requests")).toBe(2);
    expect(m.get("unread_notifications")).toBe(1);
  });

  it("client_viewer without a project assignment sees no project records", async () => {
    const h = await adminHeaders();
    const viewer = await mkUser(["CLIENT_VIEWER"], "viewerT");
    const { projectId } = await mkWorkspaceAndProject(h);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...h, "If-Match": "1" },
      payload: { status: "ACTIVE" },
    });
    await mkTask(h, projectId, { title: "visible work" });
    const res = await getDashboard(viewer.headers, "client_viewer");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    for (const w of body.widgets) {
      expect(typeof w.value).toBe("number");
    }
    expect(m.get("projects_active")).toBe(0);
    expect(m.get("tasks_open")).toBe(0);
    expect(typeof m.get("tasks_done_7d")).toBe("number");
    expect(typeof m.get("audit_events_7d")).toBe("number");
    expect((m.get("audit_events_7d") ?? 0)).toBeGreaterThan(0);
  });

  it("auditor template returns org read widgets", async () => {
    const h = await adminHeaders();
    const auditor = await mkUser(["AUDITOR"], "auditorT");
    const { projectId } = await mkWorkspaceAndProject(h);
    await mkTask(h, projectId, { title: "audited work" });
    const res = await getDashboard(auditor.headers, "auditor");
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;
    const m = widgetMap(body);
    expect(body.widgets.length).toBeGreaterThanOrEqual(4);
    for (const w of body.widgets) {
      expect(typeof w.value).toBe("number");
    }
    expect(m.get("tasks_open")).toBe(1);
  });

  it("caches the dashboard within TTL (same generated_at)", async () => {
    const h = await adminHeaders();
    await mkActiveEmployee({});
    const first = await getDashboard(h, "super_admin");
    expect(first.statusCode).toBe(200);
    const second = await getDashboard(h, "super_admin");
    expect(second.statusCode).toBe(200);
    expect((second.json() as DashboardBody).generated_at).toBe(
      (first.json() as DashboardBody).generated_at,
    );
  });

  it("never leaks cross-org rows into caller-scoped widgets", async () => {
    const h = await adminHeaders();
    await mkActiveEmployee({});
    const before = widgetMap((await getDashboard(h, "super_admin")).json() as DashboardBody);
    const otherOrg = await pool.query(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
      [`Other org ${randomUUID()}`],
    );
    const otherOrgId = (otherOrg.rows[0] as { id: string }).id;
    await mkActiveEmployee({ org_id: otherOrgId });
    clearDashboardCache();
    const after = widgetMap((await getDashboard(h, "super_admin")).json() as DashboardBody);
    expect(after.get("headcount_active")).toBe(before.get("headcount_active"));
  });
});

// ---------------------------------------------------------------------------
// my-work
// ---------------------------------------------------------------------------

describe("my-work", () => {
  it("rejects anonymous access (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/dashboards/my-work" });
    expect(res.statusCode).toBe(401);
  });

  it("returns assigned/overdue/approvals/unread for the caller", async () => {
    const h = await adminHeaders();
    const emp = await mkUser(["EMPLOYEE"], "empWork");
    const empRow = await mkActiveEmployee({});
    await linkUser(emp.id, empRow);
    const { projectId } = await mkWorkspaceAndProject(h);
    const open = await mkTask(h, projectId, { title: "work a", assignee_id: emp.id });
    await mkTask(h, projectId, {
      title: "work b late",
      assignee_id: emp.id,
      planned_end_date: istPlusDays(-1),
    });
    await mkTask(h, projectId, { title: "not mine" });
    const lop = await leaveTypeId("LOP");
    const lr = await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days,
          status, approval_chain, current_approver_id)
       VALUES ($1, $2::uuid, $3::uuid,
         (now() AT TIME ZONE 'Asia/Kolkata')::date,
         (now() AT TIME ZONE 'Asia/Kolkata')::date, 1,
         'PENDING', '[]', $4::uuid)
       RETURNING id`,
      [orgId, empRow, lop, emp.id],
    );
    const leaveId = (lr.rows[0] as { id: string }).id;
    await pool.query(
      `INSERT INTO attendance_exceptions (employee_id, exception_type, reason, source, status)
       VALUES ($1::uuid, 'MISSED_PUNCH', 'x', 'USER', 'PENDING')`,
      [empRow],
    );
    await pool.query(
      `INSERT INTO notifications (org_id, recipient_id, type, title, body)
       VALUES ($1, $2::uuid, 'TASK_ASSIGNED', 'assigned', 'task assigned to you'),
              ($1, $2::uuid, 'MENTION', 'ping', 'you were mentioned')`,
      [orgId, emp.id],
    );
    // One notification already read: excluded from the unread count.
    const readOne = await pool.query(
      `INSERT INTO notifications (org_id, recipient_id, type, title, body, read_at)
       VALUES ($1, $2::uuid, 'MENTION', 'old', 'already seen', NOW()) RETURNING id`,
      [orgId, emp.id],
    );
    void readOne;
    void open;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboards/my-work",
      headers: emp.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      assigned_open: number;
      assigned_overdue: Array<{ id: string; title: string; project_id: string; planned_end_date: string | null }>;
      pending_approvals: {
        leave: Array<{ id: string; employee_id: string; from_date: string; to_date: string }>;
        exceptions_count: number;
      };
      unread_count: number;
    };
    expect(body.assigned_open).toBe(2);
    expect(body.assigned_overdue.length).toBe(1);
    expect(body.assigned_overdue[0]).toMatchObject({
      title: "work b late",
      project_id: projectId,
      planned_end_date: istPlusDays(-1),
    });
    expect(body.pending_approvals.leave.length).toBe(1);
    expect(body.pending_approvals.leave[0]).toMatchObject({
      id: leaveId,
      employee_id: empRow,
      from_date: istToday(),
      to_date: istToday(),
    });
    // No attendance.decide: org exceptions are not the caller's approvals.
    expect(body.pending_approvals.exceptions_count).toBe(0);
    expect(body.unread_count).toBe(2);
  });

  it("counts org-pending exceptions for holders of attendance.decide", async () => {
    const h = await adminHeaders();
    const empRow = await mkActiveEmployee({});
    await pool.query(
      `INSERT INTO attendance_exceptions (employee_id, exception_type, reason, source, status)
       VALUES ($1::uuid, 'MISSED_PUNCH', 'x', 'USER', 'PENDING')`,
      [empRow],
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboards/my-work",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pending_approvals: { exceptions_count: number } };
    expect(body.pending_approvals.exceptions_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("reports", () => {
  async function seedReportEmployees() {
    await mkActiveEmployee({
      emp_no: "S6R001",
      phone: "+918320000001",
      aadhaar: "123456789012",
      pan: "ABCDE1234F",
      bank_account: "987654321098",
      phonepe_number: "+919876543210",
      salary_basic: 50000,
    });
    await mkActiveEmployee({ emp_no: "S6R002", phone: "+918320000002" });
  }

  function parseCsv(text: string): { header: string[]; rows: string[][] } {
    const lines = text.trim().split("\n").filter(line=>!line.startsWith("# "));
    // Test rows never contain commas/quotes/newlines (stable fixtures).
    const cells = lines.map((l) => l.split(","));
    return { header: cells[0] ?? [], rows: cells.slice(1) };
  }

  it("rejects anonymous report generation (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      payload: { type: "tasks", format: "csv" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects unknown report types (422)", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "unknown-report", format: "csv" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects generation without the domain read perm (403 CLIENT_VIEWER employees)", async () => {
    const viewer = await mkUser(["CLIENT_VIEWER"], "viewerR");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: viewer.headers,
      payload: { type: "employees", format: "csv" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("employees csv masks PII last-4 without pii.read (PROJECT_MANAGER)", async () => {
    await seedReportEmployees();
    const pm = await mkUser(["PROJECT_MANAGER"], "pmR");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: pm.headers,
      payload: { type: "employees", format: "csv" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      type: string;
      format: string;
      status: string;
      rows: number;
      download_url: string;
    };
    expect(body).toMatchObject({ type: "employees", format: "csv", status: "READY", rows: 2 });
    expect(body.download_url).toBe(`/api/v1/reports/${body.id}/download`);

    const dl = await app.inject({
      method: "GET",
      url: body.download_url,
      headers: pm.headers,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/csv");
    expect(dl.headers["content-disposition"] ?? "").toContain("attachment");
    const { header, rows } = parseCsv(dl.body);
    expect(header).toEqual([
      "id", "emp_no", "first_name", "last_name", "phone", "email",
      "designation", "department", "status", "date_of_joining",
      "aadhaar", "pan", "bank_account", "phonepe_number", "salary_basic",
    ]);
    expect(rows.length).toBe(2);
    const byEmpNo = new Map(rows.map((r) => [r[1], r]));
    const masked = byEmpNo.get("S6R001");
    expect(masked).toBeDefined();
    // Masked last-4, never the full values.
    expect(masked?.[10]).toBe("••••9012");
    expect(masked?.[11]).toBe("••••1234");
    expect(masked?.[12]).toBe("••••1098");
    expect(masked?.[13]).toBe("••••3210");
    expect(masked?.[14]).toBe("");
    expect(dl.body).not.toContain("123456789012");
    expect(dl.body).not.toContain("987654321098");
  });

  it("employees csv carries full PII with pii.read (admin)", async () => {
    await seedReportEmployees();
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "employees", format: "csv" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; download_url: string };
    const dl = await app.inject({
      method: "GET",
      url: body.download_url,
      headers: h,
    });
    expect(dl.statusCode).toBe(200);
    const { rows } = parseCsv(dl.body);
    const byEmpNo = new Map(rows.map((r) => [r[1], r]));
    const full = byEmpNo.get("S6R001");
    expect(full?.[10]).toBe("123456789012");
    expect(full?.[11]).toBe("ABCDE1234F");
    expect(full?.[12]).toBe("987654321098");
    expect(full?.[14]).toBe("50000");
  });

  it("tasks csv honours filters and downloads as an attachment", async () => {
    const h = await adminHeaders();
    const { projectId } = await mkWorkspaceAndProject(h);
    await mkTask(h, projectId, { title: "alpha" });
    await mkTask(h, projectId, { title: "beta" });
    const other = await mkWorkspaceAndProject(h);
    await mkTask(h, other.projectId, { title: "elsewhere" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "tasks", format: "csv", filters: { project_id: projectId } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { rows: number; download_url: string };
    expect(body.rows).toBe(2);
    const dl = await app.inject({
      method: "GET",
      url: body.download_url,
      headers: h,
    });
    expect(dl.statusCode).toBe(200);
    const { header, rows } = parseCsv(dl.body);
    expect(header).toEqual([
      "id", "project_id", "title", "status",
      "assignee_id", "priority", "planned_start_date", "planned_end_date",
    ]);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r[2]).sort()).toEqual(["alpha", "beta"]);
  });

  it("attendance + leave csvs carry the frozen headers and rows", async () => {
    const h = await adminHeaders();
    const empRow = await mkActiveEmployee({});
    await pool.query(
      `INSERT INTO attendance_records (employee_id, work_date, status)
       VALUES ($1::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date, 'COMPLETE')`,
      [empRow],
    );
    const lop = await leaveTypeId("LOP");
    await pool.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days, status, approval_chain)
       VALUES ($1, $2::uuid, $3::uuid, $4, $4, 1, 'PENDING', '[]')`,
      [orgId, empRow, lop, istPlusDays(5)],
    );
    const att = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "attendance", format: "csv" },
    });
    expect(att.statusCode).toBe(201);
    const attBody = att.json() as { rows: number; download_url: string };
    expect(attBody.rows).toBe(1);
    const attDl = await app.inject({
      method: "GET",
      url: attBody.download_url,
      headers: h,
    });
    const attCsv = parseCsv(attDl.body);
    expect(attCsv.header).toEqual([
      "id", "employee_id", "work_date", "status",
      "check_in_at", "check_out_at", "total_hours", "geofence_violation",
    ]);
    expect(attCsv.rows[0]?.[1]).toBe(empRow);

    const leave = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "leave", format: "csv" },
    });
    expect(leave.statusCode).toBe(201);
    const leaveBody = leave.json() as { rows: number; download_url: string };
    expect(leaveBody.rows).toBe(1);
    const leaveDl = await app.inject({
      method: "GET",
      url: leaveBody.download_url,
      headers: h,
    });
    const leaveCsv = parseCsv(leaveDl.body);
    expect(leaveCsv.header).toEqual([
      "id", "employee_id", "leave_type_id", "from_date",
      "to_date", "total_days", "status",
    ]);
    expect(leaveCsv.rows[0]?.[1]).toBe(empRow);
  });

  it("audits report.generate with type + rows", async () => {
    const h = await adminHeaders();
    await mkActiveEmployee({});
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "employees", format: "csv" },
    });
    const body = res.json() as { id: string };
    const audit = await pool.query(
      `SELECT after_state FROM audit_events
        WHERE action = 'report.generate' AND entity_id = $1::uuid`,
      [body.id],
    );
    expect(audit.rowCount).toBe(1);
    const after = audit.rows[0] as { after_state: { type: string; rows: number } };
    expect(after.after_state.type).toBe("employees");
    expect(after.after_state.rows).toBe(1);
  });

  it("queues reports beyond 5000 rows for background processing", async () => {
    const h = await adminHeaders();
    await pool.query(
      `INSERT INTO employees (org_id, emp_no, first_name, phone, date_of_joining, status)
       SELECT $1, 'BULK' || g, 'Bulk', '+91999' || lpad(g::text, 7, '0'),
         '2024-01-01', 'ACTIVE'
       FROM generate_series(1, 5001) g`,
      [orgId],
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: h,
      payload: { type: "employees", format: "csv" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("PENDING");
  });

  it("returns 404 for an unknown report download id", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/${randomUUID()}/download`,
      headers: h,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Punch rate limiting
// ---------------------------------------------------------------------------

describe("punch rate limiting", () => {
  it("unit: the generic limiter emits 429 with retry_after_ms", async () => {
    const limit = createRateLimiter({ max: 2, windowMs: 60_000 });
    const calls: Array<{ status: number; body: unknown }> = [];
    const reply = {
      status(code: number) {
        const rec: { status: number; body: unknown } = { status: code, body: null };
        calls.push(rec);
        return {
          send(body: unknown) {
            rec.body = body;
            return Promise.resolve();
          },
        };
      },
    };
    const req = {
      authUser: { id: "user-1" },
      ip: "127.0.0.1",
      requestId: "req-1",
    };
    await limit(req as unknown as FastifyRequest, reply as unknown as FastifyReply);
    await limit(req as unknown as FastifyRequest, reply as unknown as FastifyReply);
    expect(calls.length).toBe(0);
    await limit(req as unknown as FastifyRequest, reply as unknown as FastifyReply);
    expect(calls.length).toBe(1);
    expect(calls[0]?.status).toBe(429);
    const body = calls[0]?.body as {
      code: string;
      retryable: boolean;
      retry_after_ms: number;
    };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryable).toBe(true);
    expect(typeof body.retry_after_ms).toBe("number");
    expect(body.retry_after_ms).toBeGreaterThan(0);
  });

  it("integration: the 31st punch in a minute is 429 retryable", async () => {
    const h = await adminHeaders();
    const empRow = await mkActiveEmployee({});
    let lastStatus = 0;
    let lastBody: Record<string, unknown> = {};
    for (let i = 0; i < 31; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/attendance/events",
        headers: { ...h, "Idempotency-Key": randomUUID() },
        payload: {
          employee_id: empRow,
          event_type: "CHECK_IN",
          client_timestamp: new Date().toISOString(),
        },
      });
      lastStatus = res.statusCode;
      lastBody = res.json() as Record<string, unknown>;
    }
    expect(lastStatus).toBe(429);
    expect(lastBody["code"]).toBe("RATE_LIMITED");
    expect(lastBody["retryable"]).toBe(true);
    expect(typeof lastBody["retry_after_ms"]).toBe("number");
  });
});
