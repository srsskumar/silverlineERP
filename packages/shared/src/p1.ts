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
 * step (per_day, entitlement, lop_amount, gross, pf) rounds to the nearest paise with
 * `Math.round` in integer space, and values are divided by 100 only when
 * serialized. No float accumulation ever crosses a step boundary, so every
 * stored/returned money field is exact to 2dp. Day counts are multiples of
 * 0.5 (PARTIAL attendance = 0.5) and stay exact in binary floating point;
 * a half-round guard normalizes any summation dust before money math.
 *
 * ## Calculation
 *
 * See calculatePayslip below. P1 first shipped treating every calendar day as
 * a working day and deducting loss of pay from a gross that had already left
 * it out; runs locked under that rule keep their figures, because a locked
 * run is never recalculated except through a controlled reopen.
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
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[], GOVT_OBSERVER:[],
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

// ---------------------------------------------------------------------------
// One payslip's arithmetic
// ---------------------------------------------------------------------------

export interface PayslipLeave {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  paid: boolean;
}

export interface PayslipCalculationInput {
  /** Run period, YYYY-MM-DD inclusive. */
  periodStart: string;
  periodEnd: string;
  dateOfJoining: string;
  /** Last day employed, inclusive; null while still employed. */
  dateOfExit: string | null;
  /** Monthly basic in paise; null when no salary is set. */
  basicPaise: number | null;
  perDayDivisor: number;
  pfPct: number;
  /** This employee's effective holiday dates (already location-resolved). */
  holidays: ReadonlySet<string>;
  /** Attendance weight per work date (COMPLETE 1, PARTIAL 0.5). */
  attendance: ReadonlyMap<string, number>;
  /** Approved leave overlapping the period. */
  leaves: readonly PayslipLeave[];
}

export interface PayslipCalculation {
  /** The part of the period this person was employed; null if none. */
  windowStart: string | null;
  windowEnd: string | null;
  employedDays: number;
  workingDays: number;
  /** Sundays and holidays inside the employment window: paid, not worked. */
  paidOffDays: number;
  presentDays: number;
  paidLeaveDays: number;
  lopLeaveDays: number;
  /** Working days with no attendance and no leave at all. */
  absentDays: number;
  /** lopLeaveDays + absentDays: the days that cost pay. */
  unpaidDays: number;
  payableDays: number;
  perDayPaise: number;
  /** Pay for the employment window before any loss of pay. */
  entitlementPaise: number;
  lopPaise: number;
  grossPaise: number;
  pfPaise: number;
  totalDeductionsPaise: number;
  netPaise: number;
}

const DAY_MS = 86_400_000;

// Payroll dates are calendar dates, not instants, so UTC arithmetic on them is
// exact and a Sunday is a Sunday in every timezone. Local time would be the
// bug here: two servers in different zones would disagree about a date.
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function isSunday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}

function lastOfMonth(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * What one employee is paid for one run.
 *
 * The rule, as the owner settled it: loss of pay is deducted once; Sundays and
 * holiday-calendar days are paid days off, not absences; joiners and leavers
 * are paid for the part of the period they were employed.
 *
 * Every day of the employment window is exactly one of: a paid day off
 * (Sunday or the employee's effective holiday), or a working day, which is in
 * turn split between attendance, paid leave, unpaid leave and plain absence.
 * The split is per day and capped at one, so a day with both a punch and an
 * approved leave is paid once, a leave that spans a Sunday does not pay the
 * Sunday twice, and paid leave outranks unpaid leave on the same day because
 * the employee should not lose pay to overlapping paperwork.
 *
 * Money follows the fixed-divisor convention:
 *
 *   entitlement = pay for the employment window, as if every day were paid
 *   lop         = per_day x unpaid days (the only place absence costs money)
 *   gross       = entitlement - lop       (earned wages)
 *   pf          = pf_pct x gross
 *   net         = gross - pf
 *
 * Entitlement is worked out per calendar month. A month the person was
 * employed for in full earns the monthly basic, whatever its length: with a
 * divisor of 30, pricing a whole month day by day would pay 31 days in July
 * and 28 in February, so the same full attendance on a Rs 30,000 basic would
 * be worth Rs 31,000 one month and Rs 28,000 another. A part month (joining,
 * leaving, or a run that covers only part of a month) earns per_day for each
 * employed calendar day, never more than the monthly basic -- so a joiner on
 * 2 July, 30 days at Rs 1,000, is capped at the Rs 30,000 a full month pays.
 *
 * Because lop is subtracted from that entitlement and nowhere else, each
 * unpaid day costs exactly per_day, once.
 */
export function calculatePayslip(input: PayslipCalculationInput): PayslipCalculation {
  const windowStart =
    input.dateOfJoining > input.periodStart ? input.dateOfJoining : input.periodStart;
  const windowEnd =
    input.dateOfExit !== null && input.dateOfExit < input.periodEnd
      ? input.dateOfExit
      : input.periodEnd;
  const basicPaise = input.basicPaise ?? 0;
  const perDayPaise = Math.round(basicPaise / input.perDayDivisor);

  const days = {
    employed: 0, working: 0, off: 0, present: 0, paidLeave: 0, lopLeave: 0, absent: 0,
  };
  const hasWindow = windowStart <= windowEnd;
  const onLeave = (date: string, paid: boolean): number =>
    input.leaves.some((l) => l.paid === paid && l.from <= date && date <= l.to) ? 1 : 0;
  if (hasWindow) {
    for (let d = windowStart; d <= windowEnd; d = addDays(d, 1)) {
      days.employed += 1;
      if (isSunday(d) || input.holidays.has(d)) {
        // Paid whether or not anyone punched; a punch here adds nothing.
        days.off += 1;
        continue;
      }
      days.working += 1;
      const present = Math.min(1, input.attendance.get(d) ?? 0);
      const paidLeave = Math.min(1 - present, onLeave(d, true));
      const lopLeave = Math.min(1 - present - paidLeave, onLeave(d, false));
      days.present += present;
      days.paidLeave += paidLeave;
      days.lopLeave += lopLeave;
      days.absent += 1 - present - paidLeave - lopLeave;
    }
  }
  const unpaidDays = days.lopLeave + days.absent;

  let entitlementPaise = 0;
  if (hasWindow) {
    for (let from = windowStart; from <= windowEnd; ) {
      const monthEnd = lastOfMonth(from);
      const to = monthEnd < windowEnd ? monthEnd : windowEnd;
      const wholeMonth = from.endsWith("-01") && to === monthEnd;
      entitlementPaise += wholeMonth
        ? basicPaise
        : Math.min(basicPaise, perDayPaise * spanDays(from, to));
      from = addDays(to, 1);
    }
  }

  const lopPaise = Math.min(entitlementPaise, Math.round(perDayPaise * unpaidDays));
  const grossPaise = entitlementPaise - lopPaise;
  const pfPaise = basicPaise > 0 ? Math.round((grossPaise * input.pfPct) / 100) : 0;
  const netPaise = Math.max(0, grossPaise - pfPaise);

  return {
    windowStart: hasWindow ? windowStart : null,
    windowEnd: hasWindow ? windowEnd : null,
    employedDays: days.employed,
    workingDays: days.working,
    paidOffDays: days.off,
    presentDays: days.present,
    paidLeaveDays: days.paidLeave,
    lopLeaveDays: days.lopLeave,
    absentDays: days.absent,
    unpaidDays,
    payableDays: days.employed - unpaidDays,
    perDayPaise,
    entitlementPaise,
    lopPaise,
    grossPaise,
    pfPaise,
    totalDeductionsPaise: pfPaise,
    netPaise,
  };
}

// ---------------------------------------------------------------------------
// Reading a payslip
// ---------------------------------------------------------------------------

export interface PayslipLine {
  key: string;
  label: string;
  /** Money renders as rupees; days render as a plain count. */
  kind: 'money' | 'days';
  value: number;
}

export interface PayslipView {
  /** The rates the pay was worked out from. */
  rates: PayslipLine[];
  /** Day counts: what was paid, and what was not. */
  days: PayslipLine[];
  /** Money that makes up total_deductions, and nothing else. */
  deductions: PayslipLine[];
  /** Money shown for information only: already outside gross, not deducted. */
  notes: PayslipLine[];
}

const PAYSLIP_LABELS: Record<string, string> = {
  basic: 'Monthly basic',
  per_day: 'Per-day rate',
  payable_days: 'Payable days',
  present_days: 'Days present',
  paid_leave_days: 'Paid leave',
  paid_off_days: 'Sundays and holidays (paid)',
  lop_leave_days: 'Unpaid leave',
  lop_days: 'Loss-of-pay days',
  pf: 'Provident fund',
  esi: 'ESI',
};

export const LOP_INFORMATIONAL_LABEL = 'Loss of pay (already excluded from gross)';

function payslipLabel(key: string): string {
  return PAYSLIP_LABELS[key] ?? key.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** "1 day", "4.5 days". */
export function formatPayslipDays(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * A payslip's earnings and deductions, grouped the way a person reads them.
 *
 * The stored objects are flat bags: day counts sit beside rupee amounts, and
 * lop_amount sits in `deductions` although it is not deducted -- gross is
 * already the pay for the paid days only, so the LOP figure is there to show
 * what the unpaid days cost, not to be subtracted again. Listing the bags as
 * they are showed days as rupees and a deductions column that did not add up
 * to its own total. The web slip and the PDF both render from this, so they
 * cannot drift apart.
 *
 * Slips calculated before loss of pay was corrected did subtract lop_amount a
 * second time, and their total_deductions includes it. Those are recognised
 * by their total and shown as they were paid, with LOP under deductions: a
 * locked slip is a record of what happened, not of what should have.
 */
export function payslipView(
  earnings: Record<string, unknown> | null | undefined,
  deductions: Record<string, unknown> | null | undefined,
  totalDeductions?: number | string | null,
): PayslipView {
  const view: PayslipView = { rates: [], days: [], deductions: [], notes: [] };
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const isDays = (key: string) => key.endsWith('_days');

  for (const [key, raw] of Object.entries(earnings ?? {})) {
    const value = num(raw);
    if (value === null) continue;
    if (isDays(key)) view.days.push({ key, label: payslipLabel(key), kind: 'days', value });
    else view.rates.push({ key, label: payslipLabel(key), kind: 'money', value });
  }

  let lop: PayslipLine | null = null;
  for (const [key, raw] of Object.entries(deductions ?? {})) {
    const value = num(raw);
    if (value === null) continue;
    if (isDays(key)) {
      view.days.push({ key, label: payslipLabel(key), kind: 'days', value });
    } else if (key === 'lop_amount') {
      lop = { key, label: LOP_INFORMATIONAL_LABEL, kind: 'money', value };
    } else {
      view.deductions.push({ key, label: payslipLabel(key), kind: 'money', value });
    }
  }

  if (lop) {
    const paise = (n: number) => Math.round(n * 100);
    const total = num(totalDeductions);
    const others = view.deductions.reduce((t, l) => t + paise(l.value), 0);
    const legacy = total !== null && lop.value !== 0 && paise(total) === others + paise(lop.value);
    if (legacy) view.deductions.push({ ...lop, label: 'Loss of pay' });
    else view.notes.push(lop);
  }
  return view;
}

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
