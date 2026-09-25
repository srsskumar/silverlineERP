import { z } from 'zod';
import type { RoleCode } from './rbac.js';

/**
 * Financial control (§45).
 *
 * The specification lists ten invoice states in one column:
 *
 *   Draft, Submitted, Approved, Issued, Partially Paid, Paid, Overdue,
 *   Disputed, Cancelled, Credit/Debit Adjusted
 *
 * Read as a single enum that model cannot represent the situation it most
 * needs to: an invoice the client is disputing is exactly the one that goes
 * overdue, and a document can only hold one value. These are four independent
 * facts wearing one label, so they are modelled as four:
 *
 *  - **Lifecycle** — where the document is in its own life: draft, issued,
 *    cancelled. Somebody moves it.
 *  - **Settlement** — how much of it has been paid. Derived from the
 *    allocations; never stored, because a stored total and a ledger of
 *    payments eventually disagree and the ledger is always right.
 *  - **Overdue** — a function of the due date and what is outstanding, asked
 *    at the moment of asking. Storing it means a nightly job maintains it and
 *    it is wrong in between.
 *  - **Disputed** — a flag, with a reason, that travels alongside all three.
 */

/* ------------------------------------------------------------- lifecycle */

export const INVOICE_LIFECYCLE = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'ISSUED', 'CANCELLED',
] as const;
export type InvoiceLifecycle = (typeof INVOICE_LIFECYCLE)[number];

/**
 * An issued invoice cannot go back to draft.
 *
 * It has left the building — the client has it, and it carries a document
 * number that a tax return will reference. The way back is a credit note,
 * which is a new document, not an edit to this one.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceLifecycle, InvoiceLifecycle[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['ISSUED', 'CANCELLED'],
  ISSUED: ['CANCELLED'],
  CANCELLED: [],
};

export function canIssue(from: InvoiceLifecycle): boolean {
  return (INVOICE_TRANSITIONS[from] ?? []).includes('ISSUED');
}

/* ------------------------------------------------------------- tones */

/**
 * Status-badge colour, one vocabulary for web and mobile (R5-002/003/004).
 * Two screens picking their own tones for the same record is how an invoice
 * on hold read as more severe than a disputed one on web, and the opposite
 * on mobile.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * A vendor invoice's `on_hold`/`disputed` are independent booleans, not one
 * lifecycle status, so each gets its own badge tone rather than a
 * status-keyed map. `on_hold` is the more severe of the two: it is a
 * deliberate block on payment, where `disputed` is a claim still being
 * worked out. (Owner reference: web's original mapping; mobile had the two
 * swapped and is the one that changed, R5-002.)
 */
export const PAYABLE_INVOICE_FLAG_TONES: { on_hold: Tone; disputed: Tone } = {
  on_hold: 'danger',
  disputed: 'warning',
};

/* ------------------------------------------------------------ settlement */

export type SettlementState =
  | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVER_APPLIED';

export interface SettlementPosition {
  invoiced: number;
  /** Cash actually received or paid against this document. */
  settledCash: number;
  /** Settled without cash — TDS the payer deposited, advances adjusted. */
  settledNonCash: number;
  /** Owed but not yet due for collection — retention held back. */
  deferred: number;
  outstanding: number;
  state: SettlementState;
  overdue: boolean;
  daysOverdue: number;
}

export interface AllocationLine {
  /** Cash applied to the document. */
  amount: number;
  /** Tax the payer withheld and deposits with the government on our behalf. */
  tdsAmount?: number;
  /** Money the payer is entitled to keep until the defect liability ends. */
  retentionAmount?: number;
  /** An advance already received, being set against this document. */
  advanceAdjusted?: number;
  /** Anything else withheld — a penalty, a disputed line. */
  otherDeduction?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Where a document stands once every payment against it is counted.
 *
 * The distinction that matters, and the one an implementation usually gets
 * wrong: **TDS settles the invoice; retention does not.**
 *
 * When a client pays 98 and deposits 2 as tax deducted at source, the invoice
 * is fully settled — the 2 is ours, sitting with the government, and chasing
 * the client for it would be wrong. When a client pays 95 and holds 5 as
 * retention, the 5 is still owed; it simply is not collectable until the
 * defect liability period ends.
 *
 * Treating them alike goes wrong in both directions: count TDS as unpaid and
 * the ledger carries a phantom receivable nobody can ever collect; count
 * retention as paid and real money is written off.
 */
export function settlementPosition(args: {
  invoiced: number;
  allocations: AllocationLine[];
  dueDate?: string | null;
  asOf?: string;
}): SettlementPosition {
  const invoiced = round2(args.invoiced);
  const cash = round2(args.allocations.reduce((t, a) => t + a.amount, 0));
  const nonCash = round2(args.allocations.reduce(
    (t, a) => t + (a.tdsAmount ?? 0) + (a.advanceAdjusted ?? 0), 0));
  const deferred = round2(args.allocations.reduce((t, a) => t + (a.retentionAmount ?? 0), 0));
  const other = round2(args.allocations.reduce((t, a) => t + (a.otherDeduction ?? 0), 0));

  // Retention and other withholdings remain outstanding: the money is still
  // owed, it is only not collectable yet.
  const settled = round2(cash + nonCash);
  const outstanding = round2(invoiced - settled);

  const state: SettlementState =
    settled <= 0 ? 'UNPAID'
    : outstanding < -0.005 ? 'OVER_APPLIED'
    : outstanding <= 0.005 ? 'PAID'
    : 'PARTIALLY_PAID';

  let overdue = false;
  let daysOverdue = 0;
  if (args.dueDate && outstanding > 0.005) {
    const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
    if (asOf > args.dueDate) {
      overdue = true;
      daysOverdue = Math.max(0, Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${args.dueDate}T00:00:00Z`)) / 86_400_000));
    }
  }

  return {
    invoiced,
    settledCash: cash,
    settledNonCash: nonCash,
    deferred: round2(deferred + other),
    outstanding,
    state,
    overdue,
    daysOverdue,
  };
}

/**
 * How much of a payment has not been applied to anything yet.
 *
 * §45.2 calls this "unallocated payment awaiting reconciliation". It is a
 * derived figure rather than a status: money arrives in the bank before
 * anybody knows which invoices it settles, and the gap closes as they are
 * matched. A status would have to be maintained by whoever allocates, and
 * would be wrong whenever they forgot.
 */
export function unallocated(paymentAmount: number, allocations: AllocationLine[]): number {
  // Cash only, for the same reason: the deductions on an allocation are money
  // the payer withheld, not money that arrived and is waiting to be matched.
  const applied = allocations.reduce((t, a) => t + a.amount, 0);
  return round2(paymentAmount - applied);
}

/**
 * Whether an allocation can be made, and why not when it cannot.
 *
 * Over-applying is refused rather than reported. Unlike an over-receipt of
 * material — where the goods are physically on site and denying it makes the
 * stock ledger wrong — money applied to an invoice beyond its value is simply
 * a keying error, and accepting it creates a credit nobody intended.
 */
export function checkAllocation(args: {
  paymentAmount: number;
  alreadyAllocated: AllocationLine[];
  line: AllocationLine;
  documentOutstanding: number;
}): { allowed: boolean; code?: string; reason?: string } {
  const line = args.line;
  const lineTotal = round2(line.amount + (line.tdsAmount ?? 0) + (line.retentionAmount ?? 0)
    + (line.advanceAdjusted ?? 0) + (line.otherDeduction ?? 0));
  if (lineTotal <= 0) {
    return { allowed: false, code: 'EMPTY_ALLOCATION', reason: 'An allocation has to apply something' };
  }
  const remaining = unallocated(args.paymentAmount, args.alreadyAllocated);
  // Only cash draws down the payment. Everything else on an allocation —
  // TDS, retention, an adjusted advance, a withholding — is money the payer
  // kept; it never reached our bank and so was never part of this payment.
  //
  // Getting this wrong refuses the ordinary case: a client settling a 100
  // invoice pays 98 and deposits 2 as TDS, so the payment is 98 while the
  // allocation settles 100.
  const drawnFromPayment = round2(line.amount);
  if (drawnFromPayment - remaining > 0.005) {
    return {
      allowed: false, code: 'EXCEEDS_PAYMENT',
      reason: `Only ${remaining} of this payment is unallocated; ${drawnFromPayment} would over-apply it`,
    };
  }
  const settlesDocument = round2(line.amount + (line.tdsAmount ?? 0) + (line.advanceAdjusted ?? 0));
  if (settlesDocument - args.documentOutstanding > 0.005) {
    return {
      allowed: false, code: 'EXCEEDS_DOCUMENT',
      reason: `The document has ${args.documentOutstanding} outstanding; ${settlesDocument} would over-apply it`,
    };
  }
  return { allowed: true };
}

/* ------------------------------------------------------- financial periods */

export interface FinancialPeriod {
  code: string;
  startsOn: string;
  endsOn: string;
  status: 'OPEN' | 'CLOSED';
}

export type PeriodVerdict =
  | { allowed: true; period?: FinancialPeriod }
  | { allowed: false; code: string; reason: string; period?: FinancialPeriod };

/**
 * Whether a financial document may be dated into a given day (§45.3).
 *
 * A closed period refuses new documents as well as edits to old ones. Closing
 * a month and then letting somebody book a fresh invoice into it is the same
 * thing as not closing it: the figures that were signed off change afterwards.
 *
 * A date in no period at all is allowed. Periods are a control an organisation
 * opts into, and refusing every document until somebody defines a calendar
 * would make the feature a blocker rather than a safeguard.
 */
export function periodAllows(
  periods: FinancialPeriod[], date: string, opts: { hasOverride?: boolean } = {},
): PeriodVerdict {
  const period = periods.find(p => p.startsOn <= date && date <= p.endsOn);
  if (!period || period.status === 'OPEN') return { allowed: true, period };
  if (opts.hasOverride) return { allowed: true, period };
  return {
    allowed: false,
    code: 'PERIOD_CLOSED',
    reason: `${period.code} is closed. Post this to an open period, or have it reopened with a reason on record.`,
    period,
  };
}

/** Two periods covering the same day would make "which period" a matter of luck. */
export function findPeriodOverlap(periods: FinancialPeriod[]): FinancialPeriod[] | null {
  const ordered = [...periods].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
  for (let i = 0; i < ordered.length - 1; i += 1) {
    if (ordered[i].endsOn >= ordered[i + 1].startsOn) return [ordered[i], ordered[i + 1]];
  }
  return null;
}

/* ---------------------------------------------------- bank reconciliation */

export const RECONCILIATION_STATES = [
  'UNMATCHED', 'MATCHED', 'PARTIALLY_MATCHED', 'EXCEPTION', 'RECONCILED',
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export interface BankLine {
  amount: number;
  /** Set once a person has confirmed the match. */
  reconciledAt?: string | null;
  state: ReconciliationState;
}

export interface ImportVerdict {
  action: 'APPLY' | 'SKIP_RECONCILED' | 'FLAG_EXCEPTION';
  state: ReconciliationState;
  note?: string;
}

/**
 * What an import may do to a bank line it has seen before (§45.4).
 *
 * "No integration should silently overwrite manually reconciled records" is
 * the whole rule, and the important word is *silently*. A person who
 * reconciled a line has made a judgement the feed does not have; if the feed
 * now disagrees, the answer is to raise it as an exception for them to look
 * at, not to quietly take one side or the other.
 */
export function reconcileImport(existing: BankLine | null, incoming: { amount: number }): ImportVerdict {
  if (!existing) return { action: 'APPLY', state: 'UNMATCHED' };
  if (existing.state === 'RECONCILED' || existing.reconciledAt) {
    if (Math.abs(existing.amount - incoming.amount) <= 0.005) {
      return { action: 'SKIP_RECONCILED', state: 'RECONCILED', note: 'Already reconciled and unchanged' };
    }
    return {
      action: 'FLAG_EXCEPTION',
      state: 'EXCEPTION',
      note: `The feed now reports ${incoming.amount} against a line reconciled at ${existing.amount}`,
    };
  }
  return { action: 'APPLY', state: existing.state === 'EXCEPTION' ? 'EXCEPTION' : 'UNMATCHED' };
}

/* ------------------------------------------------------------ permissions */

export const FINANCE_PERMISSIONS = [
  'payment.read', 'payment.manage',
  // Applying a payment to a document is the act that closes a receivable, and
  // is kept apart from recording that the money arrived.
  'payment.allocate',
  'period.read', 'period.manage',
  // Posting into a closed period. Reserved: it undoes the only guarantee a
  // close provides.
  'period.override',
  'bank.read', 'bank.reconcile',
  'invoice.read', 'invoice.manage', 'invoice.issue',
  // Narrower than invoice.manage (fix round 1, I4, controller ruling):
  // POST /api/v1/invoices accepts either. invoice.manage already implies
  // it -- every holder of invoice.manage is granted this too, below -- so
  // this exists for a role that should create a vendor invoice without
  // also gaining the authority to edit its lines, change its status,
  // dispute it or record a three-way match against it.
  'invoice.create',
] as const;

export const FINANCE_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...FINANCE_PERMISSIONS],
  // Everything except posting into a closed period, which §4.1 keeps with the
  // top role as a final escalation.
  ADMIN: FINANCE_PERMISSIONS.filter(p => p !== 'period.override'),
  PAYROLL_OFFICER: ['payment.read', 'payment.manage', 'payment.allocate',
    'period.read', 'bank.read', 'bank.reconcile', 'invoice.read', 'invoice.manage', 'invoice.create'],
  PROJECT_MANAGER: ['payment.read', 'period.read', 'invoice.read'],
  BID_TENDER_MANAGER: ['payment.read', 'invoice.read'],
  GOVT_OBSERVER: [],
  AUDITOR: ['payment.read', 'period.read', 'bank.read', 'invoice.read'],
  TEAM_LEAD: [],
  // invoice.create, not invoice.manage (fix round 1, I4, controller ruling):
  // POST /api/v1/invoices used to gate on inventory.manage, which this role
  // holds; moving that route onto invoice.manage would have taken away its
  // ability to create one, but invoice.manage itself was too broad a
  // replacement -- it also covers editing lines, status, disputes and
  // three-way matching, none of which this role needs. invoice.create is
  // the narrow permission POST /invoices accepts specifically for this.
  INVENTORY_MANAGER: ['invoice.read', 'invoice.create'],
  HR_MANAGER: [],
  EMPLOYEE: [],
  SALES_BD_EXECUTIVE: ['invoice.read'],
  CLIENT_VIEWER: [],
};

/* ---------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const money = z.coerce.number().finite().min(0);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const PAYMENT_DIRECTIONS = ['RECEIVABLE', 'PAYABLE'] as const;

/**
 * How money moves, wherever it moves.
 *
 * One list rather than one per module: a client receipt and an employee
 * reimbursement use the same instruments, and two lists drift until a mode
 * valid in one screen is rejected by another.
 *
 * ADJUSTMENT is not an instrument — it records a settlement where no money
 * moved, such as an advance being set against a bill.
 */
export const PAYMENT_MODES = [
  'NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH', 'PAYROLL', 'ADJUSTMENT',
] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const paymentSchema = z.object({
  direction: z.enum(PAYMENT_DIRECTIONS),
  payment_no: text.max(50),
  paid_on: dateString,
  amount: money.refine(v => v > 0, 'A payment has to be for something'),
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(100).optional(),
  /** The client or vendor on the other side. */
  party_type: z.enum(['CLIENT', 'VENDOR', 'EMPLOYEE']).optional(),
  party_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  bank_account: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const paymentAllocationSchema = z.object({
  document_type: z.enum(['RA_BILL', 'VENDOR_INVOICE', 'EXPENSE_CLAIM', 'ADVANCE']),
  document_id: uuid,
  amount: money,
  tds_amount: money.optional(),
  retention_amount: money.optional(),
  advance_adjusted: money.optional(),
  other_deduction: money.optional(),
  deduction_reason: z.string().trim().max(500).optional(),
}).superRefine((v, ctx) => {
  // An RA bill's net payable is already net of TDS, retention, security
  // deposit, cess and advance recovery: the bill deducted them when it was
  // certified. A receipt against it settles the cash that arrived and nothing
  // else. Accepting TDS or an advance adjustment here as well deducts the same
  // money a second time and closes the bill with part of it never received.
  if (v.document_type === 'RA_BILL') {
    for (const field of ['tds_amount', 'advance_adjusted'] as const) {
      if ((v[field] ?? 0) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: [field],
          message: field === 'tds_amount'
            ? 'An RA bill\'s net payable is already after TDS. Allocate only the cash received.'
            : 'An RA bill already recovered the advance when it was certified. Allocate only the cash received.',
        });
      }
    }
  }
  // A withholding without a stated reason is the line the client disputes,
  // and an unexplained one cannot be defended.
  if ((v.other_deduction ?? 0) > 0 && !v.deduction_reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['deduction_reason'],
      message: 'Say why the amount was withheld',
    });
  }
});

export const financialPeriodSchema = z.object({
  code: text.max(30),
  starts_on: dateString,
  ends_on: dateString,
}).refine(v => v.ends_on >= v.starts_on, {
  message: 'A period cannot end before it starts', path: ['ends_on'],
});

export const periodClosureSchema = z.object({
  action: z.enum(['CLOSE', 'REOPEN']),
  // Reopening a closed period changes figures somebody has already signed
  // off, so it is never done without a reason on record.
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.action === 'REOPEN' && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say why the period is being reopened',
    });
  }
});

export const bankTransactionSchema = z.object({
  statement_ref: text.max(100),
  value_date: dateString,
  amount: z.coerce.number().finite(),
  narration: z.string().trim().max(500).optional(),
  bank_account: z.string().trim().max(50).optional(),
});

export const bankImportSchema = z.object({
  bank_account: z.string().trim().max(50).optional(),
  transactions: z.array(bankTransactionSchema).min(1).max(1000),
});

export const invoiceStatusSchema = z.object({
  status: z.enum(INVOICE_LIFECYCLE),
  reason: z.string().trim().max(1000).optional(),
});

export const disputeSchema = z.object({
  disputed: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.disputed && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say what is being disputed — it is what the conversation with the client starts from',
    });
  }
});
