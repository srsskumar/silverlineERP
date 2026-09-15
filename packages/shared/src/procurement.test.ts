import { describe, expect, it } from 'vitest';
import {
  receiptStatus, threeWayMatch, withinRequisition,
  requisitionSchema, purchaseOrderSchema, grnSchema,
  PR_TRANSITIONS, PO_TRANSITIONS, PROCUREMENT_ROLE_GRANTS,
  compareQuotes, lowestQuote, checkAmendment,
  returnSchema, acknowledgementSchema, rfqSchema,
  type MatchLine, type VendorQuote, type AmendmentLine,
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

describe('RFQ comparison (§43.1)', () => {
  const base = (over: Partial<VendorQuote> = {}): VendorQuote => ({
    vendorId: 'v1', vendorName: 'Alpha Traders',
    lines: [{ reference: 'Cement', quantity: 100, unitRate: 400, gstRatePct: 28 }],
    ...over,
  });

  it('ranks on landed cost, not on unit rate', () => {
    // 400 a bag plus 5,000 freight is 450 delivered, and loses to 420 carriage
    // paid. Comparing unit rates picks the wrong vendor and it is real money.
    const result = compareQuotes([
      base({ vendorId: 'cheap-rate', vendorName: 'Cheap Rate', freight: 5_000 }),
      base({
        vendorId: 'carriage-paid', vendorName: 'Carriage Paid',
        lines: [{ reference: 'Cement', quantity: 100, unitRate: 420, gstRatePct: 28 }],
      }),
    ]);
    expect(lowestQuote(result)!.vendorId).toBe('carriage-paid');
    expect(result.find(r => r.vendorId === 'cheap-rate')!.landedCost).toBe(45_000);
    expect(result.find(r => r.vendorId === 'carriage-paid')!.landedCost).toBe(42_000);
  });

  it('excludes recoverable GST from the comparison', () => {
    // It comes back, so it is not a cost.
    const result = compareQuotes([base()]);
    expect(result[0].taxAmount).toBe(11_200);
    expect(result[0].irrecoverableTax).toBe(0);
    expect(result[0].landedCost).toBe(40_000);
  });

  it('counts GST as a cost when it cannot be claimed', () => {
    // A composition or unregistered supplier's tax is money that never comes
    // back, and ignoring that regularly reverses a ranking.
    const result = compareQuotes([
      base({ vendorId: 'registered', vendorName: 'Registered Co' }),
      base({
        vendorId: 'composition', vendorName: 'Composition Co', gstCreditable: false,
        lines: [{ reference: 'Cement', quantity: 100, unitRate: 380, gstRatePct: 28 }],
      }),
    ]);
    // 380 looks cheaper than 400 until the unrecoverable tax is counted.
    expect(result.find(r => r.vendorId === 'composition')!.landedCost).toBe(48_640);
    expect(lowestQuote(result)!.vendorId).toBe('registered');
  });

  it('applies a line discount before tax', () => {
    const result = compareQuotes([base({
      lines: [{ reference: 'Cement', quantity: 100, unitRate: 400, discountPct: 10, gstRatePct: 28 }],
    })]);
    expect(result[0].discount).toBe(4_000);
    expect(result[0].taxableValue).toBe(36_000);
    expect(result[0].landedCost).toBe(36_000);
  });

  it('evaluates an unqualified quote but never ranks it', () => {
    // The comparison sheet has to show what they offered; L1 must still be a
    // vendor who could actually do the work.
    const result = compareQuotes([
      base({ vendorId: 'cheapest', vendorName: 'Cheapest', technicallyQualified: false,
             lines: [{ reference: 'Cement', quantity: 100, unitRate: 300 }] }),
      base({ vendorId: 'qualified', vendorName: 'Qualified' }),
    ]);
    const unqualified = result.find(r => r.vendorId === 'cheapest')!;
    expect(unqualified.landedCost).toBe(30_000);
    expect(unqualified.rank).toBeNull();
    expect(lowestQuote(result)!.vendorId).toBe('qualified');
  });

  it('breaks a genuine tie on delivery', () => {
    const result = compareQuotes([
      base({ vendorId: 'slow', vendorName: 'Slow', deliveryDays: 30 }),
      base({ vendorId: 'fast', vendorName: 'Fast', deliveryDays: 7 }),
    ]);
    expect(lowestQuote(result)!.vendorId).toBe('fast');
  });

  it('ranks every qualified quote in order', () => {
    const result = compareQuotes([
      base({ vendorId: 'c', vendorName: 'C', lines: [{ reference: 'X', quantity: 1, unitRate: 300 }] }),
      base({ vendorId: 'a', vendorName: 'A', lines: [{ reference: 'X', quantity: 1, unitRate: 100 }] }),
      base({ vendorId: 'b', vendorName: 'B', lines: [{ reference: 'X', quantity: 1, unitRate: 200 }] }),
    ]);
    expect(result.find(r => r.vendorId === 'a')!.rank).toBe(1);
    expect(result.find(r => r.vendorId === 'b')!.rank).toBe(2);
    expect(result.find(r => r.vendorId === 'c')!.rank).toBe(3);
  });

  it('keeps the sheet in the order quotes were received', () => {
    const result = compareQuotes([
      base({ vendorId: 'second', vendorName: 'Second', lines: [{ reference: 'X', quantity: 1, unitRate: 500 }] }),
      base({ vendorId: 'first', vendorName: 'First', lines: [{ reference: 'X', quantity: 1, unitRate: 100 }] }),
    ]);
    expect(result.map(r => r.vendorId)).toEqual(['second', 'first']);
  });

  it('returns nothing recommended when no quote qualifies', () => {
    const result = compareQuotes([base({ technicallyQualified: false })]);
    expect(lowestQuote(result)).toBeNull();
  });
});

describe('PO amendment rules (§43.2)', () => {
  const line = (over: Partial<AmendmentLine> = {}): AmendmentLine => ({
    poLineId: 'l1', reference: 'Cement',
    currentQuantity: 100, newQuantity: 100,
    currentRate: 400, newRate: 400,
    receivedQuantity: 0,
    ...over,
  });

  it('accepts an increase on an untouched line', () => {
    const check = checkAmendment([line({ newQuantity: 150 })]);
    expect(check.valid).toBe(true);
    expect(check.valueChanged).toBe(true);
    expect(check.newTotal).toBe(60_000);
  });

  it('refuses to reduce a line below what has already been received', () => {
    // The material is on site and in stock. Reducing under it leaves a receipt
    // with no authority behind it and a payable nobody can reconcile.
    const check = checkAmendment([line({ newQuantity: 50, receivedQuantity: 80 })]);
    expect(check.valid).toBe(false);
    expect(check.problems[0]).toContain('already been received');
  });

  it('allows reducing to exactly what was received', () => {
    // Short-closing the balance is ordinary.
    expect(checkAmendment([line({ newQuantity: 80, receivedQuantity: 80 })]).valid).toBe(true);
  });

  it('refuses a rate change once material has been received at the old rate', () => {
    const check = checkAmendment([line({ newRate: 450, receivedQuantity: 20 })]);
    expect(check.valid).toBe(false);
    expect(check.problems[0]).toContain('agreed price');
  });

  it('allows a rate change while nothing has been received', () => {
    expect(checkAmendment([line({ newRate: 450 })]).valid).toBe(true);
  });

  it('refuses a zero quantity and points at cancellation instead', () => {
    const check = checkAmendment([line({ newQuantity: 0 })]);
    expect(check.problems[0]).toContain('cancel the line');
  });

  it('refuses a negative rate', () => {
    expect(checkAmendment([line({ newRate: -1 })]).valid).toBe(false);
  });

  it('reports no value change when nothing moved', () => {
    const check = checkAmendment([line()]);
    expect(check.valueChanged).toBe(false);
    expect(check.previousTotal).toBe(check.newTotal);
  });

  it('checks every line and collects all the problems', () => {
    const check = checkAmendment([
      line({ reference: 'A', newQuantity: 10, receivedQuantity: 50 }),
      line({ reference: 'B', newRate: 500, receivedQuantity: 10 }),
      line({ reference: 'C', newQuantity: 200 }),
    ]);
    expect(check.problems).toHaveLength(2);
    expect(check.problems.map(p => p.split(':')[0])).toEqual(['A', 'B']);
  });
});

describe('return and acknowledgement schemas (§43.3, §43.4)', () => {
  const ret = {
    return_no: 'RTV-1', grn_id: '3f1a0c2e-0000-4000-8000-000000000001',
    return_date: '2026-09-20', reason: 'QUALITY_REJECTION' as const,
    remarks: 'Bags torn and damp on arrival',
    lines: [{ grn_line_id: '3f1a0c2e-0000-4000-8000-000000000002', quantity: 10 }],
  };

  it('accepts a return with a reason and remarks', () => {
    expect(returnSchema.safeParse(ret).success).toBe(true);
  });

  it('insists a return explains itself', () => {
    expect(returnSchema.safeParse({ ...ret, remarks: '' }).success).toBe(false);
  });

  it('refuses a return of nothing', () => {
    expect(returnSchema.safeParse({ ...ret, lines: [] }).success).toBe(false);
    expect(returnSchema.safeParse({
      ...ret, lines: [{ grn_line_id: ret.lines[0].grn_line_id, quantity: 0 }],
    }).success).toBe(false);
  });

  it('defaults a return to pending resolution', () => {
    // Whether the vendor replaces or credits is usually decided later.
    expect(returnSchema.parse(ret).resolution).toBe('PENDING');
  });

  it('accepts an acknowledgement with a promised date and exceptions', () => {
    expect(acknowledgementSchema.safeParse({
      acknowledged_on: '2026-09-16', promised_delivery_date: '2026-10-01',
      exceptions: 'Cement available only in 50kg bags',
    }).success).toBe(true);
  });

  it('requires at least two vendors on a competitive RFQ', () => {
    const rfq = {
      rfq_no: 'RFQ-1', due_date: '2026-09-25',
      lines: [{ description: 'Cement', unit: 'bag', quantity: 100 }],
    };
    expect(rfqSchema.safeParse({ ...rfq, vendor_ids: ['3f1a0c2e-0000-4000-8000-000000000001'] }).success)
      .toBe(false);
    expect(rfqSchema.safeParse({
      ...rfq,
      vendor_ids: ['3f1a0c2e-0000-4000-8000-000000000001', '3f1a0c2e-0000-4000-8000-000000000002'],
    }).success).toBe(true);
  });
});
