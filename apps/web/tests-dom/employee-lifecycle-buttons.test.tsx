/**
 * A-010: DRAFT and SUSPENDED employees had no way back onto the roster
 * through the web UI.
 *
 * The API has always had `POST /employees/:id/activate` (DRAFT → ACTIVE) and
 * `POST /employees/:id/suspend` (ACTIVE → SUSPENDED) — the activate route's
 * own comment says creation "deliberately lands an employee in DRAFT ...
 * [activation] is the explicit, audited step that puts them on the roster
 * once the record is complete" — but `EmployeeDetailView` only ever wired up
 * Exit and Reactivate. Reactivate itself was also scoped to
 * `exited` (EXITED/TERMINATED only), so a SUSPENDED employee could not be
 * reactivated either, even though the server's reactivate route explicitly
 * accepts SUSPENDED as a starting status.
 *
 * Net effect: every employee created through the web app starts DRAFT (the
 * server always inserts it, per A-008) and could never be moved to ACTIVE
 * through the product — a full onboarding-to-active dead end.
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

describe('EmployeeDetailView lifecycle actions (A-010)', () => {
  it('offers Activate for a DRAFT employee', async () => {
    employee = { id: 'e1', emp_no: 'EMP001', first_name: 'Asha', status: 'DRAFT', version: 1 };
    wrap(<EmployeeDetailView id="e1" />);
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
  });

  it('offers Suspend (not just Exit) for an ACTIVE employee', async () => {
    employee = { id: 'e2', emp_no: 'EMP002', first_name: 'Rahim', status: 'ACTIVE', version: 1 };
    wrap(<EmployeeDetailView id="e2" />);
    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
  });

  it('offers Reactivate (not Activate) for a SUSPENDED employee', async () => {
    employee = { id: 'e3', emp_no: 'EMP003', first_name: 'Meera', status: 'SUSPENDED', version: 1 };
    wrap(<EmployeeDetailView id="e3" />);
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });
});
