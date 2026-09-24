/**
 * A-012: `/org/holidays` had no edit or deactivate control even though
 * `PATCH /holidays/:id` has always accepted date/name/type/active/reason.
 * This mounts the real edit dialog against a stubbed server and checks that
 * it sends only the field that changed, plus the reason the API requires —
 * not the whole record, and not a reason-less body.
 *
 * Follows apps/web/tests-dom/org-settings-form.test.tsx's shape.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { EditHolidayDialog } from '@/components/HolidayDialogs';
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
    roles: ['SUPER_ADMIN'], permissions: ['holiday.manage', 'holiday.read'], impersonation: null,
  },
};

const HOLIDAY = {
  id: 'h1', date: '2026-05-01', name: 'Labour Day', type: 'national',
  scope_type: null, scope_id: null, active: true,
};

const sent: Array<{ path: string; body: unknown }> = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  sent.length = 0;
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    if (path === '/api/v1/holidays/h1' && init?.method === 'PATCH') {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return jsonResponse({ data: { ...HOLIDAY, name: 'Labor Day' } });
    }
    return jsonResponse({ data: null }, 404);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('holiday edit dialog', () => {
  it('PATCHes only the field that changed, plus the required reason', async () => {
    render(
      <AuthProvider>
        <EditHolidayDialog open holiday={HOLIDAY} onClose={() => {}} />
      </AuthProvider>,
    );

    const name = await screen.findByLabelText(/Name/) as HTMLInputElement;
    expect(name.value).toBe('Labour Day');
    // Date and type start from the record, not blank or defaulted.
    expect((screen.getByLabelText(/Date/) as HTMLInputElement).value).toBe('2026-05-01');

    fireEvent.change(name, { target: { value: 'Labor Day' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Fixed the spelling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ name: 'Labor Day', reason: 'Fixed the spelling' });
  });
});
