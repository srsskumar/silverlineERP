/**
 * Shared world for the Silverline business test catalogue.
 *
 * Implements the catalogue's "Test data baseline" verbatim: two organizations
 * to prove tenant isolation; in the primary organization all seeded roles, two
 * districts, two complete District→Mandal→Village→Site chains, two active
 * employees, one suspended and one exited employee, one employee with a direct
 * fence and one with only a site assignment, circular and polygon fences, an
 * active project with a configurable workflow, an inactive project, leave
 * balances, an open payroll period, assets, and stock with quantity one.
 *
 * The world is built through the real HTTP surface wherever an endpoint exists,
 * so the fixture itself is a smoke test of the product rather than a parallel
 * re-implementation of it. Direct SQL is used only where the product
 * deliberately exposes no endpoint (creating a second tenant, linking a user to
 * an employee, suspending an employee).
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance, InjectOptions } from "fastify";
import { ROLE_CODES, type RoleCode } from "@silverline/shared";
import { buildApp } from "../../src/createApp.js";
import { migrate } from "../../src/database/migrate.js";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seedDatabase } from "../../src/database/seed.js";
import { testDatabaseUrl } from "../database.js";

export const TEST_DB = testDatabaseUrl();
export const JWT_SECRET = "catalogue-secret-change-me";
export const ORG_TIMEZONE = "Asia/Kolkata";

/** Password used for every fixture user. */
export const PASSWORD = "Pass1234!";

export type Headers = Record<string, string>;

/**
 * The catalogue fixes the organization timezone to Asia/Kolkata and asks for a
 * frozen clock "where dates affect results". Faking the system clock would
 * break the pg driver's timers, so instead the whole suite derives every
 * date-dependent value from this one reference, captured once per run.
 */
export const NOW = new Date();

/** Calendar day in the organization timezone, YYYY-MM-DD. */
export function workDate(at: Date = NOW): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ORG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** First day of the month containing `at`, in the organization timezone. */
export function monthStart(at: Date = NOW): string {
  return `${workDate(at).slice(0, 7)}-01`;
}

/** Last day of the month containing `at`, in the organization timezone. */
export function monthEnd(at: Date = NOW): string {
  const [y, m] = workDate(at).split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${workDate(at).slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

// Every suite writes uploads to its own directory so parallel runs cannot
// collide, and so a failed run leaves its evidence behind for inspection.
process.env["UPLOADS_DIR"] ??= join(tmpdir(), `sl-catalogue-${process.pid}`);

/**
 * Tables the catalogue suites own. Ordered so foreign keys never block the
 * TRUNCATE; `organizations`, `roles` and `permissions` are deliberately absent
 * because the seed owns them.
 */
// Commercial spine (§6.3–6.5, §8, §37). These must be listed: they carry
// foreign keys into projects/users/organizations, and PostgreSQL refuses to
// truncate a table that an unlisted table references.
const OWNED_TABLES = `expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims, expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines, vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs, invoice_match_results, grn_lines, goods_receipt_notes, po_amendments, purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions, invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies, approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills, project_advances, project_billing_policies, boq_items, party_gst_registrations, record_conversions, bank_guarantee_instruments,
  competitor_bids, tender_eligibility_items, tender_corrigenda,
  private_proposals, tenders, interactions, opportunities, leads,
  contacts, clients,
  provider_jobs, advisory_cases, payslip_revisions,
  project_workflow_overrides, notification_deliveries, report_registry,
  report_schedules, payslip_documents, vendors, inventory_items, invoices,
  stock_transactions, assets, asset_assignments, asset_audits, cycles,
  custom_field_definitions, domain_events, automation_rules,
  automation_executions, webhook_subscriptions, webhook_deliveries,
  insight_feedback, v2_operations, geo_fence_employee_assignments,
  device_registrations, audit_events, sessions, idempotency_keys, user_roles,
  users, employee_documents, employees, org_units, holidays,
  attendance_exceptions, attendance_records, attendance_events, geo_fences,
  leave_requests, leave_balances, leave_types, mentions, comments,
  task_evidence, task_dependencies, tasks, projects, project_workflows,
  project_types, workspaces, notifications, task_labels, labels, saved_filters,
  board_columns, boards, payslips, payroll_runs, payroll_policies`;

/** A District→Mandal→Village→Site chain. */
export interface UnitChain {
  district: string;
  mandal: string;
  village: string;
  site: string;
}

export interface CatalogueWorld {
  app: FastifyInstance;
  pool: Pool;

  /** Primary tenant (the seeded demo organization). */
  orgId: string;
  /** Second tenant, used only to prove isolation. */
  otherOrgId: string;

  adminId: string;
  admin: Headers;
  /** One signed-in user per seeded role code. */
  role: Record<RoleCode, Headers>;
  /** The user id behind each role's headers. */
  roleUserId: Record<RoleCode, string>;

  /** Two districts, two complete chains. `chainA.district !== chainB.district`. */
  chainA: UnitChain;
  chainB: UnitChain;

  /** ACTIVE, sits on chainA's site, and holds a direct fence assignment. */
  directEmployee: string;
  /** ACTIVE, sits on chainB's site, and has no direct fence. */
  siteEmployee: string;
  /** SUSPENDED. */
  suspendedEmployee: string;
  /** EXITED. */
  exitedEmployee: string;

  /** Signed-in user linked to `directEmployee` (EMPLOYEE role). */
  directUser: Headers;
  directUserId: string;
  /** Signed-in user linked to `siteEmployee` (EMPLOYEE role). */
  siteUser: Headers;
  siteUserId: string;

  /** Circular fence over chainA's site; holds `directEmployee`'s assignment. */
  circleFence: string;
  /** Polygon fence over chainB's site. */
  polygonFence: string;
  /** Circular fences at the coarser levels of chainB, for precedence tests. */
  villageFence: string;
  mandalFence: string;
  districtFence: string;

  workspaceId: string;
  projectTypeId: string;
  /** ACTIVE project carrying a per-project workflow override. */
  activeProject: string;
  /** Project left in an inactive lifecycle state. */
  inactiveProject: string;

  /** Open payroll run covering the current month. */
  payrollRunId: string;

  /** Asset available for assignment. */
  assetId: string;
  /** Inventory item stocked with exactly one unit. */
  itemId: string;
  vendorId: string;

  /** Entities living in `otherOrgId`, for cross-tenant negatives. */
  other: {
    orgId: string;
    adminId: string;
    admin: Headers;
    district: string;
    site: string;
    employee: string;
    fence: string;
  };
}

/** Geometry the whole catalogue shares, so "inside" means the same everywhere. */
export const GEO = {
  /** Centre of the circular fence on chainA's site. */
  circleCentre: { lat: 17.385, lng: 78.4867 },
  circleRadiusM: 200,
  /** ~150 m north of the centre — comfortably inside. */
  insideCircle: { lat: 17.38635, lng: 78.4867 },
  /** Exactly on the 200 m boundary, due north. */
  boundaryCircle: { lat: 17.385 + 200 / 111_320, lng: 78.4867 },
  /** ~2 km away — outside by any tolerance the fixture uses. */
  outsideCircle: { lat: 17.405, lng: 78.4867 },

  /** Square polygon on chainB's site, ~1.1 km on a side. */
  polygon: [
    [17.4, 78.5],
    [17.41, 78.5],
    [17.41, 78.51],
    [17.4, 78.51],
  ] as Array<[number, number]>,
  insidePolygon: { lat: 17.405, lng: 78.505 },
  /** A vertex — "on the edge" in the catalogue's sense. */
  edgePolygon: { lat: 17.4, lng: 78.5 },
  outsidePolygon: { lat: 17.42, lng: 78.52 },

  /** Centres for the coarser fences of chainB, deliberately far apart. */
  villageCentre: { lat: 17.45, lng: 78.55 },
  mandalCentre: { lat: 17.5, lng: 78.6 },
  districtCentre: { lat: 17.6, lng: 78.7 },
} as const;

/** Metres per degree of latitude — good to ~0.1% at these latitudes. */
export const M_PER_DEG_LAT = 111_320;

let seq = 0;
/** Monotonic, collision-free suffix for unique business keys. */
export function uniq(prefix = ""): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * A fresh Idempotency-Key header.
 *
 * A UUID rather than a readable slug: some routes (leave requests, payroll)
 * require the key to *be* a UUID, and a single shape that satisfies every route
 * keeps callers from having to know which is which.
 */
export function idem(): Headers {
  return { "idempotency-key": randomUUID() };
}

export async function openPool(): Promise<Pool> {
  return new Pool({ connectionString: TEST_DB });
}

/** Truncates everything the catalogue owns, leaving the seed's rows intact. */
export async function truncateOwned(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${OWNED_TABLES}`);
}

/**
 * Builds (or rebuilds) the catalogue baseline. Call once per test file from
 * `beforeAll`; individual tests create their own rows for anything they mutate.
 */
export async function buildWorld(): Promise<CatalogueWorld> {
  await migrate(TEST_DB);
  const pool = new Pool({ connectionString: TEST_DB });
  await truncateOwned(pool);
  const { orgId, adminId } = await seedDatabase(pool, { bcryptRounds: 4 });
  await pool.query("UPDATE organizations SET timezone = $2 WHERE id = $1", [
    orgId,
    ORG_TIMEZONE,
  ]);

  // The catalogue drives far more logins and punches per run than a real user
  // ever would; the rate limiters are exercised deliberately in their own
  // tests rather than incidentally throttling every other one.
  const app = await buildApp({
    pool,
    jwtSecret: JWT_SECRET,
    nodeEnv: "test",
    loginRateLimitMax: 100_000,
    punchRateLimitMax: 100_000,
  });
  await app.ready();

  const world = {} as CatalogueWorld;
  world.app = app;
  world.pool = pool;
  world.orgId = orgId;
  world.adminId = adminId;

  const login = async (username: string, password: string): Promise<Headers> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    const body = res.json() as { access_token?: string };
    if (!body.access_token) {
      throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`);
    }
    return { authorization: `Bearer ${body.access_token}` };
  };

  world.admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);

  // --- one signed-in user per seeded role ---------------------------------
  world.role = {} as Record<RoleCode, Headers>;
  world.roleUserId = {} as Record<RoleCode, string>;
  for (const code of ROLE_CODES) {
    const username = `cat_${code.toLowerCase()}_${uniq()}`;
    const id = await createUser(pool, orgId, { username, roles: [code] });
    world.roleUserId[code] = id;
    world.role[code] = await login(username, PASSWORD);
  }

  // --- two districts, two complete chains ---------------------------------
  world.chainA = await createChain(app, world.admin, "A");
  world.chainB = await createChain(app, world.admin, "B");

  // --- employees -----------------------------------------------------------
  world.directEmployee = await createEmployee(app, world.admin, {
    district_id: world.chainA.district,
    mandal_id: world.chainA.mandal,
    village_id: world.chainA.village,
    site_id: world.chainA.site,
    salary_basic: 30000,
  });
  world.siteEmployee = await createEmployee(app, world.admin, {
    district_id: world.chainB.district,
    mandal_id: world.chainB.mandal,
    village_id: world.chainB.village,
    site_id: world.chainB.site,
    salary_basic: 24000,
  });
  world.suspendedEmployee = await createEmployee(app, world.admin, {
    district_id: world.chainA.district,
  });
  world.exitedEmployee = await createEmployee(app, world.admin, {
    district_id: world.chainA.district,
  });

  // Creation lands every employee in DRAFT; the baseline's two active
  // employees reach ACTIVE through the product's own activation transition.
  for (const employeeId of [
    world.directEmployee,
    world.siteEmployee,
    world.suspendedEmployee,
    world.exitedEmployee,
  ]) {
    await activate(app, world.admin, employeeId);
  }
  await suspend(app, world.admin, world.suspendedEmployee);
  const exited = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${world.exitedEmployee}/exit`,
    headers: { ...world.admin, ...idem() },
    payload: { exit_date: workDate(), reason: "Catalogue baseline: exited employee" },
  });
  if (exited.statusCode >= 400) {
    throw new Error(`baseline exit failed: ${exited.statusCode} ${exited.body}`);
  }

  // Employee-role users linked to their employee rows, so punch scope resolves.
  const directUsername = `cat_emp_direct_${uniq()}`;
  world.directUserId = await createUser(pool, orgId, {
    username: directUsername,
    roles: ["EMPLOYEE"],
    employeeId: world.directEmployee,
  });
  world.directUser = await login(directUsername, PASSWORD);

  const siteUsername = `cat_emp_site_${uniq()}`;
  world.siteUserId = await createUser(pool, orgId, {
    username: siteUsername,
    roles: ["EMPLOYEE"],
    employeeId: world.siteEmployee,
  });
  world.siteUser = await login(siteUsername, PASSWORD);

  // --- fences --------------------------------------------------------------
  // Circle on chainA's site, directly assigned to `directEmployee`.
  world.circleFence = await createFence(app, world.admin, {
    name: "Catalogue circle (site A)",
    scope_type: "site",
    scope_id: world.chainA.site,
    geometry_type: "circle",
    geometry: { ...GEO.circleCentre, radius_m: GEO.circleRadiusM },
    tolerance_meters: 0,
    employee_ids: [world.directEmployee],
  });
  // Polygon on chainB's site — `siteEmployee` reaches it through the hierarchy.
  world.polygonFence = await createFence(app, world.admin, {
    name: "Catalogue polygon (site B)",
    scope_type: "site",
    scope_id: world.chainB.site,
    geometry_type: "polygon",
    geometry: { points: GEO.polygon },
    tolerance_meters: 0,
  });
  world.villageFence = await createFence(app, world.admin, {
    name: "Catalogue village fence (B)",
    scope_type: "village",
    scope_id: world.chainB.village,
    geometry_type: "circle",
    geometry: { ...GEO.villageCentre, radius_m: 300 },
  });
  world.mandalFence = await createFence(app, world.admin, {
    name: "Catalogue mandal fence (B)",
    scope_type: "mandal",
    scope_id: world.chainB.mandal,
    geometry_type: "circle",
    geometry: { ...GEO.mandalCentre, radius_m: 400 },
  });
  world.districtFence = await createFence(app, world.admin, {
    name: "Catalogue district fence (B)",
    scope_type: "district",
    scope_id: world.chainB.district,
    geometry_type: "circle",
    geometry: { ...GEO.districtCentre, radius_m: 500 },
  });

  // --- projects ------------------------------------------------------------
  world.workspaceId = await post(app, world.admin, "/api/v1/workspaces", {
    code: `WS${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue workspace",
  });
  const types = await app.inject({
    method: "GET",
    url: "/api/v1/project-types",
    headers: world.admin,
  });
  const typeRows = (types.json() as { data: Array<{ id: string }> }).data;
  world.projectTypeId = typeRows[0]!.id;

  world.activeProject = await post(app, world.admin, "/api/v1/projects", {
    workspace_id: world.workspaceId,
    project_type_id: world.projectTypeId,
    code: `PRJ${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue active project",
  });
  // Projects, like employees, are created as drafts; the baseline's active
  // project walks the frozen DRAFT→ACTIVE edge rather than being forced.
  await patchProject(app, world.admin, world.activeProject, { status: "ACTIVE" });
  world.inactiveProject = await post(app, world.admin, "/api/v1/projects", {
    workspace_id: world.workspaceId,
    project_type_id: world.projectTypeId,
    code: `PRJ${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue inactive project",
  });
  await patchProject(app, world.admin, world.inactiveProject, { status: "ACTIVE" });
  await patchProject(app, world.admin, world.inactiveProject, { status: "ON_HOLD" });

  // A per-project workflow override makes "configurable workflow" real rather
  // than implied by the shared project-type default.
  const workflow = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${world.activeProject}/workflow`,
    headers: world.admin,
  });
  const wf = workflow.json() as {
    statuses: string[];
    allowed_transitions: Record<string, string[]>;
    version: number;
  };
  const savedWorkflow = await app.inject({
    method: "PUT",
    url: `/api/v1/projects/${world.activeProject}/workflow`,
    headers: { ...world.admin, "if-match": String(wf.version), ...idem() },
    payload: { statuses: wf.statuses, allowed_transitions: wf.allowed_transitions },
  });
  if (savedWorkflow.statusCode >= 400) {
    throw new Error(
      `baseline workflow override failed: ${savedWorkflow.statusCode} ${savedWorkflow.body}`,
    );
  }

  // --- leave balances ------------------------------------------------------
  const leaveTypes = await app.inject({
    method: "GET",
    url: "/api/v1/leave/types",
    headers: world.admin,
  });
  const casual = (leaveTypes.json() as { data: Array<{ id: string; code: string }> }).data.find(
    (t) => t.code === "CL",
  );
  if (casual) {
    for (const employeeId of [world.directEmployee, world.siteEmployee]) {
      const balance = await app.inject({
        method: "POST",
        url: "/api/v1/leave/balances",
        headers: { ...world.admin, ...idem() },
        payload: {
          employee_id: employeeId,
          leave_type_id: casual.id,
          period_year: Number(workDate().slice(0, 4)),
          opening_balance: 12,
        },
      });
      if (balance.statusCode >= 400) {
        throw new Error(`baseline leave balance failed: ${balance.statusCode} ${balance.body}`);
      }
    }
  }

  // --- open payroll period -------------------------------------------------
  world.payrollRunId = await post(app, world.role.PAYROLL_OFFICER, "/api/v1/payroll/runs", {
    period_start: monthStart(),
    period_end: monthEnd(),
  });

  // --- assets and stock ----------------------------------------------------
  world.vendorId = await post(app, world.role.INVENTORY_MANAGER, "/api/v1/vendors", {
    code: `V${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue vendor",
  });
  world.assetId = await post(app, world.role.INVENTORY_MANAGER, "/api/v1/assets", {
    asset_code: `AS${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue laptop",
    category: "IT",
    condition: "GOOD",
  });
  world.itemId = await post(app, world.role.INVENTORY_MANAGER, "/api/v1/inventory/items", {
    code: `IT${uniq().toUpperCase().slice(-6)}`,
    name: "Catalogue cement bag",
    unit: "BAG",
  });
  // Exactly one unit in stock — the catalogue's concurrency probe (BR-08).
  await app.inject({
    method: "POST",
    url: "/api/v1/inventory/transactions",
    headers: { ...world.role.INVENTORY_MANAGER, ...idem() },
    payload: { item_id: world.itemId, direction: "IN", quantity: 1, reference: "baseline" },
  });

  // --- second tenant -------------------------------------------------------
  world.other = await buildOtherOrg(app, pool, login);
  world.otherOrgId = world.other.orgId;

  return world;
}

async function buildOtherOrg(
  app: FastifyInstance,
  pool: Pool,
  login: (u: string, p: string) => Promise<Headers>,
): Promise<CatalogueWorld["other"]> {
  const otherOrgId = (
    await pool.query(
      "INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id",
      [`Catalogue Other Org ${uniq()}`, ORG_TIMEZONE],
    )
  ).rows[0].id as string;
  await pool.query(
    "INSERT INTO payroll_policies (org_id, per_day_divisor, pf_pct) VALUES ($1, 30, 12) ON CONFLICT (org_id) DO NOTHING",
    [otherOrgId],
  );

  const username = `cat_other_admin_${uniq()}`;
  const adminId = await createUser(pool, otherOrgId, {
    username,
    roles: ["SUPER_ADMIN"],
  });
  const headers = await login(username, PASSWORD);

  const district = await post(app, headers, "/api/v1/org/units", {
    type: "district",
    code: `OD${uniq().toUpperCase().slice(-6)}`,
    name: "Other district",
  });
  const mandal = await post(app, headers, "/api/v1/org/units", {
    type: "mandal",
    code: `OM${uniq().toUpperCase().slice(-6)}`,
    name: "Other mandal",
    parent_id: district,
  });
  const village = await post(app, headers, "/api/v1/org/units", {
    type: "village",
    code: `OV${uniq().toUpperCase().slice(-6)}`,
    name: "Other village",
    parent_id: mandal,
  });
  const site = await post(app, headers, "/api/v1/org/units", {
    type: "site",
    code: `OS${uniq().toUpperCase().slice(-6)}`,
    name: "Other site",
    parent_id: village,
  });
  const employee = await createActiveEmployee(app, headers, {
    district_id: district,
    mandal_id: mandal,
    village_id: village,
    site_id: site,
  });
  const fence = await createFence(app, headers, {
    name: "Other org fence",
    scope_type: "site",
    scope_id: site,
    geometry_type: "circle",
    geometry: { lat: 19.076, lng: 72.8777, radius_m: 150 },
  });

  return { orgId: otherOrgId, adminId, admin: headers, district, site, employee, fence };
}

// ---------------------------------------------------------------------------
// Small helpers reused by every catalogue suite
// ---------------------------------------------------------------------------

/** The org's leave type ids, keyed by code (CL, SL, EL, LOP). */
export async function leaveTypeIds(
  app: FastifyInstance,
  headers: Headers,
): Promise<Record<string, string>> {
  const res = await app.inject({ method: "GET", url: "/api/v1/leave/types", headers });
  const rows = (res.json() as { data: Array<{ id: string; code: string }> }).data;
  return Object.fromEntries(rows.map((t) => [t.code, t.id]));
}

/**
 * Gives an employee an opening balance so balance-backed types can be
 * requested. CL/SL/EL all require a balance, so a request from a freshly
 * created employee is rejected until this runs.
 */
export async function grantLeaveBalance(
  app: FastifyInstance,
  headers: Headers,
  employeeId: string,
  leaveTypeId: string,
  openingBalance = 12,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/leave/balances",
    headers: { ...headers, ...idem() },
    payload: {
      employee_id: employeeId,
      leave_type_id: leaveTypeId,
      period_year: Number(workDate().slice(0, 4)),
      opening_balance: openingBalance,
    },
  });
  if (res.statusCode >= 400) {
    throw new Error(`grantLeaveBalance failed: ${res.statusCode} ${res.body}`);
  }
}

/** Signs in and returns an Authorization header, throwing on failure. */
export async function loginAs(
  app: FastifyInstance,
  username: string,
  password: string = PASSWORD,
): Promise<Headers> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { access_token?: string };
  if (!body.access_token) {
    throw new Error(`login failed for ${username}: ${res.statusCode} ${res.body}`);
  }
  return { authorization: `Bearer ${body.access_token}` };
}

/**
 * Signs in as a user identified by id.
 *
 * Every fixture user shares PASSWORD except the seeded admin, so the password
 * is chosen from the username rather than threaded through every caller.
 */
export async function headersForUserId(
  w: CatalogueWorld,
  userId: string,
): Promise<Headers> {
  const row = await w.pool.query("SELECT username FROM users WHERE id = $1", [userId]);
  const username = row.rows[0]?.username as string | undefined;
  if (!username) throw new Error(`no user ${userId}`);
  return loginAs(w.app, username, username === ADMIN_USERNAME ? ADMIN_PASSWORD : PASSWORD);
}

/** Reads a row's current version, for callers that must send If-Match. */
export async function versionOf(
  w: CatalogueWorld,
  table: string,
  id: string,
): Promise<number> {
  const allowed = new Set([
    "employees",
    "geo_fences",
    "projects",
    "tasks",
    "leave_requests",
    "payroll_runs",
    "assets",
    "inventory_items",
    "boards",
    "cycles",
    "attendance_exceptions",
    "automation_rules",
    "custom_field_definitions",
  ]);
  if (!allowed.has(table)) throw new Error(`versionOf: unexpected table ${table}`);
  const row = await w.pool.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
  if (!row.rowCount) throw new Error(`versionOf: no ${table} row ${id}`);
  return Number(row.rows[0].version);
}

/** If-Match header carrying a row's current version. */
export async function ifMatch(
  w: CatalogueWorld,
  table: string,
  id: string,
): Promise<Headers> {
  return { "if-match": String(await versionOf(w, table, id)) };
}

export async function createUser(
  pool: Pool,
  orgId: string,
  opts: { username: string; password?: string; roles?: RoleCode[]; employeeId?: string },
): Promise<string> {
  const hash = await bcrypt.hash(opts.password ?? PASSWORD, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status, employee_id)
     VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
    [orgId, opts.username, hash, opts.employeeId ?? null],
  );
  const id = res.rows[0].id as string;
  for (const code of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      id,
      role.rows[0].id,
    ]);
  }
  return id;
}

/** POSTs a create endpoint and returns the new row's id, throwing on failure. */
export async function post(
  app: FastifyInstance,
  headers: Headers,
  url: string,
  payload: unknown,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { ...headers, ...idem() },
    payload: payload as InjectOptions["payload"],
  });
  if (res.statusCode >= 400) {
    throw new Error(`fixture POST ${url} failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { id?: string };
  if (!body.id) throw new Error(`fixture POST ${url} returned no id: ${res.body}`);
  return body.id;
}

export async function createChain(
  app: FastifyInstance,
  headers: Headers,
  label: string,
): Promise<UnitChain> {
  const tag = uniq().toUpperCase().slice(-5);
  const district = await post(app, headers, "/api/v1/org/units", {
    type: "district",
    code: `D${label}${tag}`,
    name: `District ${label}`,
  });
  const mandal = await post(app, headers, "/api/v1/org/units", {
    type: "mandal",
    code: `M${label}${tag}`,
    name: `Mandal ${label}`,
    parent_id: district,
  });
  const village = await post(app, headers, "/api/v1/org/units", {
    type: "village",
    code: `V${label}${tag}`,
    name: `Village ${label}`,
    parent_id: mandal,
  });
  const site = await post(app, headers, "/api/v1/org/units", {
    type: "site",
    code: `S${label}${tag}`,
    name: `Site ${label}`,
    parent_id: village,
  });
  return { district, mandal, village, site };
}

export async function createEmployee(
  app: FastifyInstance,
  headers: Headers,
  over: Record<string, unknown> = {},
): Promise<string> {
  const tag = uniq();
  return post(app, headers, "/api/v1/employees", {
    emp_no: `E${tag.toUpperCase().slice(-8)}`,
    first_name: "Catalogue",
    last_name: "Employee",
    phone: uniquePhone(),
    date_of_joining: "2024-01-15",
    ...over,
  });
}

/** Moves a DRAFT employee to ACTIVE through the product's own transition. */
export async function activate(
  app: FastifyInstance,
  headers: Headers,
  employeeId: string,
  reason = "Catalogue baseline: record complete",
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${employeeId}/activate`,
    headers: { ...headers, ...idem() },
    payload: { reason },
  });
  if (res.statusCode >= 400) {
    throw new Error(`activate ${employeeId} failed: ${res.statusCode} ${res.body}`);
  }
}

/** Moves an ACTIVE employee to SUSPENDED. */
export async function suspend(
  app: FastifyInstance,
  headers: Headers,
  employeeId: string,
  reason = "Catalogue baseline: suspended employee",
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${employeeId}/suspend`,
    headers: { ...headers, ...idem() },
    payload: { reason },
  });
  if (res.statusCode >= 400) {
    throw new Error(`suspend ${employeeId} failed: ${res.statusCode} ${res.body}`);
  }
}

/** Creates an employee and activates it in one step. */
export async function createActiveEmployee(
  app: FastifyInstance,
  headers: Headers,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = await createEmployee(app, headers, over);
  await activate(app, headers, id);
  return id;
}

/**
 * PATCHes a project, reading its current version first so callers never have to
 * thread If-Match through their own code.
 */
export async function patchProject(
  app: FastifyInstance,
  headers: Headers,
  projectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const current = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}`,
    headers,
  });
  const { version } = current.json() as { version: number };
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${projectId}`,
    headers: { ...headers, "if-match": String(version), ...idem() },
    payload: payload as InjectOptions["payload"],
  });
  if (res.statusCode >= 400) {
    throw new Error(`patch project ${projectId} failed: ${res.statusCode} ${res.body}`);
  }
}

export async function createFence(
  app: FastifyInstance,
  headers: Headers,
  payload: Record<string, unknown>,
): Promise<string> {
  return post(app, headers, "/api/v1/geo-fences", payload);
}

let phoneSeq = 0;
/** A distinct, schema-valid Indian mobile number per call. */
export function uniquePhone(): string {
  phoneSeq += 1;
  const tail = String((Date.now() % 1_000_000) * 10 + (phoneSeq % 10)).slice(-8);
  return `+919${tail.padStart(9, "0").slice(-9)}`;
}

/** A punch payload with the catalogue's defaults filled in. */
export function punch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "CHECK_IN",
    client_timestamp: new Date().toISOString(),
    ...over,
  };
}

/** Latitude offset, in degrees, for a distance due north in metres. */
export function metresNorth(metres: number): number {
  return metres / M_PER_DEG_LAT;
}
