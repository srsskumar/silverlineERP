/**
 * Enrolling an authenticator signs you out, and says so.
 *
 * POST /auth/mfa/verify revokes every session on the server. The security
 * screen then refetched everything with a token that had just died: the
 * page read "not enabled", spun, and eventually dropped the person on the
 * sign-in form with nothing said. Now the form signs out on purpose, leaves
 * a message for the sign-in screen, and goes there.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { MutationForm } from '@/components/v2/Workbench';
import { LoginNotice } from '@/components/LoginNotice';
import {
  __resetAuthStateForTests, authNavigation, getAccessToken, getRefreshToken, setTokens, takeLoginNotice,
} from '@/lib/apiClient';

// This jsdom has no web storage of its own; a map each is enough.
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
    user: { id: 'u1', username: 'r.kumar', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
            mfa_enabled: false, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
    roles: ['HR_MANAGER'], permissions: [], impersonation: null,
  },
};
const calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetAuthStateForTests();
  setTokens('hr-access', 'hr-refresh');
  vi.spyOn(authNavigation, 'toLogin').mockImplementation(() => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    // The server has revoked every session by the time this answers.
    if (path === '/api/v1/auth/mfa/verify') return jsonResponse({ enabled: true, mfa_enabled: true });
    return jsonResponse({ code: 'INVALID_TOKEN', message: 'Session revoked or expired' }, 401);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a change that revokes every session', () => {
  it('signs out, leaves the reason for the sign-in screen, and goes there', async () => {
    render(
      <AuthProvider>
        <MutationForm
          path="auth/mfa/verify"
          fields={[{ key: 'code', label: 'Authentication code', required: true }]}
          submit="Verify and enable"
          signOutMessage="Two-factor authentication is on. Sign in again with your password and a code from your authenticator."
        />
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText(/Authentication code/), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enable' }));

    await waitFor(() => expect(authNavigation.toLogin).toHaveBeenCalled());
    expect(calls).toContain('POST /api/v1/auth/mfa/verify');
    // Nothing was refetched with the dead token: no query storm, no spinner.
    expect(calls.filter((c) => c === 'GET /api/v1/auth/me').length).toBeLessThanOrEqual(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();

    // ...and the sign-in screen finds the message, once.
    render(<LoginNotice />);
    expect(await screen.findByRole('status')).toHaveTextContent(/Two-factor authentication is on/);
    expect(takeLoginNotice()).toBeNull();
  });
});
