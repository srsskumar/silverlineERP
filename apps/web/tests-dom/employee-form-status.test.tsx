/**
 * A-008: editing an employee always 422'd, no matter what you changed.
 *
 * `EmployeeForm`'s edit mode showed a "Status" `<select>` seeded from the
 * employee's real current status (a non-empty value, since every employee
 * has one). React Hook Form includes every registered field in the values
 * object handed to `onSubmit`, so every save sent `status` back to the API
 * even when the picker was never touched. `PATCH /employees/:id` explicitly
 * 422s the instant `"status" in req.body` — "Status is immutable here; use
 * exit/reactivate" — so no edit could ever succeed.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/employees', () => ({
  listEmployees: vi.fn(async () => ({ data: [] })),
}));
vi.mock('@/lib/org', () => ({
  listOrgUnits: vi.fn(async () => ({ data: [] })),
}));
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiClient')>()),
  apiRequest: vi.fn(async () => ({ data: [] })),
  apiRequestRaw: vi.fn(async () => ({ data: [] })),
}));

const { EmployeeForm } = await import('@/components/EmployeeForm');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const EXISTING_EMPLOYEE = {
  id: 'e1',
  emp_no: 'EMP001',
  first_name: 'Jane',
  phone: '+919876543210',
  date_of_joining: '2024-01-01',
  status: 'ACTIVE',
  version: 3,
};

describe('EmployeeForm edit mode', () => {
  it('does not send status back on an untouched save (A-008)', async () => {
    const onSubmit = vi.fn(async () => {});
    wrap(
      <EmployeeForm mode="edit" defaultValues={EXISTING_EMPLOYEE} submitLabel="Save changes" onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('status');
  });

  it('has no writable Status control at all — the API rejects it on PATCH and silently ignores it on create', () => {
    wrap(<EmployeeForm mode="edit" defaultValues={EXISTING_EMPLOYEE} onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText('Status')).toBeNull();
  });

  it(
    'saves an employee with Gender left on its blank placeholder option (A-009: an optional ' +
      '<select> enum with no ""-tolerant schema blocked every save, not just that field)',
    async () => {
      const onSubmit = vi.fn(async () => {});
      // EXISTING_EMPLOYEE has no `gender`, so the native <select> sits on its
      // blank "Select gender" option (value ""), exactly like a real
      // employee record with gender never recorded.
      wrap(
        <EmployeeForm mode="edit" defaultValues={EXISTING_EMPLOYEE} submitLabel="Save changes" onSubmit={onSubmit} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('gender');
    },
  );
});
