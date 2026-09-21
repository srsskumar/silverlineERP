import { describe, expect, it } from 'vitest';
import {
  LOP_INFORMATIONAL_LABEL,
  calculatePayslip,
  formatPayslipDays,
  payslipView,
  type PayslipCalculationInput,
} from './p1.js';

/**
 * One payslip's arithmetic.
 *
 * August 2026 starts on a Saturday; its Sundays are the 2nd, 9th, 16th, 23rd
 * and 30th, so it has 31 days, 5 Sundays and 26 working days. A Rs 30,000
 * basic over the default divisor of 30 is Rs 1,000 a day; PF is 12%.
 */
const AUG_SUNDAYS = new Set(['2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30']);

function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Full attendance on every non-Sunday in the range, minus any skipped dates. */
function present(from: string, to: string, skip: string[] = []): Map<string, number> {
  const isSunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
  return new Map(
    daysOf(from, to).filter((d) => !isSunday(d) && !skip.includes(d)).map((d) => [d, 1]),
  );
}

function slip(over: Partial<PayslipCalculationInput>) {
  return calculatePayslip({
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    dateOfJoining: '2024-01-01',
    dateOfExit: null,
    basicPaise: 3_000_000,
    perDayDivisor: 30,
    pfPct: 12,
    holidays: new Set(),
    attendance: new Map(),
    leaves: [],
    ...over,
  });
}

describe('calculatePayslip', () => {
  it('pays a full 31-day month of attendance exactly the monthly basic', () => {
    const s = slip({ attendance: present('2026-08-01', '2026-08-31') });
    expect(s.workingDays).toBe(26);
    expect(s.paidOffDays).toBe(5);
    expect(s.presentDays).toBe(26);
    expect(s.payableDays).toBe(31);
    expect(s.unpaidDays).toBe(0);
    // Not 31 x 1,000: a whole month earns the monthly basic.
    expect(s.grossPaise).toBe(3_000_000);
    expect(s.pfPaise).toBe(360_000);
    expect(s.totalDeductionsPaise).toBe(360_000);
    expect(s.netPaise).toBe(2_640_000);
  });

  it('pays a full 28-day February the monthly basic too', () => {
    const s = slip({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      attendance: present('2026-02-01', '2026-02-28'),
    });
    expect(s.unpaidDays).toBe(0);
    expect(s.grossPaise).toBe(3_000_000);
  });

  it('charges an unpaid day exactly one per_day, once', () => {
    // One working day (Monday the 3rd) with no punch and no leave.
    const s = slip({ attendance: present('2026-08-01', '2026-08-31', ['2026-08-03']) });
    expect(s.absentDays).toBe(1);
    expect(s.lopPaise).toBe(100_000);
    // 30,000 - 1,000 = 29,000; PF 12% = 3,480; net 25,520. LOP is not in
    // total deductions: it is already out of gross.
    expect(s.grossPaise).toBe(2_900_000);
    expect(s.totalDeductionsPaise).toBe(348_000);
    expect(s.netPaise).toBe(2_552_000);
  });

  it('pays Sundays and holidays without anyone punching, and never as LOP', () => {
    // Independence Day, Saturday the 15th, is this employee's holiday. No
    // punch on it and none on any Sunday, yet nothing is lost.
    const attendance = present('2026-08-01', '2026-08-31', ['2026-08-15']);
    const s = slip({ holidays: new Set(['2026-08-15']), attendance });
    expect(s.paidOffDays).toBe(6);
    expect(s.workingDays).toBe(25);
    expect(s.unpaidDays).toBe(0);
    expect(s.grossPaise).toBe(3_000_000);

    // Without the holiday on their calendar the same day is an absence.
    const other = slip({ attendance });
    expect(other.unpaidDays).toBe(1);
    expect(other.grossPaise).toBe(2_900_000);
  });

  it('pays a leaver for the days up to and including the exit date', () => {
    // Exit on Thursday the 20th: 20 employed days, Sundays 2, 9 and 16 among
    // them. Part month, so 20 x 1,000 = 20,000; PF 2,400; net 17,600.
    const s = slip({ dateOfExit: '2026-08-20', attendance: present('2026-08-01', '2026-08-20') });
    expect(s.windowEnd).toBe('2026-08-20');
    expect(s.employedDays).toBe(20);
    expect(s.paidOffDays).toBe(3);
    expect(s.unpaidDays).toBe(0);
    expect(s.grossPaise).toBe(2_000_000);
    expect(s.netPaise).toBe(1_760_000);
  });

  it('pays a joiner from the joining date, not for the days before it', () => {
    // Joins Monday the 17th: 15 employed days, Sundays 23 and 30 among them.
    // The days before joining are neither paid nor LOP.
    const s = slip({ dateOfJoining: '2026-08-17', attendance: present('2026-08-17', '2026-08-31') });
    expect(s.windowStart).toBe('2026-08-17');
    expect(s.employedDays).toBe(15);
    expect(s.paidOffDays).toBe(2);
    expect(s.unpaidDays).toBe(0);
    expect(s.lopPaise).toBe(0);
    expect(s.grossPaise).toBe(1_500_000);
  });

  it('caps a part month at the monthly basic', () => {
    // Joins on the 2nd: 30 days x 1,000 is exactly the basic, never more.
    const s = slip({ dateOfJoining: '2026-08-02', attendance: present('2026-08-02', '2026-08-31') });
    expect(s.entitlementPaise).toBe(3_000_000);
    expect(s.grossPaise).toBe(3_000_000);
  });

  it('pays a day with both a punch and an approved paid leave once', () => {
    const s = slip({
      periodStart: '2026-08-03',
      periodEnd: '2026-08-04',
      attendance: new Map([['2026-08-03', 1]]),
      leaves: [{ from: '2026-08-03', to: '2026-08-04', paid: true }],
    });
    expect(s.presentDays).toBe(1);
    expect(s.paidLeaveDays).toBe(1);
    expect(s.payableDays).toBe(2);
    expect(s.grossPaise).toBe(200_000);
  });

  it('does not count leave on a Sunday as leave taken', () => {
    // CL Saturday 1st to Monday 3rd spans Sunday the 2nd: two leave days,
    // one paid Sunday. Tuesday and Wednesday are unattended: 2 days LOP.
    const s = slip({
      periodEnd: '2026-08-05',
      leaves: [{ from: '2026-08-01', to: '2026-08-03', paid: true }],
    });
    expect(s.paidLeaveDays).toBe(2);
    expect(s.paidOffDays).toBe(1);
    expect(s.unpaidDays).toBe(2);
    expect(s.grossPaise).toBe(300_000);
  });

  it('prefers paid over unpaid leave on the same day, and half-pays a PARTIAL day', () => {
    const s = slip({
      periodStart: '2026-08-03',
      periodEnd: '2026-08-04',
      attendance: new Map([['2026-08-04', 0.5]]),
      leaves: [
        { from: '2026-08-03', to: '2026-08-03', paid: true },
        { from: '2026-08-03', to: '2026-08-03', paid: false },
      ],
    });
    expect(s.paidLeaveDays).toBe(1);
    expect(s.lopLeaveDays).toBe(0);
    expect(s.absentDays).toBe(0.5);
    expect(s.lopPaise).toBe(50_000);
    expect(s.grossPaise).toBe(150_000);
  });

  it('pays nothing and deducts nothing without a salary', () => {
    const s = slip({ basicPaise: null, attendance: present('2026-08-01', '2026-08-31') });
    expect(s.grossPaise).toBe(0);
    expect(s.pfPaise).toBe(0);
    expect(s.netPaise).toBe(0);
  });

  it('prices a two-month run month by month', () => {
    // All of August (basic) plus 1-10 September as a part month (10 x 1,000).
    const s = slip({
      periodEnd: '2026-09-10',
      attendance: present('2026-08-01', '2026-09-10'),
    });
    expect(s.entitlementPaise).toBe(4_000_000);
    expect(s.grossPaise).toBe(4_000_000);
  });

  it('agrees with the August calendar it is documented against', () => {
    const sundays = daysOf('2026-08-01', '2026-08-31').filter(
      (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0,
    );
    expect(new Set(sundays)).toEqual(AUG_SUNDAYS);
  });
});

describe('payslipView', () => {
  const earnings = {
    basic: 30000, per_day: 1000, payable_days: 4.5, present_days: 1.5,
    paid_leave_days: 2, paid_off_days: 1, lop_leave_days: 0,
  };
  const deductions = { lop_days: 0.5, lop_amount: 500, pf: 540 };

  it('separates day counts from money', () => {
    const v = payslipView(earnings, deductions, 540);
    expect(v.rates.map((l) => l.key)).toEqual(['basic', 'per_day']);
    expect(v.rates.every((l) => l.kind === 'money')).toBe(true);
    expect(v.days.map((l) => l.key)).toEqual([
      'payable_days', 'present_days', 'paid_leave_days', 'paid_off_days', 'lop_leave_days', 'lop_days',
    ]);
    expect(v.days.every((l) => l.kind === 'days')).toBe(true);
    expect(v.days.find((l) => l.key === 'paid_off_days')?.label).toBe('Sundays and holidays (paid)');
  });

  it('shows LOP as information, so the deductions add up to their total', () => {
    const v = payslipView(earnings, deductions, '540.00');
    expect(v.deductions.map((l) => l.key)).toEqual(['pf']);
    expect(v.deductions.reduce((t, l) => t + l.value, 0)).toBe(540);
    expect(v.notes).toEqual([
      { key: 'lop_amount', label: LOP_INFORMATIONAL_LABEL, kind: 'money', value: 500 },
    ]);
  });

  it('shows a slip from before the LOP fix as it was paid', () => {
    // Its total included LOP a second time: 500 + 540.
    const v = payslipView(earnings, deductions, 1040);
    expect(v.deductions.map((l) => [l.key, l.label])).toEqual([
      ['pf', 'Provident fund'],
      ['lop_amount', 'Loss of pay'],
    ]);
    expect(v.notes).toEqual([]);
  });

  it('keeps unknown deductions as money that counts, labelled readably', () => {
    const v = payslipView({}, { pf: 4800, professional_tax: 200 }, 5000);
    expect(v.deductions.map((l) => l.label)).toEqual(['Provident fund', 'Professional tax']);
  });

  it('formats a day count as a count', () => {
    expect(formatPayslipDays(1)).toBe('1 day');
    expect(formatPayslipDays(4.5)).toBe('4.5 days');
    expect(formatPayslipDays(0)).toBe('0 days');
  });
});
