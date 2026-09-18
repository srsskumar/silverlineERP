import { describe, expect, it } from 'vitest';
import { apportionPayroll, apportionRun } from './payroll-costing.js';

/**
 * Splitting a wage bill across the projects it was earned on.
 *
 * Every figure here ends up in a cost ledger that is compared against the
 * payroll it came from. A split that loses or invents a paisa is a
 * reconciliation somebody does by hand every month, which is the work this
 * exists to remove — so the arithmetic is the whole of the test.
 */

const slip = (over: Partial<Parameters<typeof apportionPayroll>[0]> = {}) => apportionPayroll({
  gross: 30000, totalDays: 30, byProject: [{ projectId: 'a', days: 30 }], ...over,
});

describe('one payslip', () => {
  it('puts the whole wage on the one project it was worked on', () => {
    const r = slip();
    expect(r.lines).toEqual([{ projectId: 'a', days: 30, amount: 30000 }]);
    expect(r.unattributedAmount).toBe(0);
  });

  it('splits by days, not evenly', () => {
    const r = slip({ byProject: [{ projectId: 'a', days: 18 }, { projectId: 'b', days: 12 }] });
    expect(r.lines.find(l => l.projectId === 'a')!.amount).toBe(18000);
    expect(r.lines.find(l => l.projectId === 'b')!.amount).toBe(12000);
  });

  it('adds up to the payslip exactly, however awkward the split', () => {
    // A third of a rupee three ways is where a naive split loses a paisa.
    const r = apportionPayroll({
      gross: 10000.01, totalDays: 3,
      byProject: [{ projectId: 'a', days: 1 }, { projectId: 'b', days: 1 }, { projectId: 'c', days: 1 }],
    });
    const total = r.lines.reduce((t, l) => t + l.amount, 0);
    expect(Math.round(total * 100)).toBe(Math.round(10000.01 * 100));
  });

  it('gives the spare paise to the largest share, deterministically', () => {
    const r = apportionPayroll({
      gross: 100, totalDays: 3,
      byProject: [{ projectId: 'big', days: 2 }, { projectId: 'small', days: 1 }],
    });
    const big = r.lines.find(l => l.projectId === 'big')!.amount;
    const small = r.lines.find(l => l.projectId === 'small')!.amount;
    expect(big + small).toBe(100);
    expect(big).toBeGreaterThan(small);
    // Same input, same answer, every time.
    expect(apportionPayroll({
      gross: 100, totalDays: 3,
      byProject: [{ projectId: 'big', days: 2 }, { projectId: 'small', days: 1 }],
    }).lines).toEqual(r.lines);
  });
});

describe('days no project claims', () => {
  it('charges the projects only for the days they got', () => {
    // Twenty days present, twelve on a project. The other eight were office
    // days, training or travel.
    const r = slip({ totalDays: 20, byProject: [{ projectId: 'a', days: 12 }] });
    expect(r.lines[0].amount).toBe(18000);
    expect(r.unattributedDays).toBe(8);
    expect(r.unattributedAmount).toBe(12000);
  });

  it('does not spread unattributed days across whoever happens to be listed', () => {
    // Charging a project for a day nobody worked on it is worse than
    // admitting the day is unaccounted for.
    const r = slip({ totalDays: 30, byProject: [{ projectId: 'a', days: 1 }] });
    expect(r.lines[0].amount).toBe(1000);
    expect(r.unattributedAmount).toBe(29000);
  });

  it('attributes nothing when no day names a project', () => {
    const r = slip({ byProject: [] });
    expect(r.lines).toEqual([]);
    expect(r.unattributedAmount).toBe(30000);
    expect(r.unattributedDays).toBe(30);
  });

  it('survives an employee with no days present at all', () => {
    const r = slip({ totalDays: 0, byProject: [] });
    expect(r.lines).toEqual([]);
    expect(r.unattributedAmount).toBe(30000);
  });
});

describe('the arithmetic refusing to be gamed', () => {
  it('never charges more days than the person was present', () => {
    // Two villages on one day is one day of wage, not two. Otherwise a crew
    // member moved between villages costs double.
    const r = slip({
      totalDays: 10,
      byProject: [{ projectId: 'a', days: 10 }, { projectId: 'b', days: 10 }],
    });
    const total = r.lines.reduce((t, l) => t + l.amount, 0);
    expect(total).toBeLessThanOrEqual(30000);
    expect(r.attributedDays).toBe(10);
  });

  it('ignores a project credited with no days', () => {
    const r = slip({ byProject: [{ projectId: 'a', days: 30 }, { projectId: 'ghost', days: 0 }] });
    expect(r.lines.map(l => l.projectId)).toEqual(['a']);
  });

  it('handles a zero payslip without dividing by it', () => {
    const r = slip({ gross: 0 });
    expect(r.lines[0].amount).toBe(0);
  });
});

describe('a whole run', () => {
  const run = () => apportionRun([
    { employeeId: 'e1', gross: 30000, totalDays: 30, byProject: [{ projectId: 'a', days: 30 }] },
    { employeeId: 'e2', gross: 20000, totalDays: 20, byProject: [{ projectId: 'a', days: 10 }, { projectId: 'b', days: 10 }] },
    { employeeId: 'e3', gross: 15000, totalDays: 15, byProject: [] },
  ]);

  it('sums every payslip onto the projects worked', () => {
    const r = run();
    const a = r.byProject.find(p => p.projectId === 'a')!;
    const b = r.byProject.find(p => p.projectId === 'b')!;
    expect(a.amount).toBe(40000);
    expect(b.amount).toBe(10000);
  });

  it('counts the people behind each project, not just the money', () => {
    const r = run();
    expect(r.byProject.find(p => p.projectId === 'a')!.employees).toBe(2);
    expect(r.byProject.find(p => p.projectId === 'b')!.employees).toBe(1);
  });

  it('says how much of the run landed nowhere', () => {
    // The third employee worked fifteen days that no project claims.
    const r = run();
    expect(r.unattributedAmount).toBe(15000);
    expect(r.unattributedDays).toBe(15);
    expect(r.employeesWithNoAttributableDays).toBe(1);
  });

  it('accounts for every rupee in the run, posted or not', () => {
    // 30000 + 20000 + 15000, all of it either on a project or declared as
    // unattributed. Nothing quietly disappears.
    const r = run();
    const posted = r.byProject.reduce((t, p) => t + p.amount, 0);
    expect(posted + r.unattributedAmount).toBe(65000);
  });

  it('orders projects by what they cost, largest first', () => {
    const r = run();
    expect(r.byProject.map(p => p.projectId)).toEqual(['a', 'b']);
  });

  it('returns nothing for a run with no payslips', () => {
    const r = apportionRun([]);
    expect(r.byProject).toEqual([]);
    expect(r.unattributedAmount).toBe(0);
  });
});
