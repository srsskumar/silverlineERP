import { z } from 'zod';
import { dateStringSchema } from './s1.js';
import type { RoleCode } from './rbac.js';

/**
 * Procurement: requisition → order → receipt → invoice (§6.6, §13.2, §43).
 *
 * The chain exists to answer one question before money leaves: did we order
 * this, did it arrive, and does the bill match? That is the three-way match,
 * and every structure here serves it.
 *
 * Quantities are cumulative in the same way running-account bills are. A
 * purchase order is received across several GRNs, so "how much is still to
 * come" is derived from the sum of receipts rather than stored on the order —
 * storing it invites two writers to disagree about the same number.
 */

/* ------------------------------------------------------------ quantities */

const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ReceiptPosition {
  orderedQuantity: number;
  /** Sum of accepted quantity across every GRN raised so far. */
  receivedQuantity: number;
  rejectedQuantity: number;
}

export interface ReceiptStatus extends ReceiptPosition {
  pendingQuantity: number;
  overReceivedQuantity: number;
  status: 'AWAITED' | 'PARTIAL' | 'COMPLETE' | 'OVER_RECEIVED';
}

/**
 * Where a line stands against its order.
 *
 * Over-receipt is reported rather than refused: the material is physically on
 * site and pretending otherwise makes the stock ledger wrong. Whether to accept
 * the excess is a commercial decision, and the caller gates on it.
 */
export function receiptStatus(position: ReceiptPosition, tolerancePct = 0): ReceiptStatus {
  const { orderedQuantity, receivedQuantity, rejectedQuantity } = position;
  const allowed = orderedQuantity * (1 + tolerancePct / 100);
  const pending = round3(Math.max(0, orderedQuantity - receivedQuantity));
  const over = round3(Math.max(0, receivedQuantity - allowed));
  return {
    ...position,
    pendingQuantity: pending,
    overReceivedQuantity: over,
    status:
      over > 0 ? 'OVER_RECEIVED'
      : receivedQuantity === 0 ? 'AWAITED'
      : receivedQuantity >= orderedQuantity ? 'COMPLETE'
      : 'PARTIAL',
  };
}

/* ---------------------------------------------------------- 3-way match */

export interface MatchLine {
  reference: string;
  orderedQuantity: number;
  orderedRate: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  invoicedRate: number;
}

export interface MatchTolerance {
  /** Percent the invoiced quantity may exceed what was received. */
  quantityPct?: number;
  /** Percent the invoiced rate may exceed the ordered rate. */
  ratePct?: number;
  /** Absolute rupee variance tolerated on the line value. */
  valueAbsolute?: number;
}

export type MatchExceptionCode =
  | 'QUANTITY_EXCEEDS_RECEIPT'
  | 'RATE_EXCEEDS_ORDER'
  | 'VALUE_VARIANCE'
  | 'NOTHING_RECEIVED';

export interface MatchException {
  reference: string;
  code: MatchExceptionCode;
  message: string;
  ordered: number;
  received: number;
  invoiced: number;
}

export interface MatchResult {
  matched: boolean;
  exceptions: MatchException[];
  orderedValue: number;
  receivedValue: number;
  invoicedValue: number;
}

/**
 * Match invoice against order and receipt.
 *
 * Two independent checks, because they fail for different reasons and a single
 * value comparison hides both: billing for more than arrived is a quantity
 * problem, and billing at a higher rate than agreed is a price problem. A
 * combined check can net them off and pass an invoice that is wrong twice.
 *
 * The receipt, not the order, bounds the quantity. Ordering a hundred and
 * being billed for a hundred is irrelevant if only sixty arrived.
 */
export function threeWayMatch(lines: MatchLine[], tolerance: MatchTolerance = {}): MatchResult {
  const exceptions: MatchException[] = [];
  const qtyTolerance = tolerance.quantityPct ?? 0;
  const rateTolerance = tolerance.ratePct ?? 0;
  const valueTolerance = tolerance.valueAbsolute ?? 0;

  for (const line of lines) {
    if (line.invoicedQuantity > 0 && line.receivedQuantity === 0) {
      exceptions.push({
        reference: line.reference, code: 'NOTHING_RECEIVED',
        message: `${line.reference}: invoiced for ${line.invoicedQuantity} but nothing has been received`,
        ordered: line.orderedQuantity, received: 0, invoiced: line.invoicedQuantity,
      });
      continue;
    }

    const allowedQty = line.receivedQuantity * (1 + qtyTolerance / 100);
    if (line.invoicedQuantity > allowedQty) {
      exceptions.push({
        reference: line.reference, code: 'QUANTITY_EXCEEDS_RECEIPT',
        message: `${line.reference}: invoiced ${line.invoicedQuantity} against ${line.receivedQuantity} received`,
        ordered: line.orderedQuantity, received: line.receivedQuantity, invoiced: line.invoicedQuantity,
      });
    }

    const allowedRate = line.orderedRate * (1 + rateTolerance / 100);
    if (line.invoicedRate > allowedRate) {
      exceptions.push({
        reference: line.reference, code: 'RATE_EXCEEDS_ORDER',
        message: `${line.reference}: invoiced at ${line.invoicedRate} against an ordered rate of ${line.orderedRate}`,
        ordered: line.orderedRate, received: line.receivedQuantity, invoiced: line.invoicedRate,
      });
    }

    // A value check on top catches the case where quantity and rate each sit
    // inside tolerance but together move the line more than intended.
    if (valueTolerance > 0) {
      const expected = line.receivedQuantity * line.orderedRate;
      const invoiced = line.invoicedQuantity * line.invoicedRate;
      if (invoiced - expected > valueTolerance) {
        exceptions.push({
          reference: line.reference, code: 'VALUE_VARIANCE',
          message: `${line.reference}: invoice value exceeds the received value by more than the tolerance`,
          ordered: round2(expected), received: line.receivedQuantity, invoiced: round2(invoiced),
        });
      }
    }
  }

  const sum = (pick: (l: MatchLine) => number) => round2(lines.reduce((t, l) => t + pick(l), 0));
  return {
    matched: exceptions.length === 0,
    exceptions,
    orderedValue: sum(l => l.orderedQuantity * l.orderedRate),
    receivedValue: sum(l => l.receivedQuantity * l.orderedRate),
    invoicedValue: sum(l => l.invoicedQuantity * l.invoicedRate),
  };
}

/**
 * Whether a purchase order stays inside the requisition that authorised it.
 *
 * §6.6: a PO cannot exceed requisition scope without an authorised override.
 * Checked per line as well as in total, because a PO that swaps quantity
 * between two lines can hold the total while ordering something nobody asked
 * for.
 */
export function withinRequisition(
  requisition: { reference: string; quantity: number }[],
  order: { reference: string; quantity: number }[],
): { within: boolean; problems: string[] } {
  const asked = new Map(requisition.map(r => [r.reference, r.quantity]));
  const problems: string[] = [];
  for (const line of order) {
    const approved = asked.get(line.reference);
    if (approved === undefined) {
      problems.push(`${line.reference} is not on the requisition`);
      continue;
    }
    if (line.quantity > approved) {
      problems.push(`${line.reference}: ordering ${line.quantity} against ${approved} requisitioned`);
    }
  }
  return { within: problems.length === 0, problems };
}

/* ------------------------------------------------------------ lifecycles */

export const PR_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED'] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_TRANSITIONS: Record<PrStatus, PrStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  // CONVERTED is reached only by raising a PO, never by a status edit — a
  // requisition marked converted with no order behind it loses the lineage.
  APPROVED: ['CANCELLED'],
  REJECTED: ['DRAFT'],
  CONVERTED: [],
  CANCELLED: [],
};

export const PO_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT',
  'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  SENT: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'],
  // Short-closed: the balance will never arrive and the order is settled for
  // what did. Common, and without it a part-delivered order stays open forever.
  FULLY_RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

/* ---------------------------------------------------------------- schemas */

const text = z.string().trim().min(1).max(255);
const uuid = z.string().uuid();
const qty = z.coerce.number().positive();
const money = z.coerce.number().nonnegative();

export const requisitionSchema = z.object({
  requisition_no: text.max(50),
  project_id: uuid.nullable().optional(),
  required_by: dateStringSchema.optional(),
  justification: z.string().trim().min(1).max(2000),
  lines: z.array(z.object({
    item_id: uuid.nullable().optional(),
    description: text,
    unit: z.string().trim().min(1).max(20),
    quantity: qty,
    estimated_rate: money.optional(),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'A requisition needs at least one line'),
});

export const purchaseOrderSchema = z.object({
  po_number: text.max(50),
  vendor_id: uuid,
  requisition_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  po_date: dateStringSchema,
  delivery_date: dateStringSchema.optional(),
  payment_terms: z.string().trim().max(200).optional(),
  delivery_address: z.string().trim().max(1000).optional(),
  place_of_supply: z.string().regex(/^[0-9]{2}$/, 'Place of supply is a two-digit state code').optional(),
  /** Set with a reason when the order deliberately exceeds the requisition. */
  scope_override_reason: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    item_id: uuid.nullable().optional(),
    requisition_line_id: uuid.nullable().optional(),
    description: text,
    hsn_sac: z.string().regex(/^[0-9]{4,8}$/, 'HSN/SAC is 4 to 8 digits').optional(),
    unit: z.string().trim().min(1).max(20),
    quantity: qty,
    unit_rate: money,
    gst_rate_pct: z.coerce.number().min(0).max(28).default(0),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'An order needs at least one line'),
});

export const grnSchema = z.object({
  grn_no: text.max(50),
  purchase_order_id: uuid,
  received_date: dateStringSchema,
  challan_no: z.string().trim().max(50).optional(),
  vehicle_no: z.string().trim().max(20).optional(),
  lines: z.array(z.object({
    po_line_id: uuid,
    received_quantity: z.coerce.number().min(0),
    accepted_quantity: z.coerce.number().min(0),
    rejection_reason: z.string().trim().max(500).optional(),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'A receipt needs at least one line'),
}).superRefine((value, ctx) => {
  value.lines.forEach((line, index) => {
    if (line.accepted_quantity > line.received_quantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'More cannot be accepted than was received',
        path: ['lines', index, 'accepted_quantity'],
      });
    }
    // A rejection with no stated reason is the one the vendor disputes.
    if (line.received_quantity > line.accepted_quantity && !line.rejection_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Say why the balance was rejected',
        path: ['lines', index, 'rejection_reason'],
      });
    }
  });
});

export const PROCUREMENT_PERMISSIONS = [
  'requisition.read', 'requisition.manage',
  'po.read', 'po.manage', 'po.amend',
  'grn.read', 'grn.manage',
  'match.read', 'match.override',
  // §43 enhancements.
  'rfq.read', 'rfq.manage',
  'return.read', 'return.manage',
] as const;

export const PROCUREMENT_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...PROCUREMENT_PERMISSIONS],
  // The match override releases a payment against a mismatched invoice, so
  // §4.1 keeps it away from the role that raises the orders.
  ADMIN: PROCUREMENT_PERMISSIONS.filter(p => p !== 'match.override'),
  // Raises requisitions for their site and receives material; does not cut
  // purchase orders, which is the procurement function.
  PROJECT_MANAGER: ['requisition.read', 'requisition.manage', 'po.read', 'grn.read', 'grn.manage',
    'match.read', 'rfq.read', 'return.read', 'return.manage'],
  TEAM_LEAD: ['requisition.read', 'requisition.manage', 'po.read', 'grn.read', 'rfq.read', 'return.read'],
  INVENTORY_MANAGER: ['requisition.read', 'po.read', 'grn.read', 'grn.manage', 'match.read',
    'rfq.read', 'return.read', 'return.manage'],
  AUDITOR: ['requisition.read', 'po.read', 'grn.read', 'match.read', 'rfq.read', 'return.read'],
  BID_TENDER_MANAGER: ['requisition.read', 'po.read', 'rfq.read'],
  EMPLOYEE: [],
  SALES_BD_EXECUTIVE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  CLIENT_VIEWER: [],
};

/* ---------------------------------------------------- RFQ comparison (§43.1) */

export interface QuoteLine {
  reference: string;
  quantity: number;
  unitRate: number;
  discountPct?: number;
  gstRatePct?: number;
}

export interface VendorQuote {
  vendorId: string;
  vendorName: string;
  lines: QuoteLine[];
  /** Charged once on the quote, not per line. */
  freight?: number;
  otherCharges?: number;
  /**
   * Whether the GST on this quote can be claimed as input credit.
   *
   * False for an unregistered or composition supplier, and it changes the
   * answer: their tax is a real cost, while a registered supplier's is
   * recovered. Comparing everyone gross, or everyone net, picks the wrong
   * vendor in one direction or the other.
   */
  gstCreditable?: boolean;
  deliveryDays?: number;
  /** Cleared the technical evaluation. An unqualified quote cannot be L1. */
  technicallyQualified?: boolean;
  paymentTerms?: string;
}

export interface QuoteEvaluation {
  vendorId: string;
  vendorName: string;
  basicValue: number;
  discount: number;
  taxableValue: number;
  taxAmount: number;
  /** Tax that cannot be recovered, and is therefore part of the cost. */
  irrecoverableTax: number;
  freight: number;
  otherCharges: number;
  /** What the purchase actually costs us. The number to rank on. */
  landedCost: number;
  technicallyQualified: boolean;
  deliveryDays: number | null;
  rank: number | null;
}

/**
 * Compare quotes and rank them (§43.1).
 *
 * Ranked on landed cost, not unit rate. A vendor quoting 400 a bag with 5,000
 * freight on 100 bags costs 450 a bag delivered and loses to one quoting 420
 * carriage paid — comparing unit rates picks the wrong vendor and the
 * difference is real money.
 *
 * Recoverable GST is excluded from the cost because it comes back; tax from an
 * unregistered or composition supplier is included because it does not. That
 * single distinction regularly reverses a ranking in Indian procurement.
 *
 * Technically unqualified quotes are evaluated and shown — the comparison
 * sheet has to say what they offered — but never ranked, so L1 is always a
 * vendor who could actually do the work.
 */
export function compareQuotes(quotes: VendorQuote[]): QuoteEvaluation[] {
  const evaluated = quotes.map<QuoteEvaluation>(quote => {
    let basic = 0, discount = 0, tax = 0;
    for (const line of quote.lines) {
      const gross = line.quantity * line.unitRate;
      const off = gross * ((line.discountPct ?? 0) / 100);
      basic += gross;
      discount += off;
      tax += (gross - off) * ((line.gstRatePct ?? 0) / 100);
    }
    const taxableValue = round2(basic - discount);
    const taxAmount = round2(tax);
    // Default true: most suppliers are registered, and assuming otherwise
    // would silently inflate every comparison.
    const creditable = quote.gstCreditable ?? true;
    const irrecoverableTax = creditable ? 0 : taxAmount;
    const freight = quote.freight ?? 0;
    const otherCharges = quote.otherCharges ?? 0;
    return {
      vendorId: quote.vendorId,
      vendorName: quote.vendorName,
      basicValue: round2(basic),
      discount: round2(discount),
      taxableValue,
      taxAmount,
      irrecoverableTax,
      freight: round2(freight),
      otherCharges: round2(otherCharges),
      landedCost: round2(taxableValue + irrecoverableTax + freight + otherCharges),
      technicallyQualified: quote.technicallyQualified ?? true,
      deliveryDays: quote.deliveryDays ?? null,
      rank: null,
    };
  });

  const ranked = evaluated
    .filter(e => e.technicallyQualified)
    .sort((a, b) =>
      a.landedCost - b.landedCost ||
      // A genuine tie on price is broken by who can deliver sooner.
      (a.deliveryDays ?? Number.MAX_SAFE_INTEGER) - (b.deliveryDays ?? Number.MAX_SAFE_INTEGER) ||
      a.vendorName.localeCompare(b.vendorName));
  ranked.forEach((entry, index) => { entry.rank = index + 1; });

  // Preserve the submitted order so the sheet reads as it was received.
  return evaluated;
}

/** The recommended vendor: L1 among the technically qualified. */
export function lowestQuote(evaluations: QuoteEvaluation[]): QuoteEvaluation | null {
  return evaluations.find(e => e.rank === 1) ?? null;
}

/* ------------------------------------------------- amendment rules (§43.2) */

export interface AmendmentLine {
  poLineId: string;
  reference: string;
  currentQuantity: number;
  newQuantity: number;
  currentRate: number;
  newRate: number;
  /** Cumulative accepted quantity already received against this line. */
  receivedQuantity: number;
}

export interface AmendmentCheck {
  valid: boolean;
  problems: string[];
  previousTotal: number;
  newTotal: number;
  valueChanged: boolean;
}

/**
 * Whether a proposed amendment is coherent (§43.2).
 *
 * The rule that matters: a line cannot be amended below what has already been
 * received. The material is on site and in stock, and reducing the order under
 * it leaves a receipt with no authority behind it and a payable nobody can
 * reconcile. Rate changes on a line already received are refused for the same
 * reason — the goods were accepted at the agreed price.
 */
export function checkAmendment(lines: AmendmentLine[]): AmendmentCheck {
  const problems: string[] = [];
  let previousTotal = 0, newTotal = 0;

  for (const line of lines) {
    previousTotal += line.currentQuantity * line.currentRate;
    newTotal += line.newQuantity * line.newRate;

    if (line.newQuantity < line.receivedQuantity) {
      problems.push(
        `${line.reference}: cannot reduce to ${line.newQuantity} when ${line.receivedQuantity} has already been received`);
    }
    if (line.newQuantity <= 0) {
      problems.push(`${line.reference}: an amended quantity must be greater than zero — cancel the line instead`);
    }
    if (line.newRate !== line.currentRate && line.receivedQuantity > 0) {
      problems.push(
        `${line.reference}: the rate cannot change once ${line.receivedQuantity} has been received at the agreed price`);
    }
    if (line.newRate < 0) {
      problems.push(`${line.reference}: a rate cannot be negative`);
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    previousTotal: round2(previousTotal),
    newTotal: round2(newTotal),
    valueChanged: round2(previousTotal) !== round2(newTotal),
  };
}

/* ---------------------------------------------------------- returns (§43.3) */

export const RETURN_REASONS = [
  'QUALITY_REJECTION', 'SHORT_SUPPLY', 'EXCESS_SUPPLY',
  'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'OTHER',
] as const;

export const returnSchema = z.object({
  return_no: text.max(50),
  grn_id: uuid,
  return_date: dateStringSchema,
  reason: z.enum(RETURN_REASONS),
  /** Whether the vendor is replacing the goods or crediting the value. */
  resolution: z.enum(['REPLACEMENT', 'CREDIT_NOTE', 'PENDING']).default('PENDING'),
  remarks: z.string().trim().min(1).max(2000),
  lines: z.array(z.object({
    grn_line_id: uuid,
    quantity: z.coerce.number().positive(),
    remarks: z.string().trim().max(500).optional(),
  })).min(1, 'A return needs at least one line'),
});

export const acknowledgementSchema = z.object({
  acknowledged_on: dateStringSchema,
  promised_delivery_date: dateStringSchema.optional(),
  /** Anything the vendor could not accept as ordered. */
  exceptions: z.string().trim().max(2000).optional(),
  reference: z.string().trim().max(100).optional(),
});

export const rfqSchema = z.object({
  rfq_no: text.max(50),
  requisition_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  due_date: dateStringSchema,
  scope: z.string().trim().max(4000).optional(),
  vendor_ids: z.array(uuid).min(2, 'Competitive sourcing needs at least two vendors').max(20),
  lines: z.array(z.object({
    item_id: uuid.nullable().optional(),
    description: text,
    unit: z.string().trim().min(1).max(20),
    quantity: qty,
  })).min(1, 'An RFQ needs at least one line'),
});

export const quoteSchema = z.object({
  vendor_id: uuid,
  quote_no: z.string().trim().max(50).optional(),
  quote_date: dateStringSchema,
  validity_days: z.coerce.number().int().min(1).max(365).optional(),
  freight: money.optional(),
  other_charges: money.optional(),
  delivery_days: z.coerce.number().int().min(0).max(365).optional(),
  payment_terms: z.string().trim().max(200).optional(),
  technically_qualified: z.boolean().default(true),
  gst_creditable: z.boolean().default(true),
  lines: z.array(z.object({
    rfq_line_id: uuid,
    unit_rate: money,
    discount_pct: z.coerce.number().min(0).max(100).default(0),
    gst_rate_pct: z.coerce.number().min(0).max(28).default(0),
    remarks: z.string().trim().max(500).optional(),
  })).min(1),
});
