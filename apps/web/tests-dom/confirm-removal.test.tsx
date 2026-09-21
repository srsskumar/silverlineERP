/**
 * Removing a dependency asks first (WORK-22).
 *
 * One tap on "Remove" unblocked work that was waiting for a reason, and
 * nothing on the screen showed it had happened.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const removeDependency = vi.fn(async (_t: string, _d: string) => undefined);

vi.mock('@/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('@/lib/tasks')>()),
  removeDependency: (t: string, d: string) => removeDependency(t, d),
}));

const { DependencyManager } = await import('@/components/DependencyManager');

function mount() {
  const client = new QueryClient();
  const onChanged = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DependencyManager
        taskId="t1"
        blockedBy={[{ dependency_id: 'd1', task_id: 'p1', title: 'Pour the slab', status: 'IN_PROGRESS' }]}
        blocking={[]}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );
  return onChanged;
}

afterEach(() => { vi.restoreAllMocks(); removeDependency.mockClear(); });

describe('removing a dependency', () => {
  it('does nothing when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Pour the slab'));
    expect(removeDependency).not.toHaveBeenCalled();
  });

  it('removes it once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChanged = mount();
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(removeDependency).toHaveBeenCalledWith('t1', 'd1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
