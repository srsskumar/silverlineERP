import { z } from "zod";
import type { RoleCode } from "./rbac.js";
import { dateStringSchema } from "./s1.js";
import { cursorPageQuerySchema } from "./pagination.js";

/**
 * P1 contracts (Silverline ERP post-MVP sprint P1): payroll policy, runs,
 * payslips, and the frozen payroll calculation rules.
 * ADDITIVE module — existing exports in other files are untouched.
 *
 * ## Money handling (documented choice)
 *
 * All money lives in Postgres as NUMERIC and is converted ONCE at the API
 * boundary to integer paise (`Math.round(Number(v) * 100)`). Every derived
 * step (per_day, gross, lop_amount, pf) rounds to the nearest paise with
 * `Math.round` in integer space, and values are divided by 100 only when
 * serialized. No float accumulation ever crosses a step boundary, so every
 * stored/returned money field is exact to 2dp. Day counts are multiples of
 * 0.5 (PARTIAL attendance = 0.5) and stay exact in binary floating point;
 * a half-round guard normalizes any summation dust before money math.
 *
 * ## Calculation simplification (frozen for P1)
 *
 * `working_days` = inclusive calendar days in the period. Sundays and
 * holidays are NOT excluded in P1 (documented simplification).
 *
 * ## Run lifecycle (forward only + controlled reopen)
 *
 * OPEN → CALCULATED → REVIEW → APPROVED → LOCKED, plus
 * LOCKED → APPROVED via reopen (reason required, audited as a controlled
 * override). `VALIDATING` is a transient in-transaction state during
 * calculate. There is NO cancelled state: any overlap with ANY existing
 * run in the org (including LOCKED) rejects creation with OVERLAPPING_RUN.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const P1_PERMISSIONS = {
  PAYROLL_READ: "payroll.read",
  PAYROLL_GENERATE: "payroll.generate",
  PAYROLL_APPROVE: "payroll.approve",
  PAYROLL_LOCK: "payroll.lock",
  PAYROLL_CONFIGURE: "payroll.configure",
  PAYSLIP_READ: "payslip.read",
} as const;

export type P1PermissionCode =
  (typeof P1_PERMISSIONS)[keyof typeof P1_PERMISSIONS];

export const P1_ALL_PERMISSIONS: string[] = Object.values(P1_PERMISSIONS);

/**
 * Additive P1 grants per system role. The seeder unions these with the
 * S0 + S1 + S2 + S3 + S4 + S5 + S6 maps (left unchanged).
 * SUPER_ADMIN/ADMIN get everything; PAYROLL_OFFICER gets payroll.* +
 * payslip.read; HR_MANAGER/AUDITOR get payroll.read + payslip.read;
 * EMPLOYEE gets payslip.read (own slip only); every other role gets none.
 */
export const P1_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...P1_ALL_PERMISSIONS],
  ADMIN: [...P1_ALL_PERMISSIONS],
  PAYROLL_OFFICER: [...P1_ALL_PERMISSIONS],
  HR_MANAGER: [P1_PERMISSIONS.PAYROLL_READ, P1_PERMISSIONS.PAYSLIP_READ],
  PROJECT_MANAGER: [P1_PERMISSIONS.PAYSLIP_READ],
  TEAM_LEAD: [P1_PERMISSIONS.PAYSLIP_READ],
  EMPLOYEE: [P1_PERMISSIONS.PAYSLIP_READ],
  CLIENT_VIEWER: [],
  AUDITOR: [P1_PERMISSIONS.PAYROLL_READ, P1_PERMISSIONS.PAYSLIP_READ],
  INVENTORY_MANAGER: [],
};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Seeded default policy per org (also the DB column defaults). */
export const DEFAULT_PAYROLL_POLICY = {
  per_day_divisor: 30,
  pf_pct: 12,
} as const;

/** GET /api/v1/payroll/policy response shape. */
export const payrollPolicySchema = z.object({
  per_day_divisor: z.number().int(),
  pf_pct: z.number(),
});

export type PayrollPolicy = z.infer<typeof payrollPolicySchema>;

/** PATCH /api/v1/payroll/policy — at least one field is required. */
export const payrollPolicyPatchSchema = z
  .object({
    per_day_divisor: z.number().int().min(1).max(31).optional(),
    pf_pct: z.number().min(0).max(100).optional(),
  })
  .refine((v) => v.per_day_divisor !== undefined || v.pf_pct !== undefined, {
    message: "Nothing to update",
  });

export type PayrollPolicyPatchInput = z.infer<typeof payrollPolicyPatchSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Frozen P1 run statuses (VALIDATING is transient inside calculate). */
export const PAYROLL_RUN_STATUSES = [
  "OPEN",
  "VALIDATING",
  "CALCULATED",
  "REVIEW",
  "APPROVED",
  "LOCKED",
] as const;

export const payrollRunStatusSchema = z.enum(PAYROLL_RUN_STATUSES);

export type PayrollRunStatus = z.infer<typeof payrollRunStatusSchema>;

/** POST /api/v1/payroll/runs. */
export const payrollRunCreateSchema = z.object({
  period_start: dateStringSchema,
  period_end: dateStringSchema,
});

export type PayrollRunCreateInput = z.infer<typeof payrollRunCreateSchema>;

/** Maximum inclusive calendar-day span of a run period. */
export const PAYROLL_MAX_PERIOD_DAYS = 62;

/** POST /api/v1/payroll/runs/:id/approve — note is optional. */
export const payrollRunApproveSchema = z.object({
  note: z.string().max(2000).optional(),
});

export type PayrollRunApproveInput = z.infer<typeof payrollRunApproveSchema>;

/**
 * POST /api/v1/payroll/runs/:id/reopen — reason is enforced by the route
 * (blank/missing → 422 REASON_REQUIRED), so the schema keeps it optional.
 */
export const payrollRunReopenSchema = z.object({
  recalculate: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});

export type PayrollRunReopenInput = z.infer<typeof payrollRunReopenSchema>;

/** GET /api/v1/payroll/runs?status=&limit=&cursor= */
export const payrollRunsQuerySchema = cursorPageQuerySchema.extend({
  status: payrollRunStatusSchema.optional(),
});

export type PayrollRunsQuery = z.infer<typeof payrollRunsQuerySchema>;

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

/** GET /api/v1/payroll/runs/:id/payslips?limit=&cursor= */
export const payslipListQuerySchema = cursorPageQuerySchema;

export type PayslipListQuery = z.infer<typeof payslipListQuerySchema>;

/**
 * GET /api/v1/payslips/me?period_start=&period_end=. Each bound is
 * independent: period_start keeps runs with period_end >= start,
 * period_end keeps runs with period_start <= end. With no bounds the
 * caller's latest slip is returned.
 */
export const payslipMeQuerySchema = z.object({
  period_start: dateStringSchema.optional(),
  period_end: dateStringSchema.optional(),
});

export type PayslipMeQuery = z.infer<typeof payslipMeQuerySchema>;

/** Attendance weight per record status (any other stored value = 0). */
export const ATTENDANCE_WEIGHTS: Record<string, number> = {
  COMPLETE: 1,
  PARTIAL: 0.5,
};

/** Warning types attached to a run (and raised per employee). */
export const PAYSLIP_WARNING_TYPES = ["NO_RECORDS", "NO_SALARY"] as const;

export const payslipWarningSchema = z.object({
  type: z.enum(PAYSLIP_WARNING_TYPES),
  employee_id: z.string().uuid(),
  message: z.string(),
});

export type PayslipWarning = z.infer<typeof payslipWarningSchema>;

// ---------------------------------------------------------------------------
// Machine-readable P1 rule codes returned as the error `code`
// ---------------------------------------------------------------------------

export const P1_RULE_CODES = {
  PERIOD_TOO_LONG: "PERIOD_TOO_LONG",
  OVERLAPPING_RUN: "OVERLAPPING_RUN",
  NO_ATTENDANCE_DATA: "NO_ATTENDANCE_DATA",
  RUN_SEALED: "RUN_SEALED",
  PAYROLL_LOCKED: "PAYROLL_LOCKED",
  NO_PAYSLIP: "NO_PAYSLIP",
  NO_EMPLOYEE_LINK: "NO_EMPLOYEE_LINK",
  REASON_REQUIRED: "REASON_REQUIRED",
  DATE_RANGE: "DATE_RANGE",
} as const;

export type P1RuleCode = (typeof P1_RULE_CODES)[keyof typeof P1_RULE_CODES];
