/**
 * The organisation settings form starts from the record.
 *
 * It used to start from defaults written into the page -- thirty minutes,
 * a year -- so saving a corrected name also put the session timeout back
 * without any field ever looking wrong. This mounts the real form against a
 * stubbed server and checks that what it shows is what the server said.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { OrgSettingsForm } from '@/components/OrgSettingsForm';
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
    roles: ['SUPER_ADMIN'], permissions: ['admin.configure'], impersonation: null,
  },
};
const SETTINGS = {
  id: 'o1', name: 'Silverline Techno Solutions',
  settings: { timezone: 'Asia/Kolkata', session_timeout_minutes: 720, retention_days: 3650 },
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
    if (path === '/api/v1/admin/settings' && (init?.method ?? 'GET') === 'GET') return jsonResponse(SETTINGS);
    if (path === '/api/v1/admin/settings' && init?.method === 'PATCH') {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return jsonResponse({ ...SETTINGS, name: 'Silverline' });
    }
    return jsonResponse({ data: null }, 404);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('organisation settings form', () => {
  it('shows the values the organisation has, not defaults, and sends only what changed', async () => {
    render(<AuthProvider><OrgSettingsForm /></AuthProvider>);

    const name = await screen.findByLabelText(/Organization name/) as HTMLInputElement;
    expect(name.value).toBe('Silverline Techno Solutions');
    expect((screen.getByLabelText(/idle minutes/) as HTMLInputElement).value).toBe('720');
    expect((screen.getByLabelText(/Keep records/) as HTMLInputElement).value).toBe('3650');
    // Unset stays visibly unset.
    expect((screen.getByLabelText(/Locale/) as HTMLInputElement).value).toBe('');

    fireEvent.change(name, { target: { value: 'Silverline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({
      name: 'Silverline',
      // The timeout and retention go back exactly as they were, not as 30 and 365.
      // match_tolerance always goes over explicit (item 5, final QA fix wave):
      // all-null here is a no-op, since this organisation never had one set.
      settings: {
        timezone: 'Asia/Kolkata', session_timeout_minutes: 720, retention_days: 3650,
        match_tolerance: { quantity_pct: null, rate_pct: null, value_absolute: null },
      },
    });
  });
});
