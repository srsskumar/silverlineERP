/**
 * Task 5f item 4 — shifts (§47) had GET/POST /api/v1/shifts and no web UI
 * at all. This task also adds PATCH /api/v1/shifts/:id (edit was requested
 * but only create existed). Mounts the real form against a stubbed fetch
 * and asserts the exact request each path sends.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { ShiftForm } from '@/components/allocation/ShiftForm';
import { ShiftsManager } from '@/components/allocation/ShiftsManager';
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
const ME_MANAGE = meFor(['roster.read', 'roster.manage']);
const ME_READ_ONLY = meFor(['roster.read']);
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
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    if (init?.body || method === 'POST' || method === 'PATCH') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'shift-new', code: 'DAY', version: 1 } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('ShiftForm create', () => {
  it('sends the built payload to POST /api/v1/shifts, including toggled rest days', async () => {
    const onSaved = vi.fn();
    mount(<ShiftForm onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'day' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Day shift' } });
    fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'SUN' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/shifts', method: 'POST' });
    expect(sent[0].body).toEqual({
      code: 'DAY', name: 'Day shift', starts_at: '09:00', ends_at: '18:00', break_minutes: 60,
      rest_days: ['SUN'], daily_threshold_hours: 8, overtime_multiplier: 1.5,
      effective_from: '2026-10-01', active: true,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/shifts'] = () => jsonResponse({
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      field_errors: [{ field: 'code', message: 'Shift DAY already exists' }],
    }, 422);

    mount(<ShiftForm onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/^Code/), { target: { value: 'day' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Day shift' } });
    fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Shift DAY already exists')).toBeInTheDocument();
  });
});

describe('ShiftForm edit', () => {
  it('sends the editable fields (never code) to PATCH /api/v1/shifts/:id, with the version in If-Match', async () => {
    const existing = {
      id: 'shift-9', code: 'NIGHT', name: 'Night', starts_at: '22:00:00', ends_at: '06:00:00',
      break_minutes: 30, rest_days: [], daily_threshold_hours: 8, overtime_multiplier: 1.5,
      rest_day_multiplier: null, effective_from: '2026-09-01', effective_to: null, active: true,
      shift_hours: 7.5, version: 4,
    };
    mount(<ShiftForm initial={existing as any} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/shifts/shift-9', method: 'PATCH' });
    expect(sent[0].body).toEqual({
      name: 'Night shift', starts_at: '22:00', ends_at: '06:00', break_minutes: 30,
      rest_days: [], daily_threshold_hours: 8, overtime_multiplier: 1.5,
      effective_from: '2026-09-01', active: true, effective_to: null,
    });
    expect(sent[0].headers['x-record-version']).toBe('4');
    expect(sent[0].body).not.toHaveProperty('code');
  });
});

describe('fix round 1 item 3 — clearing effective_to on edit sends an explicit null', () => {
  it('sends effective_to: null when a shift that had one is cleared', async () => {
    const existing = {
      id: 'shift-9', code: 'NIGHT', name: 'Night', starts_at: '22:00:00', ends_at: '06:00:00',
      break_minutes: 30, rest_days: [], daily_threshold_hours: 8, overtime_multiplier: 1.5,
      rest_day_multiplier: null, effective_from: '2026-09-01', effective_to: '2026-12-31', active: true,
      shift_hours: 7.5, version: 4,
    };
    mount(<ShiftForm initial={existing as any} onClose={vi.fn()} onSaved={vi.fn()} />);

    // The field starts pre-filled from the existing shift...
    expect(await screen.findByLabelText(/Effective to/)).toHaveValue('2026-12-31');
    // ...and clearing it must send null, not omit the key (which a PATCH
    // would read as "leave it alone," via the API's own COALESCE).
    fireEvent.change(screen.getByLabelText(/Effective to/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ effective_to: null });
  });
});

describe('fix round 1 item 1 — ShiftsManager gates write controls on roster.manage', () => {
  const listHandler = () => jsonResponse({
    data: [{
      id: 'shift-1', code: 'DAY', name: 'Day', starts_at: '09:00:00', ends_at: '18:00:00',
      break_minutes: 60, rest_days: [], daily_threshold_hours: 8, overtime_multiplier: 1.5,
      effective_from: '2026-09-01', effective_to: null, active: true, shift_hours: 8, version: 1,
    }],
  });

  it('hides "New shift" and Edit from a roster.read-only session', async () => {
    ME = ME_READ_ONLY;
    handlers['GET /api/v1/shifts'] = listHandler;
    mount(<ShiftsManager />);
    await screen.findByText('DAY');
    expect(screen.queryByRole('button', { name: 'New shift' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows "New shift" and Edit for a session holding roster.manage', async () => {
    handlers['GET /api/v1/shifts'] = listHandler;
    mount(<ShiftsManager />);
    expect(await screen.findByRole('button', { name: 'New shift' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});
