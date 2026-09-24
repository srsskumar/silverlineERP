/**
 * Fix round 1, item 2 — the leave request form's "N days" preview used to
 * count calendar days client-side (inclusiveDays), which overstates a paid
 * request under the sandwich rule (D-012): a Fri-Mon range read "4 days
 * (inclusive)" while filing would actually charge 3, or fewer with a
 * holiday in the range. It now asks GET /api/v1/leave/preview -- the same
 * day-counting function filing itself uses -- instead of a second guess.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeaveRequestForm } from '@/components/LeaveRequestForm';

const previewLeave = vi.fn();
const fileRequest = vi.fn();

vi.mock('@/lib/leave', async (orig) => ({
  ...(await orig<typeof import('@/lib/leave')>()),
  previewLeave: (...args: unknown[]) => previewLeave(...args),
  fileRequest: (...args: unknown[]) => fileRequest(...args),
}));

const CL = { id: 'lt_cl', code: 'CL', name: 'Casual', is_paid: true, annual_entitlement: 12, requires_balance: true };

beforeEach(() => {
  previewLeave.mockReset();
  fileRequest.mockReset();
});

afterEach(() => vi.restoreAllMocks());

function mount() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <LeaveRequestForm types={[CL]} balances={[]} />
    </QueryClientProvider>,
  );
}

describe('LeaveRequestForm day-count preview', () => {
  it('shows the server-computed total, not a calendar-day count of the range', async () => {
    previewLeave.mockResolvedValue({
      leave_type_id: 'lt_cl', is_paid: true, from_date: '2027-01-01', to_date: '2027-01-04',
      total_days: 3, years: [{ year: 2027, days: 3 }],
    });
    mount();

    fireEvent.change(screen.getByLabelText(/Leave type/), { target: { value: 'lt_cl' } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2027-01-04' } });

    await waitFor(() =>
      expect(previewLeave).toHaveBeenCalledWith({
        leave_type_id: 'lt_cl', from_date: '2027-01-01', to_date: '2027-01-04',
      }),
    );
    // 4 calendar days in the range; the server says 3 (a Sunday excluded).
    // The badge must show the server's figure, not "4 days".
    expect(await screen.findByText(/3\s*days?/)).toBeInTheDocument();
    expect(screen.queryByText(/4 days/)).not.toBeInTheDocument();
  });

  it('warns instead of showing "0 days" when every day in the range is excluded', async () => {
    previewLeave.mockResolvedValue({
      leave_type_id: 'lt_cl', is_paid: true, from_date: '2027-01-02', to_date: '2027-01-03',
      total_days: 0, years: [{ year: 2027, days: 0 }],
    });
    mount();

    fireEvent.change(screen.getByLabelText(/Leave type/), { target: { value: 'lt_cl' } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2027-01-02' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2027-01-03' } });

    expect(await screen.findByText(/Sunday or a holiday/)).toBeInTheDocument();
    expect(screen.queryByText(/0 days/)).not.toBeInTheDocument();
  });
});
