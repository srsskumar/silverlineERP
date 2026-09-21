/**
 * §076 -- the panel that decides what somebody sees.
 *
 * The failures that matter here are the quiet ones: a restriction that
 * restricts nothing, a control offered where it would do nothing, and a
 * screen that does not say which of the two things it is changing (the
 * screens, or the data). All three are asserted.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface Payload {
  project_access: string;
  project_ids: string[];
  programmes: Array<{ survey_project_id: string; project_role: string }>;
}
const getAssignments = vi.fn(async (_id: string) => structuredClone(BASE) as unknown);
const putAssignments = vi.fn(async (_id: string, _body: Payload) => ({ summary: 'saved' }));
vi.mock('@/lib/employees', () => ({
  getAssignments: (id: string) => getAssignments(id),
  putAssignments: (id: string, body: Payload) => putAssignments(id, body),
}));

const { EmployeeAssignments } = await import('@/components/EmployeeAssignments');

const BASE = {
  employee: { id: 'e1', name: 'Ravi Kumar' },
  user: { id: 'u1', username: 'r.kumar' },
  roles: ['PROJECT_MANAGER'],
  project_access: 'ORGANISATION' as const,
  project_ids: [] as string[],
  programmes: [] as Array<Record<string, unknown>>,
  other_scopes: [] as Array<{ scope_type: string; label: string | null }>,
  choices: {
    projects: [
      { id: 'p1', code: 'PRJ-1', name: 'Kurnool resurvey', status: 'ACTIVE' },
      { id: 'p2', code: 'PRJ-2', name: 'Anantapur roads', status: 'ACTIVE' },
    ],
    programmes: [{ id: 's1', code: 'SP-1', name: 'Kurnool programme', status: 'ACTIVE' }],
  },
  summary: 'Sees every project in the organisation, and no survey programmes.',
};

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  getAssignments.mockReset().mockResolvedValue(structuredClone(BASE));
  putAssignments.mockClear();
});

describe('what the panel says it does', () => {
  it('separates the screens from the data, in words', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    expect(screen.getByText(/role decides which screens/i)).toBeTruthy();
    expect(screen.getByText(/Nothing here grants or removes a permission/i)).toBeTruthy();
  });

  it('warns that saving signs them out, because that is surprising', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    expect(screen.getByText(/signs them out/i)).toBeTruthy();
  });
});

describe('projects', () => {
  it('will not save a restriction that restricts nothing', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    fireEvent.click(screen.getByLabelText(/only the projects ticked below/i));

    expect(screen.getByText(/would read as a restriction and act as none/i)).toBeTruthy();
    const save = screen.getByRole('button', { name: /save assignments/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('saves the projects that were ticked', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    fireEvent.click(screen.getByLabelText(/only the projects ticked below/i));
    fireEvent.click(screen.getByText('Kurnool resurvey'));

    fireEvent.click(screen.getByRole('button', { name: /save assignments/i }));
    await waitFor(() => expect(putAssignments).toHaveBeenCalledTimes(1));
    expect(putAssignments.mock.calls[0][1]).toMatchObject({
      project_access: 'ASSIGNED', project_ids: ['p1'],
    });
  });

  it('offers no project control at all when there is no login to carry one', async () => {
    getAssignments.mockResolvedValue({ ...structuredClone(BASE), user: null });
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    expect(screen.getByText(/no login, so there is no project access to set/i)).toBeTruthy();
    expect(screen.queryByLabelText(/only the projects ticked below/i)).toBeNull();
    // ...but the programme half is still there, because a chainman has no login either.
    expect(screen.getByText('Kurnool programme')).toBeTruthy();
  });

  it('says when a limit set on another screen is also in force', async () => {
    getAssignments.mockResolvedValue({
      ...structuredClone(BASE),
      other_scopes: [{ scope_type: 'district', label: 'Kurnool' }],
    });
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    expect(await screen.findByText(/district \(Kurnool\)/)).toBeTruthy();
  });
});

describe('programmes', () => {
  it('carries a role once a programme is ticked, and sends it', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit />);
    await screen.findByText('Assigned work');
    fireEvent.click(screen.getByText('Kurnool programme'));

    const role = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(role, { target: { value: 'QC_USER' } });
    fireEvent.click(screen.getByRole('button', { name: /save assignments/i }));

    await waitFor(() => expect(putAssignments).toHaveBeenCalledTimes(1));
    expect(putAssignments.mock.calls[0][1]).toMatchObject({
      programmes: [{ survey_project_id: 's1', project_role: 'QC_USER' }],
    });
  });
});

describe('without permission to change it', () => {
  it('shows the assignments and no way to alter them', async () => {
    wrap(<EmployeeAssignments employeeId="e1" canEdit={false} />);
    await screen.findByText('Assigned work');
    expect(screen.queryByRole('button', { name: /save assignments/i })).toBeNull();
    expect((screen.getByLabelText(/every project in the organisation/i) as HTMLInputElement).disabled).toBe(true);
  });
});
