/**
 * Task 5f — approval policies had a complete API (GET/POST
 * /api/v1/approval-policies, POST .../:id/deactivate) and no web UI at all:
 * a live dead end, since a document type with nothing configured fails every
 * submission with NO_APPROVAL_POLICY. This mounts the real form and manager
 * against a stubbed fetch (style of tests-dom/procurement-forms.test.tsx) and
 * asserts the exact request each control sends, plus that ErrorCard offers a
 * way back to this screen when a submission hits NO_APPROVAL_POLICY.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvider } from '@/components/AuthProvider';
import { ApprovalPolicyForm } from '@/components/approvals/ApprovalPolicyForm';
import { ApprovalPoliciesManager } from '@/components/approvals/ApprovalPoliciesManager';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { ApiClientError } from '@/lib/apiClient';
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
const ME_CONFIGURE = meFor(['approval.read', 'approval.configure']);
const ME_ACT_ONLY = meFor(['approval.read', 'approval.act']);

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } as unknown as Response;
}

let sent: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }> = [];
let handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {};
let me = ME_CONFIGURE;

function stripOrigin(url: string) {
  return String(url).replace(/^https?:\/\/[^/]+/, '');
}

beforeEach(() => {
  sent = [];
  handlers = {};
  me = ME_CONFIGURE;
  window.localStorage.clear();
  __resetAuthStateForTests();
  setTokens('admin-access', 'admin-refresh');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = stripOrigin(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me') return jsonResponse(me);
    if (path === '/api/v1/projects?limit=100') return jsonResponse({ data: [] });
    const key = `${method} ${path}`;
    if (handlers[key]) return handlers[key](init);
    if (init?.body || method === 'POST') {
      sent.push({
        path, method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return jsonResponse({ data: { id: 'policy-1', name: 'New policy', document_type: 'ADVANCE', version: 1 } }, 201);
    }
    return jsonResponse({ data: [] });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: React.ReactElement) {
  return render(<AuthProvider>{node}</AuthProvider>);
}

describe('ApprovalPolicyForm', () => {
  it('sends the built payload to POST /api/v1/approval-policies', async () => {
    const onSaved = vi.fn();
    mount(<ApprovalPolicyForm onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(await screen.findByLabelText(/Document type/), { target: { value: 'ADVANCE' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Advance DoA' } });
    fireEvent.change(screen.getByLabelText(/^Tolerance/), { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('Min amount'), { target: { value: '0' } });
    fireEvent.change(screen.getByPlaceholderText('Max amount (blank = and above)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Approver role for level 1'), { target: { value: 'PROJECT_MANAGER' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/approval-policies', method: 'POST' });
    expect(sent[0].body).toEqual({
      document_type: 'ADVANCE',
      name: 'Advance DoA',
      mode: 'CUMULATIVE',
      project_id: null,
      tolerance_pct: 5,
      active: true,
      levels: [{
        sequence: 1, min_amount: 0, max_amount: null,
        approver_role: 'PROJECT_MANAGER', approver_user_id: null, sla_hours: null,
      }],
    });
    const body = sent[0].body as any;
    expect(typeof body.tolerance_pct).toBe('number');
    expect(typeof body.levels[0].min_amount).toBe('number');
    expect(body.levels[0].max_amount).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('policy-1'));
  });

  it('renders a 422 field error on the field it names', async () => {
    handlers['POST /api/v1/approval-policies'] = () => jsonResponse({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      field_errors: [{ field: 'name', message: 'A policy with that name already exists' }],
    }, 422);

    mount(<ApprovalPolicyForm onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByPlaceholderText('Min amount'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Approver role for level 1'), { target: { value: 'ADMIN' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('A policy with that name already exists')).toBeInTheDocument();
  });

  it('fix round 1 item 4 — offers a select of real role codes for the approver role, not free text', async () => {
    mount(<ApprovalPolicyForm onClose={vi.fn()} onSaved={vi.fn()} />);

    const field = await screen.findByLabelText('Approver role for level 1');
    expect(field.tagName).toBe('SELECT');
    const options = Array.from((field as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain('PROJECT_MANAGER');
    expect(options).toContain('SUPER_ADMIN');
    expect(options).toContain('ADMIN');
    // Every option is either the blank placeholder or a real SCREAMING_CASE
    // role code — never free text.
    expect(options.every((v) => v === '' || /^[A-Z][A-Z_]*$/.test(v))).toBe(true);
  });
});

describe('fix round 1 item 5 — editing a policy locks document type and project', () => {
  const existing = {
    id: 'policy-7', document_type: 'PAYMENT', name: 'Payments DoA', mode: 'CUMULATIVE',
    project_id: null, tolerance_pct: 0, active: true, version: 2,
    levels: [{ sequence: 1, min_amount: 0, max_amount: null, approver_role: 'ADMIN', approver_user_id: null, sla_hours: null }],
  };

  it('shows the document type and project as locked text, not editable controls', async () => {
    mount(<ApprovalPolicyForm initial={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText('Payment');
    expect(screen.queryByLabelText(/Document type/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Project/)).not.toBeInTheDocument();
  });

  it('still submits the original document_type and project_id even though they cannot be edited', async () => {
    mount(<ApprovalPolicyForm initial={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText('Payment');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Payments DoA v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ document_type: 'PAYMENT', project_id: null, name: 'Payments DoA v2' });
  });
});

describe('ApprovalPoliciesManager deactivate', () => {
  it('sends the version in If-Match to POST .../:id/deactivate', async () => {
    handlers['GET /api/v1/approval-policies'] = () => jsonResponse({
      data: [{
        id: 'policy-9', document_type: 'PAYMENT', name: 'Payments DoA', mode: 'CUMULATIVE',
        project_id: null, active: true, version: 3, levels: [{ sequence: 1 }],
      }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mount(<ApprovalPoliciesManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ path: '/api/v1/approval-policies/policy-9/deactivate', method: 'POST' });
    // apiClient sends the version as X-Record-Version, not If-Match (lower-cased
    // per the Headers object it builds the fetch init from).
    expect(sent[0].headers['x-record-version']).toBe('3');
  });

  it('does nothing when the confirmation is declined', async () => {
    handlers['GET /api/v1/approval-policies'] = () => jsonResponse({
      data: [{
        id: 'policy-9', document_type: 'PAYMENT', name: 'Payments DoA', mode: 'CUMULATIVE',
        project_id: null, active: true, version: 3, levels: [{ sequence: 1 }],
      }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    mount(<ApprovalPoliciesManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    expect(sent).toHaveLength(0);
  });
});

describe('warns before deactivating the last active policy for a document type (owner decision 2026-09-24)', () => {
  it('names the document type and the NO_APPROVAL_POLICY consequence when it is the only active one', async () => {
    handlers['GET /api/v1/approval-policies'] = () => jsonResponse({
      data: [{
        id: 'policy-9', document_type: 'PURCHASE_REQUISITION', name: 'Org default -- Purchase Requisition',
        mode: 'CUMULATIVE', project_id: null, active: true, version: 1, levels: [{ sequence: 1 }],
      }],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    mount(<ApprovalPoliciesManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain('only active policy');
    expect(message).toContain('Requisition');
  });

  it('uses the ordinary message when another active policy still covers the document type', async () => {
    handlers['GET /api/v1/approval-policies'] = () => jsonResponse({
      data: [
        {
          id: 'policy-org', document_type: 'PURCHASE_REQUISITION', name: 'Org default -- Purchase Requisition',
          mode: 'CUMULATIVE', project_id: null, active: true, version: 1, levels: [{ sequence: 1 }],
        },
        {
          id: 'policy-project', document_type: 'PURCHASE_REQUISITION', name: 'Site 7 ladder',
          mode: 'CUMULATIVE', project_id: 'proj-7', active: true, version: 1, levels: [{ sequence: 1 }],
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    mount(<ApprovalPoliciesManager />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Deactivate' }))[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).not.toContain('only active policy');
  });
});

describe('fix round 1 item 6 — only the clicked row shows a loading state while deactivating', () => {
  it('leaves every other row\'s Deactivate button alone while one is in flight', async () => {
    handlers['GET /api/v1/approval-policies'] = () => jsonResponse({
      data: [
        { id: 'policy-1', document_type: 'PAYMENT', name: 'Payments DoA', mode: 'CUMULATIVE', project_id: null, active: true, version: 1, levels: [] },
        { id: 'policy-2', document_type: 'ADVANCE', name: 'Advance DoA', mode: 'CUMULATIVE', project_id: null, active: true, version: 1, levels: [] },
      ],
    });
    const resolver: { fn: (() => void) | null } = { fn: null };
    handlers['POST /api/v1/approval-policies/policy-1/deactivate'] = () => new Promise((resolve) => {
      resolver.fn = () => resolve(jsonResponse({ data: { id: 'policy-1', version: 2, active: false } }));
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mount(<ApprovalPoliciesManager />);

    const deactivateButtons = await screen.findAllByRole('button', { name: 'Deactivate' });
    expect(deactivateButtons).toHaveLength(2);
    fireEvent.click(deactivateButtons[0]);

    await waitFor(() => expect(deactivateButtons[0]).toHaveAttribute('aria-busy', 'true'));
    expect(deactivateButtons[1]).not.toHaveAttribute('aria-busy', 'true');
    expect(deactivateButtons[1]).not.toBeDisabled();

    resolver.fn?.();
    await waitFor(() => expect(deactivateButtons[0]).not.toHaveAttribute('aria-busy', 'true'));
  });
});

describe('fix round 1 item 1 — ApprovalPoliciesManager gates write controls on approval.configure', () => {
  // Defense in depth: app/approvals/policies/page.tsx already requires
  // approval.configure to open the page at all, but the manager checks its
  // own permission too, the same way PaymentDetail does, rather than relying
  // solely on the page wrapper.
  const listHandler = () => jsonResponse({
    data: [{
      id: 'policy-9', document_type: 'PAYMENT', name: 'Payments DoA', mode: 'CUMULATIVE',
      project_id: null, active: true, version: 3, levels: [{ sequence: 1 }],
    }],
  });

  it('hides New policy, Edit and Deactivate from a session without approval.configure', async () => {
    me = ME_ACT_ONLY;
    handlers['GET /api/v1/approval-policies'] = listHandler;
    mount(<ApprovalPoliciesManager />);
    await screen.findByText('Payments DoA');
    expect(screen.queryByRole('button', { name: 'New policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('shows New policy, Edit and Deactivate for a session holding approval.configure', async () => {
    handlers['GET /api/v1/approval-policies'] = listHandler;
    mount(<ApprovalPoliciesManager />);
    expect(await screen.findByRole('button', { name: 'New policy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });
});

describe('ErrorCard on NO_APPROVAL_POLICY', () => {
  const error = new ApiClientError(422, {
    code: 'NO_APPROVAL_POLICY',
    message: 'No approval route is set up for advance. Ask an administrator to add one under Approvals → Policies.',
  });

  it('offers a direct link to someone holding approval.configure', async () => {
    mount(<ErrorCard error={error} />);
    const link = await screen.findByRole('link', { name: /Add an approval policy/ });
    expect(link).toHaveAttribute('href', '/approvals/policies');
  });

  it('offers no link to someone who cannot configure policies', async () => {
    me = ME_ACT_ONLY;
    mount(<ErrorCard error={error} />);
    await screen.findByText(/No approval route is set up/);
    expect(screen.queryByRole('link', { name: /Add an approval policy/ })).not.toBeInTheDocument();
  });
});
