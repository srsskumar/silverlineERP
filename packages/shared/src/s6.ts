import { z } from "zod";
import type { RoleCode } from "./rbac.js";
import { S1_PERMISSIONS } from "./s1.js";
import { S2_PERMISSIONS } from "./s2.js";
import { S3_PERMISSIONS } from "./s3.js";
import { S4_PERMISSIONS } from "./s4.js";

/**
 * S6 contracts (Silverline ERP sprint S6): role dashboards, my-work summary,
 * synchronous CSV reports, punch rate limiting.
 * ADDITIVE module — existing exports in other files are untouched.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const S6_PERMISSIONS = {
  DASHBOARD_READ: "dashboard.read",
  REPORT_GENERATE: "report.generate",
} as const;

export type S6PermissionCode =
  (typeof S6_PERMISSIONS)[keyof typeof S6_PERMISSIONS];

export const S6_ALL_PERMISSIONS: string[] = Object.values(S6_PERMISSIONS);

/**
 * Additive S6 grants per system role. The seeder unions these with the
 * S0 (`ROLE_PERMISSIONS`) + S1 (`S1_ROLE_GRANTS`) + S2 (`S2_ROLE_GRANTS`) +
 * S3 (`S3_ROLE_GRANTS`) + S4 (`S4_ROLE_GRANTS`) + S5 (`S5_ROLE_GRANTS`)
 * maps (left unchanged). Every authed role can read its own dashboard;
 * report generation is limited to SUPER_ADMIN/ADMIN/HR_MANAGER/
 * PROJECT_MANAGER (PM)/TEAM_LEAD (TL)/AUDITOR.
 */
export const S6_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S6_ALL_PERMISSIONS],
  ADMIN: [...S6_ALL_PERMISSIONS],
  HR_MANAGER: [...S6_ALL_PERMISSIONS],
  PROJECT_MANAGER: [...S6_ALL_PERMISSIONS],
  TEAM_LEAD: [...S6_ALL_PERMISSIONS],
  EMPLOYEE: [S6_PERMISSIONS.DASHBOARD_READ],
  CLIENT_VIEWER: [S6_PERMISSIONS.DASHBOARD_READ],
  AUDITOR: [...S6_ALL_PERMISSIONS],
  PAYROLL_OFFICER: [...S6_ALL_PERMISSIONS],
  INVENTORY_MANAGER: [...S6_ALL_PERMISSIONS],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[],
};

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

/** Frozen S6 dashboard templates (lowercase on the wire). */
export const DASHBOARD_TEMPLATES = [
  "super_admin",
  "admin",
  "hr_manager",
  "project_manager",
  "team_lead",
  "employee",
  "client_viewer",
  "auditor",
  "payroll_officer",
  "inventory_manager",
] as const;

export type DashboardTemplate = (typeof DASHBOARD_TEMPLATES)[number];

export const dashboardTemplateSchema = z.enum(DASHBOARD_TEMPLATES);

/** A template name maps 1:1 onto its UPPER_SNAKE role code. */
export function dashboardRoleCode(template: DashboardTemplate): string {
  return template.toUpperCase();
}

/** One dashboard widget: key + title + numeric value, optional deep link. */
export const dashboardWidgetSchema = z.object({
  key: z.string(),
  title: z.string(),
  value: z.number(),
  link: z.string().optional(),
});

export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

/** In-process dashboard cache TTL (60s; no Redis in S6). */
export const DASHBOARD_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Reports (CSV, XLSX and PDF with background generation)
// ---------------------------------------------------------------------------

export const REPORT_TYPES = [
  "employees",
  "attendance",
  "tasks",
  "leave",
  "inventory",
  "assets",
  "invoices",
  "payroll",
  "projects",
  "cycles",
  "audit",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export const reportTypeSchema = z.enum(REPORT_TYPES);

/** POST /api/v1/reports */
export const reportCreateSchema = z.object({
  type: reportTypeSchema,
  format: z.enum(["csv","xlsx","pdf"]),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export type ReportCreateInput = z.infer<typeof reportCreateSchema>;

/** Domain read permission required alongside `report.generate` per type. */
export const REPORT_DOMAIN_READ: Record<ReportType, string> = {
  employees: S1_PERMISSIONS.EMPLOYEE_READ,
  attendance: S2_PERMISSIONS.ATTENDANCE_READ,
  tasks: S4_PERMISSIONS.TASK_READ,
  leave: S3_PERMISSIONS.LEAVE_READ,
  inventory:"inventory.read",
  assets:"asset.manage",
  invoices:"inventory.read",
  payroll:"payroll.read",
  projects:"project.read",cycles:"cycle.read",audit:"audit.read",
};

/** Above this threshold, queue generation for the background worker. */
export const REPORT_MAX_ROWS = 5000;

/** Stable CSV column order per report type (documented in apps/api README). */
export const REPORT_COLUMNS: Record<ReportType, string[]> = {
 projects:["id","code","name","status","planned_start_date","planned_end_date","tasks","completed"],
 cycles:["id","project_id","name","start_date","end_date","status","planned","completed","remaining"],
 audit:["id","created_at","actor_id","action","entity_type","entity_id","request_id"],
 inventory:['id','code','name','unit','available','low_stock_threshold'],
 assets:['id','asset_code','name','category','status','condition'],
 invoices:['id','serial_number','vendor_id','subtotal','tax','total','payment_mode','reference'],
 payroll:['id','employee_id','payroll_run_id','version','gross','total_deductions','net_pay'],
  employees: [
    "id",
    "emp_no",
    "first_name",
    "last_name",
    "phone",
    "email",
    "designation",
    "department",
    "status",
    "date_of_joining",
    "aadhaar",
    "pan",
    "bank_account",
    "phonepe_number",
    "salary_basic",
  ],
  attendance: [
    "id",
    "employee_id",
    "work_date",
    "status",
    "check_in_at",
    "check_out_at",
    "total_hours",
    "geofence_violation",
  ],
  tasks: [
    "id",
    "project_id",
    "title",
    "status",
    "assignee_id",
    "priority",
    "planned_start_date",
    "planned_end_date",
  ],
  leave: [
    "id",
    "employee_id",
    "leave_type_id",
    "from_date",
    "to_date",
    "total_days",
    "status",
  ],
};

// ---------------------------------------------------------------------------
// Punch rate limit (POST /attendance/events: 30/min per authed user else IP)
// ---------------------------------------------------------------------------

/** Default punch cap: 30 punches per user per minute. */
export const PUNCH_RATE_LIMIT_MAX = 30;

/** Fixed window for the punch limiter (1 minute). */
export const PUNCH_RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Machine-readable S6 rule codes returned as the error `code`
// ---------------------------------------------------------------------------

export const S6_RULE_CODES = {
  NOT_YOUR_ROLE: "NOT_YOUR_ROLE",
  UNKNOWN_TEMPLATE: "UNKNOWN_TEMPLATE",
  TOO_LARGE: "TOO_LARGE",
} as const;

export type S6RuleCode = (typeof S6_RULE_CODES)[keyof typeof S6_RULE_CODES];
