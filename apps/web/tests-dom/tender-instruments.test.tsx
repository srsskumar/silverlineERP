/**
 * Task 5f item 6 — tender instruments (EMD/BG, §8.4/§22.2) had a complete
 * API (GET/POST /api/v1/instruments, POST .../:id/status) and only a
 * read-only inline list on the tender detail page — no way to add one or
 * change its status. Mounts the real components against a stubbed fetch and
 * asserts the exact request each sends.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { InstrumentForm } from '@/components/tenders/InstrumentForm';
import { TenderInstruments } from '@/components/tenders/TenderInstruments';
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
const ME_MANAGE = meFor(['instrument.read', 'instrument.manage']);
const ME_READ_ONLY = meFor(['instrument.read']);
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
    const key = `${method} ${path.split('?')[0]}`;
    if (handlers[key]) return handlers[key](init);
    if (method === 'POST') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'inst-new', version: 1 } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('InstrumentForm', () => {
  it('sends the built payload to POST /api/v1/instruments, attached to the tender', async () => {
    const onCreated = vi.fn();
    mount(<InstrumentForm tenderId="99999999-9999-9999-9999-999999999999" onCreated={onCreated} />);

    fireEvent.change(await screen.findByLabelText(/Issuing bank/), { target: { value: 'SBI' } });
    fireEvent.change(screen.getByLabelText(/Instrument number/), { target: { value: 'BG-001' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText(/Issue date/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: '2027-03-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add instrument' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/instruments', method: 'POST' });
    expect(sent[0].body).toEqual({
      instrument_type: 'EMD', issuing_bank: 'SBI', instrument_number: 'BG-001', amount: 250000,
      issue_date: '2026-09-01', expiry_date: '2027-03-01', tender_id: '99999999-9999-9999-9999-999999999999',
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/instruments'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'instrument_number', message: 'Expiry cannot precede the issue date' }],
    }, 422);

    mount(<InstrumentForm tenderId="99999999-9999-9999-9999-999999999999" onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Issuing bank/), { target: { value: 'SBI' } });
    fireEvent.change(screen.getByLabelText(/Instrument number/), { target: { value: 'BG-001' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText(/Issue date/), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: '2027-03-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add instrument' }));

    expect(await screen.findByText('Expiry cannot precede the issue date')).toBeInTheDocument();
  });
});

describe('TenderInstruments status change', () => {
  it('sends the version in If-Match and the target status to POST .../:id/status', async () => {
    handlers['GET /api/v1/instruments'] = () => jsonResponse({
      data: [{
        id: 'inst-1', instrument_type: 'EMD', issuing_bank: 'SBI', instrument_number: 'BG-001',
        amount: 250000, issue_date: '2026-09-01', expiry_date: '2027-03-01',
        instrument_status: 'ACTIVE', version: 2,
      }],
    });

    mount(<TenderInstruments tenderId="99999999-9999-9999-9999-999999999999" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Release' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm release' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/instruments/inst-1/status', method: 'POST' });
    expect(sent[0].body).toEqual({ instrument_status: 'RELEASED' });
    expect(sent[0].headers['x-record-version']).toBe('2');
  });
});

describe('fix round 1 item 1 — TenderInstruments already gates write controls on instrument.manage', () => {
  it('hides the create form and the Release/Forfeit actions from an instrument.read-only session', async () => {
    ME = ME_READ_ONLY;
    handlers['GET /api/v1/instruments'] = () => jsonResponse({
      data: [{
        id: 'inst-1', instrument_type: 'EMD', issuing_bank: 'SBI', instrument_number: 'BG-001',
        amount: 250000, issue_date: '2026-09-01', expiry_date: '2027-03-01',
        instrument_status: 'ACTIVE', version: 2,
      }],
    });

    mount(<TenderInstruments tenderId="99999999-9999-9999-9999-999999999999" />);

    await screen.findByText('BG-001');
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forfeit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add instrument' })).not.toBeInTheDocument();
  });
});
