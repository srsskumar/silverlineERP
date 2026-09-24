/**
 * Certifying a village's totals sends the version it replaces (SV-016).
 *
 * The API refuses to replace or clear a certified figure without the version
 * it was read at, so a recount somebody else has just certified is not
 * overwritten unseen. These pin the exact requests the web makes.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
const apiRequestRaw = vi.fn();
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiClient')>()),
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  apiRequestRaw: (...args: unknown[]) => apiRequestRaw(...args),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { roles: ['ADMIN'], permissions: [] } }),
}));

const { CertifiedTotals } = await import('@/components/survey/VillageDetail');

const FIGURES = [
  { code: 'PRIVATE_LAND_EXTENT_AC', label: 'Private extent', unit: 'Ac', recorded: 40,
    certified: 38.5, difference: -1.5, reason: 'Recount', version: 3 },
  { code: 'GOVT_LAND_EXTENT_AC', label: 'Government extent', unit: 'Ac', recorded: 12,
    certified: null, difference: null, reason: null, version: null },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CertifiedTotals village={{ id: 'v1', stages: { GROUND_TRUTHING: 'COMPLETED' } }} canCertify />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequest.mockReset();
  apiRequestRaw.mockReset();
  apiRequestRaw.mockResolvedValue({ body: { data: FIGURES }, status: 200 });
  Object.values(toast).forEach((f) => f.mockReset());
});

describe('certified totals', () => {
  it('sends the version of a figure it replaces, and none for a new one', async () => {
    apiRequest.mockResolvedValueOnce({ data: { certified: 2 } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Certify totals' }));
    const quantities = await screen.findAllByPlaceholderText(/^\d/);
    const reasons = screen.getAllByPlaceholderText('Recount at handover');
    fireEvent.change(quantities[0], { target: { value: '39' } });
    fireEvent.change(reasons[0], { target: { value: 'Second recount' } });
    fireEvent.change(quantities[1], { target: { value: '11.25' } });
    fireEvent.change(reasons[1], { target: { value: 'First recount' } });
    fireEvent.click(screen.getByRole('button', { name: /Certify 2 measures/ }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/survey/villages/v1/finals', {
      method: 'PUT',
      body: {
        finals: [
          { measure_code: 'PRIVATE_LAND_EXTENT_AC', quantity: 39, reason: 'Second recount', version: 3 },
          { measure_code: 'GOVT_LAND_EXTENT_AC', quantity: 11.25, reason: 'First recount' },
        ],
      },
    });
  });

  it('clears a figure with its version as If-Match', async () => {
    apiRequest.mockResolvedValueOnce({ data: { cleared: 1 } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Certify totals' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    expect(apiRequest).toHaveBeenCalledWith(
      '/api/v1/survey/villages/v1/finals/PRIVATE_LAND_EXTENT_AC',
      { method: 'DELETE', headers: { 'If-Match': '3' } },
    );
  });
});
