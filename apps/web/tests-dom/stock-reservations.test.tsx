/**
 * Task 5f item 5 — stock reservations (§44) had a complete API
 * (GET/POST /api/v1/stock-reservations, POST .../:id/release) and no web UI:
 * a "Reservations" tab beside Stock/Ledger/Vendors/Invoices in the inventory
 * Workbench, built from the same generic Collection/MutationForm DSL those
 * tabs already use. Mounts the real tab against a stubbed fetch and asserts
 * the exact request each control sends.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { StockReservationsTab } from '@/components/inventory/StockReservationsTab';
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
const ME_MANAGE = meFor(['reservation.read', 'reservation.manage']);
const ME_READ_ONLY = meFor(['reservation.read']);
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
    if (path === '/api/v1/inventory/items?limit=100') return jsonResponse({ data: [{ id: 'item-1', code: 'CEM', name: 'Cement' }] });
    if (path === '/api/v1/stock-locations?limit=100') return jsonResponse({ data: [{ id: 'loc-1', code: 'WH1', name: 'Warehouse 1' }] });
    if (path === '/api/v1/projects?limit=100') return jsonResponse({ data: [] });
    // The Collection component always appends its own pagination params
    // (limit/offset), so handlers below are keyed on the path alone.
    const key = `${method} ${path.split('?')[0]}`;
    if (handlers[key]) return handlers[key](init);
    if (path.startsWith('/api/v1/stock-reservations?')) return jsonResponse({ data: [] });
    if (method === 'POST') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'res-new', state: 'ACTIVE', version: 1 } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('StockReservationsTab create', () => {
  it('sends the built payload to POST /api/v1/stock-reservations', async () => {
    mount(<StockReservationsTab />);

    const itemBox = await screen.findByLabelText(/^Item/);
    fireEvent.focus(itemBox);
    fireEvent.click(await screen.findByRole('option', { name: /Cement/ }));

    const locationBox = screen.getByLabelText(/^Location/);
    fireEvent.focus(locationBox);
    fireEvent.click(await screen.findByRole('option', { name: /Warehouse 1/ }));

    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '25' } });

    fireEvent.click(screen.getByRole('button', { name: 'Reserve' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/stock-reservations', method: 'POST' });
    expect(sent[0].body).toEqual({ item_id: 'item-1', location_id: 'loc-1', quantity: '25' });
  });
});

describe('StockReservationsTab release', () => {
  it('sends the version in If-Match and an empty body to POST .../:id/release', async () => {
    handlers['GET /api/v1/stock-reservations'] = () => jsonResponse({
      data: [{
        id: 'res-1', item_id: 'item-1', item_code: 'CEM', item_name: 'Cement',
        location_name: 'Warehouse 1', quantity: 25, project_code: null,
        state: 'ACTIVE', expires_on: null, version: 3,
      }],
    });

    mount(<StockReservationsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Release' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/stock-reservations/res-1/release', method: 'POST' });
    expect(sent[0].body).toEqual({});
    expect(sent[0].headers['x-record-version']).toBe('3');
  });
});

describe('fix round 1 item 1 — StockReservationsTab already gates write controls on reservation.manage', () => {
  it('hides the "New reservation" form and the Release action from a reservation.read-only session', async () => {
    ME = ME_READ_ONLY;
    handlers['GET /api/v1/stock-reservations'] = () => jsonResponse({
      data: [{
        id: 'res-1', item_id: 'item-1', item_code: 'CEM', item_name: 'Cement',
        location_name: 'Warehouse 1', quantity: 25, project_code: null,
        state: 'ACTIVE', expires_on: null, version: 3,
      }],
    });
    mount(<StockReservationsTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(screen.queryByRole('button', { name: 'Reserve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
  });
});
