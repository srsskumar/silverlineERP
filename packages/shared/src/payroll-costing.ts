import { z } from 'zod';

/**
 * Where the wage bill actually went (§note 10).
 *
 * The cost engine has heads, budgets, entries and a profitability figure, and
 * the only things that ever fed it were expense claims and manual
 * adjustments. In a survey business the dominant cost is crew days in the
 * field, so every project's margin was revenue against almost nothing.
 *
 * The cost posted here is real money rather than an estimate: it comes from a
 * locked payroll run, apportioned across projects by the days people actually
 * worked on them. Deriving a daily rate from salary_basic would have been
 * easier and would have produced a number that agrees with nothing — the
 * figure in the accounts is what payroll paid.
 */

/** A day's work that can be attributed to a project. */
export interface ProjectDays {
  projectId: string;
  days: number;
}

export interface ApportionInput {
  /** What the payslip actually cost, in rupees. */
  gross: number;
  /** Every day the employee was present in the period, attributable or not. */
  totalDays: number;
  /** The attributable days, by project. */
  byProject: ProjectDays[];
}

export interface ApportionedLine {
  projectId: string;
  days: number;
  amount: number;
}

export interface Apportionment {
  lines: ApportionedLine[];
  attributedDays: number;
  /**
   * Days present that no project claims.
   *
   * Office days, training, travel, or a check-out that never named a village.
   * Reported rather than spread across the projects that happen to be on the
   * list — charging a project for a day nobody worked on it is worse than
   * admitting the day is unaccounted for.
   */
  unattributedDays: number;
  attributedAmount: number;
  unattributedAmount: number;
}

const toPaise = (rupees: number): number => Math.round(rupees * 100);
const toRupees = (paise: number): number => Math.round(paise) / 100;

/**
 * One payslip, split across the projects its days were worked on.
 *
 * Largest-remainder, in paise. Splitting three ways by rounding each share
 * independently loses or invents a paisa, and a cost ledger that does not add
 * up to the payroll it came from is a ledger somebody has to reconcile by
 * hand — which is the work this is supposed to remove.
 */
export function apportionPayroll(input: ApportionInput): Apportionment {
  const totalDays = Math.max(0, input.totalDays);
  const attributed = input.byProject.filter(p => p.days > 0);
  const attributedDays = attributed.reduce((t, p) => t + p.days, 0);
  const grossPaise = toPaise(input.gross);

  if (totalDays === 0 || attributedDays === 0) {
    return {
      lines: [],
      attributedDays: 0,
      unattributedDays: totalDays,
      attributedAmount: 0,
      unattributedAmount: toRupees(grossPaise),
    };
  }

  // Never more than the days actually present: a day counted against two
  // projects would charge the wage twice.
  const effectiveAttributed = Math.min(attributedDays, totalDays);
  const attributablePaise = Math.floor((grossPaise * effectiveAttributed) / totalDays);

  const exact = attributed.map(p => ({
    projectId: p.projectId,
    days: p.days,
    share: (attributablePaise * p.days) / attributedDays,
  }));
  const floored = exact.map(e => ({ ...e, paise: Math.floor(e.share) }));
  let remainder = attributablePaise - floored.reduce((t, f) => t + f.paise, 0);

  // The leftover paise go to the largest fractional parts, biggest first, so
  // the split is deterministic and the total is exact.
  const order = [...floored]
    .map((f, i) => ({ i, frac: f.share - f.paise }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i].paise += 1;
    remainder -= 1;
  }

  return {
    lines: floored.map(f => ({
      projectId: f.projectId, days: f.days, amount: toRupees(f.paise),
    })),
    attributedDays: effectiveAttributed,
    unattributedDays: Math.max(0, totalDays - effectiveAttributed),
    attributedAmount: toRupees(attributablePaise),
    unattributedAmount: toRupees(grossPaise - attributablePaise),
  };
}

/**
 * Every payslip in a run, summed per project.
 *
 * One cost entry per project per run rather than per employee: the ledger
 * answers "what did this project cost", and a row per person per month turns
 * that into a page nobody reads and leaks what each of them earns to anybody
 * who can read the cost report.
 */
export function apportionRun(
  payslips: Array<{ employeeId: string; gross: number; totalDays: number; byProject: ProjectDays[] }>,
): {
  byProject: Array<{ projectId: string; amount: number; days: number; employees: number }>;
  unattributedAmount: number;
  unattributedDays: number;
  employeesWithNoAttributableDays: number;
} {
  const byProject = new Map<string, { amount: number; days: number; employees: Set<string> }>();
  let unattributedAmount = 0;
  let unattributedDays = 0;
  let employeesWithNoAttributableDays = 0;

  for (const slip of payslips) {
    const a = apportionPayroll(slip);
    if (a.lines.length === 0) employeesWithNoAttributableDays += 1;
    unattributedAmount += a.unattributedAmount;
    unattributedDays += a.unattributedDays;
    for (const line of a.lines) {
      let b = byProject.get(line.projectId);
      if (!b) { b = { amount: 0, days: 0, employees: new Set() }; byProject.set(line.projectId, b); }
      b.amount += line.amount;
      b.days += line.days;
      b.employees.add(slip.employeeId);
    }
  }

  return {
    byProject: [...byProject.entries()]
      .map(([projectId, b]) => ({
        projectId,
        amount: toRupees(toPaise(b.amount)),
        days: b.days,
        employees: b.employees.size,
      }))
      .sort((a, b) => b.amount - a.amount),
    unattributedAmount: toRupees(toPaise(unattributedAmount)),
    unattributedDays,
    employeesWithNoAttributableDays,
  };
}

/** Posting a run's labour cost onto the projects it was worked on. */
export const payrollCostPostSchema = z.object({
  /**
   * The head to post it under.
   *
   * Optional: a LABOUR head is found or created, because an organisation
   * that has not set its cost heads up should still get its wage bill onto
   * the projects rather than losing it.
   */
  cost_head_id: z.string().uuid().optional(),
  narration: z.string().max(500).optional(),
});

export const payrollCostReverseSchema = z.object({
  reason: z.string().trim().min(1, 'Say why this is being reversed').max(500),
});
