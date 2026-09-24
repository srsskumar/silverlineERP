/**
 * B-002 — mounts the execute-payment dialog against a stubbed fetch and
 * asserts the exact method, path, headers and JSON body it sends, the same
 * way tests-dom/billing-forms.test.tsx proves the RA-bill/advance forms do.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { ExecutePaymentRunForm } from '@/components/payables/ExecutePaymentRunForm';
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
    roles: ['SUPER_ADMIN'], permissions: ['paymentrun.approve'], impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let sent: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = [];
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
    if (init?.body) {
      sent.push({
        path, method, body: JSON.parse(String(init.body)),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ data: { id: 'run-1', status: 'PAID' } }, 200);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('ExecutePaymentRunForm (B-002)', () => {
  it('sends paid_on, bank_reference and the If-Match version to POST .../execute', async () => {
    const onDone = vi.fn();
    mount(
      <ExecutePaymentRunForm runId="99999999-9999-9999-9999-999999999999" version={3} onClose={vi.fn()} onDone={onDone} />,
    );

    fireEvent.change(await screen.findByLabelText(/Paid on/), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText(/Bank reference/), { target: { value: 'UTR998877' } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Batch cleared by RTGS' } });

    fireEvent.click(screen.getByRole('button', { name: 'Execute payment' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      path: '/api/v1/payment-runs/99999999-9999-9999-9999-999999999999/execute',
      method: 'POST',
    });
    expect(sent[0].body).toEqual({
      paid_on: '2026-09-20',
      bank_reference: 'UTR998877',
      note: 'Batch cleared by RTGS',
    });
    // apiClient sends the version as X-Record-Version, not If-Match — a CDN
    // can legally rewrite a transport-level precondition on the way back,
    // and one did (see apiClient.ts's comment on this rename). Header names
    // land lower-cased: apiClient builds the fetch init from a Headers
    // object, whose .entries() always lower-cases per the Fetch spec.
    expect(sent[0].headers['x-record-version']).toBe('3');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('renders a 409 error rather than pretending the run executed', async () => {
    handlers['POST /api/v1/payment-runs/99999999-9999-9999-9999-999999999999/execute'] = () => jsonResponse({
      code: 'RUN_OUT_OF_DATE', message: 'This run no longer matches the ledger',
    }, 409);

    mount(
      <ExecutePaymentRunForm runId="99999999-9999-9999-9999-999999999999" version={3} onClose={vi.fn()} onDone={vi.fn()} />,
    );

    fireEvent.change(await screen.findByLabelText(/Paid on/), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText(/Bank reference/), { target: { value: 'UTR998877' } });
    fireEvent.click(screen.getByRole('button', { name: 'Execute payment' }));

    expect(await screen.findByText(/This run no longer matches the ledger/)).toBeInTheDocument();
  });
});
