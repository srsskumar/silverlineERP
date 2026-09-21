/**
 * Start to finish, through the real AuthProvider and the real api client.
 *
 * The component tests mock useAuth, which proves the banner renders and the
 * button calls something. It cannot prove the thing it calls actually puts
 * the administrator back -- and that is where this broke: pressing "stop"
 * left the banner on screen.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/components/AuthProvider';
import { ViewAsBanner } from '@/components/ViewAs';
import { __resetAuthStateForTests, setTokens } from '@/lib/apiClient';

/*
 * This jsdom has no localStorage (node was started without
 * --localstorage-file), and the token store is built on it. A plain map is
 * enough and keeps the thing under test real.
 */
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

const ADMIN_ME = {
  data: {
    user: { id: 'a1', username: 'admin', email: null, phone: null, org_id: 'o1',
            auth_status: 'ACTIVE', mfa_enabled: true, last_login_at: null,
            mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
    roles: ['SUPER_ADMIN'], permissions: ['admin.impersonate'], impersonation: null,
  },
};
const BORROWED_ME = {
  data: {
    user: { ...ADMIN_ME.data.user, id: 'u2', username: 'r.kumar' },
    roles: ['EMPLOYEE'], permissions: [],
    impersonation: { session_id: 's1', actor_id: 'a1', actor_username: 'admin' },
  },
};

let impersonating = false;
const calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400, status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  impersonating = false;
  calls.length = 0;
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');

  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    // The client sends a plain object, not a Headers instance.
    const sent = (init?.headers ?? {}) as Record<string, string>;
    const auth = String(sent.Authorization ?? sent.authorization ?? '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);

    if (path === '/api/v1/auth/me') {
      /*
       * The server decides who you are from the token you present. That is
       * the whole mechanism, so the fake honours it: present the borrowed
       * token and you get the borrowed identity back.
       */
      return jsonResponse(auth.includes('borrowed-access') ? BORROWED_ME : ADMIN_ME);
    }
    if (path === '/api/v1/auth/impersonate') {
      impersonating = true;
      return jsonResponse({ data: {
        access_token: 'borrowed-access', expires_at: new Date(Date.now() + 9e5).toISOString(),
        session_id: 's1', subject: { id: 'u2', username: 'r.kumar', roles: ['EMPLOYEE'] },
        notices: [],
      } }, 201);
    }
    if (path === '/api/v1/auth/impersonate/stop') {
      impersonating = false;
      return jsonResponse({ data: { ended: true, subject_id: 'u2' } });
    }
    return jsonResponse({ data: null }, 404);
  }));
});

afterEach(() => vi.unstubAllGlobals());

function Harness() {
  const { viewAs, session, refetchSession } = useAuth();
  return (
    <>
      <ViewAsBanner />
      <span data-testid="who">{session?.user.username ?? '—'}</span>
      <button onClick={() => void viewAs({ user_id: 'u2', reason: 'Checking the survey tabs' })}>
        start
      </button>
      <button onClick={() => void refetchSession().catch(() => undefined)}>poke</button>
    </>
  );
}

describe('start, then stop', () => {
  it('puts the administrator back and takes the banner down', async () => {
    render(<AuthProvider><Harness /></AuthProvider>);

    await screen.findByText('admin');
    expect(screen.queryByRole('region', { name: /viewing as another user/i })).toBeNull();

    fireEvent.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('r.kumar'));
    expect(screen.getByRole('region', { name: /viewing as another user/i }).textContent).toContain('r.kumar');

    fireEvent.click(screen.getByRole('button', { name: /stop viewing as/i }));

    // The server was told, so the borrowed token is revoked and not merely dropped.
    await waitFor(() => expect(calls).toContain('POST /api/v1/auth/impersonate/stop'));
    // ...and the screen agrees: the banner is gone and the administrator is back.
    await waitFor(() => expect(screen.queryByRole('region', { name: /viewing as another user/i })).toBeNull());
    expect(screen.getByTestId('who').textContent).toBe('admin');
    expect(impersonating).toBe(false);
  });
});

describe('when the borrowed session ends by itself', () => {
  it('takes the banner down on the next request, without anybody pressing stop', async () => {
    /*
     * The session expires, or another tab stops it. The api client notices
     * on the next 401 and puts the administrator back -- and the banner has
     * to follow, or the screen goes on claiming an identity that lapsed
     * minutes ago.
     */
    let lapsed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      const sent = (init?.headers ?? {}) as Record<string, string>;
      const auth = String(sent.Authorization ?? sent.authorization ?? '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/auth/impersonate') {
        return jsonResponse({ data: {
          access_token: 'borrowed-access', expires_at: new Date(Date.now() + 9e5).toISOString(),
          session_id: 's1', subject: { id: 'u2', username: 'r.kumar', roles: ['EMPLOYEE'] },
          notices: [],
        } }, 201);
      }
      if (path === '/api/v1/auth/me') {
        if (auth.includes('borrowed-access')) {
          return lapsed
            ? jsonResponse({ code: 'INVALID_TOKEN', message: 'That view-as session has ended' }, 401)
            : jsonResponse(BORROWED_ME);
        }
        return jsonResponse(ADMIN_ME);
      }
      return jsonResponse({ data: null }, 404);
    }));

    render(<AuthProvider><Harness /></AuthProvider>);
    await screen.findByText('admin');
    fireEvent.click(screen.getByText('start'));
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('r.kumar'));

    lapsed = true;
    fireEvent.click(screen.getByText('poke'));

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /viewing as another user/i })).toBeNull());
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('admin'));
  });
});
