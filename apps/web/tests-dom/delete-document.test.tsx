/**
 * Task 5f item 7 — document.delete had a complete, safe API (DELETE
 * /api/v1/documents/:id, retention/legal-hold checked server-side) and no
 * way to reach it from the web at all.
 *
 * DECISION: the document register (app/documents/page.tsx) has no per-document
 * detail page to hang a delete action off — it is a register list, opened
 * either on "what needs renewing" or on the register table, with no
 * click-through. Rather than build a detail page nothing else asked for,
 * the action sits inline on the register row, which is where every other
 * document fact (state, legal hold, retention note) already lives.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { DeleteDocumentButton } from '@/components/documents/DeleteDocumentButton';
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
    roles: ['SUPER_ADMIN'], permissions: ['document.read', 'document.delete'], impersonation: null,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let sent: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
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
    if (method === 'DELETE') {
      sent.push({ path, method, headers: (init?.headers ?? {}) as Record<string, string> });
      return jsonResponse({ data: { id: 'doc-1', deleted: true } });
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('DeleteDocumentButton', () => {
  it('sends DELETE with the version in If-Match, after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onDeleted = vi.fn();
    mount(<DeleteDocumentButton id="doc-1" title="Factory licence" version={5} onDeleted={onDeleted} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalledWith('Delete "Factory licence"? This cannot be undone.');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/documents/doc-1', method: 'DELETE' });
    expect(sent[0].headers['x-record-version']).toBe('5');
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(<DeleteDocumentButton id="doc-1" title="Factory licence" version={5} onDeleted={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(sent).toHaveLength(0);
  });

  it('shows the retention reason instead of a Delete action when the register already knows it is blocked', async () => {
    mount(
      <DeleteDocumentButton
        id="doc-2" title="Environmental clearance" version={2} onDeleted={vi.fn()}
        retention={{ deletable: false, reason: 'Under legal hold. It cannot be deleted until the hold is released, whatever its age.' }}
      />,
    );

    expect(await screen.findByText(/Under legal hold/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('surfaces the server refusal when retention was not pre-checked', async () => {
    handlers['DELETE /api/v1/documents/doc-3'] = () => jsonResponse({
      code: 'RETENTION_BLOCKED',
      message: 'Retention runs until 2028-01-01. It cannot be deleted before then.',
    }, 409);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mount(<DeleteDocumentButton id="doc-3" title="Old certificate" version={1} onDeleted={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/Retention runs until 2028-01-01/)).toBeInTheDocument();
  });
});
