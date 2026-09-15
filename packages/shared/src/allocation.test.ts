import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_TRANSITIONS, rangesOverlap, countsTowardCapacity, findCapacityConflict,
  utilisation, shiftHours, isRestDay, dayPay,
  ALLOCATION_ROLE_GRANTS, ALLOCATION_PERMISSIONS,
  resourceAllocationSchema as allocationSchema, shiftSchema, rosterBulkSchema,
  type Allocation,
} from './allocation.js';

const base = (over: Partial<Allocation> = {}): Allocation => ({
  employeeId: 'e1', projectId: 'p1', percentage: 50,
  startsOn: '2026-09-01', endsOn: '2026-09-30', state: 'ACTIVE', ...over,
});

describe('rangesOverlap', () => {
  it('sees an overlap of a single day', () => {
    expect(rangesOverlap(
      { startsOn: '2026-09-01', endsOn: '2026-09-10' },
      { startsOn: '2026-09-10', endsOn: '2026-09-20' })).toBe(true);
  });

  it('sees no overlap when ranges merely touch end to start', () => {
    expect(rangesOverlap(
      { startsOn: '2026-09-01', endsOn: '2026-09-09' },
      { startsOn: '2026-09-10', endsOn: '2026-09-20' })).toBe(false);
  });
});

describe('countsTowardCapacity', () => {
  it('counts planned and active work', () => {
    expect(countsTowardCapacity(base({ state: 'PLANNED' }))).toBe(true);
    expect(countsTowardCapacity(base({ state: 'ACTIVE' }))).toBe(true);
  });

  it('ignores cancelled and completed work', () => {
    // Counting them would make somebody look permanently full from the first
    // project they ever finished.
    expect(countsTowardCapacity(base({ state: 'CANCELLED' }))).toBe(false);
    expect(countsTowardCapacity(base({ state: 'COMPLETED' }))).toBe(false);
  });
});

describe('findCapacityConflict', () => {
  it('allows two part allocations that fit', () => {
    const conflict = findCapacityConflict({
      existing: [base({ id: 'a', percentage: 40 })],
      proposed: base({ percentage: 60 }),
    });
    expect(conflict).toBeNull();
  });

  it('catches a person promised past a hundred per cent', () => {
    // The failure this prevents: a manager commits an engineer who is already
    // full, and nobody finds out until both sites need them on one morning.
    const conflict = findCapacityConflict({
      existing: [base({ id: 'a', percentage: 80 })],
      proposed: base({ percentage: 40 }),
    });
    expect(conflict?.totalPercentage).toBe(120);
    expect(conflict?.overBy).toBe(20);
    expect(conflict?.allocationIds).toEqual(['a']);
  });

  it('ignores an allocation in a different period', () => {
    expect(findCapacityConflict({
      existing: [base({ id: 'a', percentage: 100, startsOn: '2026-08-01', endsOn: '2026-08-31' })],
      proposed: base({ percentage: 100 }),
    })).toBeNull();
  });

  it('ignores an allocation for a different person', () => {
    expect(findCapacityConflict({
      existing: [base({ id: 'a', employeeId: 'e2', percentage: 100 })],
      proposed: base({ percentage: 100 }),
    })).toBeNull();
  });

  it('does not count a cancelled allocation against capacity', () => {
    expect(findCapacityConflict({
      existing: [base({ id: 'a', percentage: 100, state: 'CANCELLED' })],
      proposed: base({ percentage: 100 }),
    })).toBeNull();
  });

  it('finds the worst day when allocations stack part-way through', () => {
    // Two 40% allocations start at different times; the peak is where they
    // overlap, not where either begins alone.
    const conflict = findCapacityConflict({
      existing: [
        base({ id: 'a', percentage: 40, startsOn: '2026-09-01', endsOn: '2026-09-30' }),
        base({ id: 'b', percentage: 40, startsOn: '2026-09-15', endsOn: '2026-09-30' }),
      ],
      proposed: base({ percentage: 40, startsOn: '2026-09-10', endsOn: '2026-09-20' }),
    });
    expect(conflict?.date).toBe('2026-09-15');
    expect(conflict?.totalPercentage).toBe(120);
  });

  it('catches a single allocation over capacity on its own', () => {
    expect(findCapacityConflict({ existing: [], proposed: base({ percentage: 100 }) })).toBeNull();
    const conflict = findCapacityConflict({
      existing: [], proposed: base({ percentage: 100 }), capacityPercentage: 80,
    });
    expect(conflict?.overBy).toBe(20);
  });

  it('does not conflict with its own earlier version when editing', () => {
    // Editing an allocation must not treat the row being edited as a rival.
    expect(findCapacityConflict({
      existing: [base({ id: 'a', percentage: 100 })],
      proposed: base({ id: 'a', percentage: 100 }),
    })).toBeNull();
  });
});

describe('utilisation', () => {
  it('reports what is promised and what is free on a day', () => {
    const u = utilisation([
      base({ percentage: 30 }),
      base({ percentage: 25, projectId: 'p2' }),
    ], '2026-09-15');
    expect(u.allocated).toBe(55);
    expect(u.free).toBe(45);
    expect(u.over).toBe(false);
  });

  it('reports an over-commitment as negative free time', () => {
    const u = utilisation([base({ percentage: 80 }), base({ percentage: 50, projectId: 'p2' })], '2026-09-15');
    expect(u.over).toBe(true);
    expect(u.free).toBe(-30);
  });

  it('counts nobody on a day outside every allocation', () => {
    expect(utilisation([base({ percentage: 80 })], '2026-10-15').allocated).toBe(0);
  });
});

describe('shiftHours', () => {
  it('measures an ordinary day shift', () => {
    expect(shiftHours({ code: 'D', startsAt: '09:00', endsAt: '18:00', breakMinutes: 60 })).toBe(8);
  });

  it('measures a night shift that crosses midnight', () => {
    // 22:00 to 06:00 is eight hours, not minus sixteen. Getting this wrong
    // does not look silly — it quietly underpays the people working nights.
    expect(shiftHours({ code: 'N', startsAt: '22:00', endsAt: '06:00' })).toBe(8);
  });

  it('subtracts the unpaid break', () => {
    expect(shiftHours({ code: 'D', startsAt: '08:00', endsAt: '20:00', breakMinutes: 90 })).toBe(10.5);
  });
});

describe('isRestDay', () => {
  it('knows a configured rest day', () => {
    // 2026-09-13 is a Sunday.
    expect(isRestDay({ code: 'D', startsAt: '09:00', endsAt: '18:00', restDays: ['SUN'] }, '2026-09-13'))
      .toBe(true);
    expect(isRestDay({ code: 'D', startsAt: '09:00', endsAt: '18:00', restDays: ['SUN'] }, '2026-09-14'))
      .toBe(false);
  });

  it('treats a shift with no rest days as having none', () => {
    expect(isRestDay({ code: 'D', startsAt: '09:00', endsAt: '18:00' }, '2026-09-13')).toBe(false);
  });
});

describe('dayPay', () => {
  const rule = { dailyThresholdHours: 8, multiplier: 1.5, restDayMultiplier: 2 };

  it('pays a normal day at normal rates', () => {
    const p = dayPay({ workedHours: 8, rule });
    expect(p.normalHours).toBe(8);
    expect(p.overtimeHours).toBe(0);
    expect(p.payableHours).toBe(8);
  });

  it('applies the multiplier only to the hours past the threshold', () => {
    const p = dayPay({ workedHours: 10, rule });
    expect(p.normalHours).toBe(8);
    expect(p.overtimeHours).toBe(2);
    expect(p.payableHours).toBe(11);
  });

  it('treats every hour on a rest day as premium', () => {
    // There is no "normal" portion of a day somebody was not rostered at all.
    const p = dayPay({ workedHours: 6, rule, onRestDay: true });
    expect(p.normalHours).toBe(0);
    expect(p.overtimeHours).toBe(6);
    expect(p.payableHours).toBe(12);
  });

  it('falls back to the ordinary multiplier when no rest-day rate is set', () => {
    const p = dayPay({ workedHours: 4, rule: { dailyThresholdHours: 8, multiplier: 1.5 }, onRestDay: true });
    expect(p.payableHours).toBe(6);
  });

  it('never pays for negative hours', () => {
    expect(dayPay({ workedHours: -3, rule }).payableHours).toBe(0);
  });
});

describe('allocation lifecycle', () => {
  it('cannot resurrect a completed allocation', () => {
    expect(ALLOCATION_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it('goes planned to active to completed', () => {
    expect(ALLOCATION_TRANSITIONS.PLANNED).toContain('ACTIVE');
    expect(ALLOCATION_TRANSITIONS.ACTIVE).toContain('COMPLETED');
  });
});

describe('allocation grants', () => {
  it('lets a project manager knowingly over-commit their own people', () => {
    // They are the one who has to make it work, so they hold the override.
    expect(ALLOCATION_ROLE_GRANTS.PROJECT_MANAGER).toContain('allocation.override');
  });

  it('does not let a team lead change allocations', () => {
    expect(ALLOCATION_ROLE_GRANTS.TEAM_LEAD).toEqual(['allocation.read', 'roster.read']);
  });

  it('gives payroll the roster to read but not to write', () => {
    // Payroll consumes the approved result; it does not decide the roster.
    expect(ALLOCATION_ROLE_GRANTS.PAYROLL_OFFICER).toContain('roster.read');
    expect(ALLOCATION_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain('roster.manage');
  });

  it('names every granted permission in the permission list', () => {
    const known = new Set<string>(ALLOCATION_PERMISSIONS);
    for (const perms of Object.values(ALLOCATION_ROLE_GRANTS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});

describe('schemas', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('refuses an allocation that ends before it starts', () => {
    expect(allocationSchema.safeParse({
      employee_id: uuid, project_id: uuid, percentage: 50,
      starts_on: '2026-09-30', ends_on: '2026-09-01',
    }).success).toBe(false);
  });

  it('refuses an allocation of zero or more than all of somebody', () => {
    const at = (percentage: number) => allocationSchema.safeParse({
      employee_id: uuid, project_id: uuid, percentage,
      starts_on: '2026-09-01', ends_on: '2026-09-30',
    }).success;
    expect(at(0)).toBe(false);
    expect(at(101)).toBe(false);
    expect(at(100)).toBe(true);
  });

  it('refuses a shift whose break swallows the whole span', () => {
    expect(shiftSchema.safeParse({
      code: 'X', name: 'Broken', starts_at: '09:00', ends_at: '10:00',
      break_minutes: 60, effective_from: '2026-09-01',
    }).success).toBe(false);
  });

  it('accepts a night shift crossing midnight', () => {
    expect(shiftSchema.safeParse({
      code: 'N', name: 'Night', starts_at: '22:00', ends_at: '06:00',
      effective_from: '2026-09-01',
    }).success).toBe(true);
  });

  it('refuses a roster window that ends before it starts', () => {
    expect(rosterBulkSchema.safeParse({
      shift_id: uuid, starts_on: '2026-09-30', ends_on: '2026-09-01', employee_ids: [uuid],
    }).success).toBe(false);
  });
});
