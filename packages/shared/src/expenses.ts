import { z } from 'zod';
import { addMoney, lineAmount } from './money-exact.js';
import type { RoleCode } from './rbac.js';
import { PAYMENT_MODES } from './financial-control.js';

/**
 * Expense management (§6.8, §16).
 *
 * Field teams generate travel, lodging, fuel and petty-material spend that has
 * to route through approval and, where billable, land on the project's cost
 * ledger (§15.6). The module is small; the rules that make it trustworthy are
 * not, and five of them are not in the specification at all:
 *
 *  1. Per-diem is an entitlement, not a capped reimbursement. A three-day site
 *     visit at 800/day is 2400 and needs no receipt. Treating per-diem as "a
 *     category with a limit" blocks the claim against a per-claim cap that was
 *     written per day.
 *  2. Duplicate receipts are the commonest expense fraud in field operations —
 *     one fuel bill claimed by two engineers, or the same bill re-submitted
 *     next month. Nothing in the spec prevents it. A receipt that identifies
 *     itself (vendor plus invoice number) is fingerprinted and refused twice.
 *  3. Input credit on expenses is real money and is governed by s.17(5) of the
 *     CGST Act, which blocks it outright on client entertainment and on motor
 *     fuel. Claiming it there is an assessment risk, not a saving.
 *  4. Lodging is taxed where the hotel stands. A Karnataka company's engineer
 *     staying in Delhi is charged Delhi CGST+SGST, which Karnataka cannot
 *     claim without a Delhi registration. Finance teams miss this constantly.
 *  5. A policy is tested as it stood on the date of the expense. Otherwise
 *     raising a limit in August retroactively legitimises June's overspend.
 */

/* -------------------------------------------------------------- categories */

export const EXPENSE_CATEGORIES = [
  'TRAVEL', 'LODGING', 'FUEL', 'PER_DIEM',
  'SITE_MATERIALS_PETTY', 'CLIENT_ENTERTAINMENT', 'COMMUNICATION', 'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Categories claimed as an entitlement per unit, with no receipt to produce. */
export const ENTITLEMENT_CATEGORIES: ExpenseCategory[] = ['PER_DIEM'];

export function isEntitlement(category: ExpenseCategory): boolean {
  return ENTITLEMENT_CATEGORIES.includes(category);
}

/* --------------------------------------------------------------- statuses */

export const EXPENSE_CLAIM_STATUSES = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REIMBURSED',
] as const;
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];

/**
 * WITHDRAWN exists because the specification's status set leaves an employee
 * who submitted by mistake with no way back. In its absence they ask finance
 * to "reject" the claim, and the policy-exception report fills with rejections
 * that were never policy failures.
 *
 * There is deliberately no PARTIALLY_REIMBURSED. Part-payment is a fact about
 * the reimbursement records, and it is derived from their sum; a status that
 * has to be kept in step with a running total eventually stops being true.
 */
export const EXPENSE_CLAIM_TRANSITIONS: Record<ExpenseClaimStatus, ExpenseClaimStatus[]> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  // Rework: a rejected claim returns to the employee rather than dying, so the
  // receipts already attached are not re-keyed.
  REJECTED: ['DRAFT', 'WITHDRAWN'],
  APPROVED: ['REIMBURSED'],
  REIMBURSED: [],
  WITHDRAWN: [],
};

export function canTransition(from: ExpenseClaimStatus, to: ExpenseClaimStatus): boolean {
  return (EXPENSE_CLAIM_TRANSITIONS[from] ?? []).includes(to);
}

/* ------------------------------------------------------- GST input credit */

export type CreditBlockReason =
  | 'BLOCKED_SECTION_17_5'
  | 'NO_GSTIN_ON_BILL'
  | 'PLACE_OF_SUPPLY_UNREGISTERED'
  | null;

export interface CreditabilityInput {
  category: ExpenseCategory;
  /** The supplier's GSTIN as printed on the bill; absent means no credit. */
  vendorGstin?: string | null;
  /** State code where the supply took place — for lodging, the hotel's state. */
  supplyStateCode?: string | null;
  /** State codes the organisation actually holds a GST registration in. */
  registeredStateCodes?: string[];
}

export interface Creditability {
  creditable: boolean;
  reason: CreditBlockReason;
  explanation: string | null;
}

/**
 * Whether the GST on an expense line can be taken as input credit.
 *
 * Client entertainment is food and beverage, blocked by s.17(5)(b)(i). Motor
 * fuel is blocked by s.17(5)(a) where the vehicle is not itself part of the
 * business of transport — and petrol and diesel sit outside GST in any case,
 * so there is usually no tax on the bill to argue about.
 */
export function gstCreditability(input: CreditabilityInput): Creditability {
  const blocked: Partial<Record<ExpenseCategory, string>> = {
    CLIENT_ENTERTAINMENT:
      'Food, beverage and client hospitality are blocked credits under s.17(5)(b)(i) of the CGST Act',
    FUEL:
      'Fuel for motor vehicles is a blocked credit under s.17(5)(a); petrol and diesel also fall outside GST',
    PER_DIEM:
      'A per-diem is an employee entitlement, not a taxable supply to the company',
  };
  if (blocked[input.category]) {
    return { creditable: false, reason: 'BLOCKED_SECTION_17_5', explanation: blocked[input.category]! };
  }
  if (!input.vendorGstin) {
    return {
      creditable: false, reason: 'NO_GSTIN_ON_BILL',
      explanation: 'Credit needs the supplier GSTIN and invoice number on the bill',
    };
  }
  // Hotel accommodation is supplied where the hotel stands, so the tax is that
  // state's CGST and SGST. A company not registered there cannot take it.
  if (input.category === 'LODGING' && input.supplyStateCode) {
    const registered = input.registeredStateCodes ?? [];
    if (registered.length && !registered.includes(input.supplyStateCode)) {
      return {
        creditable: false, reason: 'PLACE_OF_SUPPLY_UNREGISTERED',
        explanation:
          `Hotel accommodation is supplied in state ${input.supplyStateCode}, where the organisation holds no GST registration`,
      };
    }
  }
  return { creditable: true, reason: null, explanation: null };
}

/* ---------------------------------------------------------------- policies */

export interface ExpensePolicy {
  id?: string;
  category: ExpenseCategory;
  /** Inclusive first day this policy governs. */
  effectiveFrom: string;
  /** Inclusive last day, or null while it is the standing policy. */
  effectiveTo?: string | null;
  /** Cap on a single line. Null means uncapped. */
  perLineLimit?: number | null;
  /** Cap on the whole claim for this category. Null means uncapped. */
  perClaimLimit?: number | null;
  /** Entitlement rate per unit — the per-diem rate. */
  unitRate?: number | null;
  /** A bill must be attached above this amount. Null means always required. */
  requiresReceiptAbove?: number | null;
  /** Grade or designation this policy applies to; null applies to everyone. */
  appliesToGrade?: string | null;
}

/**
 * The policy governing a category on the date the expense was incurred.
 *
 * A grade-specific policy wins over the organisation-wide default, because a
 * per-diem written for site engineers should not be overridden by the general
 * rule that happens to have a later start date.
 */
export function policyFor(
  policies: ExpensePolicy[], category: ExpenseCategory, onDate: string, grade?: string | null,
): ExpensePolicy | null {
  const applicable = policies.filter(p =>
    p.category === category &&
    p.effectiveFrom <= onDate &&
    (p.effectiveTo === null || p.effectiveTo === undefined || p.effectiveTo >= onDate) &&
    (!p.appliesToGrade || p.appliesToGrade === grade));
  if (!applicable.length) return null;
  return applicable.sort((a, b) => {
    const gradeRank = Number(Boolean(b.appliesToGrade)) - Number(Boolean(a.appliesToGrade));
    if (gradeRank !== 0) return gradeRank;
    return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  })[0];
}

/* ------------------------------------------------------------------ lines */

export interface ExpenseLineInput {
  category: ExpenseCategory;
  expenseDate: string;
  /** Claimed amount. For an entitlement this is derived from units × rate. */
  amount: number;
  /** Number of days, kilometres or nights — entitlement categories only. */
  units?: number | null;
  hasReceipt?: boolean;
  vendorGstin?: string | null;
  invoiceNo?: string | null;
  gstAmount?: number | null;
  supplyStateCode?: string | null;
  billableToClient?: boolean;
}

export interface LineEvaluation {
  /** Amount the policy will bear without an override. */
  allowedAmount: number;
  /** Claimed above the cap, and so needing an authorised override. */
  excessAmount: number;
  receiptRequired: boolean;
  receiptMissing: boolean;
  /** Every reason this line cannot pass as claimed, in plain words. */
  exceptions: string[];
  policyException: boolean;
  credit: Creditability;
}

// To the paisa in integers (D-010): no float drift, and no ceiling on size.
const round2 = (n: number): number => addMoney(n);

/**
 * An entitlement's value: units × the rate the policy sets.
 *
 * The cap on an entitlement is per unit, never per claim — which is exactly
 * the distinction the specification collapses.
 */
export function entitlementAmount(units: number, unitRate: number): number {
  // 12.5 km x 4.35 is 54.37499... as a float; exact, it is 54.375 -> 54.38.
  return lineAmount(Math.max(0, units), Math.max(0, unitRate));
}

export function evaluateLine(
  line: ExpenseLineInput, policy: ExpensePolicy | null,
  context: { registeredStateCodes?: string[] } = {},
): LineEvaluation {
  const exceptions: string[] = [];
  const amount = round2(line.amount);
  const credit = gstCreditability({
    category: line.category,
    vendorGstin: line.vendorGstin,
    supplyStateCode: line.supplyStateCode,
    registeredStateCodes: context.registeredStateCodes,
  });

  if (!policy) {
    // No policy is not a free pass. Anything uncovered needs a decision from a
    // human, so it is flagged rather than silently allowed.
    exceptions.push(`No expense policy covers ${line.category} on ${line.expenseDate}`);
    return {
      allowedAmount: 0, excessAmount: amount, receiptRequired: !isEntitlement(line.category),
      receiptMissing: !isEntitlement(line.category) && !line.hasReceipt,
      exceptions, policyException: true, credit,
    };
  }

  let cap: number | null = policy.perLineLimit ?? null;
  if (isEntitlement(line.category)) {
    const units = Math.max(0, line.units ?? 0);
    const rate = policy.unitRate ?? 0;
    if (!units) exceptions.push('A per-diem claim must say how many days it covers');
    if (!rate) exceptions.push(`No per-diem rate is configured for ${line.category}`);
    // The cap scales with the entitlement: three days at the day rate.
    cap = rate ? entitlementAmount(units, rate) : null;
  }

  const allowedAmount = cap === null ? amount : round2(Math.min(amount, cap));
  const excessAmount = round2(Math.max(0, amount - allowedAmount));
  if (excessAmount > 0) {
    exceptions.push(isEntitlement(line.category)
      ? `Claimed ${amount} against an entitlement of ${cap}`
      : `Claimed ${amount} against a limit of ${cap}`);
  }

  // An entitlement has no bill by definition, so the receipt rule never
  // applies to one. Applying it anyway is how per-diem claims get rejected
  // for a document that does not exist.
  const threshold = policy.requiresReceiptAbove;
  const receiptRequired = !isEntitlement(line.category) &&
    (threshold === null || threshold === undefined ? true : amount > threshold);
  const receiptMissing = receiptRequired && !line.hasReceipt;
  if (receiptMissing) {
    exceptions.push(threshold
      ? `A receipt is required above ${threshold}`
      : 'A receipt is required for this category');
  }

  if (line.gstAmount && line.gstAmount > 0 && !credit.creditable && credit.reason === 'BLOCKED_SECTION_17_5') {
    exceptions.push(credit.explanation!);
  }

  return {
    allowedAmount, excessAmount, receiptRequired, receiptMissing, exceptions,
    policyException: exceptions.length > 0, credit,
  };
}

export interface ClaimEvaluation {
  totalClaimed: number;
  totalAllowed: number;
  totalExcess: number;
  /** GST that may genuinely be taken as input credit across the claim. */
  creditableGst: number;
  /** GST that cannot be claimed and is therefore part of the project's cost. */
  blockedGst: number;
  /** Cost that should reach the project ledger once the claim is approved. */
  billableToProject: number;
  lines: LineEvaluation[];
  exceptions: string[];
  /** True when approval needs an explicit override reason to be recorded. */
  requiresOverride: boolean;
}

/**
 * Evaluate a whole claim against the policies in force on each line's date.
 *
 * Per-category claim caps are applied after the per-line pass, because a cap
 * of 5,000 on lodging is a cap on the trip, not on each night.
 */
export function evaluateClaim(args: {
  lines: ExpenseLineInput[];
  policies: ExpensePolicy[];
  grade?: string | null;
  registeredStateCodes?: string[];
}): ClaimEvaluation {
  const evaluations = args.lines.map(line =>
    evaluateLine(line, policyFor(args.policies, line.category, line.expenseDate, args.grade),
      { registeredStateCodes: args.registeredStateCodes }));

  const byCategory = new Map<ExpenseCategory, number>();
  args.lines.forEach((line, i) => {
    byCategory.set(line.category, round2((byCategory.get(line.category) ?? 0) + evaluations[i].allowedAmount));
  });

  const exceptions = evaluations.flatMap(e => e.exceptions);
  for (const [category, allowed] of byCategory) {
    const first = args.lines.find(l => l.category === category)!;
    const policy = policyFor(args.policies, category, first.expenseDate, args.grade);
    const cap = policy?.perClaimLimit ?? null;
    if (cap !== null && allowed > cap) {
      const trimmed = round2(allowed - cap);
      exceptions.push(`${category} totals ${allowed} against a per-claim limit of ${cap}`);
      // Trim proportionally from the category's lines so the claim total and
      // the line totals cannot disagree.
      let remaining = trimmed;
      args.lines.forEach((line, i) => {
        if (line.category !== category || remaining <= 0) return;
        const take = Math.min(evaluations[i].allowedAmount, remaining);
        evaluations[i].allowedAmount = round2(evaluations[i].allowedAmount - take);
        evaluations[i].excessAmount = round2(evaluations[i].excessAmount + take);
        evaluations[i].policyException = true;
        remaining = round2(remaining - take);
      });
    }
  }

  const sum = (pick: (i: number) => number) =>
    round2(args.lines.reduce((t, _l, i) => t + pick(i), 0));

  return {
    totalClaimed: sum(i => args.lines[i].amount),
    totalAllowed: sum(i => evaluations[i].allowedAmount),
    totalExcess: sum(i => evaluations[i].excessAmount),
    creditableGst: sum(i => evaluations[i].credit.creditable ? (args.lines[i].gstAmount ?? 0) : 0),
    blockedGst: sum(i => evaluations[i].credit.creditable ? 0 : (args.lines[i].gstAmount ?? 0)),
    // Blocked GST is a real cost to the project; creditable GST is not, because
    // it comes back. Charging the project the full gross is the commonest way
    // site profitability is quietly understated.
    billableToProject: sum(i => args.lines[i].billableToClient
      ? evaluations[i].allowedAmount - (evaluations[i].credit.creditable ? (args.lines[i].gstAmount ?? 0) : 0)
      : 0),
    lines: evaluations,
    exceptions,
    requiresOverride: exceptions.length > 0,
  };
}

/* ------------------------------------------------------ duplicate control */

/**
 * A stable identity for a bill, or null when the line does not carry one.
 *
 * Only a line that names its supplier *and* its invoice number can be matched
 * with confidence. Fingerprinting a bare amount and date would refuse the
 * second genuine refuelling of the day, which trains people to work around the
 * control rather than with it.
 */
export function receiptFingerprint(line: {
  vendorGstin?: string | null;
  vendorName?: string | null;
  invoiceNo?: string | null;
  amount: number;
}): string | null {
  const invoice = (line.invoiceNo ?? '').trim().toUpperCase();
  if (!invoice) return null;
  const supplier = (line.vendorGstin ?? line.vendorName ?? '').trim().toUpperCase();
  if (!supplier) return null;
  return `${supplier}|${invoice}|${round2(line.amount).toFixed(2)}`;
}

/**
 * A weaker signal: the same person, category, date and amount.
 *
 * This one only ever warns. Two identical auto fares on one day is ordinary,
 * and a control that blocks it would be wrong more often than right.
 */
export function softDuplicateKey(line: {
  employeeId: string; category: ExpenseCategory; expenseDate: string; amount: number;
}): string {
  return `${line.employeeId}|${line.category}|${line.expenseDate}|${round2(line.amount).toFixed(2)}`;
}

/* ------------------------------------------------------------ maker-checker */

export interface ClaimApprovalCheck {
  approverUserId: string;
  /** Who raised the claim — an admin may key it in for someone else. */
  requestedByUserId: string;
  /** Whose expense it is. Not necessarily the same person. */
  claimantUserId: string | null;
}

/**
 * Maker-checker for an expense claim.
 *
 * The specification says an approver cannot approve their own claim, which the
 * approval engine already enforces against the *raiser*. That is not enough
 * here: when a site clerk keys in a manager's expenses, the manager is the
 * claimant but not the raiser, and the generic check would happily let them
 * approve their own spend. Both identities have to be excluded.
 */
export function canApproveClaim(check: ClaimApprovalCheck): { allowed: boolean; reason?: string } {
  if (check.approverUserId === check.requestedByUserId) {
    return { allowed: false, reason: 'You cannot approve a claim you raised' };
  }
  if (check.claimantUserId && check.approverUserId === check.claimantUserId) {
    return { allowed: false, reason: 'You cannot approve your own expenses, even when someone else keyed them in' };
  }
  return { allowed: true };
}

/* ---------------------------------------------------------- reimbursement */

// Payment instruments are shared with the finance module: a reimbursement and
// a client receipt move money the same ways, and two lists drift.
export { PAYMENT_MODES, type PaymentMode } from './financial-control.js';

/**
 * How much of an approved claim is still owed to the employee.
 *
 * Reimbursement is deliberately allowed to arrive in parts — a disputed line
 * settled later should not force finance to cancel and re-raise the claim.
 */
export function reimbursementPosition(approvedAmount: number, payments: { amount: number }[]): {
  paid: number; outstanding: number; settled: boolean;
} {
  const paid = round2(payments.reduce((t, p) => t + p.amount, 0));
  const outstanding = round2(approvedAmount - paid);
  return { paid, outstanding, settled: outstanding <= 0 };
}

/* ------------------------------------------------------------- permissions */

export const EXPENSE_PERMISSIONS = [
  'expense.read',
  // Everything the claimant needs: raise, edit a draft, submit, withdraw.
  'expense.manage',
  // Sees every claim in the organisation, not only their own.
  'expense.read_all',
  'expense.policy.read', 'expense.policy.manage',
  // Records the payment that settles an approved claim.
  'expense.reimburse',
  // Approves a claim that breaches policy, recording why. Held narrowly: an
  // override with no separate permission is not an override at all.
  'expense.override',
] as const;

export const EXPENSE_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...EXPENSE_PERMISSIONS],
  ADMIN: [...EXPENSE_PERMISSIONS],
  // Every employee raises expenses — this is the one module where the base
  // role is a first-class participant rather than a reader.
  EMPLOYEE: ['expense.read', 'expense.manage'],
  TEAM_LEAD: ['expense.read', 'expense.manage', 'expense.policy.read'],
  PROJECT_MANAGER: ['expense.read', 'expense.manage', 'expense.read_all', 'expense.policy.read'],
  // Settles claims and maintains the policy, but does not hold the override:
  // paying an over-limit claim and authorising it are two different acts.
  PAYROLL_OFFICER: ['expense.read', 'expense.manage', 'expense.read_all',
    'expense.policy.read', 'expense.policy.manage', 'expense.reimburse'],
  HR_MANAGER: ['expense.read', 'expense.manage', 'expense.read_all', 'expense.policy.read'],
  AUDITOR: ['expense.read_all', 'expense.policy.read'],
  INVENTORY_MANAGER: ['expense.read', 'expense.manage'],
  SALES_BD_EXECUTIVE: ['expense.read', 'expense.manage'],
  BID_TENDER_MANAGER: ['expense.read', 'expense.manage'],
  GOVT_OBSERVER: [],
  CLIENT_VIEWER: [],
};

/* ----------------------------------------------------------------- schemas */

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const money = z.coerce.number().finite().min(0);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const expensePolicySchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  effective_from: dateString,
  effective_to: dateString.nullable().optional(),
  per_line_limit: money.nullable().optional(),
  per_claim_limit: money.nullable().optional(),
  unit_rate: money.nullable().optional(),
  requires_receipt_above: money.nullable().optional(),
  applies_to_grade: z.string().trim().max(50).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
}).superRefine((value, ctx) => {
  if (value.effective_to && value.effective_to < value.effective_from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effective_to'], message: 'Ends before it starts' });
  }
  if (isEntitlement(value.category) && !value.unit_rate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['unit_rate'],
      message: 'A per-diem policy needs a rate per day — a cap alone cannot value the claim',
    });
  }
});

export const expenseLineSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  expense_date: dateString,
  description: text.max(500),
  amount: money,
  units: z.coerce.number().min(0).max(366).nullable().optional(),
  currency: z.string().trim().length(3).default('INR'),
  receipt_document_id: uuid.nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  vendor_gstin: z.string().trim().max(15).nullable().optional(),
  invoice_no: z.string().trim().max(50).nullable().optional(),
  gst_amount: money.nullable().optional(),
  supply_state_code: z.string().trim().max(2).nullable().optional(),
  billable_to_client: z.boolean().default(false),
  project_id: uuid.nullable().optional(),
  cost_head_id: uuid.nullable().optional(),
});

export const expenseClaimSchema = z.object({
  claim_no: text.max(50),
  /** Whose expense it is; omitted means the caller is claiming for themselves. */
  employee_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  cost_head_id: uuid.nullable().optional(),
  claim_date: dateString,
  purpose: text.max(1000),
  lines: z.array(expenseLineSchema).min(1, 'A claim needs at least one line'),
}).superRefine((value, ctx) => {
  value.lines.forEach((line, i) => {
    if (line.billable_to_client && !(line.project_id ?? value.project_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['lines', i, 'billable_to_client'],
        message: 'A billable line has to say which project bears the cost',
      });
    }
  });
});

export const claimDecisionSchema = z.object({
  status: z.enum(EXPENSE_CLAIM_STATUSES),
  reason: z.string().trim().max(1000).optional(),
  /** Required when approving a claim that breaches policy. */
  override_reason: z.string().trim().max(1000).optional(),
});

export const reimbursementSchema = z.object({
  amount: money.refine(v => v > 0, 'A reimbursement has to be for something'),
  paid_on: dateString,
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/* -------------------------------------------------------- receipt uploads */

/**
 * POST /api/v1/expense-claims/:id/receipts (B-003).
 *
 * Same base64-body shape as the S1 employee-document and S4 task-evidence
 * uploads: a local runtime cannot hand the API a multipart stream and a
 * signed URL both, so every upload in this codebase goes over JSON.
 */
export const expenseReceiptUploadSchema = z.object({
  file_name: z.string().min(1, 'file_name is required').max(255),
  content_base64: z.string().min(1, 'content_base64 is required'),
});

export type ExpenseReceiptUploadInput = z.infer<typeof expenseReceiptUploadSchema>;

/** image/jpeg, image/png, application/pdf — matched on file extension. */
export const ALLOWED_RECEIPT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'] as const;

/** A receipt caps at 10 MiB of decoded binary. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** At most five receipts on one claim. */
export const MAX_RECEIPTS_PER_CLAIM = 5;
