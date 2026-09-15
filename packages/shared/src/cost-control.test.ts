import { describe, expect, it } from 'vitest';
import {
  budgetPosition, profitability, COST_CONTROL_ROLE_GRANTS, COST_CONTROL_PERMISSIONS,
  costHeadSchema, budgetSchema,
} from './cost-control.js';

const LABOUR = '11111111-1111-4111-8111-111111111111';
const MATERIAL = '22222222-2222-4222-8222-222222222222';

describe('budgetPosition', () => {
  it('reports an unbudgeted head rather than dropping it', () => {
    const { heads } = budgetPosition(
      [{ costHeadId: LABOUR, budgetedAmount: 100000 }],
      [{ costHeadId: MATERIAL, amount: 25000, nature: 'ACTUAL' }],
    );
    const material = heads.find(h => h.costHeadId === MATERIAL)!;
    expect(material.budgeted).toBe(0);
    expect(material.actual).toBe(25000);
    // Nothing was budgeted, so a percentage would be a division by zero
    // dressed up as a number.
    expect(material.utilisationPct).toBeNull();
  });

  it('counts an open commitment against the budget before it is invoiced', () => {
    // The failure this prevents: 8 lakh spent of 10 budgeted reads as healthy
    // while 4 lakh of purchase orders are already signed.
    const { heads } = budgetPosition(
      [{ costHeadId: MATERIAL, budgetedAmount: 1000000 }],
      [
        { costHeadId: MATERIAL, amount: 800000, nature: 'ACTUAL' },
        { costHeadId: MATERIAL, amount: 400000, nature: 'COMMITTED' },
      ],
    );
    const material = heads[0];
    expect(material.actual).toBe(800000);
    expect(material.forecast).toBe(1200000);
    expect(material.variance).toBe(-200000);
    expect(material.overrun).toBe(true);
  });

  it('does not double-count a commitment that has been received', () => {
    // The order commits 400000; the receipt makes 400000 actual and reverses
    // the commitment. Forecast must not be 800000.
    const { totals } = budgetPosition(
      [{ costHeadId: MATERIAL, budgetedAmount: 1000000 }],
      [
        { costHeadId: MATERIAL, amount: 400000, nature: 'COMMITTED' },
        { costHeadId: MATERIAL, amount: -400000, nature: 'COMMITTED', reversalOf: 'po-1' },
        { costHeadId: MATERIAL, amount: 400000, nature: 'ACTUAL' },
      ],
    );
    expect(totals.actual).toBe(400000);
    expect(totals.committed).toBe(0);
    expect(totals.forecast).toBe(400000);
    expect(totals.overrun).toBe(false);
  });

  it('nets a reversed actual back out', () => {
    const { totals } = budgetPosition(
      [{ costHeadId: LABOUR, budgetedAmount: 50000 }],
      [
        { costHeadId: LABOUR, amount: 12000, nature: 'ACTUAL' },
        { costHeadId: LABOUR, amount: -12000, nature: 'ACTUAL', reversalOf: 'claim-1' },
      ],
    );
    expect(totals.actual).toBe(0);
    expect(totals.variance).toBe(50000);
  });

  it('sorts the heaviest head first, which is what a cost report is read for', () => {
    const { heads } = budgetPosition([], [
      { costHeadId: LABOUR, amount: 1000, nature: 'ACTUAL' },
      { costHeadId: MATERIAL, amount: 9000, nature: 'ACTUAL' },
    ]);
    expect(heads.map(h => h.costHeadId)).toEqual([MATERIAL, LABOUR]);
  });
});

describe('profitability', () => {
  it('separates margin to date from forecast margin', () => {
    const p = profitability({ contractValue: 1000000, actualCost: 400000, committedCost: 500000 });
    expect(p.profit).toBe(600000);
    expect(p.marginPct).toBe(60);
    expect(p.forecastProfit).toBe(100000);
    expect(p.forecastMarginPct).toBe(10);
    expect(p.lossMaking).toBe(false);
  });

  it('calls a job loss-making on commitments alone', () => {
    // 60% margin to date, and the project is already underwater. This is the
    // exact case a to-date-only report hides.
    const p = profitability({ contractValue: 1000000, actualCost: 400000, committedCost: 700000 });
    expect(p.marginPct).toBe(60);
    expect(p.lossMaking).toBe(true);
    expect(p.forecastProfit).toBe(-100000);
  });

  it('returns no margin rather than zero when there is no contract value', () => {
    const p = profitability({ contractValue: 0, actualCost: 5000 });
    expect(p.marginPct).toBeNull();
    expect(p.profit).toBe(-5000);
  });
});

describe('cost control grants', () => {
  it('keeps the manual adjustment away from the role that owns the budget', () => {
    // A project manager who can both set the budget and post an adjustment can
    // make any overrun disappear.
    expect(COST_CONTROL_ROLE_GRANTS.PROJECT_MANAGER).toContain('budget.manage');
    expect(COST_CONTROL_ROLE_GRANTS.PROJECT_MANAGER).not.toContain('cost.adjust');
  });

  it('gives the auditor reads and nothing else', () => {
    for (const p of COST_CONTROL_ROLE_GRANTS.AUDITOR) expect(p.endsWith('.read')).toBe(true);
  });

  it('grants every permission to exactly the two administrative roles', () => {
    const holders = Object.entries(COST_CONTROL_ROLE_GRANTS)
      .filter(([, perms]) => perms.includes('cost.adjust')).map(([role]) => role);
    expect(holders.sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(COST_CONTROL_PERMISSIONS);
    for (const perms of Object.values(COST_CONTROL_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  it('upper-cases a cost head code so the master does not fork', () => {
    expect(costHeadSchema.parse({ code: 'mat', name: 'Material', kind: 'MATERIAL' }).code).toBe('MAT');
  });

  it('refuses an empty budget', () => {
    expect(budgetSchema.safeParse({ lines: [] }).success).toBe(false);
  });
});
