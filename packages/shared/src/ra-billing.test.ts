import { describe, expect, it } from 'vitest';
import {
  raBillLine, computeRaBill, recoverAdvance, retentionReleaseStatus,
  raBillSchema, RA_BILL_TRANSITIONS, receivableDueDate, deductionPolicySchema,
  type RaBillLine,
} from './ra-billing.js';

const line = (over: Partial<Parameters<typeof raBillLine>[0]> = {}) =>
  raBillLine({ boqQuantity: 1000, rate: 450, cumulativeQuantity: 0, previousQuantity: 0, ...over });

describe('RA bill line — cumulative measurement', () => {
  it('claims the increment over the previous bill, not the running total', () => {
    // RA-2: 620 cum measured, 400 already billed → this bill claims 220.
    const l = line({ cumulativeQuantity: 620, previousQuantity: 400 });
    expect(l.thisQuantity).toBe(220);
    expect(l.thisAmount).toBe(99_000);
    expect(l.cumulativeAmount).toBe(279_000);
    expect(l.previousAmount).toBe(180_000);
  });

  it('bills the whole quantity on the first bill', () => {
    const l = line({ cumulativeQuantity: 400, previousQuantity: 0 });
    expect(l.thisQuantity).toBe(400);
    expect(l.thisAmount).toBe(180_000);
  });

  it('reconciles the increment against the running totals exactly', () => {
    // The property that makes cumulative storage worth it: successive bills
    // always sum to the cumulative value, whatever the rate's precision.
    const rate = 1234.567;
    const first = raBillLine({ boqQuantity: 100, rate, cumulativeQuantity: 33.333, previousQuantity: 0 });
    const second = raBillLine({ boqQuantity: 100, rate, cumulativeQuantity: 66.666, previousQuantity: 33.333 });
    const third = raBillLine({ boqQuantity: 100, rate, cumulativeQuantity: 100, previousQuantity: 66.666 });
    const summed = first.thisAmount + second.thisAmount + third.thisAmount;
    expect(Number(summed.toFixed(2))).toBe(third.cumulativeAmount);
  });

  it('flags quantity executed beyond the BOQ provision', () => {
    // Certifying this needs a deviation order; it must not pass silently.
    const l = line({ boqQuantity: 1000, cumulativeQuantity: 1120, previousQuantity: 900 });
    expect(l.isExcess).toBe(true);
    expect(l.excessQuantity).toBe(120);
  });

  it('does not flag excess while within the BOQ', () => {
    expect(line({ cumulativeQuantity: 1000, previousQuantity: 900 }).isExcess).toBe(false);
  });

  it('handles a downward re-measurement as a negative claim', () => {
    // Re-measurement found less work than the last bill certified. Storing
    // increments would need a credit note; storing the running total corrects
    // itself, and the negative increment is the correction.
    const l = line({ cumulativeQuantity: 380, previousQuantity: 400 });
    expect(l.isDownwardRevision).toBe(true);
    expect(l.thisQuantity).toBe(-20);
    expect(l.thisAmount).toBe(-9_000);
  });

  it('bills nothing when no further work was measured', () => {
    const l = line({ cumulativeQuantity: 400, previousQuantity: 400 });
    expect(l.thisQuantity).toBe(0);
    expect(l.thisAmount).toBe(0);
  });
});

describe('RA bill totals', () => {
  const lines: RaBillLine[] = [line({ cumulativeQuantity: 1000, previousQuantity: 0 })]; // 450,000

  it('adds GST to the gross and takes deductions out of it', () => {
    // The asymmetry people implement backwards: the contractor invoices
    // measured value + tax, and the client withholds from the payment.
    const bill = computeRaBill(lines, { retentionPct: 5 }, { gstRatePct: 18 });
    expect(bill.grossValue).toBe(450_000);
    expect(bill.gstAmount).toBe(81_000);
    expect(bill.totalDeductions).toBe(22_500);
    expect(bill.netPayable).toBe(450_000 + 81_000 - 22_500);
  });

  it('applies every statutory head on the gross', () => {
    const bill = computeRaBill(lines, {
      retentionPct: 5, labourCessPct: 1, tdsIncomeTaxPct: 2, tdsGstPct: 2,
    });
    const byHead = Object.fromEntries(bill.deductions.map(d => [d.head, d.amount]));
    expect(byHead.RETENTION).toBe(22_500);
    expect(byHead.LABOUR_CESS).toBe(4_500);
    expect(byHead.TDS_INCOME_TAX).toBe(9_000);
    expect(byHead.TDS_GST).toBe(9_000);
    expect(bill.totalDeductions).toBe(45_000);
  });

  it('stops withholding retention once the contract cap is reached', () => {
    // 5% of this bill would be 22,500, but only 10,000 of headroom remains
    // under the 5%-of-contract cap. Withholding the full slice would be a
    // recoverable over-deduction.
    const bill = computeRaBill(lines, { retentionPct: 5, retentionCapPctOfContract: 5 }, {
      contractValue: 10_000_000, retentionHeldToDate: 490_000,
    });
    expect(bill.deductions.find(d => d.head === 'RETENTION')!.amount).toBe(10_000);
  });

  it('withholds nothing further once the cap is already met', () => {
    const bill = computeRaBill(lines, { retentionPct: 5, retentionCapPctOfContract: 5 }, {
      contractValue: 10_000_000, retentionHeldToDate: 500_000,
    });
    expect(bill.deductions.some(d => d.head === 'RETENTION')).toBe(false);
  });

  it('omits heads the contract does not carry', () => {
    // A private client is not a notified GST deductor; charging GST TDS
    // against them would short-pay the contractor.
    const bill = computeRaBill(lines, { retentionPct: 5 });
    expect(bill.deductions.map(d => d.head)).toEqual(['RETENTION']);
  });

  it('carries fixed recoveries such as liquidated damages', () => {
    const bill = computeRaBill(lines, {}, {
      fixedDeductions: [{ head: 'LIQUIDATED_DAMAGES', label: 'LD for 12 days', amount: 27_000 }],
    });
    expect(bill.totalDeductions).toBe(27_000);
    expect(bill.deductions[0].basis).toBe('FIXED');
    expect(bill.deductions[0].ratePct).toBeNull();
  });

  it('keeps the deduction lines summing to the reported total', () => {
    // Rates that do not divide cleanly are where float arithmetic drifts.
    const odd = [line({ cumulativeQuantity: 333.333, previousQuantity: 111.111, rate: 777.77 })];
    const bill = computeRaBill(odd, {
      retentionPct: 7.5, labourCessPct: 1, tdsIncomeTaxPct: 2, tdsGstPct: 2, securityDepositPct: 2.5,
    });
    const summed = bill.deductions.reduce((t, d) => t + d.amount, 0);
    expect(Number(summed.toFixed(2))).toBe(bill.totalDeductions);
  });

  it('reconciles gross, tax and deductions to the net', () => {
    const bill = computeRaBill(lines, { retentionPct: 5, labourCessPct: 1 }, { gstRatePct: 18 });
    expect(Number((bill.grossValue + bill.gstAmount - bill.totalDeductions).toFixed(2)))
      .toBe(bill.netPayable);
  });
});

describe('advance recovery', () => {
  it('recovers the instalment percentage of the gross', () => {
    const r = recoverAdvance(1_000_000, 450_000, 20);
    expect(r.recovered).toBe(90_000);
    expect(r.remaining).toBe(910_000);
  });

  it('never recovers more than remains outstanding', () => {
    // The final recovery is the remainder. A full instalment here would take
    // the balance negative and leave the contractor owing money back.
    const r = recoverAdvance(50_000, 450_000, 20);
    expect(r.recovered).toBe(50_000);
    expect(r.remaining).toBe(0);
  });

  it('recovers nothing once the advance is cleared', () => {
    const r = recoverAdvance(0, 450_000, 20);
    expect(r.recovered).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('appears as a deduction line on the bill', () => {
    const advance = recoverAdvance(1_000_000, 450_000, 20);
    const bill = computeRaBill([line({ cumulativeQuantity: 1000 })], {}, { advances: [advance] });
    expect(bill.deductions[0].head).toBe('MOBILISATION_ADVANCE');
    expect(bill.totalDeductions).toBe(90_000);
  });
});

describe('retention release', () => {
  const base = { heldAmount: 500_000, dlpEndDate: '2027-06-30' };

  it('holds everything while the defect liability period runs', () => {
    const r = retentionReleaseStatus({ ...base, today: '2026-09-15' });
    expect(r.releasable).toBe(0);
    expect(r.withheld).toBe(500_000);
    expect(r.reason).toContain('2027-06-30');
  });

  it('releases in full once the period has ended', () => {
    const r = retentionReleaseStatus({ ...base, today: '2027-07-01' });
    expect(r.releasable).toBe(500_000);
    expect(r.withheld).toBe(0);
  });

  it('releases the first tranche on completion where the contract allows', () => {
    const r = retentionReleaseStatus({
      ...base, today: '2026-10-01', workCompletedAt: '2026-09-30', firstTranchePct: 50,
    });
    expect(r.releasable).toBe(250_000);
    expect(r.withheld).toBe(250_000);
  });

  it('does not release a tranche before the work is complete', () => {
    const r = retentionReleaseStatus({
      ...base, today: '2026-09-15', workCompletedAt: '2026-09-30', firstTranchePct: 50,
    });
    expect(r.releasable).toBe(0);
  });

  it('releases on the DLP end date itself, not the day after', () => {
    expect(retentionReleaseStatus({ ...base, today: '2027-06-30' }).releasable).toBe(500_000);
  });
});

describe('bill schema and lifecycle', () => {
  const valid = {
    project_id: '3f1a0c2e-0000-4000-8000-000000000001',
    period_from: '2026-08-01', period_to: '2026-08-31',
    lines: [{ boq_item_id: '3f1a0c2e-0000-4000-8000-000000000002', cumulative_quantity: 620 }],
  };

  it('accepts a measured bill', () => {
    expect(raBillSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a bill with nothing measured', () => {
    expect(raBillSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
  });

  it('refuses a period that ends before it starts', () => {
    expect(raBillSchema.safeParse({ ...valid, period_to: '2026-07-01' }).success).toBe(false);
  });

  it('refuses a negative cumulative quantity', () => {
    expect(raBillSchema.safeParse({
      ...valid, lines: [{ boq_item_id: valid.lines[0].boq_item_id, cumulative_quantity: -5 }],
    }).success).toBe(false);
  });

  it('requires a reason for every fixed recovery', () => {
    // A deduction without a stated reason is the one the client disputes.
    expect(raBillSchema.safeParse({
      ...valid,
      fixed_deductions: [{ head: 'PENALTY', label: 'Penalty', amount: 1000 }],
    }).success).toBe(false);
  });

  it('closes both terminal states', () => {
    expect(RA_BILL_TRANSITIONS.PAID).toEqual([]);
    expect(RA_BILL_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('allows a submitted bill back to draft but never a certified one', () => {
    // Certification makes the amount a receivable; the measurement behind it
    // must stop moving at that point.
    expect(RA_BILL_TRANSITIONS.SUBMITTED).toContain('DRAFT');
    expect(RA_BILL_TRANSITIONS.CERTIFIED).not.toContain('DRAFT');
  });
});

describe('receivableDueDate', () => {
  it('counts the agreed terms from the certification day', () => {
    expect(receivableDueDate('2026-01-15', 30)).toBe('2026-02-14');
    expect(receivableDueDate('2026-12-15', 30)).toBe('2027-01-14');
    expect(receivableDueDate('2026-03-01', 0)).toBe('2026-03-01');
  });

  it('gives no date where no terms are recorded, rather than a guess', () => {
    expect(receivableDueDate('2026-01-15', null)).toBeNull();
    expect(receivableDueDate('2026-01-15', undefined)).toBeNull();
  });

  it('takes terms on the billing policy, and lets them be cleared', () => {
    expect(deductionPolicySchema.parse({ payment_terms_days: 45 }).payment_terms_days).toBe(45);
    expect(deductionPolicySchema.parse({ payment_terms_days: null }).payment_terms_days).toBeNull();
    expect(deductionPolicySchema.safeParse({ payment_terms_days: -1 }).success).toBe(false);
    expect(deductionPolicySchema.safeParse({ payment_terms_days: 400 }).success).toBe(false);
  });
});
