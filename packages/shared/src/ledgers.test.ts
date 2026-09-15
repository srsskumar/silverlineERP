import { describe, expect, it } from 'vitest';
import {
  ageingBucket, daysBetween, ageOutstanding, payableDue, msmeInterestOn,
  creditExposure, daysSalesOutstanding, selectForRun, PAYMENT_RUN_TRANSITIONS,
  LEDGER_ROLE_GRANTS, LEDGER_PERMISSIONS,
  paymentRunSchema, runDecisionSchema, payableHoldSchema,
  type PayableCandidate,
} from './ledgers.js';

describe('ageingBucket', () => {
  it('reports an undated document as undated, not as current', () => {
    // Assuming makes an unknown look like a good number, and finding what is
    // not good is the whole point of an ageing report.
    expect(ageingBucket(null, '2026-09-15')).toBe('UNDATED');
  });

  it('puts a document due today in not-yet-due', () => {
    expect(ageingBucket('2026-09-15', '2026-09-15')).toBe('NOT_DUE');
  });

  it('buckets by days past the due date', () => {
    expect(ageingBucket('2026-09-01', '2026-09-15')).toBe('D1_30');
    expect(ageingBucket('2026-08-01', '2026-09-15')).toBe('D31_60');
    expect(ageingBucket('2026-07-01', '2026-09-15')).toBe('D61_90');
    expect(ageingBucket('2026-01-01', '2026-09-15')).toBe('OVER_90');
  });

  it('counts days across a month boundary correctly', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
  });
});

describe('ageOutstanding', () => {
  it('keeps retention out of the buckets and out of overdue', () => {
    // Retention is owed but not collectable. Ageing it sends the collections
    // team after money the client is entitled to hold.
    const s = ageOutstanding([
      { outstanding: 0, retention: 50_000, dueDate: '2020-01-01' },
      { outstanding: 100_000, dueDate: '2026-09-01' },
    ], '2026-09-15');
    expect(s.retention).toBe(50_000);
    expect(s.buckets.OVER_90).toBe(0);
    expect(s.buckets.D1_30).toBe(100_000);
    expect(s.overdue).toBe(100_000);
    expect(s.total).toBe(150_000);
  });

  it('reports a dispute separately from slow payment', () => {
    // Different problem, different person.
    const s = ageOutstanding([
      { outstanding: 80_000, dueDate: '2020-01-01', disputed: true },
      { outstanding: 20_000, dueDate: '2020-01-01' },
    ], '2026-09-15');
    expect(s.disputed).toBe(80_000);
    expect(s.buckets.OVER_90).toBe(20_000);
    expect(s.overdue).toBe(20_000);
  });

  it('keeps a held payable in the ageing', () => {
    // The money is still owed; hiding it would flatter the position.
    const s = ageOutstanding([{ outstanding: 30_000, dueDate: '2026-09-01', onHold: true }], '2026-09-15');
    expect(s.onHold).toBe(30_000);
    expect(s.total).toBe(30_000);
    expect(s.buckets.D1_30).toBe(30_000);
  });

  it('counts an undated amount without inventing an age for it', () => {
    const s = ageOutstanding([{ outstanding: 5_000 }], '2026-09-15');
    expect(s.undated).toBe(5_000);
    expect(s.overdue).toBe(0);
  });

  it('ignores a settled document', () => {
    expect(ageOutstanding([{ outstanding: 0, dueDate: '2020-01-01' }], '2026-09-15').overdue).toBe(0);
  });
});

describe('payableDue', () => {
  const msme = { udyamNumber: 'UDYAM-KR-03-0000001', msmeCategory: 'SMALL', hasWrittenAgreement: true };

  it('applies the statutory date when it beats the negotiated one', () => {
    // 45 days under s.15 with a written agreement, against 90 days agreed.
    // The statutory date governs, and an invoice the clerk thought had three
    // months is already late.
    const d = payableDue({
      party: msme, acceptanceDate: '2026-07-01',
      contractualDueDate: '2026-09-29', asOf: '2026-09-15',
    });
    expect(d.isMsme).toBe(true);
    expect(d.statutoryDueDate).toBe('2026-08-15');
    expect(d.effectiveDueDate).toBe('2026-08-15');
    expect(d.daysOverdue).toBe(31);
  });

  it('shows both dates so the difference is visible', () => {
    const d = payableDue({
      party: msme, acceptanceDate: '2026-07-01',
      contractualDueDate: '2026-09-29', asOf: '2026-09-15',
    });
    expect(d.contractualDueDate).toBe('2026-09-29');
    expect(d.statutoryDueDate).not.toBe(d.contractualDueDate);
  });

  it('uses fifteen days where there is no written agreement', () => {
    const d = payableDue({
      party: { ...msme, hasWrittenAgreement: false }, acceptanceDate: '2026-07-01',
      contractualDueDate: null, asOf: '2026-09-15',
    });
    expect(d.statutoryDueDate).toBe('2026-07-16');
  });

  it('keeps the negotiated date when it is the earlier one', () => {
    const d = payableDue({
      party: msme, acceptanceDate: '2026-07-01',
      contractualDueDate: '2026-07-10', asOf: '2026-09-15',
    });
    expect(d.effectiveDueDate).toBe('2026-07-10');
  });

  it('does not apply the Act to a supplier who is not registered', () => {
    // A medium enterprise, or one with no Udyam number, is outside s.15.
    const d = payableDue({
      party: { msmeCategory: 'SMALL' }, acceptanceDate: '2026-07-01',
      contractualDueDate: '2026-09-29', asOf: '2026-09-15',
    });
    expect(d.isMsme).toBe(false);
    expect(d.statutoryDueDate).toBeNull();
    expect(d.effectiveDueDate).toBe('2026-09-29');
  });

  it('does not apply it to a medium enterprise', () => {
    expect(payableDue({
      party: { udyamNumber: 'UDYAM-KR-03-0000001', msmeCategory: 'MEDIUM' },
      acceptanceDate: '2026-07-01', contractualDueDate: null, asOf: '2026-09-15',
    }).isMsme).toBe(false);
  });
});

describe('msmeInterestOn', () => {
  it('accrues interest past the statutory date', () => {
    // A real liability whether or not anybody recorded it, and not deductible
    // for income tax.
    const due = payableDue({
      party: { udyamNumber: 'U', msmeCategory: 'MICRO', hasWrittenAgreement: true },
      acceptanceDate: '2026-01-01', contractualDueDate: null, asOf: '2026-09-15',
    });
    const interest = msmeInterestOn({ due, outstanding: 1_000_000, asOf: '2026-09-15', bankRatePct: 6.5 });
    expect(interest).toBeGreaterThan(0);
  });

  it('accrues nothing before the statutory date', () => {
    const due = payableDue({
      party: { udyamNumber: 'U', msmeCategory: 'MICRO' },
      acceptanceDate: '2026-09-01', contractualDueDate: null, asOf: '2026-09-15',
    });
    expect(msmeInterestOn({ due, outstanding: 1_000_000, asOf: '2026-09-15', bankRatePct: 6.5 })).toBe(0);
  });

  it('accrues nothing for a supplier outside the Act', () => {
    const due = payableDue({
      party: {}, acceptanceDate: '2020-01-01', contractualDueDate: '2020-02-01', asOf: '2026-09-15',
    });
    expect(msmeInterestOn({ due, outstanding: 1_000_000, asOf: '2026-09-15', bankRatePct: 6.5 })).toBe(0);
  });
});

describe('creditExposure', () => {
  it('counts work certified but not yet billed', () => {
    // A limit checked only at order time is not a control: by the time the
    // exposure shows, the work is done and the money is at risk.
    const e = creditExposure({ limit: 1_000_000, outstanding: 600_000, uninvoiced: 500_000 });
    expect(e.exposure).toBe(1_100_000);
    expect(e.breached).toBe(true);
    expect(e.headroom).toBe(-100_000);
  });

  it('reports no limit rather than an infinite one', () => {
    const e = creditExposure({ outstanding: 600_000 });
    expect(e.limit).toBeNull();
    expect(e.headroom).toBeNull();
    expect(e.breached).toBe(false);
    expect(e.utilisationPct).toBeNull();
  });

  it('computes utilisation against a real limit', () => {
    expect(creditExposure({ limit: 400_000, outstanding: 100_000 }).utilisationPct).toBe(25);
  });
});

describe('daysSalesOutstanding', () => {
  it('reports the window it was measured over', () => {
    // The same receivable gives wildly different figures over a month and a
    // year, so a DSO with no stated period is not actionable.
    const d = daysSalesOutstanding({ outstanding: 500_000, creditSales: 3_000_000, periodDays: 90 });
    expect(d.dso).toBe(15);
    expect(d.periodDays).toBe(90);
  });

  it('gives no figure rather than zero when there were no sales', () => {
    expect(daysSalesOutstanding({ outstanding: 500_000, creditSales: 0, periodDays: 90 }).dso).toBeNull();
  });
});

describe('selectForRun', () => {
  const due = (date: string | null, statutory: string | null = null) => ({
    contractualDueDate: date, statutoryDueDate: statutory,
    effectiveDueDate: [date, statutory].filter(Boolean).sort()[0] ?? null,
    isMsme: Boolean(statutory), daysOverdue: 0,
  });
  const base = (over: Partial<PayableCandidate>): PayableCandidate => ({
    documentId: 'd1', outstanding: 1000, due: due('2026-09-01'), ...over,
  });

  it('excludes a disputed invoice', () => {
    const r = selectForRun([base({ disputed: true })], { asOf: '2026-09-15' });
    expect(r.included).toHaveLength(0);
    expect(r.excluded[0].code).toBe('DISPUTED');
  });

  it('excludes an invoice whose three-way match has not passed', () => {
    // Paying a bill that does not agree with the order and the receipt is the
    // failure the match exists to prevent.
    const r = selectForRun([base({ matchStatus: 'EXCEPTION' })], { asOf: '2026-09-15' });
    expect(r.excluded[0].code).toBe('NOT_MATCHED');
  });

  it('pays an invoice whose mismatch was already overridden', () => {
    // Somebody has formally accepted the difference; blocking it again would
    // make the override meaningless.
    const r = selectForRun([base({ matchStatus: 'OVERRIDDEN' })], { asOf: '2026-09-15' });
    expect(r.included).toHaveLength(1);
  });

  it('lets the match override through', () => {
    const r = selectForRun([base({ matchStatus: 'EXCEPTION' })],
      { asOf: '2026-09-15', hasMatchOverride: true });
    expect(r.included).toHaveLength(1);
  });

  it('excludes a held payable but says so', () => {
    const r = selectForRun([base({ onHold: true })], { asOf: '2026-09-15' });
    expect(r.excluded[0].code).toBe('ON_HOLD');
  });

  it('excludes what is not yet due unless asked otherwise', () => {
    const later = [base({ due: due('2026-12-01') })];
    expect(selectForRun(later, { asOf: '2026-09-15' }).excluded[0].code).toBe('NOT_DUE');
    expect(selectForRun(later, { asOf: '2026-09-15', includeNotYetDue: true }).included).toHaveLength(1);
  });

  it('pays the statutory obligations first', () => {
    // A legal consequence outranks a relationship one.
    const r = selectForRun([
      base({ documentId: 'negotiated', due: due('2026-08-01') }),
      base({ documentId: 'msme', due: due('2026-09-01', '2026-08-15') }),
    ], { asOf: '2026-09-15' });
    expect(r.included[0].documentId).toBe('msme');
  });

  it('excludes something already settled', () => {
    expect(selectForRun([base({ outstanding: 0 })], { asOf: '2026-09-15' }).excluded[0].code)
      .toBe('SETTLED');
  });
});

describe('payment run lifecycle', () => {
  it('cannot pay a run nobody approved', () => {
    expect(PAYMENT_RUN_TRANSITIONS.DRAFT).not.toContain('PAID');
    expect(PAYMENT_RUN_TRANSITIONS.APPROVED).toContain('PAID');
  });

  it('treats a paid run as final', () => {
    expect(PAYMENT_RUN_TRANSITIONS.PAID).toEqual([]);
  });
});

describe('ledger grants', () => {
  it('does not let the person who builds a run release it', () => {
    expect(LEDGER_ROLE_GRANTS.PAYROLL_OFFICER).toContain('paymentrun.manage');
    expect(LEDGER_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain('paymentrun.approve');
  });

  it('keeps the auditor to reads', () => {
    for (const p of LEDGER_ROLE_GRANTS.AUDITOR) expect(p.endsWith('.read')).toBe(true);
  });

  it('gives sales sight of receivables only', () => {
    expect(LEDGER_ROLE_GRANTS.SALES_BD_EXECUTIVE).toEqual(['ar.read']);
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(LEDGER_PERMISSIONS);
    for (const perms of Object.values(LEDGER_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  it('demands a reason to cancel a run but not to approve one', () => {
    expect(runDecisionSchema.safeParse({ action: 'APPROVE' }).success).toBe(true);
    expect(runDecisionSchema.safeParse({ action: 'CANCEL' }).success).toBe(false);
  });

  it('demands a reason to hold a payable', () => {
    // It is the first thing the supplier will ask.
    expect(payableHoldSchema.safeParse({ on_hold: true }).success).toBe(false);
    expect(payableHoldSchema.safeParse({ on_hold: false }).success).toBe(true);
  });

  it('requires the window a run pays through', () => {
    expect(paymentRunSchema.safeParse({ run_no: 'R1', run_date: '2026-09-15' }).success).toBe(false);
    expect(paymentRunSchema.safeParse({
      run_no: 'R1', run_date: '2026-09-15', due_through: '2026-09-30',
    }).success).toBe(true);
  });
});
