/**
 * R5-001 fix round 1, item 6: correcting the original write-up.
 *
 * The R5-001 fix (wrapping POST /api/v1/invoices as {data:...}) said no web
 * screen created an invoice through this route -- wrong. The Inventory
 * page's "Invoices" tab (apps/web/app/inventory/page.tsx) has a "Record
 * invoice" panel built from the generic <MutationForm path="invoices" .../>.
 * It still works, because MutationForm submits through apiRequest(), whose
 * unwrap() already tolerates both a bare body and a {data:...} envelope --
 * this pins that down against a regression rather than trusting it by
 * inspection.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { MutationForm } from '@/components/v2/Workbench';
import { __resetAuthStateForTests, setTokens } from '@/lib/apiClient';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: fakeStorage() });

const ME = {
  data: {
    user: { id: 'u1', username: 'inv.clerk', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
            mfa_enabled: false, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
    roles: ['SUPER_ADMIN'], permissions: ['inventory.manage'], impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetAuthStateForTests();
  setTokens('clerk-access', 'clerk-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    if (path === '/api/v1/invoices' && init?.method === 'POST') {
      // The route's actual current shape, post-R5-001: wrapped.
      return jsonResponse({ data: { id: 'inv-new', serial_number: 'INV-1', total: '100.00' } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('Inventory "Record invoice" panel (MutationForm path="invoices")', () => {
  it('unwraps the {data:...} envelope and hands the plain row to onSaved', async () => {
    const onSaved = vi.fn();
    render(
      <AuthProvider>
        <MutationForm
          path="invoices"
          fields={[
            { key: 'serial_number', label: 'Invoice number', required: true },
            { key: 'vendor_id', label: 'Vendor', required: true },
            { key: 'hsn', label: 'HSN', required: true },
            { key: 'subtotal', label: 'Subtotal', type: 'number', required: true },
            { key: 'payment_mode', label: 'Payment mode', required: true },
            { key: 'reference', label: 'Reference', required: true },
          ]}
          submit="Record invoice"
          onSaved={onSaved}
        />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByLabelText(/Invoice number/), { target: { value: 'INV-1' } });
    fireEvent.change(screen.getByLabelText(/^Vendor/), { target: { value: 'vendor-1' } });
    fireEvent.change(screen.getByLabelText(/HSN/), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText(/Subtotal/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/Payment mode/), { target: { value: 'BANK' } });
    fireEvent.change(screen.getByLabelText(/Reference/), { target: { value: 'PO-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record invoice' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // The unwrapped row, not {data: {...}} -- MutationForm's onSaved has
    // always received the plain resource, envelope or not.
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inv-new', serial_number: 'INV-1' }),
    );
    expect(await screen.findByText('Saved successfully.')).toBeInTheDocument();
  });
});
