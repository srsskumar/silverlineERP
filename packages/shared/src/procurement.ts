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
] as const;

export const PROCUREMENT_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...PROCUREMENT_PERMISSIONS],
  // The match override releases a payment against a mismatched invoice, so
  // §4.1 keeps it away from the role that raises the orders.
  ADMIN: PROCUREMENT_PERMISSIONS.filter(p => p !== 'match.override'),
  // Raises requisitions for their site and receives material; does not cut
  // purchase orders, which is the procurement function.
  PROJECT_MANAGER: ['requisition.read', 'requisition.manage', 'po.read', 'grn.read', 'grn.manage', 'match.read'],
  TEAM_LEAD: ['requisition.read', 'requisition.manage', 'po.read', 'grn.read'],
  INVENTORY_MANAGER: ['requisition.read', 'po.read', 'grn.read', 'grn.manage', 'match.read'],
  AUDITOR: ['requisition.read', 'po.read', 'grn.read', 'match.read'],
  BID_TENDER_MANAGER: ['requisition.read', 'po.read'],
  EMPLOYEE: [],
  SALES_BD_EXECUTIVE: [],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  CLIENT_VIEWER: [],
};
