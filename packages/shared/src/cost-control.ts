import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * Project cost control — budget versus actual by cost head (§15.6, §15.3).
 *
 * Two decisions shape everything here.
 *
 * First, actual cost is a *ledger*, never a running total on the project row.
 * Cost arrives from four places — approved expense claims, purchase orders,
 * goods receipts and RA bills — and each of those already has its own writer.
 * Give them one mutable number to increment and they will eventually disagree
 * about it, exactly as a stored `received_quantity` disagrees with the GRNs.
 * An append-only ledger with explicit reversals can always be re-derived and
 * always explains itself: every rupee names the document that caused it.
 *
 * Second, committed cost is tracked separately from actual cost. A project
 * manager with 10 lakh budgeted and 8 lakh spent looks fine until you notice
 * 4 lakh of open purchase orders. The money is gone — it is contractually
 * promised — it simply has not been invoiced yet. Reporting only actuals is
 * how a site overruns its budget while the dashboard is still green.
 */

/* --------------------------------------------------------------- cost heads */

/**
 * The standard heads an Indian contracting business costs a project against.
 * These mirror the way a site P&L is actually read, which is why the set is
 * fixed: a free-text head makes cross-project comparison impossible.
 */
export const COST_HEAD_KINDS = [
  'LABOUR', 'MATERIAL', 'SUBCONTRACT', 'EQUIPMENT', 'OVERHEAD', 'OTHER',
] as const;
export type CostHeadKind = (typeof COST_HEAD_KINDS)[number];

/** Where a cost entry came from. The source is always a real document. */
export const COST_SOURCES = [
  'EXPENSE_CLAIM', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'RA_BILL',
  'PAYROLL', 'MANUAL',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/**
 * Committed cost is money promised but not yet incurred; actual is money
 * incurred. A purchase order commits; the goods receipt against it converts
 * the commitment into an actual. Keeping them in one ledger with a flag —
 * rather than in two tables — means the conversion is a pair of entries that
 * still nets correctly if only one of them is ever written.
 */
export type CostNature = 'COMMITTED' | 'ACTUAL';

export interface CostEntry {
  costHeadId: string;
  amount: number;
  nature: CostNature;
  /** Set on a reversing entry; points at the entry being undone. */
  reversalOf?: string | null;
}

export interface BudgetLine {
  costHeadId: string;
  budgetedAmount: number;
}

export interface HeadPosition {
  costHeadId: string;
  budgeted: number;
  committed: number;
  actual: number;
  /** What the head will have consumed once commitments land. */
  forecast: number;
  /** Budget less forecast. Negative means the head is heading for an overrun. */
  variance: number;
  /** Forecast as a percentage of budget; null when nothing was budgeted. */
  utilisationPct: number | null;
  overrun: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Budget position per cost head, plus the project total.
 *
 * Heads with spend but no budget are included with a zero budget rather than
 * dropped. Unbudgeted spend is precisely what a cost report exists to surface;
 * silently omitting it produces a report that always balances and never helps.
 */
export function budgetPosition(budgets: BudgetLine[], entries: CostEntry[]): {
  heads: HeadPosition[];
  totals: Omit<HeadPosition, 'costHeadId'>;
} {
  const heads = new Map<string, { budgeted: number; committed: number; actual: number }>();
  const bucket = (id: string) => {
    let b = heads.get(id);
    if (!b) { b = { budgeted: 0, committed: 0, actual: 0 }; heads.set(id, b); }
    return b;
  };

  for (const b of budgets) bucket(b.costHeadId).budgeted += b.budgetedAmount;
  for (const e of entries) {
    const b = bucket(e.costHeadId);
    if (e.nature === 'COMMITTED') b.committed += e.amount;
    else b.actual += e.amount;
  }

  const positions: HeadPosition[] = [...heads.entries()].map(([costHeadId, b]) => {
    const budgeted = round2(b.budgeted);
    const committed = round2(b.committed);
    const actual = round2(b.actual);
    // A commitment that has already been received shows up as an actual *and*
    // as a reversal of the commitment, so the two never double-count. Any
    // residual negative commitment is noise from over-reversal, not a credit.
    const openCommitment = Math.max(0, committed);
    const forecast = round2(actual + openCommitment);
    return {
      costHeadId, budgeted, committed: openCommitment, actual, forecast,
      variance: round2(budgeted - forecast),
      utilisationPct: budgeted > 0 ? round2((forecast / budgeted) * 100) : null,
      overrun: budgeted > 0 && forecast > budgeted,
    };
  }).sort((a, b) => b.forecast - a.forecast);

  const sum = (pick: (p: HeadPosition) => number) => round2(positions.reduce((t, p) => t + pick(p), 0));
  const budgeted = sum(p => p.budgeted);
  const forecast = sum(p => p.forecast);
  return {
    heads: positions,
    totals: {
      budgeted, committed: sum(p => p.committed), actual: sum(p => p.actual), forecast,
      variance: round2(budgeted - forecast),
      utilisationPct: budgeted > 0 ? round2((forecast / budgeted) * 100) : null,
      overrun: budgeted > 0 && forecast > budgeted,
    },
  };
}

/* ------------------------------------------------------------ profitability */

export interface ProfitabilityInput {
  /** The awarded contract value — what the client owes for the whole job. */
  contractValue: number;
  actualCost: number;
  /** Open commitments; included so margin does not flatter an unfinished job. */
  committedCost?: number;
}

export interface Profitability {
  contractValue: number;
  actualCost: number;
  committedCost: number;
  forecastCost: number;
  /** Contract value less cost incurred to date (§15.3). */
  profit: number;
  /** Contract value less cost incurred *and* promised. */
  forecastProfit: number;
  marginPct: number | null;
  forecastMarginPct: number | null;
  lossMaking: boolean;
}

/**
 * Project profit and margin (§15.3).
 *
 * Both a to-date and a forecast figure are returned. Reporting only the
 * to-date profit on a half-finished project is how a job that is already
 * underwater reads as profitable right up until the last invoice.
 */
export function profitability(input: ProfitabilityInput): Profitability {
  const contractValue = round2(input.contractValue);
  const actualCost = round2(input.actualCost);
  const committedCost = round2(Math.max(0, input.committedCost ?? 0));
  const forecastCost = round2(actualCost + committedCost);
  const profit = round2(contractValue - actualCost);
  const forecastProfit = round2(contractValue - forecastCost);
  return {
    contractValue, actualCost, committedCost, forecastCost, profit, forecastProfit,
    marginPct: contractValue > 0 ? round2((profit / contractValue) * 100) : null,
    forecastMarginPct: contractValue > 0 ? round2((forecastProfit / contractValue) * 100) : null,
    lossMaking: forecastProfit < 0,
  };
}

/* ------------------------------------------------------------- permissions */

export const COST_CONTROL_PERMISSIONS = [
  'costhead.read', 'costhead.manage',
  'budget.read', 'budget.manage',
  'cost.read',
  // Posts a cost entry with no source document behind it. Deliberately
  // separate: a manual adjustment is the one way into this ledger that no
  // other document justifies, so it belongs to finance alone.
  'cost.adjust',
] as const;

export const COST_CONTROL_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...COST_CONTROL_PERMISSIONS],
  ADMIN: [...COST_CONTROL_PERMISSIONS],
  // Sees the position for their sites and sets the budget there, but cannot
  // write a manual adjustment — that would let a PM paper over an overrun.
  PROJECT_MANAGER: ['costhead.read', 'budget.read', 'budget.manage', 'cost.read'],
  TEAM_LEAD: ['costhead.read', 'budget.read', 'cost.read'],
  AUDITOR: ['costhead.read', 'budget.read', 'cost.read'],
  INVENTORY_MANAGER: ['costhead.read', 'cost.read'],
  BID_TENDER_MANAGER: ['costhead.read', 'budget.read', 'cost.read'],
  GOVT_OBSERVER: [],
  SALES_BD_EXECUTIVE: [],
  EMPLOYEE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  CLIENT_VIEWER: [],
};

/* ----------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const money = z.coerce.number().finite().min(0);

export const costHeadSchema = z.object({
  code: text.max(30).transform(s => s.toUpperCase()),
  name: text.max(120),
  kind: z.enum(COST_HEAD_KINDS),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
});

export const budgetSchema = z.object({
  /** Replaces the whole budget for the project, so a revision is one call. */
  revision_reason: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    cost_head_id: uuid,
    budgeted_amount: money,
    notes: z.string().trim().max(500).optional(),
  })).min(1, 'A budget needs at least one cost head'),
});

export const costAdjustmentSchema = z.object({
  project_id: uuid,
  cost_head_id: uuid,
  amount: z.coerce.number().finite(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  narration: text.max(500),
});
