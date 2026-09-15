import { describe, expect, it } from 'vitest';
import {
  INVOICE_TRANSITIONS, canIssue, settlementPosition, unallocated, checkAllocation,
  periodAllows, findPeriodOverlap, reconcileImport,
  FINANCE_ROLE_GRANTS, FINANCE_PERMISSIONS,
  paymentSchema, paymentAllocationSchema as allocationSchema, financialPeriodSchema, periodClosureSchema, disputeSchema,
  type FinancialPeriod,
} from './financial-control.js';

describe('invoice lifecycle', () => {
  it('will not let an issued invoice go back to draft', () => {
    // It has left the building and carries a number a tax return references.
    // The way back is a credit note, which is a new document.
    expect(INVOICE_TRANSITIONS.ISSUED).toEqual(['CANCELLED']);
  });

  it('lets a submitted invoice be pulled back for correction', () => {
    expect(INVOICE_TRANSITIONS.SUBMITTED).toContain('DRAFT');
  });

  it('only issues from approved', () => {
    expect(canIssue('APPROVED')).toBe(true);
    expect(canIssue('DRAFT')).toBe(false);
    expect(canIssue('SUBMITTED')).toBe(false);
  });

  it('treats cancelled as final', () => {
    expect(INVOICE_TRANSITIONS.CANCELLED).toEqual([]);
  });
});

describe('settlementPosition', () => {
  it('treats TDS as settling the invoice', () => {
    // The client pays 98 and deposits 2 with the government. The invoice is
    // settled — the 2 is ours, and chasing the client for it would be wrong.
    const p = settlementPosition({
      invoiced: 100,
      allocations: [{ amount: 98, tdsAmount: 2 }],
    });
    expect(p.outstanding).toBe(0);
    expect(p.state).toBe('PAID');
    expect(p.settledNonCash).toBe(2);
  });

  it('does not treat retention as settling the invoice', () => {
    // The client pays 95 and holds 5 until the defect liability ends. That 5
    // is still owed; counting it as paid writes off real money.
    const p = settlementPosition({
      invoiced: 100,
      allocations: [{ amount: 95, retentionAmount: 5 }],
    });
    expect(p.outstanding).toBe(5);
    expect(p.state).toBe('PARTIALLY_PAID');
    expect(p.deferred).toBe(5);
  });

  it('settles an invoice paid partly by adjusting an advance', () => {
    const p = settlementPosition({
      invoiced: 100,
      allocations: [{ amount: 60, advanceAdjusted: 40 }],
    });
    expect(p.state).toBe('PAID');
    expect(p.settledNonCash).toBe(40);
  });

  it('adds up several payments against one invoice', () => {
    const p = settlementPosition({
      invoiced: 1000,
      allocations: [{ amount: 400 }, { amount: 350 }, { amount: 250 }],
    });
    expect(p.state).toBe('PAID');
    expect(p.settledCash).toBe(1000);
  });

  it('reports an over-application rather than hiding it', () => {
    const p = settlementPosition({ invoiced: 100, allocations: [{ amount: 120 }] });
    expect(p.state).toBe('OVER_APPLIED');
    expect(p.outstanding).toBe(-20);
  });

  it('derives overdue from the due date and what is outstanding', () => {
    const p = settlementPosition({
      invoiced: 100, allocations: [{ amount: 40 }],
      dueDate: '2026-09-01', asOf: '2026-09-15',
    });
    expect(p.overdue).toBe(true);
    expect(p.daysOverdue).toBe(14);
  });

  it('is not overdue once it is settled, however late the payment was', () => {
    // An invoice paid in full is not an overdue receivable; it is history.
    const p = settlementPosition({
      invoiced: 100, allocations: [{ amount: 100 }],
      dueDate: '2026-01-01', asOf: '2026-09-15',
    });
    expect(p.overdue).toBe(false);
  });

  it('is not overdue when there is no due date to be late against', () => {
    const p = settlementPosition({ invoiced: 100, allocations: [], asOf: '2026-09-15' });
    expect(p.overdue).toBe(false);
    expect(p.state).toBe('UNPAID');
  });

  it('keeps a retention-only allocation out of the cash figure', () => {
    const p = settlementPosition({ invoiced: 100, allocations: [{ amount: 0, retentionAmount: 10 }] });
    expect(p.settledCash).toBe(0);
    expect(p.outstanding).toBe(100);
  });
});

describe('unallocated', () => {
  it('reports the part of a payment not yet applied', () => {
    // Money arrives before anybody knows which invoices it settles.
    expect(unallocated(1000, [{ amount: 600 }])).toBe(400);
  });

  it('counts only the cash, because a deduction never arrived', () => {
    // A client settling 1000 pays 900 and withholds 50 TDS and 50 retention.
    // The payment is 900 and it is fully applied; counting the withholdings
    // against it would make the payment look over-applied.
    expect(unallocated(900, [{ amount: 900, tdsAmount: 50, retentionAmount: 50 }])).toBe(0);
  });

  it('reports a fully unapplied payment as its whole value', () => {
    expect(unallocated(500, [])).toBe(500);
  });
});

describe('checkAllocation', () => {
  const base = { paymentAmount: 1000, alreadyAllocated: [] as never[], documentOutstanding: 5000 };

  it('allows an ordinary allocation', () => {
    expect(checkAllocation({ ...base, line: { amount: 400 } }).allowed).toBe(true);
  });

  it('refuses applying more of a payment than remains', () => {
    const r = checkAllocation({
      paymentAmount: 1000, alreadyAllocated: [{ amount: 800 }],
      line: { amount: 400 }, documentOutstanding: 5000,
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('EXCEEDS_PAYMENT');
  });

  it('refuses applying more to a document than it has outstanding', () => {
    // Unlike over-receiving material, this is only ever a keying error, and
    // accepting it creates a credit nobody intended.
    const r = checkAllocation({ ...base, line: { amount: 900 }, documentOutstanding: 500 });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('EXCEEDS_DOCUMENT');
  });

  it('does not draw an adjusted advance from the payment balance', () => {
    // The advance is money already held; it is not part of this payment.
    const r = checkAllocation({
      paymentAmount: 100, alreadyAllocated: [],
      line: { amount: 100, advanceAdjusted: 400 }, documentOutstanding: 5000,
    });
    expect(r.allowed).toBe(true);
  });

  it('does not draw TDS from the payment balance either', () => {
    // The ordinary case: a 100 invoice settled by a 98 payment plus 2 of tax
    // the client deposited. Counting the 2 against the payment refuses it.
    const r = checkAllocation({
      paymentAmount: 98, alreadyAllocated: [],
      line: { amount: 98, tdsAmount: 2 }, documentOutstanding: 100,
    });
    expect(r.allowed).toBe(true);
  });

  it('does not draw retention from the payment balance', () => {
    const r = checkAllocation({
      paymentAmount: 95, alreadyAllocated: [],
      line: { amount: 95, retentionAmount: 5 }, documentOutstanding: 100,
    });
    expect(r.allowed).toBe(true);
  });

  it('refuses an allocation that applies nothing', () => {
    expect(checkAllocation({ ...base, line: { amount: 0 } }).code).toBe('EMPTY_ALLOCATION');
  });

  it('counts TDS towards what the document is settled by', () => {
    const r = checkAllocation({ ...base, line: { amount: 490, tdsAmount: 10 }, documentOutstanding: 495 });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('EXCEEDS_DOCUMENT');
  });
});

describe('periodAllows', () => {
  const periods: FinancialPeriod[] = [
    { code: 'FY26-07', startsOn: '2026-07-01', endsOn: '2026-07-31', status: 'CLOSED' },
    { code: 'FY26-08', startsOn: '2026-08-01', endsOn: '2026-08-31', status: 'OPEN' },
  ];

  it('refuses a document dated into a closed period', () => {
    // Closing a month and then letting somebody book into it is the same as
    // not closing it: signed-off figures move afterwards.
    const v = periodAllows(periods, '2026-07-15');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe('PERIOD_CLOSED');
  });

  it('allows an open period', () => {
    expect(periodAllows(periods, '2026-08-15').allowed).toBe(true);
  });

  it('allows a date no period covers', () => {
    // Periods are a control an organisation opts into; refusing everything
    // until somebody defines a calendar makes it a blocker, not a safeguard.
    expect(periodAllows(periods, '2026-09-15').allowed).toBe(true);
  });

  it('lets the reserved override through', () => {
    expect(periodAllows(periods, '2026-07-15', { hasOverride: true }).allowed).toBe(true);
  });

  it('names the period in the refusal so the user knows which one', () => {
    const v = periodAllows(periods, '2026-07-15');
    if (!v.allowed) expect(v.reason).toContain('FY26-07');
  });
});

describe('findPeriodOverlap', () => {
  it('catches two periods covering the same day', () => {
    const overlap = findPeriodOverlap([
      { code: 'A', startsOn: '2026-07-01', endsOn: '2026-07-31', status: 'OPEN' },
      { code: 'B', startsOn: '2026-07-15', endsOn: '2026-08-15', status: 'OPEN' },
    ]);
    expect(overlap?.map(p => p.code)).toEqual(['A', 'B']);
  });

  it('accepts periods that merely touch', () => {
    expect(findPeriodOverlap([
      { code: 'A', startsOn: '2026-07-01', endsOn: '2026-07-31', status: 'OPEN' },
      { code: 'B', startsOn: '2026-08-01', endsOn: '2026-08-31', status: 'OPEN' },
    ])).toBeNull();
  });
});

describe('reconcileImport', () => {
  it('applies a line the feed has not seen before', () => {
    expect(reconcileImport(null, { amount: 100 }).action).toBe('APPLY');
  });

  it('leaves a reconciled line alone when the feed agrees', () => {
    const v = reconcileImport(
      { amount: 100, state: 'RECONCILED', reconciledAt: '2026-09-01' }, { amount: 100 });
    expect(v.action).toBe('SKIP_RECONCILED');
  });

  it('raises an exception rather than overwriting a person’s judgement', () => {
    // The rule is "no integration should silently overwrite"; the important
    // word is silently. The feed disagreeing is something a person must see.
    const v = reconcileImport(
      { amount: 100, state: 'RECONCILED', reconciledAt: '2026-09-01' }, { amount: 140 });
    expect(v.action).toBe('FLAG_EXCEPTION');
    expect(v.state).toBe('EXCEPTION');
    expect(v.note).toContain('140');
  });

  it('updates a line nobody has reconciled yet', () => {
    expect(reconcileImport({ amount: 100, state: 'UNMATCHED' }, { amount: 140 }).action).toBe('APPLY');
  });

  it('keeps an existing exception flagged', () => {
    expect(reconcileImport({ amount: 100, state: 'EXCEPTION' }, { amount: 100 }).state).toBe('EXCEPTION');
  });
});

describe('finance grants', () => {
  it('reserves posting into a closed period for the top role', () => {
    const holders = Object.entries(FINANCE_ROLE_GRANTS)
      .filter(([, perms]) => perms.includes('period.override')).map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('keeps the auditor to reads', () => {
    for (const p of FINANCE_ROLE_GRANTS.AUDITOR) expect(p.endsWith('.read')).toBe(true);
  });

  it('separates recording a payment from issuing an invoice', () => {
    // Whoever banks the money should not also be the person who decides what
    // the client was billed.
    expect(FINANCE_ROLE_GRANTS.PAYROLL_OFFICER).toContain('payment.manage');
    expect(FINANCE_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain('invoice.issue');
  });

  it('gives a project manager sight of the money without control of it', () => {
    expect(FINANCE_ROLE_GRANTS.PROJECT_MANAGER).toEqual(['payment.read', 'period.read', 'invoice.read']);
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(FINANCE_PERMISSIONS);
    for (const perms of Object.values(FINANCE_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  it('refuses a payment for nothing', () => {
    expect(paymentSchema.safeParse({
      direction: 'RECEIVABLE', payment_no: 'P1', paid_on: '2026-09-01', amount: 0, mode: 'NEFT',
    }).success).toBe(false);
  });

  it('demands a reason for a discretionary withholding', () => {
    const r = allocationSchema.safeParse({
      document_type: 'RA_BILL', document_id: '11111111-1111-4111-8111-111111111111',
      amount: 100, other_deduction: 50,
    });
    expect(r.success).toBe(false);
  });

  it('does not demand a reason for TDS, which the law sets', () => {
    expect(allocationSchema.safeParse({
      document_type: 'RA_BILL', document_id: '11111111-1111-4111-8111-111111111111',
      amount: 98, tds_amount: 2,
    }).success).toBe(true);
  });

  it('refuses a period that ends before it starts', () => {
    expect(financialPeriodSchema.safeParse({
      code: 'X', starts_on: '2026-08-01', ends_on: '2026-07-01',
    }).success).toBe(false);
  });

  it('demands a reason to reopen but not to close', () => {
    expect(periodClosureSchema.safeParse({ action: 'CLOSE' }).success).toBe(true);
    expect(periodClosureSchema.safeParse({ action: 'REOPEN' }).success).toBe(false);
    expect(periodClosureSchema.safeParse({ action: 'REOPEN', reason: 'Late credit note' }).success).toBe(true);
  });

  it('demands to know what is being disputed', () => {
    expect(disputeSchema.safeParse({ disputed: true }).success).toBe(false);
    expect(disputeSchema.safeParse({ disputed: false }).success).toBe(true);
  });
});
