import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * Workforce allocation and rostering (§47).
 *
 * The existing model assigns a person to a task and stops there, which answers
 * "who is doing this?" but never "is this person already promised elsewhere?".
 * Those are different questions and the second is the one that causes trouble:
 * a site manager commits an engineer who is already full on another project,
 * and nobody finds out until both sites need them on the same morning.
 *
 * Allocation is therefore a *proportion of somebody's time over a date range*,
 * not a flag. Two allocations overlap when their date ranges intersect, and
 * the sum of the overlapping percentages is what tells you whether a promise
 * can be kept.
 */

/* ------------------------------------------------------------ allocation */

export const ALLOCATION_STATES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export const ALLOCATION_TRANSITIONS: Record<AllocationState, AllocationState[]> = {
  PLANNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export interface Allocation {
  id?: string;
  employeeId: string;
  projectId: string;
  /** Share of the person's working time, 1–100. */
  percentage: number;
  startsOn: string;
  endsOn: string;
  state: AllocationState;
  roleOnProject?: string | null;
  plannedHours?: number | null;
}

/** Whether two date ranges share at least one day. */
export function rangesOverlap(
  a: { startsOn: string; endsOn: string },
  b: { startsOn: string; endsOn: string },
): boolean {
  return a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;
}

/**
 * Allocations that count against capacity.
 *
 * Cancelled and completed allocations are excluded: the first never happened
 * and the second is over. Counting them would make a person look permanently
 * full from the first project they ever finished.
 */
export function countsTowardCapacity(a: Allocation): boolean {
  return a.state === 'PLANNED' || a.state === 'ACTIVE';
}

export interface CapacityConflict {
  date: string;
  /** Total percentage promised on that day, including the proposed one. */
  totalPercentage: number;
  capacity: number;
  overBy: number;
  /** The allocations contributing, so the message can name them. */
  allocationIds: string[];
}

/**
 * Where a proposed allocation would push somebody past their capacity (§47.2).
 *
 * Evaluated at the boundaries rather than day by day. The total can only
 * change on a day an allocation starts or ends, so checking those dates finds
 * every peak — and a five-year allocation does not become a five-year loop.
 *
 * Returns the single worst day rather than every one of them: a person told
 * they are over-committed needs the number and the date, not a calendar.
 */
export function findCapacityConflict(args: {
  existing: Allocation[];
  proposed: Allocation;
  capacityPercentage?: number;
}): CapacityConflict | null {
  const capacity = args.capacityPercentage ?? 100;
  const relevant = args.existing.filter(a =>
    a.employeeId === args.proposed.employeeId &&
    a.id !== args.proposed.id &&
    countsTowardCapacity(a) &&
    rangesOverlap(a, args.proposed));
  if (!relevant.length && args.proposed.percentage <= capacity) return null;

  const boundaries = new Set<string>([args.proposed.startsOn]);
  for (const a of relevant) {
    if (a.startsOn >= args.proposed.startsOn && a.startsOn <= args.proposed.endsOn) {
      boundaries.add(a.startsOn);
    }
  }

  let worst: CapacityConflict | null = null;
  for (const date of boundaries) {
    const active = relevant.filter(a => a.startsOn <= date && date <= a.endsOn);
    const total = active.reduce((t, a) => t + a.percentage, 0) + args.proposed.percentage;
    if (total > capacity) {
      const conflict: CapacityConflict = {
        date,
        totalPercentage: Math.round(total * 100) / 100,
        capacity,
        overBy: Math.round((total - capacity) * 100) / 100,
        allocationIds: active.map(a => a.id).filter((id): id is string => Boolean(id)),
      };
      if (!worst || conflict.totalPercentage > worst.totalPercentage) worst = conflict;
    }
  }
  return worst;
}

/**
 * How much of a person is already promised across a window.
 *
 * Used for the utilisation view: who is idle, who is full, and who is over.
 */
export function utilisation(allocations: Allocation[], on: string, capacity = 100): {
  allocated: number; free: number; over: boolean;
} {
  const allocated = allocations
    .filter(a => countsTowardCapacity(a) && a.startsOn <= on && on <= a.endsOn)
    .reduce((t, a) => t + a.percentage, 0);
  return {
    allocated: Math.round(allocated * 100) / 100,
    free: Math.round((capacity - allocated) * 100) / 100,
    over: allocated > capacity,
  };
}

/* ---------------------------------------------------------------- rosters */

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Shift {
  code: string;
  startsAt: string;
  endsAt: string;
  /** Unpaid break, in minutes. */
  breakMinutes?: number;
  restDays?: Weekday[];
}

/**
 * Hours a shift is worth, handling one that crosses midnight.
 *
 * A night shift from 22:00 to 06:00 is eight hours, not minus sixteen. Getting
 * this wrong does not produce an obviously silly roster — it produces a
 * payroll that quietly underpays the people working nights.
 */
export function shiftHours(shift: Shift): number {
  const [sh, sm] = shift.startsAt.split(':').map(Number);
  const [eh, em] = shift.endsAt.split(':').map(Number);
  const start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end <= start) end += 24 * 60;
  const minutes = end - start - (shift.breakMinutes ?? 0);
  return Math.round((minutes / 60) * 100) / 100;
}

export function isRestDay(shift: Shift, date: string): boolean {
  const day = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return (shift.restDays ?? []).includes(day);
}

export interface OvertimeRule {
  /** Hours beyond which overtime begins, per day. */
  dailyThresholdHours: number;
  /** Multiplier applied to the overtime hours. */
  multiplier: number;
  /** Work on a rest day or holiday, if it is paid differently. */
  restDayMultiplier?: number;
}

export interface DayPay {
  normalHours: number;
  overtimeHours: number;
  /** Hours after the multipliers, for payroll to price. */
  payableHours: number;
}

/**
 * Split a day's worked hours into normal and overtime (§47.3).
 *
 * Payroll consumes this rather than raw attendance: the raw events say when a
 * phone was at a site, which is evidence, not a decision about what somebody
 * is owed. The roster and its rules turn one into the other, and only the
 * approved result should reach a payslip.
 */
export function dayPay(args: {
  workedHours: number;
  rule: OvertimeRule;
  onRestDay?: boolean;
}): DayPay {
  const worked = Math.max(0, args.workedHours);
  if (args.onRestDay) {
    // Every hour on a rest day is premium; there is no "normal" portion of a
    // day somebody was not rostered to work at all.
    const multiplier = args.rule.restDayMultiplier ?? args.rule.multiplier;
    return {
      normalHours: 0,
      overtimeHours: round2(worked),
      payableHours: round2(worked * multiplier),
    };
  }
  const normal = Math.min(worked, args.rule.dailyThresholdHours);
  const overtime = Math.max(0, worked - args.rule.dailyThresholdHours);
  return {
    normalHours: round2(normal),
    overtimeHours: round2(overtime),
    payableHours: round2(normal + overtime * args.rule.multiplier),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------ permissions */

export const ALLOCATION_PERMISSIONS = [
  'allocation.read', 'allocation.manage',
  // Committing somebody past their capacity. Recorded with a reason: the
  // warning exists to be acted on, not clicked through.
  'allocation.override',
  'roster.read', 'roster.manage',
] as const;

export const ALLOCATION_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...ALLOCATION_PERMISSIONS],
  ADMIN: [...ALLOCATION_PERMISSIONS],
  // Plans their own site's people and may knowingly over-commit, because they
  // are the one who has to make it work.
  PROJECT_MANAGER: ['allocation.read', 'allocation.manage', 'allocation.override', 'roster.read'],
  HR_MANAGER: ['allocation.read', 'allocation.manage', 'roster.read', 'roster.manage'],
  TEAM_LEAD: ['allocation.read', 'roster.read'],
  PAYROLL_OFFICER: ['allocation.read', 'roster.read'],
  AUDITOR: ['allocation.read', 'roster.read'],
  EMPLOYEE: [],
  INVENTORY_MANAGER: [],
  BID_TENDER_MANAGER: ['allocation.read'],
  SALES_BD_EXECUTIVE: [],
  CLIENT_VIEWER: [],
};

/* ---------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const resourceAllocationSchema = z.object({
  employee_id: uuid,
  project_id: uuid,
  percentage: z.coerce.number().min(1).max(100),
  starts_on: dateString,
  ends_on: dateString,
  role_on_project: z.string().trim().max(100).optional(),
  planned_hours: z.coerce.number().min(0).max(10_000).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** Required only when the allocation would breach capacity. */
  override_reason: z.string().trim().max(1000).optional(),
}).refine(v => v.ends_on >= v.starts_on, {
  message: 'An allocation cannot end before it starts', path: ['ends_on'],
});

export const shiftSchema = z.object({
  code: text.max(30).transform(v => v.toUpperCase()),
  name: text.max(100),
  starts_at: time,
  ends_at: time,
  break_minutes: z.coerce.number().int().min(0).max(480).default(0),
  rest_days: z.array(z.enum(WEEKDAYS)).max(7).default([]),
  daily_threshold_hours: z.coerce.number().min(0).max(24).default(8),
  overtime_multiplier: z.coerce.number().min(1).max(4).default(1.5),
  rest_day_multiplier: z.coerce.number().min(1).max(4).optional(),
  effective_from: dateString,
  effective_to: dateString.nullable().optional(),
  active: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (v.effective_to && v.effective_to < v.effective_from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effective_to'], message: 'Ends before it starts' });
  }
  // A shift whose break swallows the whole span pays nobody anything.
  if (shiftHours({ code: v.code, startsAt: v.starts_at, endsAt: v.ends_at, breakMinutes: v.break_minutes }) <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['break_minutes'],
      message: 'The break is as long as the shift — nobody would be working',
    });
  }
});

export const rosterEntrySchema = z.object({
  employee_id: uuid,
  shift_id: uuid,
  roster_date: dateString,
  project_id: uuid.nullable().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const rosterBulkSchema = z.object({
  shift_id: uuid,
  starts_on: dateString,
  ends_on: dateString,
  employee_ids: z.array(uuid).min(1).max(200),
  project_id: uuid.nullable().optional(),
}).refine(v => v.ends_on >= v.starts_on, {
  message: 'A roster window cannot end before it starts', path: ['ends_on'],
});
