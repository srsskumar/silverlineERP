/**
 * Task 5f item 3 — cost heads + project budgets (§15.6). The cost-heads
 * master API (GET/POST/PATCH /api/v1/cost-heads) and the budget API
 * (GET/PUT /api/v1/projects/:id/budget) existed with no web UI at all;
 * "Budget vs actual" already read from cost-position, but nothing could set
 * a budget or manage the cost-head list. Mounts each real form against a
 * stubbed fetch and asserts the exact request each sends.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { CostHeadForm } from '@/components/finance/CostHeadForm';
import { BudgetEditForm } from '@/components/finance/BudgetEditForm';
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
    roles: ['SUPER_ADMIN'], permissions: ['costhead.read', 'costhead.manage', 'budget.read', 'budget.manage'], impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let sent: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }> = [];
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
    if (path === '/api/v1/cost-heads?active=true') return jsonResponse({
      data: [{ id: '11111111-1111-1111-1111-111111111111', code: 'LAB', name: 'Labour', kind: 'LABOUR', active: true, version: 1 }],
    });
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    if (init?.body || method === 'POST' || method === 'PATCH' || method === 'PUT') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'ch-new', code: 'MAT', name: 'Material', kind: 'MATERIAL', active: true, version: 1 } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('CostHeadForm create', () => {
  it('sends the built payload to POST /api/v1/cost-heads', async () => {
    const onSaved = vi.fn();
    mount(<CostHeadForm onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'mat' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Material' } });
    fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: 'MATERIAL' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/cost-heads', method: 'POST' });
    // costHeadSchema upper-cases the code server-side too, but the web form
    // mirrors that transform so what the preview would show matches what
    // gets saved.
    expect(sent[0].body).toEqual({ code: 'MAT', name: 'Material', kind: 'MATERIAL', active: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/cost-heads'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'code', message: 'Cost head MAT already exists' }],
    }, 422);

    mount(<CostHeadForm onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'mat' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Material' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Cost head MAT already exists')).toBeInTheDocument();
  });
});

describe('CostHeadForm edit', () => {
  it('sends only the editable fields to PATCH /api/v1/cost-heads/:id, with the version in If-Match', async () => {
    const existing = { id: 'ch-7', code: 'SUB', name: 'Subcontract', kind: 'SUBCONTRACT', description: null, active: true, version: 5 };
    mount(<CostHeadForm initial={existing as any} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Subcontract works' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/cost-heads/ch-7', method: 'PATCH' });
    expect(sent[0].body).toEqual({ name: 'Subcontract works', kind: 'SUBCONTRACT', active: true });
    expect(sent[0].headers['x-record-version']).toBe('5');
    expect(sent[0].body).not.toHaveProperty('code');
  });
});

describe('BudgetEditForm', () => {
  it('sends the built payload to PUT /api/v1/projects/:id/budget', async () => {
    const onSaved = vi.fn();
    mount(<BudgetEditForm projectId="proj-1" isRevision={false} onClose={vi.fn()} onSaved={onSaved} />);

    const headSelect = await screen.findByDisplayValue('Pick a cost head');
    fireEvent.change(headSelect, { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByPlaceholderText('Budgeted amount'), { target: { value: '500000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/projects/proj-1/budget', method: 'PUT' });
    expect(sent[0].body).toEqual({ lines: [{ cost_head_id: '11111111-1111-1111-1111-111111111111', budgeted_amount: 500000 }] });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['PUT /api/v1/projects/proj-1/budget'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'revision_reason', message: 'Say why the budget is being revised' }],
    }, 422);

    mount(<BudgetEditForm projectId="proj-1" isRevision onClose={vi.fn()} onSaved={vi.fn()} />);

    const headSelect = await screen.findByDisplayValue('Pick a cost head');
    fireEvent.change(headSelect, { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByPlaceholderText('Budgeted amount'), { target: { value: '500000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));

    expect(await screen.findByText('Say why the budget is being revised')).toBeInTheDocument();
  });
});
