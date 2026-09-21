/**
 * Moving a task past unfinished predecessors, from the web (WORK-11).
 *
 * The server has always accepted an override with a reason from somebody
 * holding project.update. The web said the override "is not in web S4" and
 * told people to ask their PM to use the API -- so in practice nobody could.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';

const transitionTask = vi.fn();
let permissions: string[] = [];

vi.mock('@/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('@/lib/tasks')>()),
  transitionTask: (...args: unknown[]) => transitionTask(...args),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { permissions, user: { username: 'pm' } } }),
}));

const { StatusTransitionSelect } = await import('@/components/StatusTransitionSelect');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const blocked = () => new ApiClientError(422, {
  code: 'DEPENDENCY_BLOCKED',
  message: 'Incomplete predecessor dependencies block this transition',
} as never);

async function tryToMove() {
  wrap(<StatusTransitionSelect taskId="t1" current="TO_DO" allowedNext={['IN_PROGRESS']}
    version={3} onTransitioned={() => {}} />);
  fireEvent.change(screen.getByLabelText('Move to'), { target: { value: 'IN_PROGRESS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move' }));
  await screen.findByText(/Blocked by unfinished predecessors/);
}

beforeEach(() => {
  transitionTask.mockReset();
});

describe('overriding a dependency block', () => {
  it('asks for a reason and re-sends with override for somebody who may', async () => {
    permissions = ['task.update', 'project.update'];
    transitionTask
      .mockRejectedValueOnce(blocked())
      .mockResolvedValueOnce({ id: 't1', status: 'IN_PROGRESS' });
    await tryToMove();

    fireEvent.click(screen.getByRole('button', { name: /Override with a reason/ }));
    const move = await screen.findByRole('button', { name: 'Override and move' });
    expect(move).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Client signed off the survey' } });
    fireEvent.click(move);

    await waitFor(() => expect(transitionTask).toHaveBeenCalledTimes(2));
    expect(transitionTask.mock.calls[1]).toEqual([
      't1', 'IN_PROGRESS', 3, { override: true, override_reason: 'Client signed off the survey' },
    ]);
    await screen.findByText('Moved to IN_PROGRESS.');
  });

  it('offers no override to somebody the server would refuse', async () => {
    permissions = ['task.update'];
    transitionTask.mockRejectedValueOnce(blocked());
    await tryToMove();
    expect(screen.queryByRole('button', { name: /Override with a reason/ })).toBeNull();
  });
});
