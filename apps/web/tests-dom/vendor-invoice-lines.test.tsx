/**
 * Task 5c, finding B-004 — mounts VendorInvoiceLines against a stubbed fetch
 * and proves the missing write path actually works from the screen: it loads
 * an invoice's lines, saves an edit to PATCH .../lines, and runs the
 * three-way match via POST .../match — the same way tests-dom/
 * payables-execute.test.tsx proves ExecutePaymentRunForm does.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { VendorInvoiceLines } from '@/components/procurement/VendorInvoiceLines';
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
    roles: ['SUPER_ADMIN'], permissions: ['invoice.manage', 'match.read', 'match.override'], impersonation: null,
  },
};

const INVOICE_ID = '99999999-9999-9999-9999-999999999901';
const PO_ID = '99999999-9999-9999-9999-999999999902';
const PO_LINE_ID = '99999999-9999-9999-9999-999999999903';

const INVOICE = {
  data: {
    id: INVOICE_ID, serial_number: 'INV-1', vendor_id: 'v1', vendor_name: 'Acme Cement',
    purchase_order_id: PO_ID, match_status: 'UNMATCHED', lifecycle_status: 'ISSUED',
    subtotal: '40000.00', tax: '0.00', total: '40000.00',
    vendor_udyam_number: null, vendor_msme_category: null,
    lines: [{
      id: 'l1', item_id: null, po_line_id: PO_LINE_ID, description: 'Cement OPC 53',
      hsn_sac: '25232910', quantity: '100.000', unit_rate: '400.0000', gst_rate_pct: '0.00',
    }],
  },
};

const PO = {
  data: {
    id: PO_ID, po_number: 'PO-1',
    lines: [{ id: PO_LINE_ID, description: 'Cement OPC 53', item_id: null, hsn_sac: '25232910', unit_rate: 400, quantity: 100, pendingQuantity: 0, gst_rate_pct: 0 }],
  },
};

const NO_MATCH = { data: [] };

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
  const matchResult = {
    matched: false, exceptions: [{ code: 'QUANTITY_EXCEEDS_RECEIPT', message: 'over the receipt' }],
    orderedValue: 40000, receivedValue: 40000, invoicedValue: 44000,
  };
  handlers = {
    [`GET /api/v1/invoices/${INVOICE_ID}`]: () => jsonResponse(INVOICE),
    [`GET /api/v1/purchase-orders/${PO_ID}`]: () => jsonResponse(PO),
    [`GET /api/v1/invoices/${INVOICE_ID}/match`]: () => jsonResponse(NO_MATCH),
    [`POST /api/v1/invoices/${INVOICE_ID}/match`]: (init) => {
      sent.push({ path: `/api/v1/invoices/${INVOICE_ID}/match`, method: 'POST', body: JSON.parse(String(init?.body ?? '{}')) });
      // Once posted, a refetch of the match history should see it — the same
      // way the real GET .../match reads back what /match just recorded.
      handlers[`GET /api/v1/invoices/${INVOICE_ID}/match`] = () => jsonResponse({ data: [matchResult] });
      return jsonResponse({ data: matchResult }, 201);
    },
  };
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
      return jsonResponse({
        data: { ...INVOICE.data, lines: INVOICE.data.lines, subtotal: '32000.00', tax: '0.00', total: '32000.00' },
      }, 200);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('VendorInvoiceLines (task 5c, finding B-004)', () => {
  it('loads the invoice and its lines, pre-filled from the linked order', async () => {
    mount(<VendorInvoiceLines invoiceId={INVOICE_ID} onClose={vi.fn()} />);
    expect(await screen.findByText(/Invoice INV-1/)).toBeInTheDocument();
    // Both the description input and the order-line <select>'s selected
    // option read "Cement OPC 53" once the line is pre-filled, so
    // findByDisplayValue is ambiguous here — check the description field by
    // itself instead.
    const description = await screen.findByPlaceholderText('Description') as HTMLInputElement;
    expect(description.value).toBe('Cement OPC 53');
  });

  it('saves an edited line to PATCH .../lines', async () => {
    mount(<VendorInvoiceLines invoiceId={INVOICE_ID} onClose={vi.fn()} />);
    const qty = await screen.findByDisplayValue('100');
    fireEvent.change(qty, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save lines' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: `/api/v1/invoices/${INVOICE_ID}/lines`, method: 'PATCH' });
    const body = sent[0].body as { lines: Array<Record<string, unknown>> };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ po_line_id: PO_LINE_ID, quantity: 80, unit_rate: 400 });
  });

  it('runs the three-way match and shows the exceptions it comes back with', async () => {
    mount(<VendorInvoiceLines invoiceId={INVOICE_ID} onClose={vi.fn()} />);
    await screen.findByText(/Invoice INV-1/);
    fireEvent.click(screen.getByRole('button', { name: 'Run three-way match' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: `/api/v1/invoices/${INVOICE_ID}/match`, method: 'POST' });
    expect(await screen.findByText(/over the receipt/)).toBeInTheDocument();
  });
});
