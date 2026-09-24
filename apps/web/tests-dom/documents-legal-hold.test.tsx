/**
 * The document register can show a legal-hold badge (documents/page.tsx),
 * and POST /api/v1/documents/:id/legal-hold exists server-side
 * (§46.6.2, DOCUMENT_ROLE_GRANTS AUDITOR: document.legalhold +
 * document.legalhold.release) -- but nothing on the page ever called it.
 * An auditor or administrator holding the permission had no way to place or
 * release a hold at all; the feature was backend-only. Found live during the
 * round-2 post-deploy deep walk (documents module).
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const REGISTER_ROWS = [
  { id: 'd-open', title: 'Labour licence', type_label: 'Labour', category: 'statutory',
    owner_type: 'organization', reference_number: 'REF-1', expires_on: '2027-01-01',
    days_remaining: 90, state: 'VALID', legal_hold: false, version: 3 },
  { id: 'd-held', title: 'Insurance policy', type_label: 'Insurance', category: 'statutory',
    owner_type: 'organization', reference_number: 'REF-2', expires_on: '2027-02-01',
    days_remaining: 120, state: 'VALID', legal_hold: true, version: 5 },
];

let apiRequest: ReturnType<typeof vi.fn>;
let apiRequestRaw: ReturnType<typeof vi.fn>;

function mockSession(permissions: string[]) {
  vi.doMock('@/components/AuthProvider', () => ({
    useAuth: () => ({ session: { permissions, roles: ['ADMIN'], user: { id: 'u1' } }, status: 'authenticated' }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  }));
}

beforeEach(() => {
  vi.resetModules();
  apiRequest = vi.fn(async (path: string) => {
    if (path.includes('/legal-hold')) return { data: { ...REGISTER_ROWS[0], legal_hold: true } };
    return { data: {} };
  });
  apiRequestRaw = vi.fn(async (path: string) => {
    if (path.startsWith('/api/v1/documents?')) return { body: { data: REGISTER_ROWS, summary: {} }, requestId: 't' };
    if (path.startsWith('/api/v1/documents/renewals')) return { body: { data: [] }, requestId: 't' };
    return { body: { data: [] }, requestId: 't' };
  });
  vi.doMock('@/lib/apiClient', () => ({ apiRequest, apiRequestRaw }));
  vi.doMock('@/components/AppShell', () => ({
    AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  }));
});

function wrap(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(React.createElement(QueryClientProvider, { client }, node));
}

async function openRegister() {
  const { default: DocumentsPage } = await import('@/app/documents/page');
  wrap(<DocumentsPage />);
  fireEvent.click(screen.getByText('The register'));
  await screen.findByText('Labour licence');
}

describe('Documents register: legal hold (round-2 deep walk finding)', () => {
  it('offers to place a hold on a document that has none, for a holder of document.legalhold', async () => {
    mockSession(['document.read', 'document.manage', 'document.legalhold', 'document.legalhold.release']);
    await openRegister();

    const placeBtn = screen.getByRole('button', { name: /^place hold$/i });
    expect(placeBtn).toBeInTheDocument();
    // The row already on hold offers release, not another place.
    expect(screen.getByRole('button', { name: /^release hold$/i })).toBeInTheDocument();

    fireEvent.click(placeBtn);
    const reasonBox = await screen.findByLabelText(/reason/i);
    const submit = screen.getByRole('button', { name: /^confirm hold$/i });

    // A hold needs a reason (legalHoldSchema: min 3 chars) -- blank must not submit.
    expect(submit).toBeDisabled();
    fireEvent.change(reasonBox, { target: { value: 'Under litigation' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      '/api/v1/documents/d-open/legal-hold',
      expect.objectContaining({
        method: 'POST',
        body: { legal_hold: true, reason: 'Under litigation' },
        headers: expect.objectContaining({ 'If-Match': '3' }),
      }),
    ));
  });

  it('releases a hold without demanding a reason', async () => {
    mockSession(['document.read', 'document.manage', 'document.legalhold', 'document.legalhold.release']);
    await openRegister();

    fireEvent.click(screen.getByRole('button', { name: /^release hold$/i }));
    const confirmBtn = await screen.findByRole('button', { name: /^confirm release$/i });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      '/api/v1/documents/d-held/legal-hold',
      expect.objectContaining({
        method: 'POST',
        body: { legal_hold: false },
        headers: expect.objectContaining({ 'If-Match': '5' }),
      }),
    ));
  });

  it('hides the hold controls from a reader without document.legalhold / .release', async () => {
    // document.read alone (an ordinary reader, or a role holding read but not
    // the hold permissions) must see the badge but get no button that would
    // only 403 if pressed.
    mockSession(['document.read']);
    await openRegister();
    expect(screen.queryByRole('button', { name: /^place hold$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^release hold$/i })).not.toBeInTheDocument();
    // The read-only badge for the already-held document still shows.
    expect(screen.getByText('Legal hold')).toBeInTheDocument();
  });

  it('offers release but not place to a holder of only the release permission', async () => {
    mockSession(['document.read', 'document.legalhold.release']);
    await openRegister();
    expect(screen.queryByRole('button', { name: /^place hold$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^release hold$/i })).toBeInTheDocument();
  });
});
