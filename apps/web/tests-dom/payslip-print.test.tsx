/**
 * The payslip an employee reads.
 *
 * It used to list the stored earnings and deductions objects as they were,
 * which printed "payable_days ₹4.50" and put a loss-of-pay figure under
 * Deductions that total_deductions did not include -- so the column did not
 * add up and the reader could only conclude they had been docked twice.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PayslipPrint } from '@/components/PayslipPrint';
import type { MyPayslip } from '@/lib/payroll';

const slip = (over: Partial<MyPayslip> = {}): MyPayslip => ({
  id: 's1',
  period: { start: '2026-08-01', end: '2026-08-05' },
  run_status: 'APPROVED',
  employee: { emp_no: 'EMP1', name: 'R Kumar' },
  earnings: {
    basic: 30000, per_day: 1000, payable_days: 4.5, present_days: 1.5,
    paid_leave_days: 2, paid_off_days: 1, lop_leave_days: 0,
  },
  deductions: { lop_days: 0.5, lop_amount: 500, pf: 540 },
  gross: 4500,
  total_deductions: 540,
  net_pay: 3960,
  version: 1,
  ...over,
});

function section(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).parentElement as HTMLElement;
}

describe('PayslipPrint', () => {
  it('shows day counts as days, not rupees', () => {
    render(<PayslipPrint slip={slip()} />);
    const days = section('Days');
    expect(within(days).getByText('Payable days').nextSibling).toHaveTextContent(/^4\.5 days$/);
    expect(within(days).getByText('Sundays and holidays (paid)').nextSibling).toHaveTextContent(/^1 day$/);
    expect(within(days).getByText('Loss-of-pay days').nextSibling).toHaveTextContent(/^0\.5 days$/);
    expect(days.textContent).not.toContain('₹');
  });

  it('keeps loss of pay out of the deductions and labels it as already excluded', () => {
    render(<PayslipPrint slip={slip()} />);
    const deductions = section('Deductions');
    expect(within(deductions).getByText('Provident fund')).toBeInTheDocument();
    expect(within(deductions).queryByText(/loss of pay/i)).toBeNull();

    const notes = screen.getByTestId('payslip-notes');
    expect(within(notes).getByText('Loss of pay (already excluded from gross)')).toBeInTheDocument();
    expect(notes.textContent).toContain('500.00');
  });

  it('shows a slip calculated before the fix as it was paid, LOP among the deductions', () => {
    render(<PayslipPrint slip={slip({ total_deductions: 1040, net_pay: 3460 })} />);
    expect(within(section('Deductions')).getByText('Loss of pay')).toBeInTheDocument();
    expect(screen.queryByTestId('payslip-notes')).toBeNull();
  });
});
