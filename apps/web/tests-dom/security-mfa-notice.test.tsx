/**
 * Account security has to say *why* somebody keeps landing on it. In
 * production a super administrator without an authenticator is sent here on
 * every sign-in (the API refuses everything else with MFA_ENROLLMENT_REQUIRED),
 * and the page used to read as if the password change had not taken.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let user: Record<string, unknown> = {};
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { permissions: [], roles: ['SUPER_ADMIN'], user: { id: 'u1', username: 'admin', ...user } } }),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/lib/apiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiClient')>()),
  apiRequest: vi.fn(async () => ({ data: [] })),
  apiRequestRaw: vi.fn(async () => ({ body: { data: [] } })),
}));

const { default: SecurityPage } = await import('@/app/security/page');

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SecurityPage /></QueryClientProvider>);
}

describe('Account security explains the block', () => {
  it('tells a role that must use two-factor authentication why every other page is refused', () => {
    user = { mfa_enabled: false, mfa_enrollment_required: true, must_change_password: false };
    mount();
    expect(screen.getByText(/requires two-factor authentication/i)).toBeInTheDocument();
    expect(screen.getByText(/every other page/i)).toBeInTheDocument();
  });

  it('says nothing about it once the authenticator is enabled', () => {
    user = { mfa_enabled: true, mfa_enrollment_required: false, must_change_password: false };
    mount();
    expect(screen.queryByText(/requires two-factor authentication/i)).toBeNull();
  });
});
