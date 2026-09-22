import {mutationRoute} from "../../common/mutationRoute.js";
import {resolveScopes} from '../../common/scopes.js';
import {textPdf} from "../../common/pdf.js";
import {spreadsheet} from "../../common/xlsx.js";
import {scopedReads} from "../../common/scopedReads.js";
import {readBlob} from "../../common/blobStore.js";
import {itemDeltaSql} from "../../common/stockLedger.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  DASHBOARD_CACHE_TTL_MS,
  REPORT_COLUMNS,
  REPORT_DOMAIN_READ,
  REPORT_MAX_ROWS,
  S2_PERMISSIONS,
  S6_PERMISSIONS,
  dashboardRoleCode,
  dashboardTemplateSchema,
  reportCreateSchema,
  toFieldErrors,
  type DashboardTemplate,
  type DashboardWidget,
  type ReportType,
} from "@silverline/shared";
import { buildAuthenticate,scopesForPermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import {
  decryptPii,
  encryptPii,
  maskLast4,
  redactPiiForAudit,
} from "../../common/crypto.js";
import { sendError } from "../../common/httpErrors.js";

export interface S6RoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

type Db = Pool | PoolClient;

interface AuthUser {
  id: string;
  orgId: string;
  username: string;
  roles: string[];
  permissions: string[];
  scopes?:Array<{scope_type:string|null;scope_id:string|null}>;
  /** §075: present when an administrator is viewing as this user. */
  impersonator?: { id: string };
}

/** IST calendar day for "today" scoping (single source for S6 widgets). */
const TODAY_IST_SQL = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Non-terminal task statuses (mirrors the S4 work module). */
const OPEN_TASK_SQL = `status NOT IN ('DONE', 'CANCELLED')`;

// ---------------------------------------------------------------------------
// In-process state (S6: no Redis, no new tables)
// ---------------------------------------------------------------------------

interface DashboardCacheEntry {
  body: unknown;
  expiresAt: number;
}

/** Dashboard cache: Map keyed `${userId}:${template}`, TTL 60s. */
const dashboardCache = new Map<string, DashboardCacheEntry>();

/** Clears the dashboard cache (test isolation hook). */
export function clearDashboardCache(): void {
  dashboardCache.clear();
}

interface ReportEntry {
  id: string;
  type: ReportType;
  format: "csv"|"xlsx"|"pdf";
  encrypted?:boolean;
  scopes?:unknown;
  status: "PENDING"|"READY"|"FAILED";
  rows: number;
  /** Legacy disk location. Absent for reports written to the database. */
  filePath?: string;
  orgId: string;
  createdBy: string;
  downloadUrl: string;
}

/**
 * Report registry: in-memory Map. Restart loses old ids (acceptable in S6,
 * documented in the README); unknown ids download as 404.
 */
const reportRegistry = new Map<string, ReportEntry>();

/** Clears the report registry (test isolation hook). */
export function clearReportRegistry(): void {
  reportRegistry.clear();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function widget(
  key: string,
  title: string,
  value: number,
  link?: string,
): DashboardWidget {
  return link ? { key, title, value, link } : { key, title, value };
}

function pct(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.round(((numerator / denominator) * 100 + Number.EPSILON) * 100) / 100;
}

async function count(
  db: Db,
  sql: string,
  params: unknown[],
): Promise<number> {
  const res = await db.query(sql, params as string[]);
  return Number((res.rows[0] as { count: string }).count);
}

async function linkedEmployeeId(db: Db, userId: string): Promise<string | null> {
  const res = await db.query("SELECT employee_id FROM users WHERE id = $1", [
    userId,
  ]);
  const row = res.rows[0] as { employee_id: string | null } | undefined;
  return row?.employee_id ?? null;
}

function dateOnly(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Safe PII decrypt (null when absent or tampered — never throws the route). */
function safeDecrypt(blob: string | null): string | null {
  if (!blob) {
    return null;
  }
  try {
    return decryptPii(blob);
  } catch {
    return null;
  }
}

function csvCell(value: string): string {
  if(/^[=+@\-\t\r]/.test(value))value="'"+value;
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function filtersOf(body: { filters?: unknown }): Record<string, unknown> {
  if (body.filters !== undefined && body.filters !== null && typeof body.filters === "object" && !Array.isArray(body.filters)) {
    return body.filters as Record<string, unknown>;
  }
  return {};
}

function uuidFilter(filters: Record<string, unknown>, key: string): string | null {
  const v = filters[key];
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

function dateFilter(filters: Record<string, unknown>, key: string): string | null {
  const v = filters[key];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function textFilter(filters: Record<string, unknown>, key: string): string | null {
  const v = filters[key];
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

// ---------------------------------------------------------------------------
// Dashboard builders (each runs inside the request's single transaction)
// ---------------------------------------------------------------------------

interface DashboardBuild {
  widgets: DashboardWidget[];
  scopeNote?: string;
}

async function buildAdminWidgets(
  db: Db,
  orgId: string,
): Promise<DashboardBuild> {
  const headcount = await count(
    db,
    "SELECT COUNT(*) AS count FROM employees WHERE org_id = $1 AND status = 'ACTIVE'",
    [orgId],
  );
  const present = await count(
    db,
    `SELECT COUNT(*) AS count FROM attendance_records r
      JOIN employees e ON e.id = r.employee_id
      WHERE e.org_id = $1 AND r.work_date = ${TODAY_IST_SQL}
        AND r.status IN ('PRESENT', 'PARTIAL', 'COMPLETE')`,
    [orgId],
  );
  const pendingExceptions = await count(
    db,
    `SELECT COUNT(*) AS count FROM attendance_exceptions x
      JOIN employees e ON e.id = x.employee_id
      WHERE e.org_id = $1 AND x.status = 'PENDING'`,
    [orgId],
  );
  const openTasks = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks WHERE org_id = $1 AND ${OPEN_TASK_SQL}`,
    [orgId],
  );
  const overdueTasks = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND ${OPEN_TASK_SQL}
        AND planned_end_date IS NOT NULL AND planned_end_date < ${TODAY_IST_SQL}`,
    [orgId],
  );
  const pendingLeave = await count(
    db,
    "SELECT COUNT(*) AS count FROM leave_requests WHERE org_id = $1 AND status = 'PENDING'",
    [orgId],
  );
  return {
    widgets: [
      widget("headcount_active", "Active headcount", headcount, "/api/v1/employees"),
      widget("attendance_today_pct", "Attendance today (%)", pct(present, headcount), "/api/v1/attendance/records"),
      widget("pending_exceptions", "Pending attendance exceptions", pendingExceptions),
      widget("open_tasks", "Open tasks", openTasks, "/api/v1/tasks"),
      widget("overdue_tasks", "Overdue tasks", overdueTasks, "/api/v1/tasks?sla=overdue"),
      widget("pending_leave", "Pending leave requests", pendingLeave, "/api/v1/leave/requests"),
    ],
  };
}

async function buildHrWidgets(db: Db, orgId: string): Promise<DashboardBuild> {
  const headcount = await count(
    db,
    "SELECT COUNT(*) AS count FROM employees WHERE org_id = $1 AND status = 'ACTIVE'",
    [orgId],
  );
  const onLeaveToday = await count(
    db,
    `SELECT COUNT(*) AS count FROM leave_requests
      WHERE org_id = $1 AND status = 'APPROVED'
        AND from_date <= ${TODAY_IST_SQL} AND to_date >= ${TODAY_IST_SQL}`,
    [orgId],
  );
  const pendingLeave = await count(
    db,
    "SELECT COUNT(*) AS count FROM leave_requests WHERE org_id = $1 AND status = 'PENDING'",
    [orgId],
  );
  const pendingExceptions = await count(
    db,
    `SELECT COUNT(*) AS count FROM attendance_exceptions x
      JOIN employees e ON e.id = x.employee_id
      WHERE e.org_id = $1 AND x.status = 'PENDING'`,
    [orgId],
  );
  return {
    widgets: [
      widget("headcount_active", "Active headcount", headcount, "/api/v1/employees"),
      widget("on_leave_today", "Employees on leave today", onLeaveToday),
      widget("pending_leave", "Pending leave requests", pendingLeave, "/api/v1/leave/requests"),
      widget("pending_exceptions", "Pending attendance exceptions", pendingExceptions),
    ],
  };
}

async function buildPmWidgets(
  db: Db,
  orgId: string,
  user: AuthUser,
): Promise<DashboardBuild> {
  const mine = await db.query(
    "SELECT id FROM projects WHERE org_id = $1 AND project_manager_id = $2::uuid",
    [orgId, user.id],
  );
  const projectIds = (mine.rows as Array<{ id: string }>).map((r) => r.id);
  if (projectIds.length === 0) {
    return {
      widgets: [
        widget("my_projects", "My projects", 0),
        widget("open_tasks", "Open tasks", 0, "/api/v1/tasks"),
        widget("overdue_tasks", "Overdue tasks", 0, "/api/v1/tasks?sla=overdue"),
        widget("blocked_tasks", "Blocked tasks", 0),
      ],
      scopeNote: "no managed projects",
    };
  }
  const openTasks = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND project_id = ANY($2::uuid[]) AND ${OPEN_TASK_SQL}`,
    [orgId, projectIds],
  );
  const overdueTasks = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND project_id = ANY($2::uuid[])
        AND ${OPEN_TASK_SQL}
        AND planned_end_date IS NOT NULL AND planned_end_date < ${TODAY_IST_SQL}`,
    [orgId, projectIds],
  );
  const blockedTasks = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND project_id = ANY($2::uuid[]) AND status = 'BLOCKED'`,
    [orgId, projectIds],
  );
  return {
    widgets: [
      widget("my_projects", "My projects", projectIds.length),
      widget("open_tasks", "Open tasks", openTasks, "/api/v1/tasks"),
      widget("overdue_tasks", "Overdue tasks", overdueTasks, "/api/v1/tasks?sla=overdue"),
      widget("blocked_tasks", "Blocked tasks", blockedTasks),
    ],
  };
}

async function buildTeamLeadWidgets(
  db: Db,
  orgId: string,
  user: AuthUser,
): Promise<DashboardBuild> {
  const linked = await linkedEmployeeId(db, user.id);
  if (!linked) {
    return {
      widgets: [
        widget("team_size", "Team size", 0),
        widget("attendance_today_pct", "Attendance today (%)", 0, "/api/v1/attendance/records"),
        widget("pending_leave", "Pending leave requests (approver: me)", 0, "/api/v1/leave/requests"),
        widget("pending_exceptions", "Pending attendance exceptions", 0),
      ],
      scopeNote: "caller has no linked employee; team scope is empty",
    };
  }
  const teamRes = await db.query(
    "SELECT id FROM employees WHERE org_id = $1 AND reports_to = $2::uuid ORDER BY created_at ASC, id ASC",
    [orgId, linked],
  );
  const teamIds = (teamRes.rows as Array<{ id: string }>).map((r) => r.id);
  const note =
    teamIds.length === 0 ? "no direct reports; team scope is empty" : undefined;
  const present =
    teamIds.length === 0
      ? 0
      : await count(
          db,
          `SELECT COUNT(*) AS count FROM attendance_records
            WHERE employee_id = ANY($1::uuid[]) AND work_date = ${TODAY_IST_SQL}
              AND status IN ('PRESENT', 'PARTIAL', 'COMPLETE')`,
          [teamIds],
        );
  const pendingLeave = await count(
    db,
    "SELECT COUNT(*) AS count FROM leave_requests WHERE org_id = $1 AND status = 'PENDING' AND current_approver_id = $2::uuid",
    [orgId, user.id],
  );
  const pendingExceptions =
    teamIds.length === 0
      ? 0
      : await count(
          db,
          `SELECT COUNT(*) AS count FROM attendance_exceptions
            WHERE employee_id = ANY($1::uuid[]) AND status = 'PENDING'`,
          [teamIds],
        );
  return {
    widgets: [
      widget("team_size", "Team size", teamIds.length),
      widget("attendance_today_pct", "Attendance today (%)", pct(present, teamIds.length), "/api/v1/attendance/records"),
      widget("pending_leave", "Pending leave requests (approver: me)", pendingLeave, "/api/v1/leave/requests"),
      widget("pending_exceptions", "Pending attendance exceptions", pendingExceptions),
    ],
    ...(note ? { scopeNote: note } : {}),
  };
}

async function buildEmployeeWidgets(
  db: Db,
  orgId: string,
  user: AuthUser,
): Promise<DashboardBuild> {
  const myOpen = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND assignee_id = $2::uuid AND ${OPEN_TASK_SQL}`,
    [orgId, user.id],
  );
  const myOverdue = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND assignee_id = $2::uuid AND ${OPEN_TASK_SQL}
        AND planned_end_date IS NOT NULL AND planned_end_date < ${TODAY_IST_SQL}`,
    [orgId, user.id],
  );
  const linked = await linkedEmployeeId(db, user.id);
  const pendingLeave = linked
    ? await count(
        db,
        "SELECT COUNT(*) AS count FROM leave_requests WHERE org_id = $1 AND employee_id = $2::uuid AND status = 'PENDING'",
        [orgId, linked],
      )
    : 0;
  const pendingExceptions = await count(
    db,
    `SELECT COUNT(*) AS count FROM attendance_exceptions x
      JOIN employees e ON e.id = x.employee_id
      WHERE e.org_id = $1 AND x.status = 'PENDING' AND x.submitted_by = $2::uuid`,
    [orgId, user.id],
  );
  const unread = await count(
    db,
    "SELECT COUNT(*) AS count FROM notifications WHERE org_id = $1 AND recipient_id = $2::uuid AND read_at IS NULL",
    [orgId, user.id],
  );
  return {
    widgets: [
      widget("my_open_tasks", "My open tasks", myOpen, "/api/v1/tasks?assignee_me=true"),
      widget("my_overdue", "My overdue tasks", myOverdue, "/api/v1/tasks?assignee_me=true&sla=overdue"),
      widget("my_pending_requests", "My pending requests", pendingLeave + pendingExceptions),
      widget("unread_notifications", "Unread notifications", unread, "/api/v1/notifications?unread=true"),
    ],
  };
}

async function buildViewerWidgets(
  db: Db,
  orgId: string,
): Promise<DashboardBuild> {
  const projectsActive = await count(
    db,
    "SELECT COUNT(*) AS count FROM projects WHERE org_id = $1 AND status = 'ACTIVE'",
    [orgId],
  );
  const tasksOpen = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks WHERE org_id = $1 AND ${OPEN_TASK_SQL}`,
    [orgId],
  );
  const tasksDone7d = await count(
    db,
    `SELECT COUNT(*) AS count FROM tasks
      WHERE org_id = $1 AND status = 'DONE' AND updated_at >= NOW() - INTERVAL '7 days'`,
    [orgId],
  );
  const auditEvents7d = await count(
    db,
    `SELECT COUNT(*) AS count FROM audit_events
      WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
    [orgId],
  );
  return {
    widgets: [
      widget("projects_active", "Active projects", projectsActive, "/api/v1/projects?status=ACTIVE"),
      widget("tasks_open", "Open tasks", tasksOpen, "/api/v1/tasks"),
      widget("tasks_done_7d", "Tasks completed (7d)", tasksDone7d),
      widget("audit_events_7d", "Audit events (7d)", auditEvents7d),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report row fetchers (org-scoped; stable row order)
// ---------------------------------------------------------------------------

interface EmployeeReportRow {
  id: string;
  emp_no: string;
  first_name: string;
  last_name: string | null;
  phone: string;
  email: string | null;
  designation: string | null;
  department: string | null;
  status: string;
  date_of_joining: Date | string;
  aadhaar_encrypted: string | null;
  pan_encrypted: string | null;
  bank_account_encrypted: string | null;
  phonepe_number: string | null;
  salary_basic: string | number | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerS6Routes(
  app: FastifyInstance,
  opts: S6RoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });

  // ------------------------------------------------ GET /dashboards/role/:role
  app.get(
    "/api/v1/dashboards/role/:role",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser as AuthUser | undefined;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { role } = req.params as { role: string };
      const parsed = dashboardTemplateSchema.safeParse(role);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "UNKNOWN_TEMPLATE",
          message: `Unknown dashboard template: ${role}`,
          fieldErrors: [{ field: "role", message: "Unknown dashboard template" }],
        });
      }
      const template: DashboardTemplate = parsed.data;
      if (!user.roles.includes(dashboardRoleCode(template))) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "NOT_YOUR_ROLE",
          message: "You do not hold the role for this dashboard",
        });
      }

      user.scopes=(await opts.pool.query('SELECT ur.scope_type,ur.scope_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code=$2',[user.id,dashboardRoleCode(template)])).rows;
      if(template==='client_viewer'){user.scopes=user.scopes!.filter(s=>s.scope_type==='project'&&s.scope_id);if(!user.scopes.length)user.scopes=[{scope_type:'restricted',scope_id:user.id}];}
      const cacheKey = `${user.id}:${template}:${JSON.stringify(user.scopes)}:${user.permissions.join(",")}`;
      const nowMs = Date.now();
      const cached = dashboardCache.get(cacheKey);
      if (cached && cached.expiresAt > nowMs) {
        return reply.status(200).send(cached.body);
      }

      const client = await opts.pool.connect();
      let build: DashboardBuild;
      try {
        await client.query("BEGIN");
        const read=scopedReads(client,opts.pool,user);
        switch (template) {
          case "super_admin":
          case "admin":
            build = await buildAdminWidgets(read, user.orgId);
            break;
          case "payroll_officer":
            build={widgets:[widget('open_runs','Payroll runs awaiting lock',await count(read,"SELECT count(*) AS count FROM payroll_runs WHERE org_id=$1 AND status<>'LOCKED'",[user.orgId]),'/payroll')]};
            break;
          case "inventory_manager":
            build={widgets:[widget('items','Active stock items',await count(read,"SELECT count(*) AS count FROM inventory_items WHERE org_id=$1 AND status='ACTIVE'",[user.orgId]),'/inventory'),widget('assets','Assets in use',await count(read,"SELECT count(*) AS count FROM assets WHERE org_id=$1 AND status IN('ASSIGNED','IN_USE')",[user.orgId]),'/assets')]};
            break;
          case "hr_manager":
            build = await buildHrWidgets(read, user.orgId);
            break;
          case "project_manager":
            build = await buildPmWidgets(read, user.orgId, user);
            break;
          case "team_lead":
            build = await buildTeamLeadWidgets(read, user.orgId, user);
            break;
          case "employee":
            build = await buildEmployeeWidgets(read, user.orgId, user);
            break;
          case "client_viewer":
          case "auditor":
            build = await buildViewerWidgets(read, user.orgId);
            break;
        }
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
        throw err;
      } finally {
        client.release();
      }

      const body: Record<string, unknown> = {
        template,
        generated_at: new Date().toISOString(),
        widgets: build.widgets,
      };
      if (build.scopeNote) {
        body["scope_note"] = build.scopeNote;
      }
      dashboardCache.set(cacheKey, {
        body,
        expiresAt: nowMs + DASHBOARD_CACHE_TTL_MS,
      });
      return reply.status(200).send(body);
    },
  );

  // ------------------------------------------------ GET /dashboards/my-work
  app.get(
    "/api/v1/dashboards/my-work",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser as AuthUser | undefined;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const assignedOpen = await count(
        opts.pool,
        `SELECT COUNT(*) AS count FROM tasks
          WHERE org_id = $1 AND assignee_id = $2::uuid AND ${OPEN_TASK_SQL}`,
        [user.orgId, user.id],
      );
      const overdueRes = await opts.pool.query(
        `SELECT id, title, project_id, planned_end_date FROM tasks
          WHERE org_id = $1 AND assignee_id = $2::uuid AND ${OPEN_TASK_SQL}
            AND planned_end_date IS NOT NULL AND planned_end_date < ${TODAY_IST_SQL}
          ORDER BY planned_end_date ASC, id ASC`,
        [user.orgId, user.id],
      );
      const assignedOverdue = (
        overdueRes.rows as Array<{
          id: string;
          title: string;
          project_id: string;
          planned_end_date: Date | string;
        }>
      ).map((r) => ({
        id: r.id,
        title: r.title,
        project_id: r.project_id,
        planned_end_date: dateOnly(r.planned_end_date),
      }));
      const leaveRes = await opts.pool.query(
        `SELECT r.id, r.employee_id, r.from_date, r.to_date,
                trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name, e.emp_no AS employee_emp_no
           FROM leave_requests r
           LEFT JOIN employees e ON e.id = r.employee_id AND e.org_id = r.org_id
          WHERE r.org_id = $1 AND r.status = 'PENDING' AND r.current_approver_id = $2::uuid
          ORDER BY r.created_at ASC, r.id ASC`,
        [user.orgId, user.id],
      );
      const pendingLeave = (
        leaveRes.rows as Array<{
          id: string;
          employee_id: string;
          from_date: Date | string;
          to_date: Date | string;
          employee_name: string | null;
          employee_emp_no: string | null;
        }>
      ).map((r) => ({
        id: r.id,
        employee_id: r.employee_id,
        from_date: dateOnly(r.from_date),
        to_date: dateOnly(r.to_date),
        employee_name: r.employee_name || null,
        employee_emp_no: r.employee_emp_no ?? null,
      }));
      // Exceptions have no per-request approver column: callers holding
      // attendance.decide can decide any org-pending exception, so the count
      // is org-pending for deciders and 0 otherwise (documented in README).
      const canDecide = user.permissions.includes(
        S2_PERMISSIONS.ATTENDANCE_DECIDE,
      );
      const exceptionsCount = canDecide
        ? await count(
            scopedReads(opts.pool,opts.pool,{...user,scopes:await scopesForPermission(req,S2_PERMISSIONS.ATTENDANCE_DECIDE)}),
            `SELECT COUNT(*) AS count FROM attendance_exceptions x
              JOIN employees e ON e.id = x.employee_id
              WHERE e.org_id = $1 AND x.status = 'PENDING'`,
            [user.orgId],
          )
        : 0;
      const unreadCount = await count(
        opts.pool,
        "SELECT COUNT(*) AS count FROM notifications WHERE org_id = $1 AND recipient_id = $2::uuid AND read_at IS NULL",
        [user.orgId, user.id],
      );
      return reply.status(200).send({
        assigned_open: assignedOpen,
        assigned_overdue: assignedOverdue,
        pending_approvals: {
          leave: pendingLeave,
          exceptions_count: exceptionsCount,
        },
        unread_count: unreadCount,
      });
    },
  );

  // ------------------------------------------------ POST /reports
  app.post("/api/v1/reports", { preHandler: authenticate }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = reportCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser as AuthUser | undefined;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { type, format } = parsed.data;
    const domainRead = REPORT_DOMAIN_READ[type];
    if (
      !user.permissions.includes(S6_PERMISSIONS.REPORT_GENERATE) ||
      !user.permissions.includes(domainRead)
    ) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `Running this report needs both the "report.generate" permission and permission to read the data it covers. An administrator can add the missing one under Administration \u2192 Roles.`,
      });
    }
    user.scopes=await scopesForPermission(req,domainRead);
    if(['inventory','assets','invoices','payroll'].includes(type)&&!resolveScopes(user.scopes??[]).global)return sendError(reply,req.requestId,{status:403,code:'FORBIDDEN',message:'This report requires organization-wide permission'});
    const filters = filtersOf(parsed.data as { filters?: unknown });
    const piiScopes=await scopesForPermission(req,'employee.pii.read');
    const canSeePii = user.permissions.includes("employee.pii.read")&&(resolveScopes(piiScopes).global||scopeFingerprint({...user,scopes:piiScopes})===scopeFingerprint(user));

    const jobId=req.authUser?.worker===true&&typeof req.headers['x-report-job-id']==='string'?req.headers['x-report-job-id']:null;
    const existingJob=jobId?(await db.query('SELECT entry FROM report_registry WHERE id=$1 AND org_id=$2 AND created_by=$3',[jobId,user.orgId,user.id])).rows[0]?.entry:null;
    if(jobId&&(!existingJob||existingJob.status!=='PENDING'||existingJob.scopes!==scopeFingerprint(user)))return sendError(reply,req.requestId,{status:403,code:'SCOPE_CHANGED',message:'Report scope changed. Generate a fresh report.'});
    const maxRows=jobId?100000:REPORT_MAX_ROWS;
    const headers = REPORT_COLUMNS[type];
    let rows: string[][];
    let total: number;
    switch (type) {
      case 'projects':case 'cycles':case 'audit':
        ({total,rows}=await buildPlanningReport(scopedReads(db,opts.pool,user),user,type,filters,maxRows));
        break;
      case 'inventory':case 'assets':case 'invoices':case 'payroll':
        ({total,rows}=await buildOperationsReport(scopedReads(db,opts.pool,user),user.orgId,type,maxRows));
        break;
      case "employees":
        ({ total, rows } = await buildEmployeeReport(scopedReads(db,opts.pool,user), user.orgId, filters, canSeePii,maxRows));
        break;
      case "attendance":
        ({ total, rows } = await buildAttendanceReport(scopedReads(db,opts.pool,user), user.orgId, filters,maxRows));
        break;
      case "tasks":
        ({ total, rows } = await buildTaskReport(scopedReads(db,opts.pool,user), user.orgId, filters,maxRows));
        break;
      case "leave":
        ({ total, rows } = await buildLeaveReport(scopedReads(db,opts.pool,user), user.orgId, filters,maxRows));
        break;
    }
    if (total > maxRows) {
      if(jobId)return sendError(reply,req.requestId,{status:422,code:'TOO_LARGE',message:'Report exceeds 100,000 rows. Split it by period or scope.'});
      const id=randomUUID(),downloadUrl=`/api/v1/reports/${id}/download`;
      const entry={id,type,format,status:'PENDING',rows:total,orgId:user.orgId,createdBy:user.id,downloadUrl,request:parsed.data,scopes:scopeFingerprint(user),attempts:0};
      await db.query('INSERT INTO report_registry(id,org_id,created_by,entry) VALUES($1,$2,$3,$4)',[id,user.orgId,user.id,JSON.stringify(entry)]);
      await writeAudit(db,{orgId:user.orgId,actorId:user.id,action:'report.queue',entityType:'report',entityId:id,requestId:req.requestId});
      return reply.code(202).send({id,type,format,status:'PENDING',rows:total,download_url:downloadUrl});
    }

    const id = jobId??randomUUID();
    const metadata=[['Report',type],['Generated at',new Date().toISOString()],['Parameters',JSON.stringify(filters)],['Data scope',resolveScopes(user.scopes??[]).global?'Organization':scopeFingerprint(user)]];
    const content=format==='xlsx'?spreadsheet(headers,rows,metadata):format==='pdf'?textPdf(`Silverline ${type} report`,[...metadata.map(([k,v])=>`${k}: ${v}`),'',...rows.flatMap((row,index)=>[`Record ${index+1}`,...headers.map((h,i)=>`${h}: ${row[i]??''}`),''])]):Buffer.from(metadata.map(([k,v])=>`# ${k}: ${v}`).join('\n')+'\n'+toCsv(headers,rows));
    const contentEncrypted = encryptPii(content.toString('base64'));
    const entry: ReportEntry = {
      id,
      type,
      format,
      status: "READY",
      rows: total,
      orgId: user.orgId,
      createdBy: user.id,
      downloadUrl: `/api/v1/reports/${id}/download`,
      encrypted:true,
      scopes:scopeFingerprint(user),
    };
    await db.query('INSERT INTO report_registry(id,org_id,created_by,entry,content_encrypted) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET entry=EXCLUDED.entry,content_encrypted=EXCLUDED.content_encrypted',[id,user.orgId,user.id,JSON.stringify({...entry,containsPii:canSeePii,piiScopes:canSeePii?scopeFingerprint({...user,scopes:piiScopes}):null}),contentEncrypted]);
    reportRegistry.set(id, entry);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: "report.generate",
      entityType: "report",
      entityId: id,
      afterState: redactPiiForAudit({ type, format, rows: total }),
      requestId: req.requestId,
    });
    return reply.status(201).send({
      id,
      type,
      format,
      status: "READY" as const,
      rows: total,
      download_url: entry.downloadUrl,
    });
});});

  // ------------------------------------------------ GET /reports/:id/download
  app.get(
    "/api/v1/reports/:id/download",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser as AuthUser | undefined;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const saved=await opts.pool.query('SELECT entry,content_encrypted FROM report_registry WHERE id=$1 AND org_id=$2 AND created_by=$3',[id,user.orgId,user.id]);
      const entry = saved.rows[0]?.entry as (ReportEntry & {containsPii?:boolean;piiScopes?:string}) | undefined;
      const storedContent = saved.rows[0]?.content_encrypted as string | null | undefined;
      if(entry?.containsPii&&!user.permissions.includes('employee.pii.read'))return sendError(reply,req.requestId,{status:403,code:'FORBIDDEN',message:'Export requires the original sensitive-field permission'});
      if (!entry || entry.orgId !== user.orgId) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Report not found",
        });
      }
      user.scopes=await scopesForPermission(req,REPORT_DOMAIN_READ[entry.type]);
      if(entry.scopes&&entry.scopes!==scopeFingerprint(user))return sendError(reply,req.requestId,{status:403,code:'SCOPE_CHANGED',message:'Your scope changed. Generate a fresh report.'});
      if(entry.containsPii){const current=await scopesForPermission(req,'employee.pii.read');if(!entry.piiScopes||entry.piiScopes!==scopeFingerprint({...user,scopes:current}))return sendError(reply,req.requestId,{status:403,code:'SCOPE_CHANGED',message:'Sensitive-field scope changed. Generate a fresh report.'});}
      const domainRead = REPORT_DOMAIN_READ[entry.type];
      if (
        !user.permissions.includes(S6_PERMISSIONS.REPORT_GENERATE) ||
        !user.permissions.includes(domainRead)
      ) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message:
            `Running this report needs both the "report.generate" permission and permission to read the data it covers. An administrator can add the missing one under Administration \u2192 Roles.`,
        });
      }
      if(entry.status!=='READY')return sendError(reply,req.requestId,{status:409,code:'REPORT_NOT_READY',message:entry.status==='FAILED'?'Report generation failed. Generate a fresh report.':'Report is queued. Your inbox will notify you when it is ready.'});
      const content = await readBlob({
        content_encrypted: storedContent,
        // Reports generated by an earlier, disk-backed deployment.
        file_path: entry.filePath ?? null,
      });
      if (!content) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Report not found",
        });
      }
      await writeAudit(opts.pool,{orgId:user.orgId,actorId:user.id,action:'report.download',entityType:'report',entityId:entry.id,requestId:req.requestId});
      return reply
        .status(200)
        .header("Content-Type", entry.format==="pdf"?"application/pdf":entry.format==="xlsx"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"text/csv")
        .header(
          "Content-Disposition",
          `attachment; filename="report-${entry.id}.${entry.format}"`,
        )
        .send(content);
    },
  );
}

// ---------------------------------------------------------------------------
// Report builders (org-scoped; throw TOO_LARGE-safe totals first)
// ---------------------------------------------------------------------------

async function buildEmployeeReport(
  pool: Db,
  orgId: string,
  filters: Record<string, unknown>,
  canSeePii: boolean,
  maxRows=REPORT_MAX_ROWS,
): Promise<{ total: number; rows: string[][] }> {
  const clauses = ["org_id = $1"];
  const params: unknown[] = [orgId];
  const status = textFilter(filters, "status");
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const department = textFilter(filters, "department");
  if (department) {
    params.push(department);
    clauses.push(`department = $${params.length}`);
  }
  const where = clauses.join(" AND ");
  const total = await count(
    pool,
    `SELECT COUNT(*) AS count FROM employees WHERE ${where}`,
    params,
  );
  if (total > maxRows) {
    return { total, rows: [] };
  }
  const res = await pool.query(
    `SELECT id, emp_no, first_name, last_name, phone, email, designation,
       department, status, date_of_joining, aadhaar_encrypted, pan_encrypted,
       bank_account_encrypted, phonepe_number, salary_basic
     FROM employees WHERE ${where} ORDER BY created_at ASC, id ASC`,
    params as string[],
  );
  const rows = (res.rows as EmployeeReportRow[]).map((r) => {
    const aadhaar = safeDecrypt(r.aadhaar_encrypted);
    const pan = safeDecrypt(r.pan_encrypted);
    const bankAccount = safeDecrypt(r.bank_account_encrypted);
    return [
      r.id,
      r.emp_no,
      r.first_name,
      r.last_name ?? "",
      r.phone,
      r.email ?? "",
      r.designation ?? "",
      r.department ?? "",
      r.status,
      dateOnly(r.date_of_joining) ?? "",
      // Caller's masking rules: full PII only with employee.pii.read,
      // otherwise masked last-4 (salary has no last-4: emitted empty).
      canSeePii ? (aadhaar ?? "") : (maskLast4(aadhaar) ?? ""),
      canSeePii ? (pan ?? "") : (maskLast4(pan) ?? ""),
      canSeePii ? (bankAccount ?? "") : (maskLast4(bankAccount) ?? ""),
      canSeePii
        ? (r.phonepe_number ?? "")
        : (maskLast4(r.phonepe_number) ?? ""),
      canSeePii && r.salary_basic !== null && r.salary_basic !== undefined
        ? String(Number(r.salary_basic))
        : "",
    ];
  });
  return { total, rows };
}

async function buildAttendanceReport(
  pool: Db,
  orgId: string,
  filters: Record<string, unknown>,
  maxRows=REPORT_MAX_ROWS,
): Promise<{ total: number; rows: string[][] }> {
  const clauses = ["e.org_id = $1"];
  const params: unknown[] = [orgId];
  const employeeId = uuidFilter(filters, "employee_id");
  if (employeeId) {
    params.push(employeeId);
    clauses.push(`r.employee_id = $${params.length}::uuid`);
  }
  const from = dateFilter(filters, "from");
  if (from) {
    params.push(from);
    clauses.push(`r.work_date >= $${params.length}::date`);
  }
  const to = dateFilter(filters, "to");
  if (to) {
    params.push(to);
    clauses.push(`r.work_date <= $${params.length}::date`);
  }
  const status = textFilter(filters, "status");
  if (status) {
    params.push(status);
    clauses.push(`r.status = $${params.length}`);
  }
  const where = clauses.join(" AND ");
  const total = await count(
    pool,
    `SELECT COUNT(*) AS count FROM attendance_records r
      JOIN employees e ON e.id = r.employee_id WHERE ${where}`,
    params,
  );
  if (total > maxRows) {
    return { total, rows: [] };
  }
  const res = await pool.query(
    `SELECT r.id, r.employee_id, r.work_date, r.status, r.check_in_at,
       r.check_out_at, r.total_hours, r.geofence_violation
     FROM attendance_records r
     JOIN employees e ON e.id = r.employee_id
     WHERE ${where} ORDER BY r.work_date ASC, r.id ASC`,
    params as string[],
  );
  const rows = (
    res.rows as Array<{
      id: string;
      employee_id: string;
      work_date: Date | string;
      status: string;
      check_in_at: Date | string | null;
      check_out_at: Date | string | null;
      total_hours: string | number | null;
      geofence_violation: boolean;
    }>
  ).map((r) => [
    r.id,
    r.employee_id,
    dateOnly(r.work_date) ?? "",
    r.status,
    iso(r.check_in_at) ?? "",
    iso(r.check_out_at) ?? "",
    r.total_hours === null || r.total_hours === undefined
      ? ""
      : String(Number(r.total_hours)),
    r.geofence_violation ? "true" : "false",
  ]);
  return { total, rows };
}

async function buildTaskReport(
  pool: Db,
  orgId: string,
  filters: Record<string, unknown>,
  maxRows=REPORT_MAX_ROWS,
): Promise<{ total: number; rows: string[][] }> {
  const clauses = ["org_id = $1"];
  const params: unknown[] = [orgId];
  const projectId = uuidFilter(filters, "project_id");
  if (projectId) {
    params.push(projectId);
    clauses.push(`project_id = $${params.length}::uuid`);
  }
  const status = textFilter(filters, "status");
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const assigneeId = uuidFilter(filters, "assignee_id");
  if (assigneeId) {
    params.push(assigneeId);
    clauses.push(`assignee_id = $${params.length}::uuid`);
  }
  const where = clauses.join(" AND ");
  const total = await count(
    pool,
    `SELECT COUNT(*) AS count FROM tasks WHERE ${where}`,
    params,
  );
  if (total > maxRows) {
    return { total, rows: [] };
  }
  const res = await pool.query(
    `SELECT id, project_id, title, status, assignee_id, priority,
       planned_start_date, planned_end_date
     FROM tasks WHERE ${where} ORDER BY created_at ASC, id ASC`,
    params as string[],
  );
  const rows = (
    res.rows as Array<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      assignee_id: string | null;
      priority: string;
      planned_start_date: Date | string | null;
      planned_end_date: Date | string | null;
    }>
  ).map((r) => [
    r.id,
    r.project_id,
    r.title,
    r.status,
    r.assignee_id ?? "",
    r.priority,
    dateOnly(r.planned_start_date) ?? "",
    dateOnly(r.planned_end_date) ?? "",
  ]);
  return { total, rows };
}

async function buildLeaveReport(
  pool: Db,
  orgId: string,
  filters: Record<string, unknown>,
  maxRows=REPORT_MAX_ROWS,
): Promise<{ total: number; rows: string[][] }> {
  const clauses = ["org_id = $1"];
  const params: unknown[] = [orgId];
  const employeeId = uuidFilter(filters, "employee_id");
  if (employeeId) {
    params.push(employeeId);
    clauses.push(`employee_id = $${params.length}::uuid`);
  }
  const status = textFilter(filters, "status");
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  const from = dateFilter(filters, "from");
  if (from) {
    params.push(from);
    clauses.push(`to_date >= $${params.length}::date`);
  }
  const to = dateFilter(filters, "to");
  if (to) {
    params.push(to);
    clauses.push(`from_date <= $${params.length}::date`);
  }
  const where = clauses.join(" AND ");
  const total = await count(
    pool,
    `SELECT COUNT(*) AS count FROM leave_requests WHERE ${where}`,
    params,
  );
  if (total > maxRows) {
    return { total, rows: [] };
  }
  const res = await pool.query(
    `SELECT id, employee_id, leave_type_id, from_date, to_date, total_days, status
     FROM leave_requests WHERE ${where} ORDER BY created_at ASC, id ASC`,
    params as string[],
  );
  const rows = (
    res.rows as Array<{
      id: string;
      employee_id: string;
      leave_type_id: string;
      from_date: Date | string;
      to_date: Date | string;
      total_days: string | number;
      status: string;
    }>
  ).map((r) => [
    r.id,
    r.employee_id,
    r.leave_type_id,
    dateOnly(r.from_date) ?? "",
    dateOnly(r.to_date) ?? "",
    String(Number(r.total_days)),
    r.status,
  ]);
  return { total, rows };
}

function scopeFingerprint(user:AuthUser):string {return JSON.stringify((user.scopes??[]).map(s=>[s.scope_type,s.scope_id]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}

async function buildOperationsReport(db:Db,orgId:string,type:'inventory'|'assets'|'invoices'|'payroll',maxRows=REPORT_MAX_ROWS):Promise<{total:number;rows:string[][]}>{
 const sources={inventory:`SELECT i.*,COALESCE((SELECT sum(${itemDeltaSql()}) FROM stock_transactions WHERE item_id=i.id),0) AS available FROM inventory_items i WHERE i.org_id=$1`,assets:'SELECT * FROM assets WHERE org_id=$1',invoices:'SELECT * FROM invoices WHERE org_id=$1',payroll:'SELECT * FROM payslips WHERE is_current=true AND org_id=$1 AND employee_id IN(SELECT id FROM employees)'};
 const result=await db.query(`SELECT * FROM (${sources[type]}) source ORDER BY id LIMIT ${maxRows+1}`,[orgId]);
 return {total:result.rows.length,rows:result.rows.map(r=>REPORT_COLUMNS[type].map(k=>String(r[k]??'')))};
}

async function buildPlanningReport(db:Db,user:AuthUser,type:'projects'|'cycles'|'audit',filters:Record<string,unknown>,maxRows:number):Promise<{total:number;rows:string[][]}>{
 const values:unknown[]=[user.orgId,maxRows+1],where=['org_id=$1'];
 if(typeof filters.project_id==='string'&&type!=='audit'){values.push(filters.project_id);where.push(`${type==='projects'?'id':'project_id'}=$${values.length}::uuid`);}
 if(type==='audit'){for(const [key,operator] of [['from','>='],['to','<=']] as const)if(typeof filters[key]==='string'){values.push(filters[key]);where.push(`created_at::date ${operator} $${values.length}::date`);}}
 const scope=resolveScopes(user.scopes??[]),sql=type==='projects'?`SELECT p.id,p.code,p.name,p.status,p.planned_start_date::text,p.planned_end_date::text,(SELECT count(*) FROM tasks WHERE project_id=p.id) AS tasks,(SELECT count(*) FROM tasks WHERE project_id=p.id AND status='DONE') AS completed FROM projects p WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC,p.id LIMIT $2`:type==='audit'?`SELECT id,created_at::text,actor_id,action,entity_type,entity_id,request_id FROM audit_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id LIMIT $2`:`SELECT c.id,c.project_id,c.name,c.start_date::text,c.end_date::text,c.status,CASE WHEN $${values.push(scope.global)} OR c.project_id=ANY($${values.push(scope.projects)}::uuid[]) THEN c.metrics->>'planned' END AS planned,CASE WHEN $${values.length-1} OR c.project_id=ANY($${values.length}::uuid[]) THEN c.metrics->>'completed' END AS completed,CASE WHEN $${values.length-1} OR c.project_id=ANY($${values.length}::uuid[]) THEN c.metrics->>'remaining' END AS remaining FROM cycles c WHERE ${where.join(' AND ')} AND project_id IN(SELECT id FROM projects) ORDER BY start_date DESC,id LIMIT $2`;
 const result=await db.query(sql,values);return {total:result.rows.length,rows:result.rows.map(r=>REPORT_COLUMNS[type].map(k=>String(r[k]??'')))};
}
