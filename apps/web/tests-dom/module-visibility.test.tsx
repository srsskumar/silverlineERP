/**
 * The module-visibility admin screen (owner request, 2026-09-24).
 *
 * Mounts the real component against a stubbed server: it renders the
 * resolved matrix the API sends, and toggling a row sends the PUT the API
 * expects -- role_code, module_code, and the new visible value.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { ModuleVisibility } from '@/components/ModuleVisibility';
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

const MATRIX = {
  data: {
    roles: [{ code: 'EMPLOYEE', name: 'Employee' }, { code: 'SUPER_ADMIN', name: 'Super admin' }],
    modules: [
      { code: 'my-work', label: 'My work', group: 'Work', permission: 'task.read' },
      { code: 'payroll', label: 'Payroll', group: 'People', permission: 'payroll.read' },
    ],
    cells: [
      { role_code: 'EMPLOYEE', module_code: 'my-work', visible: true, default_visible: true, source: 'default' },
      { role_code: 'EMPLOYEE', module_code: 'payroll', visible: false, default_visible: false, source: 'default' },
      { role_code: 'SUPER_ADMIN', module_code: 'my-work', visible: true, default_visible: true, source: 'default' },
      { role_code: 'SUPER_ADMIN', module_code: 'payroll', visible: true, default_visible: true, source: 'default' },
    ],
  },
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
    if (path === '/api/v1/admin/module-visibility' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(MATRIX);
    }
    if (path === '/api/v1/admin/module-visibility' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      sent.push({ path, body });
      return jsonResponse({ data: body });
    }
    return jsonResponse({ data: null }, 404);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('module visibility admin screen', () => {
  it('shows the resolved matrix for the selected role', async () => {
    render(<AuthProvider><ModuleVisibility /></AuthProvider>);

    await screen.findByText('My work');
    expect(screen.getByText('Payroll')).toBeInTheDocument();
    // EMPLOYEE (the first role) is selected by default: my-work visible, payroll hidden.
    expect(screen.getAllByText('Visible')).toHaveLength(1);
    expect(screen.getAllByText('Hidden')).toHaveLength(1);
    expect(screen.getByText(/on by default via task\.read/)).toBeInTheDocument();
  });

  it('sends role_code, module_code and the new visible value when a row is toggled', async () => {
    render(<AuthProvider><ModuleVisibility /></AuthProvider>);
    await screen.findByText('My work');

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ role_code: 'EMPLOYEE', module_code: 'my-work', visible: false });
  });

  it('switches to the chosen role and shows what it currently sees', async () => {
    render(<AuthProvider><ModuleVisibility /></AuthProvider>);
    await screen.findByText('My work');

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SUPER_ADMIN' } });

    // SUPER_ADMIN sees both by default.
    await waitFor(() => expect(screen.getAllByText('Visible')).toHaveLength(2));
  });
});
