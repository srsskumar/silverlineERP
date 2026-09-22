/**
 * The pickers that replaced "paste a UUID here".
 *
 * An employee is chosen by typing a name; the register is asked for matches
 * and the field hands back the id. Somebody who cannot read the register
 * gets the id box back, with a hint, rather than a picker showing nothing.
 * The same for a user account and the staff directory.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { EmployeePicker } from '@/components/EmployeePicker';
import { UserPicker } from '@/components/UserPicker';
import { PersonName } from '@/components/PersonName';
import { peopleIndex } from '@/lib/people';
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

function me(permissions: string[]) {
  return {
    data: {
      user: { id: 'u-admin', username: 'admin', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
              mfa_enabled: true, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
      roles: ['HR'], permissions, impersonation: null,
    },
  };
}

const ANITA = { id: 'e-anita', emp_no: 'EMP-042', first_name: 'Anita', last_name: 'Rao', designation: 'Surveyor', status: 'ACTIVE', version: 1 };
const BALA = { id: 'e-bala', emp_no: 'EMP-007', first_name: 'Bala', last_name: 'Krishna', designation: 'Driver', status: 'ACTIVE', version: 1 };

const requested: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

function stubServer(permissions: string[], opts: { peopleStatus?: number } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    if (path === '/api/v1/auth/me') return jsonResponse(me(permissions));
    if (path.startsWith('/api/v1/employees?')) {
      const q = new URL(`http://x${path}`).searchParams.get('q') ?? '';
      if (permissions.includes('employee.read') === false) return jsonResponse({ code: 'FORBIDDEN', message: 'no' }, 403);
      const rows = [ANITA, BALA].filter((e) => !q || `${e.first_name} ${e.last_name} ${e.emp_no}`.toLowerCase().includes(q.toLowerCase()));
      return jsonResponse({ data: rows, next_cursor: null, has_more: false });
    }
    if (path.startsWith('/api/v1/people')) {
      if (opts.peopleStatus === 403) return jsonResponse({ code: 'FORBIDDEN', message: 'no' }, 403);
      return jsonResponse({ data: [
        { id: 'u-anita', username: 'anita', employee_id: 'e-anita', emp_no: 'EMP-042', name: 'Anita Rao', employee_status: 'ACTIVE' },
        { id: 'u-left', username: 'left', employee_id: 'e-left', emp_no: 'EMP-001', name: 'Somebody Left', employee_status: 'EXITED' },
        { id: 'u-admin', username: 'admin', employee_id: null, emp_no: null, name: 'admin', employee_status: null },
      ], has_more: false });
    }
    return jsonResponse({ data: null }, 404);
  }));
}

beforeEach(() => {
  requested.length = 0;
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('access', 'refresh');
});

afterEach(() => vi.unstubAllGlobals());

describe('EmployeePicker', () => {
  it('searches the register as you type and hands back the id', async () => {
    stubServer(['employee.read']);
    const onChange = vi.fn();
    render(<AuthProvider><EmployeePicker id="who" value="" onChange={onChange} /></AuthProvider>);

    const box = await screen.findByRole('combobox');
    await waitFor(() => expect(requested.some((p) => p.startsWith('/api/v1/employees?'))).toBe(true));
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'bala' } });

    // The server is asked with what was typed, scoped to people still here.
    await waitFor(() => expect(requested.some((p) => p.includes('q=bala') && p.includes('status=ACTIVE'))).toBe(true));
    const option = await screen.findByRole('option', { name: /Bala Krishna/ });
    // The option reads "Name · EMP-NO · Designation".
    expect(option.textContent).toContain('EMP-007');
    expect(option.textContent).toContain('Driver');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('e-bala');
  });

  it('shows the chosen person by name, even one handed in from outside the search', async () => {
    stubServer(['employee.read']);
    render(<AuthProvider><EmployeePicker id="who" value="e-anita" onChange={() => {}} /></AuthProvider>);
    const box = await screen.findByRole('combobox') as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe('Anita Rao'));
  });

  it('falls back to the id box, and says why, without employee.read', async () => {
    stubServer(['leave.admin']);
    const onChange = vi.fn();
    render(<AuthProvider><EmployeePicker id="who" value="" onChange={onChange} /></AuthProvider>);

    const box = await screen.findByPlaceholderText('Employee id');
    expect(screen.getByText(/cannot browse the employee register/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.change(box, { target: { value: '64634e67-6b51' } });
    expect(onChange).toHaveBeenCalledWith('64634e67-6b51');
    // And it never asked for a list it was not going to get.
    expect(requested.some((p) => p.startsWith('/api/v1/employees'))).toBe(false);
  });
});

describe('UserPicker', () => {
  it('offers the directory by name, minus leavers and whoever is excluded', async () => {
    stubServer([]);
    const onChange = vi.fn();
    render(<AuthProvider><UserPicker id="to" value="" onChange={onChange} exclude={['u-admin']} /></AuthProvider>);
    const box = await screen.findByRole('combobox');
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    fireEvent.focus(box);
    expect(await screen.findByRole('option', { name: /Anita Rao/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Somebody Left/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /admin/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Anita Rao/ }));
    expect(onChange).toHaveBeenCalledWith('u-anita');
  });

  it('falls back to the id box when the directory is refused', async () => {
    stubServer([], { peopleStatus: 403 });
    render(<AuthProvider><UserPicker id="to" value="" onChange={() => {}} /></AuthProvider>);
    expect(await screen.findByPlaceholderText('User id')).toBeInTheDocument();
    expect(screen.getByText(/not open to your account/)).toBeInTheDocument();
  });
});

describe('PersonName', () => {
  it('prints the name with the number, and keeps the id on hover', () => {
    render(<PersonName id="64634e67-6b51-4c1e-9a3e-0123456789ab" name="Anita Rao" empNo="EMP-042" />);
    const el = screen.getByTitle('64634e67-6b51-4c1e-9a3e-0123456789ab');
    expect(el.textContent).toBe('Anita Rao· EMP-042');
  });

  it('resolves a bare user id through the directory index', () => {
    const index = peopleIndex([{ id: 'u1', username: 'anita', employee_id: 'e1', emp_no: 'EMP-042', name: 'Anita Rao', employee_status: 'ACTIVE' }]);
    render(<PersonName id="u1" index={index} />);
    expect(screen.getByTitle('u1').textContent).toContain('Anita Rao');
  });

  it('shows the shortened id, as an id, when nothing better is known', () => {
    render(<PersonName id="64634e67-6b51-4c1e-9a3e-0123456789ab" />);
    const el = screen.getByTitle('64634e67-6b51-4c1e-9a3e-0123456789ab');
    expect(el.textContent).toBe('64634e67…');
    expect(el.className).toContain('font-mono');
  });

  it('prints a dash for nobody', () => {
    render(<PersonName />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
