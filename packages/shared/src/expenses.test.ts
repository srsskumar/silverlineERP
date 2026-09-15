import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CLAIM_TRANSITIONS, canTransition, gstCreditability, policyFor,
  evaluateLine, evaluateClaim, entitlementAmount, receiptFingerprint, softDuplicateKey,
  canApproveClaim, reimbursementPosition, EXPENSE_ROLE_GRANTS, EXPENSE_PERMISSIONS,
  expensePolicySchema, expenseClaimSchema, type ExpensePolicy,
} from './expenses.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

describe('claim lifecycle', () => {
  it('lets a rejected claim be reworked rather than abandoned', () => {
    expect(canTransition('REJECTED', 'DRAFT')).toBe(true);
  });

  it('gives an employee a way to take back a submission', () => {
    // Without WITHDRAWN, a mistaken submission has to be "rejected", and the
    // policy-exception report fills with failures that never happened.
    expect(canTransition('SUBMITTED', 'WITHDRAWN')).toBe(true);
  });

  it('will not reimburse a claim nobody approved', () => {
    expect(canTransition('SUBMITTED', 'REIMBURSED')).toBe(false);
    expect(canTransition('APPROVED', 'REIMBURSED')).toBe(true);
  });

  it('treats reimbursed and withdrawn as final', () => {
    expect(EXPENSE_CLAIM_TRANSITIONS.REIMBURSED).toEqual([]);
    expect(EXPENSE_CLAIM_TRANSITIONS.WITHDRAWN).toEqual([]);
  });
});

describe('gstCreditability', () => {
  it('blocks credit on client entertainment under s.17(5)(b)', () => {
    const c = gstCreditability({ category: 'CLIENT_ENTERTAINMENT', vendorGstin: '29AAACS1234A1ZK' });
    expect(c.creditable).toBe(false);
    expect(c.reason).toBe('BLOCKED_SECTION_17_5');
    expect(c.explanation).toContain('17(5)');
  });

  it('blocks credit on motor fuel even with a tax invoice', () => {
    expect(gstCreditability({ category: 'FUEL', vendorGstin: '29AAACS1234A1ZK' }).creditable).toBe(false);
  });

  it('refuses credit when the bill carries no GSTIN', () => {
    const c = gstCreditability({ category: 'LODGING' });
    expect(c.creditable).toBe(false);
    expect(c.reason).toBe('NO_GSTIN_ON_BILL');
  });

  it('refuses hotel credit in a state the company is not registered in', () => {
    // Accommodation is supplied where the hotel stands, so a Karnataka company
    // gets Delhi CGST+SGST it cannot touch. Missed constantly in practice.
    const c = gstCreditability({
      category: 'LODGING', vendorGstin: '07AAACS1234A1ZK',
      supplyStateCode: '07', registeredStateCodes: ['29'],
    });
    expect(c.creditable).toBe(false);
    expect(c.reason).toBe('PLACE_OF_SUPPLY_UNREGISTERED');
  });

  it('allows the same hotel credit where the company is registered', () => {
    expect(gstCreditability({
      category: 'LODGING', vendorGstin: '07AAACS1234A1ZK',
      supplyStateCode: '07', registeredStateCodes: ['29', '07'],
    }).creditable).toBe(true);
  });

  it('allows credit on business travel', () => {
    expect(gstCreditability({ category: 'TRAVEL', vendorGstin: '29AAACS1234A1ZK' }).creditable).toBe(true);
  });
});

describe('policyFor', () => {
  const policies: ExpensePolicy[] = [
    { category: 'LODGING', effectiveFrom: '2026-04-01', effectiveTo: '2026-06-30', perLineLimit: 2000 },
    { category: 'LODGING', effectiveFrom: '2026-07-01', effectiveTo: null, perLineLimit: 3500 },
    { category: 'LODGING', effectiveFrom: '2026-04-01', effectiveTo: null, perLineLimit: 6000, appliesToGrade: 'M3' },
  ];

  it('tests a June expense against June policy, not today policy', () => {
    // Raising the cap in July must not retroactively legitimise June overspend.
    expect(policyFor(policies, 'LODGING', '2026-06-15')?.perLineLimit).toBe(2000);
    expect(policyFor(policies, 'LODGING', '2026-08-15')?.perLineLimit).toBe(3500);
  });

  it('prefers a grade policy over the later-dated general one', () => {
    expect(policyFor(policies, 'LODGING', '2026-08-15', 'M3')?.perLineLimit).toBe(6000);
  });

  it('returns nothing for a date before any policy existed', () => {
    expect(policyFor(policies, 'LODGING', '2026-01-01')).toBeNull();
  });
});

describe('evaluateLine', () => {
  it('flags a line no policy covers instead of waving it through', () => {
    const e = evaluateLine(
      { category: 'OTHER', expenseDate: '2026-05-01', amount: 900 }, null);
    expect(e.allowedAmount).toBe(0);
    expect(e.excessAmount).toBe(900);
    expect(e.policyException).toBe(true);
  });

  it('allows the capped amount and books the rest as excess', () => {
    const e = evaluateLine(
      { category: 'LODGING', expenseDate: '2026-05-01', amount: 2600, hasReceipt: true },
      { category: 'LODGING', effectiveFrom: '2026-04-01', perLineLimit: 2000, requiresReceiptAbove: 500 });
    expect(e.allowedAmount).toBe(2000);
    expect(e.excessAmount).toBe(600);
    expect(e.exceptions[0]).toContain('limit of 2000');
  });

  it('does not demand a receipt below the threshold', () => {
    const e = evaluateLine(
      { category: 'TRAVEL', expenseDate: '2026-05-01', amount: 400 },
      { category: 'TRAVEL', effectiveFrom: '2026-04-01', requiresReceiptAbove: 500 });
    expect(e.receiptRequired).toBe(false);
    expect(e.policyException).toBe(false);
  });

  it('never demands a receipt for a per-diem', () => {
    // A per-diem has no bill by definition; applying the receipt rule to it
    // rejects claims for a document that does not exist.
    const e = evaluateLine(
      { category: 'PER_DIEM', expenseDate: '2026-05-01', amount: 2400, units: 3 },
      { category: 'PER_DIEM', effectiveFrom: '2026-04-01', unitRate: 800, requiresReceiptAbove: 500 });
    expect(e.receiptRequired).toBe(false);
    expect(e.allowedAmount).toBe(2400);
    expect(e.policyException).toBe(false);
  });

  it('caps a per-diem per day, not per claim', () => {
    // The specification treats per-diem as "a category with a limit". Three
    // days at 800 is 2400 and must not be measured against a 1000 per-claim cap.
    const e = evaluateLine(
      { category: 'PER_DIEM', expenseDate: '2026-05-01', amount: 2400, units: 3 },
      { category: 'PER_DIEM', effectiveFrom: '2026-04-01', unitRate: 800, perLineLimit: 1000 });
    expect(e.allowedAmount).toBe(2400);
    expect(e.excessAmount).toBe(0);
  });

  it('trims a per-diem claimed above its entitlement', () => {
    const e = evaluateLine(
      { category: 'PER_DIEM', expenseDate: '2026-05-01', amount: 3000, units: 3 },
      { category: 'PER_DIEM', effectiveFrom: '2026-04-01', unitRate: 800 });
    expect(e.allowedAmount).toBe(2400);
    expect(e.excessAmount).toBe(600);
    expect(e.exceptions[0]).toContain('entitlement');
  });

  it('asks how many days a per-diem covers', () => {
    const e = evaluateLine(
      { category: 'PER_DIEM', expenseDate: '2026-05-01', amount: 800 },
      { category: 'PER_DIEM', effectiveFrom: '2026-04-01', unitRate: 800 });
    expect(e.exceptions.join(' ')).toContain('how many days');
  });

  it('raises the blocked-credit exception when tax was claimed on entertainment', () => {
    const e = evaluateLine(
      { category: 'CLIENT_ENTERTAINMENT', expenseDate: '2026-05-01', amount: 5900,
        hasReceipt: true, vendorGstin: '29AAACS1234A1ZK', gstAmount: 900 },
      { category: 'CLIENT_ENTERTAINMENT', effectiveFrom: '2026-04-01', requiresReceiptAbove: 0 });
    expect(e.credit.creditable).toBe(false);
    expect(e.exceptions.join(' ')).toContain('17(5)');
  });
});

describe('evaluateClaim', () => {
  const policies: ExpensePolicy[] = [
    { category: 'LODGING', effectiveFrom: '2026-04-01', perLineLimit: 3000, perClaimLimit: 5000, requiresReceiptAbove: 500 },
    { category: 'TRAVEL', effectiveFrom: '2026-04-01', requiresReceiptAbove: 1000 },
    { category: 'PER_DIEM', effectiveFrom: '2026-04-01', unitRate: 800 },
  ];

  it('applies a per-claim cap across the trip, not per night', () => {
    const c = evaluateClaim({
      lines: [
        { category: 'LODGING', expenseDate: '2026-05-01', amount: 3000, hasReceipt: true },
        { category: 'LODGING', expenseDate: '2026-05-02', amount: 3000, hasReceipt: true },
      ],
      policies,
    });
    expect(c.totalClaimed).toBe(6000);
    expect(c.totalAllowed).toBe(5000);
    expect(c.totalExcess).toBe(1000);
    expect(c.exceptions.join(' ')).toContain('per-claim limit');
  });

  it('keeps line totals and the claim total in step after trimming', () => {
    const c = evaluateClaim({
      lines: [
        { category: 'LODGING', expenseDate: '2026-05-01', amount: 3000, hasReceipt: true },
        { category: 'LODGING', expenseDate: '2026-05-02', amount: 3000, hasReceipt: true },
      ],
      policies,
    });
    const lineSum = c.lines.reduce((t, l) => t + l.allowedAmount, 0);
    expect(lineSum).toBe(c.totalAllowed);
  });

  it('charges the project net of credit it will get back', () => {
    // 11800 with 1800 recoverable GST costs the project 10000, not 11800.
    // Charging gross is how site profitability is quietly understated.
    const c = evaluateClaim({
      lines: [{
        category: 'SITE_MATERIALS_PETTY', expenseDate: '2026-05-01', amount: 11800,
        hasReceipt: true, vendorGstin: '29AAACS1234A1ZK', invoiceNo: 'B/1',
        gstAmount: 1800, billableToClient: true,
      }],
      policies: [{ category: 'SITE_MATERIALS_PETTY', effectiveFrom: '2026-04-01' }],
    });
    expect(c.creditableGst).toBe(1800);
    expect(c.billableToProject).toBe(10000);
  });

  it('charges blocked tax to the project, because it is a real cost', () => {
    const c = evaluateClaim({
      lines: [{
        category: 'CLIENT_ENTERTAINMENT', expenseDate: '2026-05-01', amount: 5900,
        hasReceipt: true, vendorGstin: '29AAACS1234A1ZK', gstAmount: 900,
        billableToClient: true,
      }],
      policies: [{ category: 'CLIENT_ENTERTAINMENT', effectiveFrom: '2026-04-01', requiresReceiptAbove: 0 }],
    });
    expect(c.blockedGst).toBe(900);
    expect(c.billableToProject).toBe(5900);
  });

  it('leaves a clean claim with nothing to override', () => {
    const c = evaluateClaim({
      lines: [
        { category: 'TRAVEL', expenseDate: '2026-05-01', amount: 900 },
        { category: 'PER_DIEM', expenseDate: '2026-05-01', amount: 1600, units: 2 },
      ],
      policies,
    });
    expect(c.requiresOverride).toBe(false);
    expect(c.totalAllowed).toBe(2500);
  });
});

describe('entitlementAmount', () => {
  it('values three days at the day rate', () => {
    expect(entitlementAmount(3, 800)).toBe(2400);
  });

  it('refuses to turn a negative into a credit', () => {
    expect(entitlementAmount(-3, 800)).toBe(0);
  });
});

describe('duplicate control', () => {
  it('fingerprints a bill that identifies itself', () => {
    const a = receiptFingerprint({ vendorGstin: '29aaacs1234a1zk', invoiceNo: 'inv-9', amount: 1200 });
    const b = receiptFingerprint({ vendorGstin: '29AAACS1234A1ZK', invoiceNo: 'INV-9', amount: 1200 });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('declines to fingerprint a bill with no invoice number', () => {
    // Two genuine refuellings on one day would otherwise be refused, and a
    // control people route around is worse than none.
    expect(receiptFingerprint({ vendorGstin: '29AAACS1234A1ZK', amount: 500 })).toBeNull();
    expect(receiptFingerprint({ invoiceNo: 'INV-9', amount: 500 })).toBeNull();
  });

  it('distinguishes the same invoice number claimed at a different amount', () => {
    expect(receiptFingerprint({ vendorName: 'Shell', invoiceNo: 'A1', amount: 500 }))
      .not.toBe(receiptFingerprint({ vendorName: 'Shell', invoiceNo: 'A1', amount: 600 }));
  });

  it('keys the soft warning on person, category, date and amount', () => {
    const key = softDuplicateKey({ employeeId: UUID, category: 'FUEL', expenseDate: '2026-05-01', amount: 500 });
    expect(key).toBe(`${UUID}|FUEL|2026-05-01|500.00`);
  });
});

describe('canApproveClaim', () => {
  const approver = 'user-a';

  it('refuses the raiser', () => {
    expect(canApproveClaim({
      approverUserId: approver, requestedByUserId: approver, claimantUserId: 'user-b',
    }).allowed).toBe(false);
  });

  it('refuses the claimant even when a clerk keyed the claim in', () => {
    // The generic engine only knows the raiser. A manager whose expenses were
    // keyed in by a site clerk would otherwise approve their own spend.
    const r = canApproveClaim({
      approverUserId: approver, requestedByUserId: 'clerk', claimantUserId: approver,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('your own expenses');
  });

  it('allows a genuine third party', () => {
    expect(canApproveClaim({
      approverUserId: approver, requestedByUserId: 'clerk', claimantUserId: 'user-b',
    }).allowed).toBe(true);
  });
});

describe('reimbursementPosition', () => {
  it('reports the balance still owed after a part payment', () => {
    const p = reimbursementPosition(5000, [{ amount: 3000 }]);
    expect(p.paid).toBe(3000);
    expect(p.outstanding).toBe(2000);
    expect(p.settled).toBe(false);
  });

  it('settles on the exact amount', () => {
    expect(reimbursementPosition(5000, [{ amount: 3000 }, { amount: 2000 }]).settled).toBe(true);
  });
});

describe('expense grants', () => {
  it('makes every employee a first-class participant', () => {
    expect(EXPENSE_ROLE_GRANTS.EMPLOYEE).toContain('expense.manage');
    expect(EXPENSE_ROLE_GRANTS.EMPLOYEE).not.toContain('expense.read_all');
  });

  it('separates paying a claim from authorising one over policy', () => {
    // Whoever settles the payment must not also be the person who waves the
    // breach through.
    expect(EXPENSE_ROLE_GRANTS.PAYROLL_OFFICER).toContain('expense.reimburse');
    expect(EXPENSE_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain('expense.override');
  });

  it('holds the override to the administrative roles', () => {
    const holders = Object.entries(EXPENSE_ROLE_GRANTS)
      .filter(([, perms]) => perms.includes('expense.override')).map(([role]) => role);
    expect(holders.sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('gives the auditor reads without the ability to raise a claim', () => {
    expect(EXPENSE_ROLE_GRANTS.AUDITOR).toContain('expense.read_all');
    expect(EXPENSE_ROLE_GRANTS.AUDITOR).not.toContain('expense.manage');
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(EXPENSE_PERMISSIONS);
    for (const perms of Object.values(EXPENSE_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  it('insists a per-diem policy carries a rate', () => {
    const r = expensePolicySchema.safeParse({
      category: 'PER_DIEM', effective_from: '2026-04-01', per_line_limit: 1000,
    });
    expect(r.success).toBe(false);
  });

  it('accepts a per-diem policy with a rate', () => {
    expect(expensePolicySchema.safeParse({
      category: 'PER_DIEM', effective_from: '2026-04-01', unit_rate: 800,
    }).success).toBe(true);
  });

  it('rejects a policy that ends before it starts', () => {
    expect(expensePolicySchema.safeParse({
      category: 'TRAVEL', effective_from: '2026-06-01', effective_to: '2026-05-01',
    }).success).toBe(false);
  });

  it('will not accept a billable line with no project to bear it', () => {
    const r = expenseClaimSchema.safeParse({
      claim_no: 'EXP-1', claim_date: '2026-05-02', purpose: 'Site visit',
      lines: [{
        category: 'TRAVEL', expense_date: '2026-05-01', description: 'Taxi',
        amount: 500, billable_to_client: true,
      }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts the same line once the claim names a project', () => {
    expect(expenseClaimSchema.safeParse({
      claim_no: 'EXP-1', claim_date: '2026-05-02', purpose: 'Site visit', project_id: PROJECT,
      lines: [{
        category: 'TRAVEL', expense_date: '2026-05-01', description: 'Taxi',
        amount: 500, billable_to_client: true,
      }],
    }).success).toBe(true);
  });

  it('refuses a claim with no lines', () => {
    expect(expenseClaimSchema.safeParse({
      claim_no: 'EXP-1', claim_date: '2026-05-02', purpose: 'Site visit', lines: [],
    }).success).toBe(false);
  });
});
