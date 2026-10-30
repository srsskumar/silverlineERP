/**
 * Configuration → Employees (owner request 2026-10-30): one row per login,
 * each module's resolved state with the person's own overrides marked, a
 * filter bar, and a bulk update that sends exactly the selected ids with
 * `null` for "follow the role". Mounted against a stubbed fetch in the style
 * of tests-dom/approval-policies.test.tsx.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { EmployeeModuleVisibility } from '@/components/EmployeeModuleVisibility';
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
    roles: ['ADMIN'], permissions: ['admin.configure', 'users.read'], impersonation: null,
  },
};

const ROLES = { data: { roles: [{ code: 'EMPLOYEE', name: 'Employee' }, { code: 'HR_MANAGER', name: 'HR manager' }], modules: [], cells: [] } };

const row = (
  user_id: string, username: string,
  myWork: { visible: boolean; source: string },
  inbox: { visible: boolean; source: string } = { visible: true, source: 'default' },
) => ({
  user_id, username, employee_id: `e-${user_id}`, emp_no: `EMP-${username}`, name: `Person ${username}`,
  designation: 'Surveyor', district_id: 'd1', district: 'Guntur', employee_status: 'ACTIVE', roles: ['EMPLOYEE'],
  modules: { 'my-work': myWork, inbox },
});
// asha has her own settings for both modules; bala follows her role for both, so
// the bulk editor opens with my-work and inbox "Mixed".
const USERS = {
  data: [
    row('u1', 'asha', { visible: false, source: 'user' }, { visible: true, source: 'user' }),
    row('u2', 'bala', { visible: true, source: 'default' }),
  ],
  next_cursor: null,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let gets: string[] = [];
let puts: Array<{ path: string; body: unknown }> = [];

beforeEach(() => {
  gets = []; puts = [];
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    if (method === 'GET' && path === '/api/v1/admin/module-visibility') return jsonResponse(ROLES);
    if (method === 'GET' && path.startsWith('/api/v1/admin/module-visibility/users')) { gets.push(path); return jsonResponse(USERS); }
    if (method === 'PUT' && path === '/api/v1/admin/module-visibility/users') {
      puts.push({ path, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ data: { updated: 2 } });
    }
    return jsonResponse({ data: [] });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mount = () => render(<AuthProvider><EmployeeModuleVisibility /></AuthProvider>);

describe('Configuration → Employees', () => {
  it('shows one row per login and marks the person overrides', async () => {
    mount();
    const asha = await screen.findByTestId('visibility-row-u1', {}, { timeout: 4000 });
    expect(within(asha).getByTestId('cell-my-work')).toHaveTextContent(/hidden/i);
    expect(within(asha).getByTestId('cell-my-work')).toHaveTextContent(/person/i);
    const bala = screen.getByTestId('visibility-row-u2');
    expect(within(bala).getByTestId('cell-my-work')).toHaveTextContent(/shown/i);
    expect(within(bala).getByTestId('cell-my-work')).not.toHaveTextContent(/person/i);
  });

  it('bulk update sends exactly the selected ids and null for follow-role', async () => {
    mount();
    await screen.findByTestId('visibility-row-u1', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('select-u1'));
    fireEvent.click(screen.getByTestId('select-u2'));
    fireEvent.click(screen.getByRole('button', { name: /bulk update/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('editor-my-work'), { target: { value: 'hide' } });
    fireEvent.change(within(dialog).getByTestId('editor-inbox'), { target: { value: 'follow' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({
      user_ids: ['u1', 'u2'],
      changes: [{ module_code: 'my-work', visible: false }, { module_code: 'inbox', visible: null }],
    });
  });

  it('filter changes refetch with the query string', async () => {
    mount();
    await screen.findByTestId('visibility-row-u1', {}, { timeout: 4000 });
    fireEvent.change(screen.getByLabelText(/role/i), { target: { value: 'HR_MANAGER' } });
    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'asha' } });
    await waitFor(() => expect(gets.some((p) => p.includes('role_code=HR_MANAGER') && p.includes('q=asha'))).toBe(true));
  });
});
