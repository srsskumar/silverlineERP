/**
 * "On leave today" is a badge, not a status (owner decision 2026-09-24 #2).
 *
 * The API computes `on_leave_today` in SQL from approved leave covering the
 * organisation's current day and exposes it on employee list/detail
 * responses. The employee `status` field itself never gains an ON_LEAVE
 * value -- the badge is purely a read-model overlay next to it.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PERMISSIONS_HELD = [
  'employee.read',
  'employee.create',
  'employee.exit',
  'employee.reactivate',
  'users.read',
  'document.upload',
];

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { permissions: PERMISSIONS_HELD, user: { id: 'u1', username: 'hr' } } }),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/EmployeeAssignments', () => ({ EmployeeAssignments: () => null }));
vi.mock('@/components/DocumentList', () => ({ DocumentList: () => null }));
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiClient')>()),
  apiRequest: vi.fn(async () => ({ data: {} })),
  apiRequestRaw: vi.fn(async () => ({ data: {} })),
}));

let employee: Record<string, unknown>;
vi.mock('@/lib/employees', () => ({
  getEmployee: vi.fn(async () => employee),
  patchEmployee: vi.fn(async () => employee),
}));

const { EmployeeDetailView } = await import('@/app/employees/[id]/DetailClient');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('EmployeeDetailView on-leave-today badge (owner decision 2026-09-24 #2)', () => {
  it('shows the badge when on_leave_today is true', async () => {
    employee = {
      id: 'e1', emp_no: 'EMP001', first_name: 'Asha', status: 'ACTIVE', version: 1,
      on_leave_today: true,
    };
    wrap(<EmployeeDetailView id="e1" />);
    expect(await screen.findByTestId('on-leave-today-badge')).toHaveTextContent('On leave today');
    // The status field itself is untouched -- still ACTIVE, not ON_LEAVE.
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('shows no badge when on_leave_today is false', async () => {
    employee = {
      id: 'e2', emp_no: 'EMP002', first_name: 'Rahim', status: 'ACTIVE', version: 1,
      on_leave_today: false,
    };
    wrap(<EmployeeDetailView id="e2" />);
    await screen.findByText('ACTIVE');
    expect(screen.queryByTestId('on-leave-today-badge')).toBeNull();
  });
});
