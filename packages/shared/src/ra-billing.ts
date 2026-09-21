import { z } from 'zod';
import { dateStringSchema } from './s1.js';
import type { RoleCode } from './rbac.js';

/**
 * Running-account billing for contract work.
 *
 * Indian EPC and infrastructure contracts are not billed on milestones. Work
 * is measured periodically, and each bill claims the *cumulative* quantity
 * executed to date less everything already billed. That single fact drives the
 * whole model: a bill line stores the running total, not the increment, so a
 * re-measurement corrects the record instead of requiring a credit note, and
 * the increment is always derived.
 *
 * Getting this wrong is expensive in a specific way: if increments are stored
 * and one bill is revised, every later bill silently misstates the contract
 * position and the error is only found at final reconciliation.
 *
 * All money is handled in paise internally. Percentages of a rupee figure
 * produce fractions that float arithmetic accumulates badly across a dozen
 * deduction heads, and a bill that is off by a rupee will be rejected by the
 * client's accounts department.
 */

/**
 * Canonical grants. seed.ts rebuilds role_permissions from these maps on every
 * run, so a grant that exists only in the migration is dropped by the next
 * seed — the same trap the commercial spine hit.
 */
export const BILLING_PERMISSIONS = [
  'boq.read','boq.manage',
  'rabill.read','rabill.manage','rabill.certify',
  'retention.read','retention.release',
] as const;

export const BILLING_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...BILLING_PERMISSIONS],
  ADMIN: [...BILLING_PERMISSIONS],
  // §4.1 segregation of duties: a PM measures and submits the bill but does
  // not certify it. Certifying your own measurement removes the only check on
  // it, and certification is what turns the figure into a receivable.
  PROJECT_MANAGER: ['boq.read','boq.manage','rabill.read','rabill.manage','retention.read'],
  TEAM_LEAD: ['boq.read','rabill.read'],
  AUDITOR: ['boq.read','rabill.read','retention.read'],
  BID_TENDER_MANAGER: ['boq.read','rabill.read'],
  GOVT_OBSERVER: [],
  SALES_BD_EXECUTIVE: [],
  EMPLOYEE: [],
  CLIENT_VIEWER: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: ['boq.read'],
};

const toPaise = (rupees: number): number => Math.round(rupees * 100);
const toRupees = (paise: number): number => Math.round(paise) / 100;

/** Percentage of an amount, in paise, rounded half-up to the paisa. */
function pctOfPaise(amountPaise: number, pct: number): number {
  return Math.round((amountPaise * pct) / 100);
}

/* ------------------------------------------------------------------- BOQ */

export const boqItemSchema = z.object({
  item_code: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(1000),
  unit: z.string().trim().min(1).max(20),
  quantity: z.coerce.number().positive(),
  rate: z.coerce.number().nonnegative(),
  /** Groups items into sub-heads the way a tender BOQ is organised. */
  section: z.string().trim().max(150).optional(),
});

/* --------------------------------------------------------------- bill line */

export interface RaBillLineInput {
  boqQuantity: number;
  rate: number;
  /** Total measured to date, not this period's increment. */
  cumulativeQuantity: number;
  /** Cumulative figure certified on the previous bill; 0 on the first. */
  previousQuantity: number;
}

export interface RaBillLine {
  cumulativeQuantity: number;
  previousQuantity: number;
  /** Derived: what this bill actually claims. Negative on a downward revision. */
  thisQuantity: number;
  rate: number;
  cumulativeAmount: number;
  previousAmount: number;
  thisAmount: number;
  /** Executed beyond the BOQ provision — needs a deviation order to certify. */
  excessQuantity: number;
  isExcess: boolean;
  /** A re-measurement that reduced the running total below the last bill. */
  isDownwardRevision: boolean;
}

export function raBillLine(input: RaBillLineInput): RaBillLine {
  const { boqQuantity, rate, cumulativeQuantity, previousQuantity } = input;
  const ratePaise = toPaise(rate);
  const cumulativeAmountPaise = Math.round(cumulativeQuantity * ratePaise);
  const previousAmountPaise = Math.round(previousQuantity * ratePaise);
  const excess = Math.max(0, cumulativeQuantity - boqQuantity);
  return {
    cumulativeQuantity,
    previousQuantity,
    thisQuantity: round3(cumulativeQuantity - previousQuantity),
    rate,
    cumulativeAmount: toRupees(cumulativeAmountPaise),
    previousAmount: toRupees(previousAmountPaise),
    // Derived from the amounts rather than quantity x rate, so the bill always
    // reconciles to the running total even when a rate carries more decimals
    // than the line amounts do.
    thisAmount: toRupees(cumulativeAmountPaise - previousAmountPaise),
    excessQuantity: round3(excess),
    isExcess: excess > 0,
    isDownwardRevision: cumulativeQuantity < previousQuantity,
  };
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/* ------------------------------------------------------------- deductions */

/**
 * Deduction heads on a running-account bill.
 *
 * Order matters for presentation but not arithmetic: every head below is
 * computed on the gross value of the bill, which is how public-works bills are
 * drawn. A head computed on a net-of-other-deductions base would need its own
 * basis field, which is why `basis` is explicit rather than assumed.
 */
export type DeductionHead =
  | 'RETENTION'
  | 'SECURITY_DEPOSIT'
  | 'LABOUR_CESS'
  | 'TDS_INCOME_TAX'
  | 'TDS_GST'
  | 'MOBILISATION_ADVANCE'
  | 'MATERIAL_ADVANCE'
  | 'LIQUIDATED_DAMAGES'
  | 'PENALTY'
  | 'OTHER';

export interface DeductionPolicy {
  /** Percent withheld against defects, released after the DLP. */
  retentionPct?: number;
  /** Cap beyond which retention stops accruing, as a percent of contract value. */
  retentionCapPctOfContract?: number;
  securityDepositPct?: number;
  /**
   * Building and Other Construction Workers cess. Statutory at 1% of the cost
   * of construction where the contract exceeds the notified threshold.
   */
  labourCessPct?: number;
  /** Income-tax TDS under s.194C: 1% for individuals/HUF, 2% otherwise. */
  tdsIncomeTaxPct?: number;
  /**
   * GST TDS under s.51 CGST Act: 2%, deducted by government and notified
   * deductors on contracts above 2.5 lakh. Not applicable to private clients.
   */
  tdsGstPct?: number;
}

export interface DeductionLine {
  head: DeductionHead;
  label: string;
  basis: 'GROSS' | 'FIXED';
  ratePct: number | null;
  amount: number;
}

export interface AdvanceRecovery {
  head: 'MOBILISATION_ADVANCE' | 'MATERIAL_ADVANCE';
  outstanding: number;
  recoveryPct: number;
  recovered: number;
  remaining: number;
}

/**
 * Recover an advance from a bill.
 *
 * Recovery is a percentage of the gross, capped at what is still outstanding —
 * the final recovery is always the remainder, never a full instalment that
 * would take the balance negative and leave the contractor owing money back.
 */
export function recoverAdvance(
  outstanding: number, grossValue: number, recoveryPct: number,
  head: AdvanceRecovery['head'] = 'MOBILISATION_ADVANCE',
): AdvanceRecovery {
  const outstandingPaise = toPaise(outstanding);
  const instalment = pctOfPaise(toPaise(grossValue), recoveryPct);
  const recovered = Math.min(Math.max(0, outstandingPaise), Math.max(0, instalment));
  return {
    head,
    outstanding,
    recoveryPct,
    recovered: toRupees(recovered),
    remaining: toRupees(outstandingPaise - recovered),
  };
}

export interface RaBillTotals {
  grossValue: number;
  /** Retention actually withheld on this bill after any contract cap. */
  deductions: DeductionLine[];
  totalDeductions: number;
  gstAmount: number;
  netPayable: number;
}

export interface RaBillContext {
  /** Cumulative gross certified on earlier bills, for the retention cap. */
  previouslyBilledGross?: number;
  /** Retention already withheld, for the cap. */
  retentionHeldToDate?: number;
  contractValue?: number;
  gstRatePct?: number;
  advances?: AdvanceRecovery[];
  /** Fixed-amount heads: liquidated damages, penalties, ad-hoc recoveries. */
  fixedDeductions?: { head: DeductionHead; label: string; amount: number }[];
}

const HEAD_LABELS: Record<DeductionHead, string> = {
  RETENTION: 'Retention',
  SECURITY_DEPOSIT: 'Security deposit',
  LABOUR_CESS: 'Labour cess (BOCW)',
  TDS_INCOME_TAX: 'TDS — income tax',
  TDS_GST: 'TDS — GST',
  MOBILISATION_ADVANCE: 'Mobilisation advance recovery',
  MATERIAL_ADVANCE: 'Material advance recovery',
  LIQUIDATED_DAMAGES: 'Liquidated damages',
  PENALTY: 'Penalty',
  OTHER: 'Other recovery',
};

/**
 * Draw up the money side of a running-account bill.
 *
 * GST is charged on the gross value and added, while every deduction is taken
 * from it — that asymmetry is the part people implement backwards. The
 * contractor invoices the full measured value plus tax, and the client
 * withholds retention and statutory deductions from the payment.
 */
export function computeRaBill(
  lines: RaBillLine[], policy: DeductionPolicy, context: RaBillContext = {},
): RaBillTotals {
  const grossPaise = lines.reduce((total, line) => total + toPaise(line.thisAmount), 0);
  const deductions: DeductionLine[] = [];

  const add = (head: DeductionHead, pct: number | undefined, amountPaise: number) => {
    if (amountPaise <= 0) return;
    deductions.push({
      head, label: HEAD_LABELS[head], basis: 'GROSS',
      ratePct: pct ?? null, amount: toRupees(amountPaise),
    });
  };

  // Retention stops once the contract cap is reached; continuing to withhold
  // past it is a recoverable over-deduction the contractor will raise.
  if (policy.retentionPct) {
    let retention = pctOfPaise(grossPaise, policy.retentionPct);
    if (policy.retentionCapPctOfContract && context.contractValue) {
      const cap = pctOfPaise(toPaise(context.contractValue), policy.retentionCapPctOfContract);
      const held = toPaise(context.retentionHeldToDate ?? 0);
      retention = Math.max(0, Math.min(retention, cap - held));
    }
    add('RETENTION', policy.retentionPct, retention);
  }
  if (policy.securityDepositPct) {
    add('SECURITY_DEPOSIT', policy.securityDepositPct, pctOfPaise(grossPaise, policy.securityDepositPct));
  }
  if (policy.labourCessPct) {
    add('LABOUR_CESS', policy.labourCessPct, pctOfPaise(grossPaise, policy.labourCessPct));
  }
  if (policy.tdsIncomeTaxPct) {
    add('TDS_INCOME_TAX', policy.tdsIncomeTaxPct, pctOfPaise(grossPaise, policy.tdsIncomeTaxPct));
  }
  if (policy.tdsGstPct) {
    add('TDS_GST', policy.tdsGstPct, pctOfPaise(grossPaise, policy.tdsGstPct));
  }

  for (const advance of context.advances ?? []) {
    if (advance.recovered > 0) {
      deductions.push({
        head: advance.head, label: HEAD_LABELS[advance.head], basis: 'GROSS',
        ratePct: advance.recoveryPct, amount: advance.recovered,
      });
    }
  }
  for (const fixed of context.fixedDeductions ?? []) {
    if (fixed.amount > 0) {
      deductions.push({
        head: fixed.head, label: fixed.label || HEAD_LABELS[fixed.head],
        basis: 'FIXED', ratePct: null, amount: fixed.amount,
      });
    }
  }

  const totalDeductionsPaise = deductions.reduce((t, d) => t + toPaise(d.amount), 0);
  const gstPaise = context.gstRatePct ? pctOfPaise(grossPaise, context.gstRatePct) : 0;

  return {
    grossValue: toRupees(grossPaise),
    deductions,
    totalDeductions: toRupees(totalDeductionsPaise),
    gstAmount: toRupees(gstPaise),
    netPayable: toRupees(grossPaise + gstPaise - totalDeductionsPaise),
  };
}

/* ------------------------------------------------------------- retention */

/**
 * Whether withheld retention may be released.
 *
 * §6.7 forbids marking retention releasable before the defect liability period
 * ends. Half-release on completion and half after the DLP is the common
 * contract shape, so the decision reports which tranche is due rather than a
 * bare boolean.
 */
export function retentionReleaseStatus(args: {
  heldAmount: number;
  dlpEndDate: string;
  workCompletedAt?: string | null;
  firstTranchePct?: number;
  today?: string;
}): { releasable: number; withheld: number; reason: string } {
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const held = toPaise(args.heldAmount);
  const firstPct = args.firstTranchePct ?? 0;

  if (today >= args.dlpEndDate) {
    return { releasable: toRupees(held), withheld: 0, reason: 'Defect liability period has ended' };
  }
  if (firstPct > 0 && args.workCompletedAt && today >= args.workCompletedAt) {
    const tranche = pctOfPaise(held, firstPct);
    return {
      releasable: toRupees(tranche),
      withheld: toRupees(held - tranche),
      reason: `First tranche due on completion; balance held until ${args.dlpEndDate}`,
    };
  }
  return {
    releasable: 0,
    withheld: toRupees(held),
    reason: `Defect liability period runs to ${args.dlpEndDate}`,
  };
}

/* ---------------------------------------------------------------- schemas */

export const RA_BILL_STATUSES = ['DRAFT', 'SUBMITTED', 'CERTIFIED', 'PAID', 'CANCELLED'] as const;
export type RaBillStatus = (typeof RA_BILL_STATUSES)[number];

/**
 * A bill is measured, then submitted, then certified by the client, then paid.
 * Certification is the point the amount becomes a receivable, so it is the
 * point after which the measurement may no longer be edited.
 */
export const RA_BILL_TRANSITIONS: Record<RaBillStatus, RaBillStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['CERTIFIED', 'DRAFT', 'CANCELLED'],
  CERTIFIED: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export const raBillSchema = z.object({
  project_id: z.string().uuid(),
  bill_type: z.enum(['RA', 'FINAL']).default('RA'),
  period_from: dateStringSchema,
  period_to: dateStringSchema,
  measurement_book_ref: z.string().trim().max(100).optional(),
  remarks: z.string().trim().max(4000).optional(),
  lines: z.array(z.object({
    boq_item_id: z.string().uuid(),
    cumulative_quantity: z.coerce.number().nonnegative(),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'A bill needs at least one measured item'),
  fixed_deductions: z.array(z.object({
    head: z.enum(['LIQUIDATED_DAMAGES', 'PENALTY', 'OTHER']),
    label: z.string().trim().max(150),
    amount: z.coerce.number().positive(),
    reason: z.string().trim().min(1).max(1000),
  })).max(20).default([]),
}).refine(v => v.period_to >= v.period_from, {
  message: 'The period cannot end before it starts',
  path: ['period_to'],
});

/**
 * When a certified bill falls due: the certification day plus the payment
 * terms agreed on the project.
 *
 * No terms, no date. A receivable with no recorded terms is reported as
 * undated rather than given a default, because a guessed due date makes an
 * unknown look current -- and finding what is not current is the whole job
 * of the ageing.
 */
export function receivableDueDate(certifiedOn: string, termsDays: number | null | undefined): string | null {
  if (termsDays === null || termsDays === undefined || !Number.isFinite(termsDays)) return null;
  const at = Date.parse(`${certifiedOn}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return new Date(at + Math.round(termsDays) * 86_400_000).toISOString().slice(0, 10);
}

export const deductionPolicySchema = z.object({
  retention_pct: z.coerce.number().min(0).max(100).optional(),
  retention_cap_pct_of_contract: z.coerce.number().min(0).max(100).optional(),
  security_deposit_pct: z.coerce.number().min(0).max(100).optional(),
  labour_cess_pct: z.coerce.number().min(0).max(10).optional(),
  tds_income_tax_pct: z.coerce.number().min(0).max(30).optional(),
  tds_gst_pct: z.coerce.number().min(0).max(10).optional(),
  gst_rate_pct: z.coerce.number().min(0).max(40).optional(),
  /**
   * Days from certification to payment, as agreed with the client. Null
   * clears it; bills certified without terms stay undated in the ageing.
   */
  payment_terms_days: z.coerce.number().int().min(0).max(365).nullable().optional(),
});

export const raBillDisputeSchema = z.object({
  disputed: z.boolean(),
  reason: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.disputed && !v.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['reason'],
      message: 'Say what the client disputes -- it is what the conversation with them starts from',
    });
  }
});

export const advanceSchema = z.object({
  project_id: z.string().uuid(),
  advance_type: z.enum(['MOBILISATION', 'MATERIAL', 'PLANT']),
  amount: z.coerce.number().positive(),
  paid_on: dateStringSchema,
  /** Percentage of each bill's gross applied against the outstanding balance. */
  recovery_pct: z.coerce.number().min(0.01).max(100),
  bank_guarantee_id: z.string().uuid().nullable().optional(),
  remarks: z.string().trim().max(1000).optional(),
});
