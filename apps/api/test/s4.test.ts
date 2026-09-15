import {testDatabaseUrl} from "./database.js";
import { createHash, randomUUID } from "node:crypto";
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

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE stock_count_lines, stock_counts, stock_reservations, bank_transactions, payment_allocations, payments, financial_periods, project_categories, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, stock_locations, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, geo_fence_employee_assignments, device_registrations, audit_events, sessions, idempotency_keys, user_roles,
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

async function mkUser(
  roles: string[],
  tag: string,
): Promise<{ id: string; username: string; headers: Record<string, string> }> {
  const username = `s4_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const id = await createUser({ username, password: "Pass1234!", roles });
  return { id, username, headers: await headersFor(username, "Pass1234!") };
}

async function mkWorkspace(
  headers: Record<string, string>,
  name?: string,
): Promise<{ id: string; name: string }> {
  seq += 1;
  const wsName = name ?? `WS-${seq}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers,
    payload: { name: wsName, description: `${wsName} desc` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; name: string };
  return { id: body.id, name: body.name };
}

async function typeMap(): Promise<Record<string, string>> {
  const h = await adminHeaders();
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/project-types",
    headers: h,
  });
  expect(res.statusCode).toBe(200);
  const rows = (res.json() as { data: Array<{ id: string; code: string }> }).data;
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

async function mkProject(
  headers: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<{ id: string; code: string; version: number }> {
  const ws = await mkWorkspace(await adminHeaders());
  seq += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: {
      workspace_id: ws.id,
      code: `S4P${String(seq).padStart(5, "0")}`,
      name: `Project ${seq}`,
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; code: string; version: number };
  return { id: body.id, code: body.code, version: body.version };
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
    payload: { project_id: projectId, title: `Task ${randomUUID().slice(0, 8)}`, ...over },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; version: number };
  return { id: body.id, version: body.version };
}

function stepTask(
  headers: Record<string, string>,
  id: string,
  status: string,
  version: number,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/tasks/${id}/status`,
    headers: { ...headers, "If-Match": String(version) },
    payload: { status, ...extra },
  });
}

/** Drives a task TO_DO→IN_PROGRESS→IN_REVIEW→DONE, returning final version. */
async function finishTask(
  headers: Record<string, string>,
  id: string,
  startVersion: number,
): Promise<number> {
  let v = startVersion;
  for (const s of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
    const res = await stepTask(headers, id, s, v);
    expect(res.statusCode).toBe(200);
    v = (res.json() as { version: number }).version;
  }
  return v;
}

function empPayload(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    emp_no: `S4E${String(seq).padStart(5, "0")}`,
    first_name: "S4",
    last_name: "User",
    phone: `+9182000${String(10000 + seq)}`,
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

async function activateEmployee(employeeId: string): Promise<void> {
  await pool.query("UPDATE employees SET status = 'ACTIVE' WHERE id = $1::uuid", [
    employeeId,
  ]);
}

async function mkVillage(): Promise<string> {
  const h = await adminHeaders();
  seq += 1;
  const d = await app.inject({
    method: "POST",
    url: "/api/v1/org/units",
    headers: h,
    payload: { type: "district", code: `S4D${seq}`, name: `District ${seq}` },
  });
  expect(d.statusCode).toBe(201);
  const districtId = (d.json() as { id: string }).id;
  const m = await app.inject({
    method: "POST",
    url: "/api/v1/org/units",
    headers: h,
    payload: {
      type: "mandal",
      code: `S4M${seq}`,
      name: `Mandal ${seq}`,
      parent_id: districtId,
    },
  });
  expect(m.statusCode).toBe(201);
  const mandalId = (m.json() as { id: string }).id;
  const v = await app.inject({
    method: "POST",
    url: "/api/v1/org/units",
    headers: h,
    payload: {
      type: "village",
      code: `S4V${seq}`,
      name: `Village ${seq}`,
      parent_id: mandalId,
    },
  });
  expect(v.statusCode).toBe(201);
  return (v.json() as { id: string }).id;
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
    `TRUNCATE TABLE stock_count_lines, stock_counts, stock_reservations, bank_transactions, payment_allocations, payments, financial_periods, project_categories, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments, competitor_bids, tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions, opportunities, leads, contacts, clients, provider_jobs, advisory_cases, payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry, report_schedules, payslip_documents, vendors, inventory_items, invoices, stock_transactions, stock_locations, assets, asset_assignments, asset_audits, cycles, custom_field_definitions, domain_events, automation_rules, automation_executions, webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations, device_registrations, mentions, comments, task_evidence, task_dependencies,
      tasks, projects, project_workflows, project_types, workspaces,
      notifications, task_labels, labels, saved_filters, board_columns, boards,
      payslips, payroll_runs, payroll_policies`,
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

// ------------------------------------------------------------------ workspaces

describe("workspaces", () => {
  it("creates a workspace (201 bare) with ACTIVE status", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: h,
      payload: { name: "Field Ops", description: "Field workspace" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body["name"]).toBe("Field Ops");
    expect(body["description"]).toBe("Field workspace");
    expect(body["status"]).toBe("ACTIVE");
    expect(typeof body["id"]).toBe("string");
  });

  it("lists workspaces with the frozen item shape", async () => {
    const h = await adminHeaders();
    const ws = await mkWorkspace(h, "List Me");
    const res = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; name: string; description: string | null; status: string }>;
      has_more: boolean;
    };
    const found = body.data.find((w) => w.id === ws.id);
    expect(found).toMatchObject({ name: "List Me", status: "ACTIVE" });
    expect(Object.keys(found ?? {}).sort()).toEqual(
      ["description", "id", "name", "status"].sort(),
    );
  });

  it("gets a workspace by id", async () => {
    const h = await adminHeaders();
    const ws = await mkWorkspace(h, "Get Me");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${ws.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Get Me");
  });

  it("returns 404 for an unknown workspace", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${randomUUID()}`,
      headers: h,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects workspace creation without workspace.manage (403 CLIENT_VIEWER)", async () => {
    const viewer = await mkUser(["CLIENT_VIEWER"], "viewer");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: viewer.headers,
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ project types

describe("project types", () => {
  it("lists the seeded types, each on the default workflow", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/project-types",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{
        id: string;
        code: string;
        name: string;
        workflow: { statuses: string[]; allowed_transitions: Record<string, string[]> };
      }>;
    };
    // Asserts the canonical set is present rather than pinning a count: the
    // business adds types (AMC, Goods, Services) and an exact-equality check
    // turns every such addition into a test failure that teaches nothing.
    const byCode = Object.fromEntries(body.data.map((t) => [t.code, t]));
    expect(byCode["general"]?.name).toBe("General");
    expect(byCode["fieldwork"]?.name).toBe("Field Work");
    expect(byCode["amc"]?.name).toBe("AMC");
    expect(byCode["goods"]?.name).toBe("Goods");
    expect(byCode["services"]?.name).toBe("Services");
    expect(byCode["goods_and_services"]?.name).toBe("Goods and Services");
    for (const t of body.data) {
      expect(t.workflow.statuses).toEqual([
        "TO_DO",
        "IN_PROGRESS",
        "IN_REVIEW",
        "DONE",
        "BLOCKED",
        "CANCELLED",
      ]);
      expect(t.workflow.allowed_transitions["TO_DO"]).toEqual([
        "IN_PROGRESS",
        "CANCELLED",
      ]);
      expect(t.workflow.allowed_transitions["IN_PROGRESS"]).toEqual([
        "IN_REVIEW",
        "BLOCKED",
        "TO_DO",
      ]);
      expect(t.workflow.allowed_transitions["DONE"]).toEqual([]);
    }
  });

  it("requires auth (401 anon)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/project-types" });
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ projects

describe("projects", () => {
  it("creates a project (201 bare, DRAFT, MEDIUM default)", async () => {
    const h = await adminHeaders();
    const ws = await mkWorkspace(h);
    const types = await typeMap();
    const pm = await mkUser(["PROJECT_MANAGER"], "pm");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: h,
      payload: {
        workspace_id: ws.id,
        code: "PRJ-001",
        name: "Bridge Survey",
        project_type_id: types["general"],
        project_manager_id: pm.id,
        priority: "HIGH",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace_id: ws.id,
      code: "PRJ-001",
      name: "Bridge Survey",
      project_type_id: types["general"],
      project_manager_id: pm.id,
      priority: "HIGH",
      status: "DRAFT",
      version: 1,
    });
  });

  it("rejects a duplicate code in the same org (409)", async () => {
    const h = await adminHeaders();
    const ws = await mkWorkspace(h);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: h,
      payload: { workspace_id: ws.id, code: "DUP-1", name: "One" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: h,
      payload: { workspace_id: ws.id, code: "DUP-1", name: "Two" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("404s when the workspace does not exist in-org", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: h,
      payload: { workspace_id: randomUUID(), code: "X-1", name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("transitions DRAFT→ACTIVE (200) and reports version", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${p.id}`,
      headers: { ...h, "If-Match": String(p.version) },
      payload: { status: "ACTIVE" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; version: number };
    expect(body.status).toBe("ACTIVE");
    expect(body.version).toBe(2);
  });

  it("rejects an illegal project transition (422 INVALID_PROJECT_STATUS)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${p.id}`,
      headers: { ...h, "If-Match": String(p.version) },
      payload: { status: "CLOSED" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("INVALID_PROJECT_STATUS");
  });

  it("returns workflow + counts on project detail", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    await mkTask(h, p.id);
    const t2 = await mkTask(h, p.id);
    await finishTask(h, t2.id, t2.version);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${p.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workflow: { statuses: string[]; allowed_transitions: Record<string, string[]> };
      counts: { total: number; open: number; done: number };
    };
    expect(body.workflow.statuses).toContain("BLOCKED");
    expect(body.counts).toEqual({ total: 2, open: 1, done: 1 });
  });

  it("filters project list by status and q", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h, { code: "FILT-1", name: "Filterable Alpha" });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${p.id}`,
      headers: { ...h, "If-Match": String(p.version) },
      payload: { status: "ACTIVE" },
    });
    const byStatus = await app.inject({
      method: "GET",
      url: "/api/v1/projects?status=ACTIVE",
      headers: h,
    });
    expect(
      ((byStatus.json() as { data: Array<{ id: string }> }).data).some(
        (r) => r.id === p.id,
      ),
    ).toBe(true);
    const byQ = await app.inject({
      method: "GET",
      url: "/api/v1/projects?q=Filterable",
      headers: h,
    });
    expect((byQ.json() as { data: unknown[] }).data.length).toBeGreaterThan(0);
    const byQMiss = await app.inject({
      method: "GET",
      url: "/api/v1/projects?q=zzz-no-such-project",
      headers: h,
    });
    expect((byQMiss.json() as { data: unknown[] }).data.length).toBe(0);
  });

  it("forbids project close for EMPLOYEE (403)", async () => {
    const h = await adminHeaders();
    const emp = await mkUser(["EMPLOYEE"], "emp");
    const p = await mkProject(h);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${p.id}/close`,
      headers: emp.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ task create

describe("task create", () => {
  it("quick-adds with title only (201 bare, TO_DO)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: h,
      payload: { project_id: p.id, title: "Just do it" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      project_id: p.id,
      title: "Just do it",
      status: "TO_DO",
      version: 1,
    });
    expect(body["assignee_id"]).toBeNull();
    expect(body["board_position"]).toBe(0);
  });

  it("rejects a parent from another project (422 INVALID_PARENT)", async () => {
    const h = await adminHeaders();
    const pa = await mkProject(h);
    const pb = await mkProject(h);
    const parent = await mkTask(h, pa.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: h,
      payload: {
        project_id: pb.id,
        title: "Cross-project child",
        parent_task_id: parent.id,
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("INVALID_PARENT");
  });

  it("rejects an assignee whose linked employee is not ACTIVE (422 ASSIGNEE_INACTIVE)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const empUser = await mkUser(["EMPLOYEE"], "linked");
    const empId = await mkEmployee(h); // DRAFT, not ACTIVE
    await linkUser(empUser.id, empId);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: h,
      payload: {
        project_id: p.id,
        title: "Assigned to inactive",
        assignee_id: empUser.id,
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("ASSIGNEE_INACTIVE");
  });

  it("accepts full fields incl. village, dates, priority, estimate", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const villageId = await mkVillage();
    const worker = await mkUser(["EMPLOYEE"], "worker");
    const empId = await mkEmployee(h);
    await activateEmployee(empId);
    await linkUser(worker.id, empId);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: h,
      payload: {
        project_id: p.id,
        title: "Full task",
        description: "Everything set",
        assignee_id: worker.id,
        village_id: villageId,
        planned_start_date: "2026-09-10",
        planned_end_date: "2026-09-20",
        priority: "URGENT",
        estimated_hours: 12.5,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      title: "Full task",
      assignee_id: worker.id,
      village_id: villageId,
      planned_start_date: "2026-09-10",
      planned_end_date: "2026-09-20",
      priority: "URGENT",
      estimated_hours: 12.5,
    });
  });

  it("forbids task creation for CLIENT_VIEWER (403)", async () => {
    const h = await adminHeaders();
    const viewer = await mkUser(["CLIENT_VIEWER"], "viewer");
    const p = await mkProject(h);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: viewer.headers,
      payload: { project_id: p.id, title: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ task detail/patch

describe("task detail + patch", () => {
  it("returns subtasks, dependencies and allowed_next on detail", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const parent = await mkTask(h, p.id, { title: "Parent" });
    const child = await mkTask(h, p.id, {
      title: "Child",
      parent_task_id: parent.id,
    });
    const other = await mkTask(h, p.id, { title: "Other" });
    const dep = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${other.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: parent.id },
    });
    expect(dep.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${parent.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subtasks: Array<{ id: string; title: string; status: string }>;
      dependencies: {
        blocked_by: Array<{ id: string }>;
        blocking: Array<{ id: string }>;
      };
      allowed_next: string[];
    };
    expect(body.subtasks.map((s) => s.id)).toEqual([child.id]);
    expect(body.subtasks[0]).toMatchObject({ title: "Child", status: "TO_DO" });
    expect(body.dependencies.blocked_by).toEqual([]);
    expect(body.dependencies.blocking.map((t) => t.id)).toEqual([other.id]);
    expect(body.allowed_next).toEqual(["IN_PROGRESS", "CANCELLED"]);
  });

  it("patches title/description (200) with If-Match", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t.id}`,
      headers: { ...h, "If-Match": String(t.version) },
      payload: { title: "Renamed", priority: "HIGH" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Renamed", priority: "HIGH", version: 2 });
  });

  it("rejects status in PATCH body (422 USE_STATUS_ENDPOINT)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t.id}`,
      headers: { ...h, "If-Match": String(t.version) },
      payload: { status: "DONE" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("USE_STATUS_ENDPOINT");
  });

  it("rejects assignee in PATCH body (422 USE_ASSIGN_ENDPOINT)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const other = await mkUser(["EMPLOYEE"], "other");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t.id}`,
      headers: { ...h, "If-Match": String(t.version) },
      payload: { assignee_id: other.id },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("USE_ASSIGN_ENDPOINT");
  });

  it("409s a stale If-Match version on PATCH", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t.id}`,
      headers: { ...h, "If-Match": "999" },
      payload: { title: "Stale" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("VERSION_CONFLICT");
  });
});

// ------------------------------------------------------------------ status machine

describe("task status machine", () => {
  it("walks the happy path TO_DO→IN_PROGRESS", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await stepTask(h, t.id, "IN_PROGRESS", t.version);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "IN_PROGRESS", version: 2 });
  });

  it("rejects TO_DO→DONE with allowed_next (422 INVALID_TRANSITION)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await stepTask(h, t.id, "DONE", t.version);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; allowed_next: string[] };
    expect(body.code).toBe("INVALID_TRANSITION");
    expect(body.allowed_next).toEqual(["IN_PROGRESS", "CANCELLED"]);
  });

  // DONE and CANCELLED are terminal by design: DEFAULT_TASK_WORKFLOW maps both
  // to [], the override validator refuses outgoing edges from either, and the
  // date trigger stamps actual_end_at on entry to DONE. Reopening finished work
  // means a new task, not a backwards edge.
  it("keeps DONE terminal (no DONE→BLOCKED, no DONE→CANCELLED)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const version = await finishTask(h, t.id, t.version);
    for (const target of ["BLOCKED", "CANCELLED", "IN_PROGRESS", "TO_DO"]) {
      const res = await stepTask(h, t.id, target, version);
      expect(res.statusCode, target).toBe(422);
      const body = res.json() as { code: string; allowed_next: string[] };
      expect(body.code).toBe("INVALID_TRANSITION");
      expect(body.allowed_next).toEqual([]);
    }
  });

  it("keeps CANCELLED terminal", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const cancelled = await stepTask(h, t.id, "CANCELLED", t.version);
    expect(cancelled.statusCode).toBe(200);
    const version = (cancelled.json() as { version: number }).version;
    const res = await stepTask(h, t.id, "IN_PROGRESS", version);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { allowed_next: string[] }).allowed_next).toEqual([]);
  });

  // The kanban board picks drop targets from list rows, so a list that omits
  // allowed_next lets the UI offer DONE→BLOCKED and eat a 422 rollback. Every
  // list row must advertise exactly what the status endpoint will accept.
  it("advertises allowed_next on list rows, matching what the server enforces", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const open = await mkTask(h, p.id, { title: "Open one" });
    const done = await mkTask(h, p.id, { title: "Done one" });
    await finishTask(h, done.id, done.version);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${p.id}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as {
      data: Array<{ id: string; status: string; allowed_next: string[] }>;
    }).data;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(open.id)?.allowed_next).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(byId.get(done.id)?.allowed_next).toEqual([]);
    // Contract check: the detail endpoint and the list agree row for row.
    for (const row of rows) {
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/tasks/${row.id}`,
        headers: h,
      });
      expect((detail.json() as { allowed_next: string[] }).allowed_next).toEqual(
        row.allowed_next,
      );
    }
  });

  it("blocks DONE with open subtasks (422 SUBTASKS_OPEN), then allows it", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const parent = await mkTask(h, p.id, { title: "P" });
    const child = await mkTask(h, p.id, {
      title: "C",
      parent_task_id: parent.id,
    });
    let pv = parent.version;
    for (const s of ["IN_PROGRESS", "IN_REVIEW"]) {
      const r = await stepTask(h, parent.id, s, pv);
      expect(r.statusCode).toBe(200);
      pv = (r.json() as { version: number }).version;
    }
    const blocked = await stepTask(h, parent.id, "DONE", pv);
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { code: string }).code).toBe("SUBTASKS_OPEN");
    await finishTask(h, child.id, child.version);
    const done = await stepTask(h, parent.id, "DONE", pv);
    expect(done.statusCode).toBe(200);
    expect((done.json() as { status: string }).status).toBe("DONE");
  });

  it("blocks IN_PROGRESS on incomplete predecessors (422 DEPENDENCY_BLOCKED)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    const dep = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    expect(dep.statusCode).toBe(201);
    const res = await stepTask(h, b.id, "IN_PROGRESS", b.version);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; blocking: string[] };
    expect(body.code).toBe("DEPENDENCY_BLOCKED");
    expect(body.blocking).toEqual([a.id]);
    // After A finishes, B proceeds.
    await finishTask(h, a.id, a.version);
    const ok = await stepTask(h, b.id, "IN_PROGRESS", b.version);
    expect(ok.statusCode).toBe(200);
  });

  it("allows override with project.update + reason (audit OVERRIDE)", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pm");
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    const res = await stepTask(pm.headers, b.id, "IN_PROGRESS", b.version, {
      override: true,
      override_reason: "client escalation",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("IN_PROGRESS");
    const audit = await pool.query(
      `SELECT action, reason FROM audit_events
       WHERE action = 'task.status.override' AND entity_id = $1::uuid`,
      [b.id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe("client escalation");
  });

  it("rejects override without project.update (403 TEAM_LEAD)", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "tl");
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    const res = await stepTask(tl.headers, b.id, "IN_PROGRESS", b.version, {
      override: true,
      override_reason: "trying anyway",
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects override without a reason (422)", async () => {
    const h = await adminHeaders();
    const pm = await mkUser(["PROJECT_MANAGER"], "pm2");
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    const res = await stepTask(pm.headers, b.id, "IN_PROGRESS", b.version, {
      override: true,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("OVERRIDE_REASON_REQUIRED");
  });

  it("409s a stale If-Match version on status change", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await stepTask(h, t.id, "IN_PROGRESS", 4242);
    expect(res.statusCode).toBe(409);
  });
});

// ------------------------------------------------------------------ assign

describe("task assign", () => {
  it("requires a reason (422) then assigns with audit", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "tl");
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const worker = await mkUser(["EMPLOYEE"], "worker");
    const bare = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/assign`,
      headers: tl.headers,
      payload: { assignee_id: worker.id },
    });
    expect(bare.statusCode).toBe(422);
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/assign`,
      headers: tl.headers,
      payload: { assignee_id: worker.id, reason: "best skills for this" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { assignee_id: string }).assignee_id).toBe(worker.id);
    const audit = await pool.query(
      `SELECT reason FROM audit_events
       WHERE action = 'task.assign' AND entity_id = $1::uuid`,
      [t.id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe(
      "best skills for this",
    );
  });

  it("rejects assigning to an inactive linked employee (422 ASSIGNEE_INACTIVE)", async () => {
    const h = await adminHeaders();
    const tl = await mkUser(["TEAM_LEAD"], "tl2");
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const empUser = await mkUser(["EMPLOYEE"], "linked2");
    const empId = await mkEmployee(h);
    await linkUser(empUser.id, empId); // DRAFT, not ACTIVE
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/assign`,
      headers: tl.headers,
      payload: { assignee_id: empUser.id, reason: "assign anyway" },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("ASSIGNEE_INACTIVE");
  });
});

// ------------------------------------------------------------------ dependencies

describe("task dependencies", () => {
  it("rejects a cycle A→B→A (422 DEPENDENCY_CYCLE)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    expect(first.statusCode).toBe(201);
    const cycle = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: b.id },
    });
    expect(cycle.statusCode).toBe(422);
    expect((cycle.json() as { code: string }).code).toBe("DEPENDENCY_CYCLE");
  });

  it("rejects a self-dependency (422 SELF_DEPENDENCY)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("SELF_DEPENDENCY");
  });

  it("rejects a cross-project dependency (422 INVALID_DEPENDENCY)", async () => {
    const h = await adminHeaders();
    const pa = await mkProject(h);
    const pb = await mkProject(h);
    const a = await mkTask(h, pa.id, { title: "A" });
    const b = await mkTask(h, pb.id, { title: "B" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("INVALID_DEPENDENCY");
  });

  it("deletes a dependency (204) and 404s an unknown one", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const a = await mkTask(h, p.id, { title: "A" });
    const b = await mkTask(h, p.id, { title: "B" });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${b.id}/dependencies`,
      headers: h,
      payload: { predecessor_id: a.id },
    });
    const depId = (created.json() as { id: string }).id;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${b.id}/dependencies/${depId}`,
      headers: h,
    });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${b.id}/dependencies/${depId}`,
      headers: h,
    });
    expect(again.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ comments + mentions

describe("task comments", () => {
  it("creates mentions for known users and ignores unknown ones", async () => {
    const h = await adminHeaders();
    const author = await mkUser(["TEAM_LEAD"], "author");
    const target = await mkUser(["EMPLOYEE"], "target");
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/comments`,
      headers: author.headers,
      payload: { body: `hey @${target.username} and @ghost_nobody_zzz review this` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      comment: { id: string; author_username: string; body: string };
      mentioned_usernames: string[];
    };
    expect(body.comment.author_username).toBe(author.username);
    expect(body.mentioned_usernames).toEqual([target.username]);
    const rows = await pool.query(
      "SELECT mentioned_user_id FROM mentions WHERE comment_id = $1::uuid",
      [body.comment.id],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { mentioned_user_id: string }).mentioned_user_id).toBe(
      target.id,
    );
  });

  it("lists comments oldest-first with author names", async () => {
    const h = await adminHeaders();
    const author = await mkUser(["TEAM_LEAD"], "author2");
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/comments`,
      headers: author.headers,
      payload: { body: "first note" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/comments`,
      headers: author.headers,
      payload: { body: "second note" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${t.id}/comments`,
      headers: author.headers,
    });
    expect(res.statusCode).toBe(200);
    const data = (
      res.json() as {
        data: Array<{ author_username: string; body: string }>;
      }
    ).data;
    expect(data.map((c) => c.body)).toEqual(["first note", "second note"]);
    expect(data[0]?.author_username).toBe(author.username);
  });
});

// ------------------------------------------------------------------ evidence

describe("task evidence", () => {
  it("uploads evidence and returns the sha256 checksum", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const bytes = Buffer.from("%PDF-1.4 s4-evidence-bytes");
    const expected = createHash("sha256").update(bytes).digest("hex");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/evidence`,
      headers: h,
      payload: {
        evidence_type: "site_photo",
        file_name: "site.pdf",
        content_base64: bytes.toString("base64"),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; checksum: string; file_name: string };
    expect(body.checksum).toBe(expected);
    expect(body.file_name).toBe("site.pdf");
    const row = await pool.query(
      "SELECT checksum, file_size FROM task_evidence WHERE id = $1::uuid",
      [body.id],
    );
    expect((row.rows[0] as { checksum: string }).checksum).toBe(expected);
    expect(Number((row.rows[0] as { file_size: number }).file_size)).toBe(
      bytes.length,
    );
  });

  it("lists evidence for a task", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/evidence`,
      headers: h,
      payload: {
        evidence_type: "doc",
        file_name: "a.png",
        content_base64: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${t.id}/evidence`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Array<{ file_name: string }> }).data;
    expect(data.map((e) => e.file_name)).toEqual(["a.png"]);
  });

  it("rejects a disallowed extension (422)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t.id}/evidence`,
      headers: h,
      payload: {
        evidence_type: "doc",
        file_name: "run.exe",
        content_base64: Buffer.from("x").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

// ------------------------------------------------------------------ board + lists

describe("board position + task lists", () => {
  it("reorders via board-position (200) with If-Match", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    const t = await mkTask(h, p.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t.id}/board-position`,
      headers: { ...h, "If-Match": String(t.version) },
      payload: { board_position: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ board_position: 7, version: 2 });
  });

  it("filters tasks by project, q and assignee_me", async () => {
    const h = await adminHeaders();
    const worker = await mkUser(["EMPLOYEE"], "lister");
    const pa = await mkProject(h);
    const pb = await mkProject(h);
    await mkTask(h, pa.id, { title: "Alpha survey work" });
    await mkTask(h, pb.id, { title: "Beta other work" });
    const assigned = await mkTask(h, pa.id, {
      title: "My assigned job",
      assignee_id: worker.id,
    });
    const byProject = await app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${pa.id}`,
      headers: h,
    });
    expect((byProject.json() as { data: unknown[] }).data.length).toBe(2);
    const byQ = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?q=Alpha+survey",
      headers: h,
    });
    expect((byQ.json() as { data: unknown[] }).data.length).toBe(1);
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?assignee_me=true",
      headers: worker.headers,
    });
    const mineData = (mine.json() as { data: Array<{ id: string }> }).data;
    expect(mineData.map((t) => t.id)).toEqual([assigned.id]);
  });
});

// ------------------------------------------------------------------ project close

describe("project close", () => {
  it("refuses to close with open tasks (422 PROJECT_HAS_OPEN_TASKS)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${p.id}`,
      headers: { ...h, "If-Match": String(p.version) },
      payload: { status: "ACTIVE" },
    });
    await mkTask(h, p.id);
    await mkTask(h, p.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${p.id}/close`,
      headers: h,
      payload: { reason: "wrapping up" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; open_count: number };
    expect(body.code).toBe("PROJECT_HAS_OPEN_TASKS");
    expect(body.open_count).toBe(2);
  });

  it("closes once every task is terminal (200 CLOSED)", async () => {
    const h = await adminHeaders();
    const p = await mkProject(h);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${p.id}`,
      headers: { ...h, "If-Match": String(p.version) },
      payload: { status: "ACTIVE" },
    });
    const t = await mkTask(h, p.id);
    await finishTask(h, t.id, t.version);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${p.id}/close`,
      headers: h,
      payload: { reason: "all done" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("CLOSED");
    const audit = await pool.query(
      `SELECT reason FROM audit_events
       WHERE action = 'project.close' AND entity_id = $1::uuid`,
      [p.id],
    );
    expect((audit.rows[0] as { reason: string }).reason).toBe("all done");
  });
});
