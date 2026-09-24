import { describe, expect, it } from 'vitest';
import {
  requisitionSchema, purchaseOrderSchema, grnSchema, rfqSchema,
} from '../lib/validation';

/**
 * Task 5a / B-005 — procurement had no web creation forms at all for
 * requisitions, purchase orders, GRNs or RFQs even though the API routes
 * exist. These schemas are the client-side gate in front of those routes;
 * every field here must be one the route's own zod schema
 * (packages/shared/src/procurement.ts) actually accepts, or a value typed
 * into the form is silently dropped on the way to the server.
 */

const validRequisition = {
  requisition_no: 'REQ-1001',
  project_id: '11111111-1111-1111-1111-111111111111',
  required_by: '2026-10-01',
  justification: 'Cement for the retaining wall',
  lines: [
    { description: 'OPC 53 cement', unit: 'bag', quantity: 100, estimated_rate: '350.50' },
  ],
};

describe('requisitionSchema (B-005)', () => {
  it('accepts a valid requisition and coerces numeric fields', () => {
    const result = requisitionSchema.safeParse(validRequisition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lines[0].quantity).toBe(100);
      expect(result.data.lines[0].estimated_rate).toBe(350.5);
    }
  });

  it('accepts a requisition with no project and no estimated rate (both optional)', () => {
    const result = requisitionSchema.safeParse({
      requisition_no: 'REQ-1002',
      justification: 'Site consumables',
      lines: [{ description: 'Gloves', unit: 'pair', quantity: 20 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a blank requisition number', () => {
    const result = requisitionSchema.safeParse({ ...validRequisition, requisition_no: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a blank justification', () => {
    const result = requisitionSchema.safeParse({ ...validRequisition, justification: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty line list', () => {
    const result = requisitionSchema.safeParse({ ...validRequisition, lines: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a negative estimated rate', () => {
    const result = requisitionSchema.safeParse({
      ...validRequisition,
      lines: [{ ...validRequisition.lines[0], estimated_rate: '-10' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an estimated rate with more than 2 decimal places', () => {
    const result = requisitionSchema.safeParse({
      ...validRequisition,
      lines: [{ ...validRequisition.lines[0], estimated_rate: '10.555' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative quantity', () => {
    const result = requisitionSchema.safeParse({
      ...validRequisition,
      lines: [{ ...validRequisition.lines[0], quantity: 0 }],
    });
    expect(result.success).toBe(false);
  });
});

const validPo = {
  po_number: 'PO-2001',
  vendor_id: '22222222-2222-2222-2222-222222222222',
  po_date: '2026-09-24',
  lines: [
    {
      description: 'TMT bars 12mm', unit: 'kg', quantity: 500,
      unit_rate: '62.75', gst_rate_pct: 18,
    },
  ],
};

describe('purchaseOrderSchema (B-005)', () => {
  it('accepts a valid order with the full field set the API schema takes', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validPo,
      requisition_id: '11111111-1111-1111-1111-111111111111',
      project_id: '11111111-1111-1111-1111-111111111111',
      delivery_date: '2026-10-05',
      payment_terms: 'Net 30',
      delivery_address: 'Site office, Mandal road',
      place_of_supply: '36',
      scope_override_reason: 'Urgent site requirement beyond the requisition',
      lines: [{ ...validPo.lines[0], hsn_sac: '7214', requisition_line_id: '33333333-3333-3333-3333-333333333333', remarks: 'Grade Fe500' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing vendor', () => {
    const result = purchaseOrderSchema.safeParse({ ...validPo, vendor_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a place of supply that is not a two-digit code', () => {
    const result = purchaseOrderSchema.safeParse({ ...validPo, place_of_supply: 'MH' });
    expect(result.success).toBe(false);
  });

  it('rejects a GST rate outside 0..28', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validPo,
      lines: [{ ...validPo.lines[0], gst_rate_pct: 40 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative unit rate', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validPo,
      lines: [{ ...validPo.lines[0], unit_rate: '-1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a unit rate with more than 2 decimal places', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validPo,
      lines: [{ ...validPo.lines[0], unit_rate: '62.755' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an HSN/SAC that is not 4-8 digits', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validPo,
      lines: [{ ...validPo.lines[0], hsn_sac: 'AB12' }],
    });
    expect(result.success).toBe(false);
  });
});

const validGrn = {
  grn_no: 'GRN-3001',
  purchase_order_id: '22222222-2222-2222-2222-222222222222',
  received_date: '2026-09-24',
  lines: [
    { po_line_id: '44444444-4444-4444-4444-444444444444', received_quantity: 100, accepted_quantity: 100 },
  ],
};

describe('grnSchema (B-005)', () => {
  it('accepts a fully-accepted receipt', () => {
    expect(grnSchema.safeParse(validGrn).success).toBe(true);
  });

  it('accepts a partial rejection when a reason is given', () => {
    const result = grnSchema.safeParse({
      ...validGrn,
      lines: [{
        po_line_id: validGrn.lines[0].po_line_id,
        received_quantity: 100, accepted_quantity: 90, rejection_reason: 'Damaged in transit',
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a partial rejection with no reason', () => {
    const result = grnSchema.safeParse({
      ...validGrn,
      lines: [{ po_line_id: validGrn.lines[0].po_line_id, received_quantity: 100, accepted_quantity: 90 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects accepting more than was received', () => {
    const result = grnSchema.safeParse({
      ...validGrn,
      lines: [{ po_line_id: validGrn.lines[0].po_line_id, received_quantity: 10, accepted_quantity: 20 }],
    });
    expect(result.success).toBe(false);
  });

  it('carries an optional over_receipt_reason alongside the schema fields', () => {
    const result = grnSchema.safeParse({ ...validGrn, over_receipt_reason: 'Vendor over-delivered a full pallet' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.over_receipt_reason).toBe('Vendor over-delivered a full pallet');
  });

  it('rejects a missing purchase order', () => {
    const result = grnSchema.safeParse({ ...validGrn, purchase_order_id: '' });
    expect(result.success).toBe(false);
  });
});

const validRfq = {
  rfq_no: 'RFQ-4001',
  due_date: '2026-10-10',
  vendor_ids: [
    '22222222-2222-2222-2222-222222222222',
    '55555555-5555-5555-5555-555555555555',
  ],
  lines: [{ description: 'Shuttering plywood 12mm', unit: 'sheet', quantity: 200 }],
};

describe('rfqSchema (B-005)', () => {
  it('accepts a valid RFQ inviting two or more vendors', () => {
    expect(rfqSchema.safeParse(validRfq).success).toBe(true);
  });

  it('rejects fewer than two invited vendors', () => {
    const result = rfqSchema.safeParse({ ...validRfq, vendor_ids: [validRfq.vendor_ids[0]] });
    expect(result.success).toBe(false);
  });

  it('rejects a blank RFQ number', () => {
    const result = rfqSchema.safeParse({ ...validRfq, rfq_no: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty line list', () => {
    const result = rfqSchema.safeParse({ ...validRfq, lines: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a zero quantity line', () => {
    const result = rfqSchema.safeParse({ ...validRfq, lines: [{ ...validRfq.lines[0], quantity: 0 }] });
    expect(result.success).toBe(false);
  });
});
