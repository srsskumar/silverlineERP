/**
 * The "More filters" assignee dropdown, and the assignee-typed custom field
 * inside it, used to print whatever login the project's people endpoint
 * happened to send -- a username, which is not how anybody refers to a
 * colleague. The endpoint now joins the employee record and sends a name
 * alongside it; the dropdown prefers that name and only falls back to the
 * username for an account with nothing behind it (an administrator, a
 * service login).
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PEOPLE = [
  { id: 'u-asha', username: 'asha.rao', name: 'Asha Rao', emp_no: 'EMP-042' },
  { id: 'u-admin', username: 'admin', name: null, emp_no: null },
];

let apiRequestRaw: ReturnType<typeof vi.fn>;

function mockSession(permissions: string[], roles: string[]) {
  vi.doMock('@/components/AuthProvider', () => ({
    useAuth: () => ({
      session: { permissions, roles, user: { id: 'u1' } },
      status: 'authenticated',
    }),
  }));
}

beforeEach(() => {
  vi.resetModules();
  apiRequestRaw = vi.fn(async (path: string) => {
    if (path.includes('/people')) {
      return { body: { data: PEOPLE, has_more: false }, requestId: 't' };
    }
    return { body: { data: [] }, requestId: 't' };
  });
  vi.doMock('@/lib/apiClient', () => ({ apiRequestRaw }));
  // ADMIN holds task.read for real (ROLE_PERMISSIONS: [...ALL_PERMISSIONS]);
  // the mock has to carry it too now that the fetch gates on the permission
  // itself rather than on the role's name.
  mockSession(['task.read'], ['ADMIN']);
});

function wrap(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(React.createElement(QueryClientProvider, { client }, node));
}

describe('AdvancedTaskFilters', () => {
  it('shows the assignee by employee name, falling back to the username only when there is none', async () => {
    const { AdvancedTaskFilters } = await import('@/components/v2/AdvancedTaskFilters');
    wrap(
      <AdvancedTaskFilters
        project="p1"
        value={{}}
        onChange={() => {}}
      />,
    );

    // <details> content is inaccessible until opened -- the same as a user
    // has to click "More filters" before the assignee select is reachable.
    fireEvent.click(screen.getByText('More filters'));

    const select = await screen.findByLabelText('Assignee') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3)); // "Anyone" + 2 people

    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Asha Rao');
    expect(labels).not.toContain('asha.rao');
    // An account with no employee record still has to be pickable.
    expect(labels).toContain('admin');
  });

  it('does not fetch project people or custom fields for a role without task.read (P-001 round 2)', async () => {
    // GOVT_OBSERVER holds no permissions at all (GOVT_OBSERVER_ROLE_GRANTS
    // union: []). The old guard (`!roles.every(r => r === 'CLIENT_VIEWER')`)
    // only ever protected CLIENT_VIEWER by name -- any other role with no
    // task.read, this one included, sailed past it and still 403'd GET
    // /projects/:id/people and GET /custom-fields on every load.
    mockSession([], ['GOVT_OBSERVER']);
    const { AdvancedTaskFilters } = await import('@/components/v2/AdvancedTaskFilters');
    wrap(<AdvancedTaskFilters project="p1" value={{}} onChange={() => {}} />);
    fireEvent.click(screen.getByText('More filters'));

    const select = await screen.findByLabelText('Assignee') as HTMLSelectElement;
    // Only "Anyone": no people fetch went out, so nothing populated it.
    await waitFor(() => expect(select.options.length).toBe(1));
    expect(apiRequestRaw).not.toHaveBeenCalledWith(
      expect.stringContaining('/people'), expect.anything(),
    );
    expect(apiRequestRaw).not.toHaveBeenCalledWith(
      expect.stringContaining('/custom-fields'), expect.anything(),
    );
  });

  it('does fetch project people for CLIENT_VIEWER, which holds task.read', async () => {
    // The inverse of P-001: CLIENT_VIEWER actually holds task.read
    // (S4_ROLE_GRANTS), so the old role-name guard denied it a fetch it was
    // entitled to make -- the assignee dropdown silently stayed empty for a
    // permitted role.
    mockSession(['task.read'], ['CLIENT_VIEWER']);
    const { AdvancedTaskFilters } = await import('@/components/v2/AdvancedTaskFilters');
    wrap(<AdvancedTaskFilters project="p1" value={{}} onChange={() => {}} />);
    fireEvent.click(screen.getByText('More filters'));

    const select = await screen.findByLabelText('Assignee') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
  });
});
