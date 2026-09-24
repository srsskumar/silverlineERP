/**
 * Task 5a fix round 1 — the schema tests in tests/procurement-forms.test.ts
 * check payload *shape* in isolation; they never proved that clicking
 * "Raise requisition"/"Raise order"/"Record receipt"/"Send RFQ" actually
 * sends that payload to the right endpoint. This mounts each real form
 * against a stubbed fetch, in the style of tests-dom/org-settings-form.test.tsx
 * and tests-dom/module-visibility.test.tsx, and asserts the exact method,
 * path and JSON body — including that money/quantity travel as numbers, not
 * strings left over from the `<input>` they came from.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { NewRequisition } from '@/components/procurement/NewRequisitionForm';
import { NewPurchaseOrder } from '@/components/procurement/NewPurchaseOrderForm';
import { NewGrn } from '@/components/procurement/NewGrnForm';
import { NewRfq } from '@/components/procurement/NewRfqForm';
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
    roles: ['SUPER_ADMIN'], permissions: ['requisition.manage', 'po.manage', 'grn.manage', 'rfq.manage'], impersonation: null,
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
    // A POST/PATCH the test cares about: record it and answer 201.
    if (init?.body) {
      sent.push({ path, method, body: JSON.parse(String(init.body)) });
      return jsonResponse({ data: { id: 'new-1', requisition_no: 'REQ-X', po_number: 'PO-X', rfq_no: 'RFQ-X' } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('NewRequisition (B-005)', () => {
  it('sends the built payload to POST /api/v1/requisitions', async () => {
    const onCreated = vi.fn();
    mount(<NewRequisition onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Requisition number/), { target: { value: 'REQ-1001' } });
    fireEvent.change(screen.getByLabelText(/Justification/), { target: { value: 'Cement for the retaining wall' } });
    const lineInputs = screen.getAllByPlaceholderText('Description');
    fireEvent.change(lineInputs[0], { target: { value: 'OPC 53 cement' } });
    fireEvent.change(screen.getAllByPlaceholderText('Unit')[0], { target: { value: 'bag' } });
    fireEvent.change(screen.getAllByPlaceholderText('Quantity')[0], { target: { value: '100' } });
    fireEvent.change(screen.getAllByPlaceholderText('Estimated rate (optional)')[0], { target: { value: '350.50' } });

    fireEvent.click(screen.getByRole('button', { name: 'Raise requisition' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/requisitions', method: 'POST' });
    expect(sent[0].body).toEqual({
      requisition_no: 'REQ-1001',
      justification: 'Cement for the retaining wall',
      lines: [{ description: 'OPC 53 cement', unit: 'bag', quantity: 100, estimated_rate: 350.5 }],
    });
    expect(typeof (sent[0].body as any).lines[0].quantity).toBe('number');
    expect(typeof (sent[0].body as any).lines[0].estimated_rate).toBe('number');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/requisitions'] = () => jsonResponse({
      code: 'VALIDATION_ERROR',
      message: 'That did not work',
      field_errors: [{ field: 'requisition_no', message: 'That requisition number is already in use' }],
    }, 422);

    mount(<NewRequisition onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Requisition number/), { target: { value: 'REQ-DUP' } });
    fireEvent.change(screen.getByLabelText(/Justification/), { target: { value: 'Site consumables' } });
    fireEvent.change(screen.getAllByPlaceholderText('Description')[0], { target: { value: 'Gloves' } });
    fireEvent.change(screen.getAllByPlaceholderText('Unit')[0], { target: { value: 'pair' } });
    fireEvent.change(screen.getAllByPlaceholderText('Quantity')[0], { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Raise requisition' }));

    expect(await screen.findByText('That requisition number is already in use')).toBeInTheDocument();
  });
});

describe('NewPurchaseOrder (B-005)', () => {
  it('sends a plain new order with untouched optional fields omitted', async () => {
    handlers['GET /api/v1/vendors?limit=100'] = () => jsonResponse({ data: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Vendor One' }] });
    handlers['GET /api/v1/requisitions?status=APPROVED&limit=100'] = () => jsonResponse({ data: [] });

    const onCreated = vi.fn();
    mount(<NewPurchaseOrder onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Order number/), { target: { value: 'PO-2001' } });
    fireEvent.change(await screen.findByLabelText('Vendor'), { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByLabelText(/Order date/), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'TMT bars 12mm' } });
    fireEvent.change(screen.getByPlaceholderText('Unit'), { target: { value: 'kg' } });
    fireEvent.change(screen.getByPlaceholderText('Quantity'), { target: { value: '500' } });
    fireEvent.change(screen.getByPlaceholderText('Unit rate'), { target: { value: '62.75' } });
    fireEvent.change(screen.getByPlaceholderText('GST %'), { target: { value: '18' } });

    fireEvent.click(screen.getByRole('button', { name: 'Raise order' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/purchase-orders', method: 'POST' });
    expect(sent[0].body).toEqual({
      po_number: 'PO-2001',
      vendor_id: '11111111-1111-1111-1111-111111111111',
      po_date: '2026-09-24',
      lines: [{
        description: 'TMT bars 12mm', unit: 'kg', quantity: 500, unit_rate: 62.75, gst_rate_pct: 18,
      }],
    });
    const body = sent[0].body as any;
    expect(typeof body.lines[0].quantity).toBe('number');
    expect(typeof body.lines[0].unit_rate).toBe('number');
    expect(typeof body.lines[0].gst_rate_pct).toBe('number');
    // Nothing the user never touched — requisition_id, project_id, delivery
    // fields, place_of_supply, scope_override_reason — is on the wire at all.
    expect(body).not.toHaveProperty('requisition_id');
    expect(body).not.toHaveProperty('project_id');
    expect(body).not.toHaveProperty('place_of_supply');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('carries an approved requisition\'s lines over via requisition_line_id (the from-requisition path)', async () => {
    handlers['GET /api/v1/vendors?limit=100'] = () => jsonResponse({ data: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Vendor One' }] });
    handlers['GET /api/v1/requisitions?status=APPROVED&limit=100'] = () => jsonResponse({
      data: [{ id: '44444444-4444-4444-4444-444444444444', requisition_no: 'REQ-9' }],
    });
    handlers['GET /api/v1/requisitions/44444444-4444-4444-4444-444444444444'] = () => jsonResponse({
      data: {
        id: '44444444-4444-4444-4444-444444444444',
        project_id: '33333333-3333-3333-3333-333333333333',
        lines: [{ id: '55555555-5555-5555-5555-555555555555', item_id: null, description: 'OPC 53 cement', unit: 'bag', quantity: 100, estimated_rate: '350.50' }],
      },
    });

    mount(<NewPurchaseOrder onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Order number/), { target: { value: 'PO-3001' } });
    fireEvent.change(await screen.findByLabelText('Vendor'), { target: { value: '11111111-1111-1111-1111-111111111111' } });
    fireEvent.change(screen.getByLabelText(/Order date/), { target: { value: '2026-09-24' } });

    fireEvent.change(await screen.findByLabelText(/From an approved requisition/), { target: { value: '44444444-4444-4444-4444-444444444444' } });

    // The line came from the requisition, not from a blank template.
    await waitFor(() => expect((screen.getByPlaceholderText('Description') as HTMLInputElement).value).toBe('OPC 53 cement'));
    expect((screen.getByPlaceholderText('Quantity') as HTMLInputElement).value).toBe('100');
    expect((screen.getByPlaceholderText('Unit rate') as HTMLInputElement).value).toBe('350.5');

    fireEvent.click(screen.getByRole('button', { name: 'Raise order' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0].body as any;
    expect(body.requisition_id).toBe('44444444-4444-4444-4444-444444444444');
    expect(body.project_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(body.lines).toEqual([{
      requisition_line_id: '55555555-5555-5555-5555-555555555555',
      description: 'OPC 53 cement',
      unit: 'bag',
      quantity: 100,
      unit_rate: 350.5,
      gst_rate_pct: 0,
    }]);
  });
});

describe('NewGrn (B-005)', () => {
  const poLines = [
    { id: '66666666-6666-6666-6666-666666666666', description: 'TMT bars 12mm', quantity: 500, pendingQuantity: 200 },
  ];

  it('sends the built payload to POST /api/v1/grns, with over_receipt_reason carried alongside the schema fields', async () => {
    const onCreated = vi.fn();
    mount(<NewGrn purchaseOrderId="77777777-7777-7777-7777-777777777777" poNumber="PO-2001" lines={poLines} onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Receipt number/), { target: { value: 'GRN-3001' } });
    fireEvent.change(screen.getByLabelText(/Received date/), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByLabelText(/Over-receipt reason/), { target: { value: 'Vendor over-delivered a full pallet' } });
    // The line pre-fills from the pending quantity; push it over what was ordered.
    fireEvent.change(screen.getByPlaceholderText('Received quantity'), { target: { value: '250' } });
    fireEvent.change(screen.getByPlaceholderText('Accepted quantity'), { target: { value: '250' } });

    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/grns', method: 'POST' });
    expect(sent[0].body).toEqual({
      grn_no: 'GRN-3001',
      purchase_order_id: '77777777-7777-7777-7777-777777777777',
      received_date: '2026-09-24',
      over_receipt_reason: 'Vendor over-delivered a full pallet',
      lines: [{ po_line_id: '66666666-6666-6666-6666-666666666666', received_quantity: 250, accepted_quantity: 250 }],
    });
    const body = sent[0].body as any;
    expect(typeof body.lines[0].received_quantity).toBe('number');
    expect(typeof body.lines[0].accepted_quantity).toBe('number');
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});

describe('NewRfq (B-005)', () => {
  it('sends the built payload to POST /api/v1/rfqs, including the checked vendor_ids', async () => {
    handlers['GET /api/v1/vendors?limit=100'] = () => jsonResponse({
      data: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Vendor One' }, { id: '22222222-2222-2222-2222-222222222222', name: 'Vendor Two' }],
    });
    handlers['GET /api/v1/requisitions?limit=100'] = () => jsonResponse({ data: [] });

    const onCreated = vi.fn();
    mount(<NewRfq onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/RFQ number/), { target: { value: 'RFQ-4001' } });
    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: '2026-10-10' } });
    fireEvent.click(await screen.findByLabelText('Vendor One'));
    fireEvent.click(screen.getByLabelText('Vendor Two'));
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Shuttering plywood 12mm' } });
    fireEvent.change(screen.getByPlaceholderText('Unit'), { target: { value: 'sheet' } });
    fireEvent.change(screen.getByPlaceholderText('Quantity'), { target: { value: '200' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send RFQ' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/rfqs', method: 'POST' });
    expect(sent[0].body).toEqual({
      rfq_no: 'RFQ-4001',
      due_date: '2026-10-10',
      vendor_ids: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
      lines: [{ description: 'Shuttering plywood 12mm', unit: 'sheet', quantity: 200 }],
    });
    expect(typeof (sent[0].body as any).lines[0].quantity).toBe('number');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });
});
