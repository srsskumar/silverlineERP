/**
 * "Due for purge" report and explicit purge action (owner decision
 * 2026-09-24 #3). No scheduled deletion exists anywhere in the product; the
 * panel is the only place a document is ever removed for retention, and it
 * always requires a reason and an explicit confirm.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { DueForPurgePanel } from '@/components/documents/DueForPurgePanel';
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
    roles: ['SUPER_ADMIN'], permissions: ['document.read', 'document.delete'], impersonation: null,
  },
};

const DUE = {
  data: [
    { id: 'doc-1', title: 'Old labour licence', type_label: 'Labour licence', category: 'STATUTORY',
      owner_type: 'organization', retain_until: '2024-01-01' },
    { id: 'doc-2', title: 'Old GST registration', type_label: 'GST registration', category: 'STATUTORY',
      owner_type: 'organization', retain_until: '2023-06-01' },
  ],
  as_of: '2026-09-24', total: 2,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let sent: Array<{ path: string; method: string; body: unknown }> = [];
let handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {};

function stripOrigin(url: string) {
  return String(url).replace(/^https?:\/\/[^/]+/, '');
}

beforeEach(() => {
  sent = [];
  handlers = {};
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = stripOrigin(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    if (path === '/api/v1/documents/due-for-purge') return jsonResponse(DUE);
    if (path === '/api/v1/documents/purge') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ path, method, body });
      return jsonResponse({ data: { purged: [], reason: body?.reason, purged_count: (body?.ids ?? []).length } });
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('DueForPurgePanel', () => {
  it('lists what is due, and requires both a selection and a reason before purging', async () => {
    mount(<DueForPurgePanel />);

    expect(await screen.findByText('Old labour licence')).toBeInTheDocument();
    expect(screen.getByText('Old GST registration')).toBeInTheDocument();

    const purgeButton = screen.getByRole('button', { name: 'Purge selected' });
    expect(purgeButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Old labour licence' }));
    expect(purgeButton).toBeDisabled(); // selected, but no reason yet

    fireEvent.change(screen.getByLabelText(/Reason for purging/), { target: { value: 'Year-end sweep' } });
    expect(purgeButton).not.toBeDisabled();
  });

  it('says plainly that purge removes the register entry only (fix round 1, item 1)', async () => {
    mount(<DueForPurgePanel />);
    expect(await screen.findByText(/removes the register entry only/)).toBeInTheDocument();
    expect(screen.getByText(/until deleted there/)).toBeInTheDocument();
  });

  it('repeats the register-only notice inside the confirm dialog', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(<DueForPurgePanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Old labour licence' }));
    fireEvent.change(screen.getByLabelText(/Reason for purging/), { target: { value: 'Year-end sweep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Purge selected' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('removes the register entry only'));
  });

  it('confirms, then sends only the selected ids and the reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount(<DueForPurgePanel />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Old labour licence' }));
    fireEvent.change(screen.getByLabelText(/Reason for purging/), { target: { value: 'Year-end sweep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Purge selected' }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ ids: ['doc-1'], reason: 'Year-end sweep' });
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(<DueForPurgePanel />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Old labour licence' }));
    fireEvent.change(screen.getByLabelText(/Reason for purging/), { target: { value: 'Year-end sweep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Purge selected' }));

    expect(sent).toHaveLength(0);
  });

  it('surfaces a refusal (legal hold or not yet due) without pretending it worked', async () => {
    handlers['POST /api/v1/documents/purge'] = () => jsonResponse({
      code: 'PURGE_REFUSED',
      message: '1 of 1 selected document(s) cannot be purged',
      field_errors: [{ field: 'doc-1', message: 'Under legal hold.' }],
    }, 409);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount(<DueForPurgePanel />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Old labour licence' }));
    fireEvent.change(screen.getByLabelText(/Reason for purging/), { target: { value: 'Year-end sweep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Purge selected' }));

    expect(await screen.findByText(/cannot be purged/)).toBeInTheDocument();
  });

  it('shows nothing to purge when the report is empty', async () => {
    handlers['GET /api/v1/documents/due-for-purge'] = () => jsonResponse({ data: [], as_of: '2026-09-24', total: 0 });
    mount(<DueForPurgePanel />);
    expect(await screen.findByText('Nothing is due for purge')).toBeInTheDocument();
  });
});
