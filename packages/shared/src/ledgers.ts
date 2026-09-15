import { z } from 'zod';
import type { RoleCode } from './rbac.js';
import { msmeDueDate, msmeDelayInterest } from './india.js';

/**
 * Accounts payable and receivable (§58).
 *
 * Two operational questions, not accounting:
 *
 *  - Who owes us, how long have they owed it, and is any of it at risk?
 *  - Whom do we owe, what must be paid by law this week, and what may wait?
 *
 * Both ledgers are derived from the documents and their allocations. Neither is
 * ever a stored balance, for the reason §45 gives: a cached total and a ledger
 * of payments eventually disagree, and the ledger is always right.
 */

/* ---------------------------------------------------------------- ageing */

export const AGEING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const BUCKET_LABELS: Record<AgeingBucket, string> = {
  NOT_DUE: 'Not yet due',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  OVER_90: 'Over 90 days',
};

/**
 * Which bucket an outstanding amount falls into.
 *
 * A document with no due date is reported as undated rather than assumed
 * current: assuming makes an unknown look like a good number, and the whole
 * point of an ageing report is to find what is not good.
 */
export function ageingBucket(dueDate: string | null | undefined, asOf: string): AgeingBucket | 'UNDATED' {
  if (!dueDate) return 'UNDATED';
  if (asOf <= dueDate) return 'NOT_DUE';
  const days = daysBetween(dueDate, asOf);
  if (days <= 30) return 'D1_30';
  if (days <= 60) return 'D31_60';
  if (days <= 90) return 'D61_90';
  return 'OVER_90';
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface AgeingItem {
  outstanding: number;
  dueDate?: string | null;
  disputed?: boolean;
  /** Withheld under the contract; owed but not collectable yet. */
  retention?: number;
  onHold?: boolean;
}

export interface AgeingSummary {
  buckets: Record<AgeingBucket, number>;
  undated: number;
  /** Reported apart from the buckets — a dispute is a different problem. */
  disputed: number;
  /** Owed but not collectable until the defect liability period ends. */
  retention: number;
  onHold: number;
  /** Everything owed, including retention and disputes. */
  total: number;
  /** What is genuinely late and genuinely chaseable. */
  overdue: number;
}

/**
 * Age a set of outstanding amounts.
 *
 * Retention is excluded from the buckets and from the overdue total. It is
 * withheld under the contract until the defect liability period ends — owed,
 * but not collectable. Dropping it into the 90-plus bucket sends the
 * collections team after money the client is entitled to hold, which wastes
 * their week and damages the relationship.
 *
 * Disputed amounts are also kept out of the buckets: a dispute is a different
 * problem from slow payment and goes to a different person.
 */
export function ageOutstanding(items: AgeingItem[], asOf: string): AgeingSummary {
  const buckets: Record<AgeingBucket, number> = {
    NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0,
  };
  let undated = 0, disputed = 0, retention = 0, onHold = 0, total = 0;

  for (const item of items) {
    const amount = round2(item.outstanding);
    const held = round2(item.retention ?? 0);
    total += amount + held;
    retention += held;
    if (item.onHold) onHold += amount;
    if (amount <= 0) continue;
    if (item.disputed) { disputed += amount; continue; }
    const bucket = ageingBucket(item.dueDate, asOf);
    if (bucket === 'UNDATED') undated += amount;
    else buckets[bucket] += amount;
  }

  const overdue = buckets.D1_30 + buckets.D31_60 + buckets.D61_90 + buckets.OVER_90;
  return {
    buckets: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, round2(v)])) as Record<AgeingBucket, number>,
    undated: round2(undated),
    disputed: round2(disputed),
    retention: round2(retention),
    onHold: round2(onHold),
    total: round2(total),
    overdue: round2(overdue),
  };
}

/* ------------------------------------------------------- MSME payables */

export interface MsmeParty {
  udyamNumber?: string | null;
  msmeCategory?: string | null;
  hasWrittenAgreement?: boolean;
}

export interface PayableDue {
  /** The date agreed with the supplier. */
  contractualDueDate: string | null;
  /** The date the MSMED Act fixes, where the supplier is registered. */
  statutoryDueDate: string | null;
  /** The earlier of the two — the one that actually governs. */
  effectiveDueDate: string | null;
  isMsme: boolean;
  daysOverdue: number;
}

/**
 * When a payable is actually due (§58.3.2).
 *
 * For a supplier with a Udyam registration and a micro or small category,
 * s.15 of the MSMED Act fixes the period at 45 days with a written agreement
 * and 15 without — regardless of the credit terms negotiated. Where that date
 * is earlier than the agreed one, it governs.
 *
 * Both dates are returned rather than only the answer, because a payables
 * clerk needs to see *why* an invoice they thought had sixty days is already
 * late.
 */
export function payableDue(args: {
  party: MsmeParty;
  acceptanceDate: string | null;
  contractualDueDate: string | null;
  asOf: string;
}): PayableDue {
  const isMsme = Boolean(
    args.party.udyamNumber &&
    ['MICRO', 'SMALL'].includes(String(args.party.msmeCategory ?? '').toUpperCase()));

  const statutoryDueDate = isMsme && args.acceptanceDate
    ? msmeDueDate(args.acceptanceDate, args.party.hasWrittenAgreement !== false)
    : null;

  const candidates = [args.contractualDueDate, statutoryDueDate].filter(Boolean) as string[];
  const effectiveDueDate = candidates.length ? candidates.sort()[0] : null;

  return {
    contractualDueDate: args.contractualDueDate,
    statutoryDueDate,
    effectiveDueDate,
    isMsme,
    daysOverdue: effectiveDueDate && args.asOf > effectiveDueDate
      ? daysBetween(effectiveDueDate, args.asOf) : 0,
  };
}

/**
 * Interest accrued on a late MSME payment (§58.3.3).
 *
 * Three times the RBI bank rate, compounded monthly, under s.16. It is a real
 * liability whether or not anybody has recorded it, and it is not deductible
 * for income tax — so a payables report that omits it understates both the
 * amount owed and the tax cost of paying late.
 */
export function msmeInterestOn(args: {
  due: PayableDue;
  outstanding: number;
  asOf: string;
  bankRatePct: number;
}): number {
  if (!args.due.isMsme || !args.due.statutoryDueDate) return 0;
  if (args.asOf <= args.due.statutoryDueDate) return 0;
  return msmeDelayInterest(
    args.outstanding, args.due.statutoryDueDate, args.asOf, args.bankRatePct).interest;
}

/* ------------------------------------------------------ credit exposure */

export interface CreditExposure {
  limit: number | null;
  outstanding: number;
  /** Certified but not yet billed — committed, and it will become a receivable. */
  uninvoiced: number;
  exposure: number;
  headroom: number | null;
  breached: boolean;
  utilisationPct: number | null;
}

/**
 * A client's exposure against their credit limit (§58.2.4).
 *
 * Counts work certified but not yet billed. A limit checked only when an order
 * is taken is not a control — by the time the exposure is visible the work is
 * already done and the money already at risk.
 */
export function creditExposure(args: {
  limit?: number | null;
  outstanding: number;
  uninvoiced?: number;
}): CreditExposure {
  const outstanding = round2(args.outstanding);
  const uninvoiced = round2(args.uninvoiced ?? 0);
  const exposure = round2(outstanding + uninvoiced);
  const limit = args.limit === null || args.limit === undefined ? null : round2(args.limit);
  return {
    limit,
    outstanding,
    uninvoiced,
    exposure,
    headroom: limit === null ? null : round2(limit - exposure),
    breached: limit !== null && exposure > limit,
    utilisationPct: limit && limit > 0 ? round2((exposure / limit) * 100) : null,
  };
}

/* ----------------------------------------------------------------- DSO */

/**
 * Days sales outstanding.
 *
 * Returned with the window it was measured over. A DSO with no stated period
 * is not a number anybody can act on — the same receivable produces wildly
 * different figures over a month and over a year.
 */
export function daysSalesOutstanding(args: {
  outstanding: number;
  creditSales: number;
  periodDays: number;
}): { dso: number | null; periodDays: number } {
  if (args.creditSales <= 0 || args.periodDays <= 0) {
    return { dso: null, periodDays: args.periodDays };
  }
  return {
    dso: round2((args.outstanding / args.creditSales) * args.periodDays),
    periodDays: args.periodDays,
  };
}

/* ---------------------------------------------------------- payment run */

export const PAYMENT_RUN_STATES = ['DRAFT', 'APPROVED', 'PAID', 'CANCELLED'] as const;
export type PaymentRunState = (typeof PAYMENT_RUN_STATES)[number];

export const PAYMENT_RUN_TRANSITIONS: Record<PaymentRunState, PaymentRunState[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export interface PayableCandidate {
  documentId: string;
  outstanding: number;
  due: PayableDue;
  disputed?: boolean;
  onHold?: boolean;
  /** Whether the three-way match passed (§13.2). */
  matchStatus?: string | null;
}

export interface RunSelection {
  included: PayableCandidate[];
  excluded: Array<{ documentId: string; code: string; reason: string }>;
}

/**
 * Which payables a run may include (§58.3.4).
 *
 * Ordered by statutory due date first: the invoices that carry a legal
 * consequence get paid before those that carry only a relationship one.
 *
 * A held payable is excluded from the run but stays in the ageing — the money
 * is still owed, and hiding it would make the payables position look better
 * than it is.
 */
export function selectForRun(
  candidates: PayableCandidate[],
  opts: { asOf: string; hasMatchOverride?: boolean; includeNotYetDue?: boolean } = { asOf: '' },
): RunSelection {
  const included: PayableCandidate[] = [];
  const excluded: RunSelection['excluded'] = [];

  for (const c of candidates) {
    if (c.outstanding <= 0) {
      excluded.push({ documentId: c.documentId, code: 'SETTLED', reason: 'Already settled' });
      continue;
    }
    if (c.disputed) {
      excluded.push({ documentId: c.documentId, code: 'DISPUTED', reason: 'Under dispute' });
      continue;
    }
    if (c.onHold) {
      excluded.push({ documentId: c.documentId, code: 'ON_HOLD', reason: 'On hold' });
      continue;
    }
    // Paying a bill that does not agree with the order and the receipt is the
    // failure the three-way match exists to prevent. OVERRIDDEN is payable:
    // somebody has already formally accepted the difference, and blocking it a
    // second time would make the override meaningless.
    const matchOk = !c.matchStatus || c.matchStatus === 'MATCHED' || c.matchStatus === 'OVERRIDDEN';
    if (!matchOk && !opts.hasMatchOverride) {
      excluded.push({
        documentId: c.documentId, code: 'NOT_MATCHED',
        reason: `Three-way match is ${String(c.matchStatus).toLowerCase()}`,
      });
      continue;
    }
    if (!opts.includeNotYetDue && c.due.effectiveDueDate && opts.asOf < c.due.effectiveDueDate) {
      excluded.push({ documentId: c.documentId, code: 'NOT_DUE', reason: 'Not yet due' });
      continue;
    }
    included.push(c);
  }

  // A statutory obligation already past its date comes first, whatever else is
  // older: it accrues interest under s.16 and has to be disclosed in the annual
  // accounts, where a late payment to a non-MSME supplier costs goodwill and
  // nothing else. Within each group, oldest first.
  const rank = (c: PayableCandidate) =>
    c.due.isMsme && c.due.statutoryDueDate && opts.asOf > c.due.statutoryDueDate ? 0 : 1;
  included.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const aKey = a.due.effectiveDueDate ?? '9999-12-31';
    const bKey = b.due.effectiveDueDate ?? '9999-12-31';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return b.outstanding - a.outstanding;
  });

  return { included, excluded };
}

/* ------------------------------------------------------------ permissions */

export const LEDGER_PERMISSIONS = [
  'ar.read', 'ap.read',
  'payable.hold',
  'paymentrun.read', 'paymentrun.manage', 'paymentrun.approve',
] as const;

export const LEDGER_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...LEDGER_PERMISSIONS],
  ADMIN: [...LEDGER_PERMISSIONS],
  // Builds the run; does not release it. Building a batch and paying it
  // single-handed is how money reaches an unintended account.
  PAYROLL_OFFICER: ['ar.read', 'ap.read', 'payable.hold', 'paymentrun.read', 'paymentrun.manage'],
  PROJECT_MANAGER: ['ar.read', 'ap.read'],
  BID_TENDER_MANAGER: ['ar.read'],
  SALES_BD_EXECUTIVE: ['ar.read'],
  AUDITOR: ['ar.read', 'ap.read', 'paymentrun.read'],
  INVENTORY_MANAGER: ['ap.read'],
  TEAM_LEAD: [],
  HR_MANAGER: [],
  EMPLOYEE: [],
  CLIENT_VIEWER: [],
};

/* ---------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const paymentRunSchema = z.object({
  run_no: text.max(50),
  run_date: dateString,
  /** Pay everything due on or before this date. */
  due_through: dateString,
  bank_account: z.string().trim().max(50).optional(),
  include_not_yet_due: z.boolean().default(false),
  notes: z.string().trim().max(1000).optional(),
});

export const runDecisionSchema = z.object({
  action: z.enum(['APPROVE', 'CANCEL']),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.action === 'CANCEL' && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say why the run is being cancelled',
    });
  }
});

export const payableHoldSchema = z.object({
  on_hold: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.on_hold && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say why payment is being held — it is what the supplier will ask',
    });
  }
});
