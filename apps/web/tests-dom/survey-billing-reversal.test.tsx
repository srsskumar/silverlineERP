/**
 * Reversing a payment recorded by mistake, from the web (SV-019, round 2).
 *
 * The API has let an administrator reverse a PAID claim since fix round 1;
 * without a screen nobody could. These pin the exact requests the two ways in
 * send: one claim from the village's billing table, and a batch from the
 * villages list, which previews before it writes.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiClient')>()),
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));

const { ReversePaymentDialog, mayReversePayments } =
  await import('@/components/survey/ReversePaymentDialog');
const { BillingBulkBar } = await import('@/components/survey/BillingBulkBar');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const CLAIM = { id: 'c1', milestone: 1, percent: 50, status: 'PAID', version: 4 };

beforeEach(() => {
  apiRequest.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

describe('who may reverse a payment', () => {
  it('matches the API gate: administrators only', () => {
    expect(mayReversePayments(['ADMIN'])).toBe(true);
    expect(mayReversePayments(['SUPER_ADMIN'])).toBe(true);
    expect(mayReversePayments(['PROJECT_MANAGER'])).toBe(false);
    expect(mayReversePayments(['TEAM_LEAD', 'EMPLOYEE'])).toBe(false);
    expect(mayReversePayments(undefined)).toBe(false);
  });
});

describe('reversing one paid claim', () => {
  it('asks for a reason of five characters, then sends it with If-Match', async () => {
    const done = vi.fn();
    apiRequest.mockResolvedValueOnce({ data: { id: 'c1', status: 'APPROVED' } });
    wrap(<ReversePaymentDialog claim={CLAIM} onDone={done} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Reverse payment' }))
      .find((b) => b.closest('[role=dialog]'))!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'oops' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Paid in error  ' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/survey/billing/c1/reverse', {
      method: 'POST',
      headers: { 'If-Match': '4' },
      body: { reason: 'Paid in error' },
    });
    await waitFor(() => expect(done).toHaveBeenCalled());
  });
});

describe('reversing payments in bulk', () => {
  const VILLAGES = [{ id: 'v1', village_name: 'Adakula', stages: {} }];
  const bar = (canReverse: boolean) => wrap(
    <BillingBulkBar selected={['v1']} villages={VILLAGES} canManage canReverse={canReverse}
      onDone={() => {}} onClear={() => {}} onKeepEligible={() => {}} />,
  );

  it('is not offered to somebody who may not reverse', () => {
    bar(false);
    expect(screen.queryByRole('option', { name: /reversal/i })).toBeNull();
  });

  it('previews with a dry run, then applies, sending the reason', async () => {
    apiRequest
      .mockResolvedValueOnce({ data: { dry_run: true, would_change: 1, villages: ['Adakula'],
        skipped: [], not_found: [], out_of_order: 0, without_extent: 0 } })
      .mockResolvedValueOnce({ data: { dry_run: false, updated: 1, villages: ['Adakula'],
        skipped: [], not_found: [], out_of_order: 0 } });
    bar(true);

    fireEvent.change(screen.getByLabelText('Record'), { target: { value: 'REVERSE' } });
    const show = screen.getByRole('button', { name: 'Show what would happen' });
    expect(show).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for reversing'),
      { target: { value: 'Batch marked paid by mistake' } });
    expect(show).toBeEnabled();
    fireEvent.click(show);

    await screen.findByText('1 payment(s) would be reversed to approved');
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/api/v1/survey/billing/bulk', {
      method: 'POST',
      body: { survey_village_ids: ['v1'], action: 'REVERSE', milestone: 1,
        reason: 'Batch marked paid by mistake', dry_run: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 village(s)' }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/api/v1/survey/billing/bulk', {
      method: 'POST',
      body: { survey_village_ids: ['v1'], action: 'REVERSE', milestone: 1,
        reason: 'Batch marked paid by mistake', dry_run: false },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      '1 payment(s) reversed to approved', undefined));
  });
});
