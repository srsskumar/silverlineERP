/**
 * Task 5f item 2 — financial control (§45) had complete API routes
 * (payments/allocations, bank-transactions import/reconcile, financial
 * periods create/closure) and no web UI at all. Mounts each real form
 * against a stubbed fetch (style of tests-dom/procurement-forms.test.tsx)
 * and asserts the exact request each control sends.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { PaymentForm } from '@/components/finance/PaymentForm';
import { PaymentAllocationForm } from '@/components/finance/PaymentAllocationForm';
import { PaymentsManager } from '@/components/finance/PaymentsManager';
import { FinancialPeriodsManager } from '@/components/finance/FinancialPeriodsManager';
import { BankImportForm } from '@/components/finance/BankImportForm';
import { BankReconciliationManager } from '@/components/finance/BankReconciliationManager';
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

function meFor(permissions: string[]) {
  return {
    data: {
      user: { id: 'a1', username: 'admin', email: null, phone: null, org_id: 'o1', auth_status: 'ACTIVE',
              mfa_enabled: true, last_login_at: null, mfa_enrollment_required: false, timezone: 'Asia/Kolkata' },
      roles: ['SUPER_ADMIN'], permissions, impersonation: null,
    },
  };
}
const ME_MANAGE = meFor([
  'payment.read', 'payment.manage', 'payment.allocate', 'bank.read', 'bank.reconcile', 'period.read', 'period.manage',
]);
const ME_READ_ONLY = meFor(['payment.read', 'bank.read', 'period.read']);
let ME = ME_MANAGE;

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
  ME = ME_MANAGE;
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = stripOrigin(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    if (path === '/api/v1/projects?limit=100') return jsonResponse({ data: [] });
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    if (init?.body || method === 'POST') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'new-1', version: 1, applied: 1, created: 1, skipped: 0, exceptions: 0, flagged: [] } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('PaymentForm', () => {
  it('sends the built payload to POST /api/v1/payments, with untouched optional fields omitted', async () => {
    const onCreated = vi.fn();
    mount(<PaymentForm onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Payment number/), { target: { value: 'PAY-1001' } });
    fireEvent.change(screen.getByLabelText(/Paid on/), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '50000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/payments', method: 'POST' });
    expect(sent[0].body).toEqual({
      direction: 'RECEIVABLE', payment_no: 'PAY-1001', paid_on: '2026-09-20', amount: 50000, mode: 'NEFT',
    });
    expect(typeof (sent[0].body as any).amount).toBe('number');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/payments'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'payment_no', message: 'That payment number is already in use' }],
    }, 422);

    mount(<PaymentForm onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Payment number/), { target: { value: 'DUP' } });
    fireEvent.change(screen.getByLabelText(/Paid on/), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create payment' }));

    expect(await screen.findByText('That payment number is already in use')).toBeInTheDocument();
  });
});

describe('PaymentAllocationForm', () => {
  it('sends the built payload to POST /api/v1/payments/:id/allocations', async () => {
    const onAllocated = vi.fn();
    mount(<PaymentAllocationForm paymentId="pay-9" onAllocated={onAllocated} />);

    fireEvent.change(await screen.findByLabelText(/Document ID/), { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '25000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/payments/pay-9/allocations', method: 'POST' });
    expect(sent[0].body).toEqual({
      document_type: 'RA_BILL', document_id: '11111111-1111-1111-1111-111111111111', amount: 25000,
    });
    await waitFor(() => expect(onAllocated).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/payments/pay-9/allocations'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'amount', message: 'This would over-allocate the payment' }],
    }, 422);

    mount(<PaymentAllocationForm paymentId="pay-9" onAllocated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Document ID/), { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));

    expect(await screen.findByText('This would over-allocate the payment')).toBeInTheDocument();
  });
});

function mountPeriods() {
  return mount(<FinancialPeriodsManager />);
}

describe('FinancialPeriodsManager', () => {
  it('sends the built payload to POST /api/v1/financial-periods', async () => {
    mountPeriods();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: '2026-10' } });
    fireEvent.change(screen.getByLabelText(/Starts on/), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/Ends on/), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create period' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/financial-periods', method: 'POST' });
    expect(sent[0].body).toEqual({ code: '2026-10', starts_on: '2026-10-01', ends_on: '2026-10-31' });
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/financial-periods'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'code', message: 'Period 2026-10 already exists' }],
    }, 422);
    mountPeriods();

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: '2026-10' } });
    fireEvent.change(screen.getByLabelText(/Starts on/), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/Ends on/), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create period' }));

    expect(await screen.findByText('Period 2026-10 already exists')).toBeInTheDocument();
  });

  it('closes a period with the version in If-Match, after confirming', async () => {
    handlers['GET /api/v1/financial-periods'] = () => jsonResponse({
      data: [{ id: 'per-1', code: '2026-09', starts_on: '2026-09-01', ends_on: '2026-09-30', status: 'OPEN', version: 4 }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mountPeriods();

    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/financial-periods/per-1/closure', method: 'POST' });
    expect(sent[0].body).toEqual({ action: 'CLOSE' });
    expect(sent[0].headers['x-record-version']).toBe('4');
  });

  it('reopens a period with the version in If-Match and the typed reason', async () => {
    handlers['GET /api/v1/financial-periods'] = () => jsonResponse({
      data: [{ id: 'per-2', code: '2026-08', starts_on: '2026-08-01', ends_on: '2026-08-31', status: 'CLOSED', version: 7 }],
    });
    mountPeriods();

    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    fireEvent.change(screen.getByPlaceholderText('Reason for reopening'), { target: { value: 'Late invoice found' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reopen' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/financial-periods/per-2/closure', method: 'POST' });
    expect(sent[0].body).toEqual({ action: 'REOPEN', reason: 'Late invoice found' });
    expect(sent[0].headers['x-record-version']).toBe('7');
  });
});

describe('BankImportForm', () => {
  it('parses the CSV and sends the built payload to POST /api/v1/bank-transactions/import', async () => {
    mount(<BankImportForm />);

    fireEvent.change(screen.getByLabelText(/Bank account/), { target: { value: 'HDFC-001' } });
    fireEvent.change(screen.getByLabelText(/CSV/), {
      target: { value: 'statement_ref,value_date,amount,narration\nTXN001,2026-09-20,50000,NEFT credit' },
    });

    await screen.findByText('1 transaction ready to import.');
    fireEvent.click(screen.getByRole('button', { name: /Import 1 transaction/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/bank-transactions/import', method: 'POST' });
    expect(sent[0].body).toEqual({
      bank_account: 'HDFC-001',
      transactions: [{ statement_ref: 'TXN001', value_date: '2026-09-20', amount: 50000, narration: 'NEFT credit' }],
    });
    expect(typeof (sent[0].body as any).transactions[0].amount).toBe('number');
  });

  it('flags an unparsable row instead of sending it', async () => {
    mount(<BankImportForm />);

    fireEvent.change(screen.getByLabelText(/CSV/), {
      target: { value: 'statement_ref,value_date,amount\nTXN002,not-a-date,abc' },
    });

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import 1 transaction/ })).not.toBeInTheDocument();
  });
});

describe('BankReconciliationManager reconcile', () => {
  it('sends the version in If-Match and the payment id to POST .../:id/reconcile', async () => {
    handlers['GET /api/v1/bank-transactions'] = () => jsonResponse({
      data: [{
        id: 'bt-1', statement_ref: 'TXN001', value_date: '2026-09-20', amount: 50000,
        bank_account: 'HDFC-001', reconciliation_status: 'UNMATCHED', version: 2,
      }],
    });

    mount(<BankReconciliationManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile' }));
    fireEvent.change(screen.getByPlaceholderText('Payment ID (UUID)'), { target: { value: 'pay-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/bank-transactions/bt-1/reconcile', method: 'POST' });
    expect(sent[0].body).toEqual({ payment_id: 'pay-5' });
    expect(sent[0].headers['x-record-version']).toBe('2');
  });
});

describe('fix round 1 item 1 — write controls gated on manage permissions, not just read', () => {
  it('PaymentsManager hides "New payment" from a payment.read-only session', async () => {
    ME = ME_READ_ONLY;
    mount(<PaymentsManager />);
    await screen.findByText('No payments');
    expect(screen.queryByRole('button', { name: 'New payment' })).not.toBeInTheDocument();
  });

  it('PaymentsManager shows "New payment" for a session holding payment.manage', async () => {
    mount(<PaymentsManager />);
    expect(await screen.findByRole('button', { name: 'New payment' })).toBeInTheDocument();
  });

  it('FinancialPeriodsManager hides the create form and Close action from a period.read-only session', async () => {
    ME = ME_READ_ONLY;
    handlers['GET /api/v1/financial-periods'] = () => jsonResponse({
      data: [{ id: 'per-1', code: '2026-09', starts_on: '2026-09-01', ends_on: '2026-09-30', status: 'OPEN', version: 1 }],
    });
    mount(<FinancialPeriodsManager />);
    await screen.findByText('2026-09');
    expect(screen.queryByLabelText(/^Code/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('FinancialPeriodsManager shows the create form and Close action for a session holding period.manage', async () => {
    handlers['GET /api/v1/financial-periods'] = () => jsonResponse({
      data: [{ id: 'per-1', code: '2026-09', starts_on: '2026-09-01', ends_on: '2026-09-30', status: 'OPEN', version: 1 }],
    });
    mount(<FinancialPeriodsManager />);
    expect(await screen.findByLabelText(/^Code/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('BankReconciliationManager hides the import form and Reconcile action from a bank.read-only session', async () => {
    ME = ME_READ_ONLY;
    handlers['GET /api/v1/bank-transactions'] = () => jsonResponse({
      data: [{
        id: 'bt-1', statement_ref: 'TXN001', value_date: '2026-09-20', amount: 50000,
        bank_account: null, reconciliation_status: 'UNMATCHED', version: 1,
      }],
    });
    mount(<BankReconciliationManager />);
    await screen.findByText('TXN001');
    expect(screen.queryByLabelText(/CSV/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconcile' })).not.toBeInTheDocument();
  });

  it('BankReconciliationManager shows the import form and Reconcile action for a session holding bank.reconcile', async () => {
    handlers['GET /api/v1/bank-transactions'] = () => jsonResponse({
      data: [{
        id: 'bt-1', statement_ref: 'TXN001', value_date: '2026-09-20', amount: 50000,
        bank_account: null, reconciliation_status: 'UNMATCHED', version: 1,
      }],
    });
    mount(<BankReconciliationManager />);
    expect(await screen.findByLabelText(/CSV/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument();
  });
});
