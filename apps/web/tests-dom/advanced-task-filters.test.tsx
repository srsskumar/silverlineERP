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

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@/lib/apiClient', () => ({
    apiRequestRaw: vi.fn(async (path: string) => {
      if (path.includes('/people')) {
        return { body: { data: PEOPLE, has_more: false }, requestId: 't' };
      }
      return { body: { data: [] }, requestId: 't' };
    }),
  }));
  vi.doMock('@/components/AuthProvider', () => ({
    useAuth: () => ({
      session: { permissions: [], roles: ['ADMIN'], user: { id: 'u1' } },
      status: 'authenticated',
    }),
  }));
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
});
