import { describe, expect, it } from 'vitest';
import {
  receiptStatus, threeWayMatch, withinRequisition,
  requisitionSchema, purchaseOrderSchema, grnSchema,
  PR_TRANSITIONS, PO_TRANSITIONS, PROCUREMENT_ROLE_GRANTS,
  type MatchLine,
} from './procurement.js';

const line = (over: Partial<MatchLine> = {}): MatchLine => ({
  reference: 'Cement OPC 53',
  orderedQuantity: 100, orderedRate: 400,
  receivedQuantity: 100, invoicedQuantity: 100, invoicedRate: 400,
  ...over,
});

describe('receipt position', () => {
  it('reports nothing received as awaited', () => {
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 0, rejectedQuantity: 0 });
    expect(s.status).toBe('AWAITED');
    expect(s.pendingQuantity).toBe(100);
  });

  it('tracks a part delivery', () => {
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 60, rejectedQuantity: 0 });
    expect(s.status).toBe('PARTIAL');
    expect(s.pendingQuantity).toBe(40);
  });

  it('closes the line once the order is met', () => {
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 100, rejectedQuantity: 0 });
    expect(s.status).toBe('COMPLETE');
    expect(s.pendingQuantity).toBe(0);
  });

  it('reports an over-receipt rather than hiding it', () => {
    // The material is physically on site. Pretending otherwise makes the stock
    // ledger wrong; whether to accept it is a commercial decision.
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 108, rejectedQuantity: 0 });
    expect(s.status).toBe('OVER_RECEIVED');
    expect(s.overReceivedQuantity).toBe(8);
  });

  it('allows an over-receipt inside tolerance', () => {
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 102, rejectedQuantity: 0 }, 5);
    expect(s.status).toBe('COMPLETE');
    expect(s.overReceivedQuantity).toBe(0);
  });

  it('accumulates across several receipts', () => {
    // A PO is received over several GRNs; the position is the running sum.
    const s = receiptStatus({ orderedQuantity: 100, receivedQuantity: 40 + 35, rejectedQuantity: 5 });
    expect(s.pendingQuantity).toBe(25);
  });
});

describe('three-way match', () => {
  it('passes when order, receipt and invoice agree', () => {
    const result = threeWayMatch([line()]);
    expect(result.matched).toBe(true);
    expect(result.exceptions).toHaveLength(0);
  });

  it('catches an invoice for more than arrived', () => {
    // Ordering a hundred is irrelevant if only sixty arrived — the receipt,
    // not the order, bounds what may be billed.
    const result = threeWayMatch([line({ receivedQuantity: 60, invoicedQuantity: 100 })]);
    expect(result.matched).toBe(false);
    expect(result.exceptions[0].code).toBe('QUANTITY_EXCEEDS_RECEIPT');
  });

  it('allows billing for less than arrived', () => {
    // Part-billing a delivery is ordinary; the balance comes on a later bill.
    expect(threeWayMatch([line({ receivedQuantity: 100, invoicedQuantity: 60 })]).matched).toBe(true);
  });

  it('catches a rate above the order', () => {
    const result = threeWayMatch([line({ invoicedRate: 450 })]);
    expect(result.matched).toBe(false);
    expect(result.exceptions[0].code).toBe('RATE_EXCEEDS_ORDER');
  });

  it('allows a rate below the order', () => {
    expect(threeWayMatch([line({ invoicedRate: 380 })]).matched).toBe(true);
  });

  it('reports quantity and rate separately when both are wrong', () => {
    // A single value comparison nets these off and can pass an invoice that is
    // wrong twice.
    const result = threeWayMatch([line({ receivedQuantity: 60, invoicedQuantity: 100, invoicedRate: 450 })]);
    expect(result.exceptions.map(e => e.code).sort())
      .toEqual(['QUANTITY_EXCEEDS_RECEIPT', 'RATE_EXCEEDS_ORDER']);
  });

  it('refuses an invoice when nothing has arrived', () => {
    const result = threeWayMatch([line({ receivedQuantity: 0, invoicedQuantity: 100 })]);
    expect(result.exceptions[0].code).toBe('NOTHING_RECEIVED');
    // No point also complaining about quantity; the receipt is the problem.
    expect(result.exceptions).toHaveLength(1);
  });

  it('honours a quantity tolerance', () => {
    expect(threeWayMatch([line({ receivedQuantity: 100, invoicedQuantity: 102 })], { quantityPct: 5 }).matched)
      .toBe(true);
    expect(threeWayMatch([line({ receivedQuantity: 100, invoicedQuantity: 110 })], { quantityPct: 5 }).matched)
      .toBe(false);
  });

  it('honours a rate tolerance', () => {
    expect(threeWayMatch([line({ invoicedRate: 408 })], { ratePct: 2 }).matched).toBe(true);
    expect(threeWayMatch([line({ invoicedRate: 420 })], { ratePct: 2 }).matched).toBe(false);
  });

  it('catches a value drift that each tolerance would pass on its own', () => {
    // Quantity +4% and rate +4% both sit inside a 5% tolerance, but together
    // they move the line more than intended.
    const drifted = line({ receivedQuantity: 100, invoicedQuantity: 104, invoicedRate: 416 });
    expect(threeWayMatch([drifted], { quantityPct: 5, ratePct: 5 }).matched).toBe(true);
    const withValue = threeWayMatch([drifted], { quantityPct: 5, ratePct: 5, valueAbsolute: 1000 });
    expect(withValue.matched).toBe(false);
    expect(withValue.exceptions[0].code).toBe('VALUE_VARIANCE');
  });

  it('reports the three values for the exception screen', () => {
    const result = threeWayMatch([line({ receivedQuantity: 60, invoicedQuantity: 60 })]);
    expect(result.orderedValue).toBe(40_000);
    expect(result.receivedValue).toBe(24_000);
    expect(result.invoicedValue).toBe(24_000);
  });

  it('checks every line, not only the first', () => {
    const result = threeWayMatch([
      line({ reference: 'A' }),
      line({ reference: 'B', invoicedRate: 999 }),
      line({ reference: 'C', receivedQuantity: 0, invoicedQuantity: 10 }),
    ]);
    expect(result.exceptions.map(e => e.reference)).toEqual(['B', 'C']);
  });
});

describe('requisition scope', () => {
  const asked = [{ reference: 'A', quantity: 100 }, { reference: 'B', quantity: 50 }];

  it('accepts an order inside what was requisitioned', () => {
    expect(withinRequisition(asked, [{ reference: 'A', quantity: 80 }]).within).toBe(true);
  });

  it('catches ordering more of a line than was asked for', () => {
    const result = withinRequisition(asked, [{ reference: 'A', quantity: 120 }]);
    expect(result.within).toBe(false);
    expect(result.problems[0]).toContain('120');
  });

  it('catches an item nobody requisitioned', () => {
    const result = withinRequisition(asked, [{ reference: 'Z', quantity: 1 }]);
    expect(result.problems[0]).toContain('not on the requisition');
  });

  it('checks per line, not on the total', () => {
    // Swapping quantity between lines holds the total while ordering something
    // nobody asked for in that quantity.
    const result = withinRequisition(asked, [
      { reference: 'A', quantity: 150 },
      { reference: 'B', quantity: 0 },
    ]);
    expect(result.within).toBe(false);
  });
});

describe('lifecycles', () => {
  it('leaves an approved requisition convertible only by raising an order', () => {
    // CONVERTED is absent from every transition list: a requisition marked
    // converted with no order behind it loses the lineage.
    for (const targets of Object.values(PR_TRANSITIONS)) {
      expect(targets).not.toContain('CONVERTED');
    }
  });

  it('closes every terminal state', () => {
    expect(PR_TRANSITIONS.CONVERTED).toEqual([]);
    expect(PR_TRANSITIONS.CANCELLED).toEqual([]);
    expect(PO_TRANSITIONS.CLOSED).toEqual([]);
    expect(PO_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('lets a rejected requisition be reworked', () => {
    expect(PR_TRANSITIONS.REJECTED).toContain('DRAFT');
  });

  it('allows a part-delivered order to be short-closed', () => {
    // Without this a part-delivered order stays open forever waiting for a
    // balance that will never arrive.
    expect(PO_TRANSITIONS.PARTIALLY_RECEIVED).toContain('CLOSED');
  });

  it('never advertises a state that does not exist', () => {
    const known = new Set(Object.keys(PO_TRANSITIONS));
    for (const targets of Object.values(PO_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });
});

describe('schemas', () => {
  const grnBase = {
    grn_no: 'GRN-1', purchase_order_id: '3f1a0c2e-0000-4000-8000-000000000001',
    received_date: '2026-09-15',
  };
  const poLine = { po_line_id: '3f1a0c2e-0000-4000-8000-000000000002' };

  it('refuses a requisition with no lines', () => {
    expect(requisitionSchema.safeParse({
      requisition_no: 'PR-1', justification: 'Site needs it', lines: [],
    }).success).toBe(false);
  });

  it('insists a requisition says why', () => {
    expect(requisitionSchema.safeParse({
      requisition_no: 'PR-1',
      lines: [{ description: 'Cement', unit: 'bag', quantity: 10 }],
    }).success).toBe(false);
  });

  it('refuses accepting more than was received', () => {
    expect(grnSchema.safeParse({
      ...grnBase, lines: [{ ...poLine, received_quantity: 50, accepted_quantity: 60 }],
    }).success).toBe(false);
  });

  it('insists a rejection says why', () => {
    // The unexplained rejection is the one the vendor disputes.
    expect(grnSchema.safeParse({
      ...grnBase, lines: [{ ...poLine, received_quantity: 50, accepted_quantity: 40 }],
    }).success).toBe(false);
    expect(grnSchema.safeParse({
      ...grnBase,
      lines: [{ ...poLine, received_quantity: 50, accepted_quantity: 40, rejection_reason: 'Bags torn, damp' }],
    }).success).toBe(true);
  });

  it('accepts a full clean receipt', () => {
    expect(grnSchema.safeParse({
      ...grnBase, lines: [{ ...poLine, received_quantity: 50, accepted_quantity: 50 }],
    }).success).toBe(true);
  });

  it('validates HSN and place of supply on an order', () => {
    const base = {
      po_number: 'PO-1', vendor_id: '3f1a0c2e-0000-4000-8000-000000000003',
      po_date: '2026-09-15',
      lines: [{ description: 'Cement', unit: 'bag', quantity: 10, unit_rate: 400, hsn_sac: '25232910' }],
    };
    expect(purchaseOrderSchema.safeParse({ ...base, place_of_supply: '27' }).success).toBe(true);
    expect(purchaseOrderSchema.safeParse({ ...base, place_of_supply: 'MH' }).success).toBe(false);
    expect(purchaseOrderSchema.safeParse({
      ...base, lines: [{ ...base.lines[0], hsn_sac: '25' }],
    }).success).toBe(false);
  });
});

describe('role grants', () => {
  it('keeps the match override away from the role that raises orders', () => {
    // §4.1: releasing payment against a mismatched invoice is the control the
    // buyer must not hold.
    expect(PROCUREMENT_ROLE_GRANTS.ADMIN).toContain('po.manage');
    expect(PROCUREMENT_ROLE_GRANTS.ADMIN).not.toContain('match.override');
    const holders = Object.entries(PROCUREMENT_ROLE_GRANTS)
      .filter(([, codes]) => codes.includes('match.override')).map(([r]) => r);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('lets a PM requisition and receive but not cut orders', () => {
    expect(PROCUREMENT_ROLE_GRANTS.PROJECT_MANAGER).toContain('requisition.manage');
    expect(PROCUREMENT_ROLE_GRANTS.PROJECT_MANAGER).toContain('grn.manage');
    expect(PROCUREMENT_ROLE_GRANTS.PROJECT_MANAGER).not.toContain('po.manage');
  });

  it('keeps the Auditor read-only across procurement', () => {
    for (const code of PROCUREMENT_ROLE_GRANTS.AUDITOR) {
      expect(code.endsWith('.read')).toBe(true);
    }
  });
});
