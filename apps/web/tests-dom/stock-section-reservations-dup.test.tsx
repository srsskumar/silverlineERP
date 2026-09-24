/**
 * R5 item 4(b): stock-reservations had two panels showing the same data —
 * this one embedded in StockSection (the inventory Workbench's "Locations"
 * tab) and the fuller StockReservationsTab (its own "Reservations" tab,
 * which also gates the list on reservation.read and adds the create/release
 * forms). Keeping both meant two places that could disagree about which
 * reservations exist. StockSection's copy is removed; StockReservationsTab
 * is the one screen for this now.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { StockSection } from '@/components/v2/StockSection';
import { __resetAuthStateForTests, setTokens } from '@/lib/apiClient';

const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
});

const ME = {
  data: {
    user: { id: 'a1', username: 'admin', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
            mfa_enabled: true, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
    roles: ['SUPER_ADMIN'],
    permissions: ['location.read', 'location.manage', 'stockcount.read', 'stockcount.manage', 'reservation.read', 'stock.read'],
    impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

function stripOrigin(url: string) {
  return String(url).replace(/^https?:\/\/[^/]+/, '');
}

beforeEach(() => {
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = stripOrigin(url);
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('StockSection (R5 item 4b)', () => {
  it('no longer shows its own "Reservations" panel now that reservation.read is granted', async () => {
    mount(<StockSection />);

    // A panel StockSection still owns proves the session/permissions wired up.
    await waitFor(() => expect(screen.getByText('Storage locations')).toBeInTheDocument());

    expect(screen.queryByText('Reservations')).not.toBeInTheDocument();
  });
});
