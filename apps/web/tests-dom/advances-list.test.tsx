/**
 * Item 6 (final QA fix wave) — "New advance" had no list beside it and no
 * GET to back one. Mounts AdvancesList against a stubbed fetch and proves it
 * shows an advance that was created, scoped to the project it asks for.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { AdvancesList } from '@/components/billing/AdvancesList';
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
    roles: ['SUPER_ADMIN'], permissions: ['rabill.read'], impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {};
let requested: string[] = [];

function stripOrigin(url: string) {
  return String(url).replace(/^https?:\/\/[^/]+/, '');
}

beforeEach(() => {
  handlers = {};
  requested = [];
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = stripOrigin(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') return jsonResponse(ME);
    requested.push(path);
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

const PROJECT_ID = '33333333-3333-3333-3333-333333333333';

describe('AdvancesList (item 6, final QA fix wave)', () => {
  it('shows an advance the user just created', async () => {
    handlers[`GET /api/v1/advances?project_id=${PROJECT_ID}`] = () => jsonResponse({
      data: [{
        id: 'adv-1', advance_type: 'MOBILISATION', amount: 500000, paid_on: '2026-09-01',
        recovery_pct: 10, recovered_amount: 0, status: 'OUTSTANDING',
      }],
    });

    mount(<AdvancesList projectId={PROJECT_ID} />);

    expect(await screen.findByText('Mobilisation')).toBeInTheDocument();
    // StatusBadge title-cases the raw status.
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
    // Scoped to the project it was asked to show.
    expect(requested).toContain(`/api/v1/advances?project_id=${PROJECT_ID}`);
  });

  it('renders nothing rather than an empty table when there are no advances', async () => {
    handlers[`GET /api/v1/advances?project_id=${PROJECT_ID}`] = () => jsonResponse({ data: [] });

    const { container } = mount(<AdvancesList projectId={PROJECT_ID} />);

    await waitFor(() => expect(requested).toContain(`/api/v1/advances?project_id=${PROJECT_ID}`));
    expect(container.querySelector('table')).not.toBeInTheDocument();
  });

  it('shows an error card rather than an empty list on failure', async () => {
    handlers[`GET /api/v1/advances?project_id=${PROJECT_ID}`] = () =>
      jsonResponse({ code: 'SERVER_ERROR', message: 'Something broke' }, 500);

    mount(<AdvancesList projectId={PROJECT_ID} />);

    // The AuthProvider's QueryClient retries a failed query once with a
    // ~1s backoff before it settles as an error, so this needs more than
    // Testing Library's default 1s findBy timeout.
    expect(await screen.findByText('Something broke', {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
