/**
 * §075 -- the banner is the safety mechanism, so it is the thing tested.
 *
 * The failure mode of view-as is not that it fails to start. It is an
 * administrator who forgets they are somebody else: they file a bug about
 * their own permissions, or worse, make a change believing it is theirs.
 * Everything here is about whether the screen makes that impossible to miss
 * and always offers the way out.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const stopViewAs = vi.fn(async () => undefined);
const viewAs = vi.fn(async () => [] as string[]);
let sessionValue: unknown = null;

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: sessionValue,
    status: 'authenticated',
    isLoading: false,
    error: null,
    login: vi.fn(),
    verifyMfa: vi.fn(),
    logout: vi.fn(),
    refetchSession: vi.fn(),
    viewAs,
    stopViewAs,
  }),
}));

const fetchImpersonationTargets = vi.fn();
vi.mock('@/lib/apiClient', () => ({
  fetchImpersonationTargets: (...args: unknown[]) => fetchImpersonationTargets(...args),
}));

const { ViewAsBanner, ViewAsDialog } = await import('@/components/ViewAs');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const ORDINARY = {
  user: { username: 'admin' }, roles: ['ADMIN'], permissions: [], impersonation: null,
};
const BORROWED = {
  user: { username: 'r.kumar' },
  roles: ['EMPLOYEE'],
  permissions: [],
  impersonation: { session_id: 's1', actor_id: 'a1', actor_username: 'admin' },
};

beforeEach(() => {
  stopViewAs.mockClear();
  viewAs.mockClear();
  fetchImpersonationTargets.mockReset();
  sessionValue = ORDINARY;
});

describe('the banner', () => {
  it('is absent on an ordinary session -- it must not become wallpaper', () => {
    wrap(<ViewAsBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names whose session this is, and says the work is recorded against both', () => {
    sessionValue = BORROWED;
    wrap(<ViewAsBanner />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('r.kumar');
    expect(banner.textContent).toMatch(/recorded against them, and against you/i);
  });

  it('always offers the way out, and calls it by name', async () => {
    sessionValue = BORROWED;
    wrap(<ViewAsBanner />);
    const stop = screen.getByRole('button', { name: /stop viewing as r\.kumar/i });
    fireEvent.click(stop);
    await waitFor(() => expect(stopViewAs).toHaveBeenCalledTimes(1));
  });
});

describe('the picker', () => {
  const TARGETS = [
    { id: 'u1', username: 'r.kumar', full_name: 'Ravi Kumar', designation: 'Surveyor',
      roles: ['EMPLOYEE'], permission_count: 4, allowed: true, blocked_reason: null },
    { id: 'u2', username: 'payroll1', full_name: null, designation: null,
      roles: ['PAYROLL_OFFICER'], permission_count: 3, allowed: false,
      blocked_reason: 'That account can do things you cannot (payroll.manage)' },
  ];

  it('shows the accounts you may not hold, with the reason, rather than hiding them', async () => {
    fetchImpersonationTargets.mockResolvedValue(TARGETS);
    wrap(<ViewAsDialog open onOpenChange={() => {}} />);
    await screen.findByText('Ravi Kumar');
    expect(screen.getByText(/payroll\.manage/)).toBeTruthy();
    // ...and the one you may not hold cannot be chosen.
    const blocked = screen.getByText('payroll1').closest('button');
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
  });

  it('will not start without a reason worth reading', async () => {
    fetchImpersonationTargets.mockResolvedValue(TARGETS);
    wrap(<ViewAsDialog open onOpenChange={() => {}} />);
    await screen.findByText('Ravi Kumar');
    fireEvent.click(screen.getByText('Ravi Kumar'));

    const start = screen.getByRole('button', { name: /view as r\.kumar/i });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/why/i), { target: { value: 'test' } });
    expect(screen.getByText(/say a little more/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /view as r\.kumar/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts once it has somebody and a reason', async () => {
    fetchImpersonationTargets.mockResolvedValue(TARGETS);
    wrap(<ViewAsDialog open onOpenChange={() => {}} />);
    await screen.findByText('Ravi Kumar');
    fireEvent.click(screen.getByText('Ravi Kumar'));
    fireEvent.change(screen.getByLabelText(/why/i), {
      target: { value: 'Checking the vectorization tab for the Kurnool crew' },
    });
    fireEvent.click(screen.getByRole('button', { name: /view as r\.kumar/i }));
    await waitFor(() => expect(viewAs).toHaveBeenCalledTimes(1));
    expect(viewAs.mock.calls[0][0]).toMatchObject({ user_id: 'u1', minutes: 30 });
  });
});
