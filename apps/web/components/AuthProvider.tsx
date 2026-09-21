'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { ToastProvider } from './ui/Toast';
import {
  ApiClientError,
  beginImpersonation,
  fetchMe,
  getImpersonation,
  getRefreshToken,
  loginRequest,
  logout as apiLogout,
  restoreOwnSession,
  setTokens,
  IMPERSONATION_ENDED_EVENT,
  startImpersonationRequest,
  stopImpersonationRequest,
  getAccessToken,
  type MeResponse,
} from '@/lib/apiClient';
import { queryKeys } from '@/lib/query-keys';

export interface Session {
  user: MeResponse['user'];
  roles: string[];
  permissions: string[];
  /** §075: who is really at the keyboard, when it is not this user. */
  impersonation: MeResponse['impersonation'];
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  isLoading: boolean;
  error: unknown;
  login: (
    username: string, password: string,
  ) => Promise<{ mfaRequired: boolean; mustChangePassword: boolean }>;
  verifyMfa: (token: string) => Promise<void>;
  logout: () => void;
  refetchSession: () => Promise<void>;
  /** §075. Start holding another user's session; returns anything worth warning about. */
  viewAs: (input: { user_id: string; reason: string; minutes?: number }) => Promise<string[]>;
  /** Put the administrator back where they were. Safe to call when not impersonating. */
  stopViewAs: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function AuthInner({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [mfaPending, setMfaPending] = React.useState(false);
  const pendingCredentials = React.useRef<{ username: string; password: string } | null>(null);
  // Reactive token presence. `enabled` below must re-evaluate after
  // login/logout — reading localStorage directly is NOT reactive, and
  // setMfaPending(false) with an unchanged value bails out of re-rendering,
  // which used to leave the session query permanently disabled after a fresh
  // login (tokens stored, /me never fired, dashboard bounced back to login).
  const [hasTokens, setHasTokens] = React.useState<boolean | null>(null);
  // Hydration guard: the session-boot decision reads localStorage, which does
  // not exist during prerender. Without this gate, the prerender (no token →
  // 'unauthenticated' → form) mismatches the first client render (token found
  // → 'loading' → spinner) and React throws a hydration error for every
  // returning user. mounted=false on both → identical first output; the boot
  // decision runs only post-hydration.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
    /*
     * A borrowed session has no refresh token by design (§075), so asking
     * only about that one would decide, on every reload, that an
     * impersonating administrator is signed out and bounce them to the
     * login screen.
     */
    setHasTokens(getRefreshToken() !== null || getImpersonation() !== null);
  }, []);

  const sessionQuery = useQuery({
    queryKey: queryKeys.session.me(),
    queryFn: fetchMe,
    // Only attempt to boot a session when a refresh token is stored.
    enabled:
      mounted &&
      !mfaPending &&
      (hasTokens === true || queryClient.getQueryData(queryKeys.session.me()) !== undefined),
    staleTime: 60_000,
    retry: false,
  });

  const session: Session | null = sessionQuery.data
    ? {
        user: sessionQuery.data.user,
        roles: sessionQuery.data.roles,
        permissions: sessionQuery.data.permissions,
        impersonation: sessionQuery.data.impersonation ?? null,
      }
    : null;

  const status: AuthStatus = !mounted ? 'loading' : mfaPending
    ? 'unauthenticated'
    : session
      ? 'authenticated'
      : sessionQuery.isLoading || sessionQuery.isFetching
        ? 'loading'
        : 'unauthenticated';

  const login = React.useCallback(
    async (username: string, password: string) => {
      setMfaPending(false);
      pendingCredentials.current = null;
      const res = await loginRequest(username, password);
      if (res.mfa_required) {
        // Tokens arrive after MFA verification; hold auth until then.
        setMfaPending(true);
        pendingCredentials.current = { username, password };
        return { mfaRequired: true, mustChangePassword: false };
      }
      queryClient.clear();
      setTokens(res.access_token, res.refresh_token);
      setHasTokens(true);
      // Wait for state update to enable query, then refetch
      await queryClient.refetchQueries({ queryKey: queryKeys.session.me() });
      // A password somebody else chose. The account is signed in -- it has to
      // be, or the password could never be changed -- but every other request
      // comes back 403 until it is, so send them straight there rather than
      // to a dashboard that cannot load.
      return {
        mfaRequired: false,
        mustChangePassword: (res as { must_change_password?: boolean })
          .must_change_password === true,
      };
    },
    [queryClient],
  );

  const verifyMfa = React.useCallback(
    async (token: string) => {
      const credentials = pendingCredentials.current;
      if (!credentials) throw new Error('Verification session expired. Please sign in again.');
      const res = await loginRequest(credentials.username, credentials.password, token);
      if (res.mfa_required) throw new Error('Enter the code from your authenticator.');
      pendingCredentials.current = null;
      queryClient.clear();
      setTokens(res.access_token, res.refresh_token);
      setHasTokens(true);
      setMfaPending(false);
      await queryClient.refetchQueries({ queryKey: queryKeys.session.me() });
    },
    [queryClient],
  );

  const logout = React.useCallback(() => {
    setMfaPending(false);
    pendingCredentials.current = null;
    setHasTokens(false);
    queryClient.clear();
    void apiLogout();
  }, [queryClient]);

  /*
   * Swap whose session this is, and make the screen agree.
   *
   * Everything cached was fetched as somebody else, so none of it may
   * survive the switch -- but the session query itself must, because an
   * observer is mounted on it. queryClient.clear() destroys that query
   * along with the rest, and since neither `hasTokens` nor `mfaPending`
   * changes here, nothing forces a re-render: the observer goes on serving
   * the identity that has just stopped being true. That is what shipped --
   * pressing "stop" left the banner up, and pressing "start" left the
   * administrator's own name on screen until something else happened to
   * re-render.
   *
   * So: drop everything else, and refetch this one in place.
   */
  const swapIdentity = React.useCallback(async () => {
    const sessionKey = JSON.stringify(queryKeys.session.me());
    queryClient.removeQueries({
      predicate: (q) => JSON.stringify(q.queryKey) !== sessionKey,
    });
    await queryClient.refetchQueries({ queryKey: queryKeys.session.me() });
  }, [queryClient]);

  /*
   * The borrowed session can end without this tab asking: it expires, or it
   * is stopped elsewhere. The api client puts the administrator back on the
   * next 401 and says so; this is what takes the banner down when it does.
   */
  React.useEffect(() => {
    const onEnded = () => { void swapIdentity(); };
    window.addEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(IMPERSONATION_ENDED_EVENT, onEnded);
  }, [swapIdentity]);

  const viewAs = React.useCallback(
    async (input: { user_id: string; reason: string; minutes?: number }) => {
      const own = getAccessToken();
      if (!own) throw new Error('Sign in again before viewing as somebody else.');
      const started = await startImpersonationRequest(input);
      beginImpersonation(
        {
          subject_id: started.subject.id,
          subject_username: started.subject.username,
          subject_name: null,
          actor_username: '',
          expires_at: started.expires_at,
          original_access: own,
          original_refresh: getRefreshToken(),
        },
        started.access_token,
      );
      setHasTokens(true);
      await swapIdentity();
      return started.notices;
    },
    [swapIdentity],
  );

  const stopViewAs = React.useCallback(async () => {
    if (getImpersonation()) {
      // Tell the server first, so the borrowed token is revoked and not merely dropped.
      await stopImpersonationRequest().catch(() => undefined);
      restoreOwnSession();
    }
    /*
     * Refetch even when there was nothing stored locally. The borrowed
     * session can end without this button -- it expires, or an
     * administrator stops it from their other tab -- and the api client
     * puts the session back on the next 401. The banner has to come down
     * then too.
     */
    setHasTokens(true);
    await swapIdentity();
  }, [swapIdentity]);

  const refetchSession = React.useCallback(async () => {
    await sessionQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionQuery.refetch]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      isLoading: status === 'loading',
      error: sessionQuery.error,
      login,
      verifyMfa,
      logout,
      refetchSession,
      viewAs,
      stopViewAs,
    }),
    [status, session, sessionQuery.error, login, verifyMfa, logout, refetchSession, viewAs, stopViewAs],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      {/* Inside the query provider so a mutation's onSuccess can reach it. */}
      <ToastProvider>
        <AuthInner>{children}</AuthInner>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export { ApiClientError };
