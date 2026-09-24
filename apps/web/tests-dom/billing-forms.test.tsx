/**
 * Task 5a fix round 1 — same gap as tests-dom/procurement-forms.test.tsx:
 * the billing schema tests never proved that "Draw bill"/"Record advance"
 * actually sends the built payload to the right endpoint. Mounts the real
 * forms against a stubbed fetch and asserts the exact method, path and JSON
 * body.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { NewRaBill } from '@/components/billing/NewRaBillForm';
import { NewAdvance } from '@/components/billing/NewAdvanceForm';
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
    roles: ['SUPER_ADMIN'], permissions: ['rabill.manage'], impersonation: null,
  },
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
    if (init?.body) {
      sent.push({ path, method, body: JSON.parse(String(init.body)) });
      return jsonResponse({ data: { id: 'new-1', bill_no: 1, bill_type: 'RA' } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('NewRaBill (B-007)', () => {
  it('sends the built payload to POST /api/v1/ra-bills', async () => {
    handlers['GET /api/v1/projects/33333333-3333-3333-3333-333333333333/boq'] = () => jsonResponse({
      data: [{ id: '88888888-8888-8888-8888-888888888888', item_code: 'C-01', description: 'Excavation', unit: 'cum', quantity: 1000, rate: 120 }],
    });

    const onCreated = vi.fn();
    mount(<NewRaBill projectId="33333333-3333-3333-3333-333333333333" onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Period from/), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText(/Period to/), { target: { value: '2026-08-31' } });
    fireEvent.change(await screen.findByDisplayValue('Pick a BOQ item'), { target: { value: '88888888-8888-8888-8888-888888888888' } });
    fireEvent.change(screen.getByPlaceholderText('Cumulative quantity to date'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Draw bill' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/ra-bills', method: 'POST' });
    expect(sent[0].body).toEqual({
      project_id: '33333333-3333-3333-3333-333333333333',
      bill_type: 'RA',
      period_from: '2026-08-01',
      period_to: '2026-08-31',
      lines: [{ boq_item_id: '88888888-8888-8888-8888-888888888888', cumulative_quantity: 120 }],
      fixed_deductions: [],
    });
    expect(typeof (sent[0].body as any).lines[0].cumulative_quantity).toBe('number');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('sends a fixed deduction with a numeric amount', async () => {
    handlers['GET /api/v1/projects/33333333-3333-3333-3333-333333333333/boq'] = () => jsonResponse({
      data: [{ id: '88888888-8888-8888-8888-888888888888', item_code: 'C-01', description: 'Excavation', unit: 'cum', quantity: 1000, rate: 120 }],
    });

    mount(<NewRaBill projectId="33333333-3333-3333-3333-333333333333" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Period from/), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText(/Period to/), { target: { value: '2026-08-31' } });
    fireEvent.change(await screen.findByDisplayValue('Pick a BOQ item'), { target: { value: '88888888-8888-8888-8888-888888888888' } });
    fireEvent.change(screen.getByPlaceholderText('Cumulative quantity to date'), { target: { value: '120' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add deduction' }));
    fireEvent.change(screen.getByPlaceholderText('Label'), { target: { value: 'Delay penalty' } });
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5000.00' } });
    fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'Two weeks beyond the schedule' } });

    fireEvent.click(screen.getByRole('button', { name: 'Draw bill' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0].body as any;
    expect(body.fixed_deductions).toEqual([
      { head: 'OTHER', label: 'Delay penalty', amount: 5000, reason: 'Two weeks beyond the schedule' },
    ]);
    expect(typeof body.fixed_deductions[0].amount).toBe('number');
  });
});

describe('NewAdvance (B-007)', () => {
  it('sends the built payload to POST /api/v1/advances', async () => {
    const onClose = vi.fn();
    mount(<NewAdvance projectId="33333333-3333-3333-3333-333333333333" onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText(/Paid on/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '500000.00' } });
    fireEvent.change(screen.getByLabelText(/Recovery %/), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/advances', method: 'POST' });
    expect(sent[0].body).toEqual({
      project_id: '33333333-3333-3333-3333-333333333333',
      advance_type: 'MOBILISATION',
      amount: 500000,
      paid_on: '2026-09-01',
      recovery_pct: 10,
    });
    const body = sent[0].body as any;
    expect(typeof body.amount).toBe('number');
    expect(typeof body.recovery_pct).toBe('number');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/advances'] = () => jsonResponse({
      code: 'VALIDATION_ERROR',
      message: 'That did not work',
      field_errors: [{ field: 'recovery_pct', message: 'Recovery % must be greater than 0' }],
    }, 422);

    mount(<NewAdvance projectId="33333333-3333-3333-3333-333333333333" onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Paid on/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '500000.00' } });
    fireEvent.change(screen.getByLabelText(/Recovery %/), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));

    expect(await screen.findByText('Recovery % must be greater than 0')).toBeInTheDocument();
  });
});
