/**
 * R5-008 — bulk-open next year's leave balances (leave.admin).
 *
 * Web: a button that dry-runs first (so the confirm shows real preview
 * counts) then writes for real on confirm, plus a December-onward banner
 * nudging admins who have not opened next year's balances yet — otherwise a
 * request crossing into January 422s for lack of a row, not for lack of
 * entitlement.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/components/AuthProvider';
import { __resetAuthStateForTests, setTokens } from '@/lib/apiClient';

const openYearBalances = vi.fn();

vi.mock('@/lib/leave', async (orig) => ({
  ...(await orig<typeof import('@/lib/leave')>()),
  listTypes: vi.fn(async () => []),
  listBalances: vi.fn(async () => []),
  openYearBalances: (...args: unknown[]) => openYearBalances(...args),
}));

let isDecember = true;
vi.mock('@/lib/finance', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance')>()),
  businessToday: () => (isDecember ? '2026-12-05' : '2026-06-05'),
}));

const { BalancesPanel } = await import('@/app/leave/balances/page');

function meFor(permissions: string[]) {
  return {
    data: {
      user: { id: 'a1', username: 'admin', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
              mfa_enabled: true, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
      roles: ['SUPER_ADMIN'], permissions, impersonation: null,
    },
  };
}
const ME_ADMIN = meFor(['leave.admin', 'leave.request']);
const ME_NO_ADMIN = meFor(['leave.request']);
let ME = ME_ADMIN;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

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

beforeEach(() => {
  ME = ME_ADMIN;
  isDecember = true;
  openYearBalances.mockReset();
  openYearBalances.mockResolvedValue({ year: 2027, created: 0, skipped: 3, total: 10, dry_run: true });
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <BalancesPanel />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('R5-008 open-year button', () => {
  it('shows "Open 2027 balances" to a leave.admin session and previews via dry-run before writing', async () => {
    // Outside the December-banner scenario (tested separately below), so the
    // toolbar button's accessible name is unambiguous.
    isDecember = false;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open 2027 balances' }));

    const dialog = await screen.findByRole('dialog', { name: 'Open 2027 balances' });
    await waitFor(() => expect(openYearBalances).toHaveBeenCalledWith({ year: 2027, dry_run: true }));
    expect(await within(dialog).findByText(/Would create/)).toHaveTextContent('Would create 7 of 10');

    openYearBalances.mockResolvedValueOnce({ year: 2027, created: 7, skipped: 3, total: 10, dry_run: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open 2027 balances' }));

    await waitFor(() =>
      expect(openYearBalances).toHaveBeenCalledWith({ year: 2027 }),
    );
    expect(await within(dialog).findByText(/Opened 2027: 7 created, 3 already existed/)).toBeInTheDocument();
  });

  it('hides the button from a session without leave.admin', async () => {
    ME = ME_NO_ADMIN;
    mount();
    await screen.findByLabelText('Employee');
    expect(screen.queryByRole('button', { name: 'Open 2027 balances' })).not.toBeInTheDocument();
  });
});

describe('R5-008 December rollover banner', () => {
  it('nudges an admin from 1 December when next year is not fully open', async () => {
    mount();
    expect(await screen.findByText(/not open yet/)).toHaveTextContent('7 employee x type balances for 2027 are not open yet');
  });

  it('says nothing before December', async () => {
    isDecember = false;
    mount();
    await screen.findByLabelText('Employee');
    expect(screen.queryByText(/not open yet/)).not.toBeInTheDocument();
    expect(openYearBalances).not.toHaveBeenCalled();
  });

  it('says nothing once next year is already fully open', async () => {
    openYearBalances.mockResolvedValue({ year: 2027, created: 0, skipped: 10, total: 10, dry_run: true });
    mount();
    await waitFor(() => expect(openYearBalances).toHaveBeenCalledWith({ year: 2027, dry_run: true }));
    expect(screen.queryByText(/not open yet/)).not.toBeInTheDocument();
  });

  it('says nothing to a session without leave.admin', async () => {
    ME = ME_NO_ADMIN;
    mount();
    await screen.findByLabelText('Employee');
    expect(openYearBalances).not.toHaveBeenCalled();
    expect(screen.queryByText(/not open yet/)).not.toBeInTheDocument();
  });
});
