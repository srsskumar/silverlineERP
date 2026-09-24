/**
 * API client for Silverline ERP (apps/web, S0).
 *
 * Client-side only: no SSR usage, no cookies — tokens live in memory with a
 * localStorage fallback so a static-exported page can restore a session.
 *
 * Contract (built in parallel by the API agent — code against it):
 *   POST /api/v1/auth/login   {username, password} -> 200 {access_token, refresh_token, mfa_required?}
 *   POST /api/v1/auth/refresh {refresh_token}      -> 200 {access_token, refresh_token}
 *   POST /api/v1/auth/mfa/verify {token}           -> 200 token pair
 *   GET  /api/v1/auth/me                           -> 200 {user, roles[], permissions[]}
 *   GET  /api/v1/audit ...
 * Error envelope (non-2xx): {code, message, field_errors[], request_id, retryable}
 */

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  field_errors?: Array<{ field: string; message: string }>;
  request_id?: string;
  retryable?: boolean;
  /** Extra server-supplied fields (e.g. `available`, `conflicting_dates`). */
  details?: Record<string, unknown>;
}

export interface ApiSuccess<T> {
  data: T;
  request_id?: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: Array<{ field: string; message: string }>;
  readonly requestId?: string;
  readonly retryable: boolean;
  /** Extra server-supplied error fields (e.g. `available`, `conflicting_dates`). */
  readonly details: Record<string, unknown>;

  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.message || `Request failed with status ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = envelope.code || httpStatusToCode(status);
    this.fieldErrors = envelope.field_errors ?? [];
    this.requestId = envelope.request_id;
    this.retryable = envelope.retryable ?? status >= 500;
    this.details = envelope.details ?? {};
  }
}

function httpStatusToCode(status: number): string {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'REQUEST_FAILED';
}

export function getBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101';
  return raw.replace(/\/+$/, '');
}

const DEV_API_LOGS = process.env.NODE_ENV === 'development';

function safeLogPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || '/';
}

async function fetchWithApiTiming(
  method: string,
  path: string,
  attempt: number,
  request: () => Promise<Response>,
): Promise<Response> {
  if (!DEV_API_LOGS) return request();
  const startedAt = performance.now();
  const route = safeLogPath(path);
  console.debug(`[api] request ${method} ${route}`, { attempt });
  try {
    const response = await request();
    console.info(`[api] response ${method} ${route}`, {
      attempt,
      status: response.status,
      duration_ms: Math.round(performance.now() - startedAt),
      request_id: response.headers.get('x-request-id') ?? undefined,
    });
    return response;
  } catch (error) {
    console.warn(`[api] network error ${method} ${route}`, {
      attempt,
      duration_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : 'Network request failed',
    });
    throw error;
  }
}

const ACCESS_KEY = 'silverline.access_token';
const REFRESH_KEY = 'silverline.refresh_token';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

let inMemoryAccessToken: string | null = null;
let inMemoryRefreshToken: string | null = null;

export function getAccessToken(): string | null {
  if (inMemoryAccessToken) return inMemoryAccessToken;
  if (isBrowser()) return window.localStorage.getItem(ACCESS_KEY);
  return null;
}

export function getRefreshToken(): string | null {
  if (inMemoryRefreshToken) return inMemoryRefreshToken;
  if (isBrowser()) return window.localStorage.getItem(REFRESH_KEY);
  return null;
}

export function setTokens(accessToken: string | null, refreshToken: string | null): void {
  inMemoryAccessToken = accessToken;
  inMemoryRefreshToken = refreshToken;
  if (isBrowser()) {
    if (accessToken) window.localStorage.setItem(ACCESS_KEY, accessToken);
    else window.localStorage.removeItem(ACCESS_KEY);
    if (refreshToken) window.localStorage.setItem(REFRESH_KEY, refreshToken);
    else window.localStorage.removeItem(REFRESH_KEY);
  }
}

export function clearTokens(): void {
  setTokens(null, null);
  if (isBrowser()) window.localStorage.removeItem(IMPERSONATION_KEY);
}

/* ------------------------------------------------------------------ §075
 * Viewing the application as another user.
 *
 * The borrowed token is put where every request already looks for one, so
 * nothing else in the application has to know this feature exists. What
 * needs care is the administrator's own session: it is set aside here
 * rather than thrown away, and -- critically -- the refresh cycle is
 * switched off while borrowed. Without that, the first 401 would quietly
 * refresh the *administrator* back into place, and they would carry on
 * testing while believing they were still somebody else.
 */

const IMPERSONATION_KEY = 'silverline.impersonation';

export interface ImpersonationState {
  subject_id: string;
  subject_username: string;
  subject_name: string | null;
  actor_username: string;
  expires_at: string;
  /** The administrator's own session, set aside until they stop. */
  original_access: string;
  original_refresh: string | null;
}

export function getImpersonation(): ImpersonationState | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(IMPERSONATION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.original_access === 'string'
      ? (parsed as unknown as ImpersonationState)
      : null;
  } catch {
    return null;
  }
}

export function beginImpersonation(state: ImpersonationState, borrowedAccessToken: string): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(state));
  // No refresh token: a borrowed session lasts exactly as long as it was granted.
  setTokens(borrowedAccessToken, null);
}

/**
 * Fired when a borrowed session ends, by any route.
 *
 * A view-as session can end without anybody pressing the button: it expires,
 * or it is stopped from another tab. The api client notices that on the next
 * 401 and puts the administrator back -- but React has no way to know, so the
 * banner sat there claiming an identity that had already lapsed. This is how
 * the token store tells the session provider to catch up.
 */
export const IMPERSONATION_ENDED_EVENT = 'silverline:impersonation-ended';

/** Put the administrator back. Returns false if they were never away. */
export function restoreOwnSession(): boolean {
  const state = getImpersonation();
  if (!state) return false;
  if (isBrowser()) {
    window.localStorage.removeItem(IMPERSONATION_KEY);
  }
  setTokens(state.original_access, state.original_refresh);
  if (isBrowser()) window.dispatchEvent(new CustomEvent(IMPERSONATION_ENDED_EVENT));
  return true;
}

/*
 * Where the sign-in screen is reached from, kept behind an object so a test
 * can watch the navigation without a real window to navigate.
 */
export const authNavigation = {
  /** True when a navigation was started; false when already on the sign-in screen. */
  toLogin(): boolean {
    if (isBrowser() && window.location.pathname !== '/login') {
      window.location.assign('/login');
      return true;
    }
    return false;
  },
};

function redirectToLogin(): void {
  authNavigation.toLogin();
}

/*
 * A word for the sign-in screen about why somebody is looking at it.
 *
 * Enrolling an authenticator, turning it off and changing a password all
 * revoke every session on purpose, and the screen used to go from a
 * spinner to the sign-in form with nothing said. sessionStorage, so it is
 * this tab's and gone once read; the sign-in screen reads it once.
 */
const LOGIN_NOTICE_KEY = 'silverline.login_notice';

export function takeLoginNotice(): string | null {
  if (!isBrowser()) return null;
  try {
    const notice = window.sessionStorage.getItem(LOGIN_NOTICE_KEY);
    if (notice) window.sessionStorage.removeItem(LOGIN_NOTICE_KEY);
    return notice;
  } catch {
    return null;
  }
}

function leaveLoginNotice(message: string): void {
  if (!isBrowser()) return;
  try { window.sessionStorage.setItem(LOGIN_NOTICE_KEY, message); } catch { /* private mode: no note, same sign-out */ }
}

/**
 * Sign out on purpose, and say why on the way in.
 *
 * For the changes that revoke every session server-side: the tokens in hand
 * are already dead, so nothing is sent; they are dropped, the message is
 * left for the sign-in screen, and the browser goes there.
 */
export function signOutWithNotice(message: string): void {
  clearTokens();
  leaveLoginNotice(message);
  authNavigation.toLogin();
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  clearTokens();
  if (refreshToken) {
    await fetchWithApiTiming('POST', '/api/v1/auth/logout', 1, () =>
      fetch(`${getBaseUrl()}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(5000),
      }),
    ).catch(() => undefined);
  }
  redirectToLogin();
}

/*
 * crypto.randomUUID() is a secure-context API: on a plain-HTTP origin (this
 * site, until it has a certificate) it throws, and the old fallback --
 * `${Date.now()}-${random}` -- is not shaped like a UUID at all. Every
 * mutating request still worked, because most routes accept a free-form
 * idempotency key; POST /leave/requests is stricter and requires a real UUID,
 * so every leave filing over HTTP failed with 422 MISSING_IDEMPOTENCY_KEY
 * while the button, the request and the server were each doing exactly what
 * they were told.
 *
 * crypto.getRandomValues() carries no such restriction -- it works in every
 * context, secure or not -- so the fallback builds a proper RFC 4122 v4 UUID
 * from it instead. Once the site has TLS, crypto.randomUUID() is used
 * directly and this path never runs.
 */
export function uuidV4(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the always-available generator below
  }
  return uuidV4();
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic 401 -> refresh -> retry cycle (used by auth endpoints). */
  skipAuthRetry?: boolean;
  /**
   * How long to wait before giving up, in milliseconds.
   *
   * Thirty seconds suits a request that reads a screenful. It does not suit
   * a bulk import, where the server is legitimately working for a minute on
   * rows the caller sent it — and an upload that the browser abandons while
   * the server is still writing leaves somebody with no idea how much of
   * their file went in.
   */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a response body into payload + request id, tolerating raw bodies. */
function unwrap<T>(json: unknown, headerRequestId: string | null): ApiSuccess<T> {
  if (isRecord(json) && 'data' in json) {
    const rec = json as Record<string, unknown>;
    const requestId =
      typeof rec.request_id === 'string'
        ? rec.request_id
        : typeof rec.requestId === 'string'
          ? rec.requestId
          : (headerRequestId ?? undefined);
    return { data: rec.data as T, request_id: requestId };
  }
  return { data: json as T, request_id: headerRequestId ?? undefined };
}

function toEnvelope(json: unknown, headerRequestId: string | null): ApiErrorEnvelope {
  if (isRecord(json)) {
    const rec = json as Record<string, unknown>;
    const { code, message, field_errors, request_id, retryable, ...rest } = rec;
    return {
      code: typeof code === 'string' ? code : 'REQUEST_FAILED',
      message: typeof message === 'string' ? message : 'Request failed',
      field_errors: Array.isArray(field_errors)
        ? (field_errors as Array<{ field: string; message: string }>)
        : [],
      request_id:
        typeof request_id === 'string' ? request_id : (headerRequestId ?? undefined),
      retryable: typeof retryable === 'boolean' ? retryable : undefined,
      details: rest,
    };
  }
  return { code: 'REQUEST_FAILED', message: 'Request failed', request_id: headerRequestId ?? undefined, details: {} };
}

/** Shared in-flight refresh so concurrent 401s trigger exactly one refresh call. */
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    /*
     * Never refresh a borrowed session. The stored refresh token belongs to
     * the administrator, and using it here would silently hand them their
     * own identity back mid-test.
     */
    if (getImpersonation()) return false;
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetchWithApiTiming('POST', '/api/v1/auth/refresh', 1, () =>
        fetch(`${getBaseUrl()}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (res.status === 429 || res.status >= 500) throw new ApiClientError(res.status,{code:'REFRESH_UNAVAILABLE',message:'Session refresh is temporarily unavailable. Please retry.'});
      if (!res.ok) return false;
      const json: unknown = await res.json().catch(() => null);
      const payload = isRecord(json) && 'data' in json ? (json as Record<string, unknown>).data : json;
      if (!isRecord(payload)) return false;
      const access = payload.access_token;
      const refresh = payload.refresh_token;
      if (typeof access !== 'string' || typeof refresh !== 'string') return false;
      setTokens(access, refresh);
      return true;
    } catch (error) {
      if(error instanceof ApiClientError) throw error;
      throw new ApiClientError(0,{code:'NETWORK_ERROR',message:'Connection unavailable. Your session is saved; please retry.'});
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
  const raw = await apiRequestRaw(path, options);
  return unwrap<T>(raw.body, raw.requestId ?? null);
}

/**
 * S5 additive: same auth/refresh/idempotency/error handling as apiRequest,
 * but returns the RAW response body (no `{data:...}` unwrap) plus the request
 * id, so cursor-paginated callers can read `next_cursor`/`has_more` siblings
 * that `unwrap` would otherwise discard. Existing callers are untouched.
 */
export async function apiRequestRaw(
  path: string,
  options: RequestOptions = {},
): Promise<{ body: unknown; requestId?: string; status: number }> {
  const { body, skipAuthRetry = false, headers, timeoutMs, ...rest } = options;
  const method = (rest.method ?? 'GET').toUpperCase();
  const stableHeaders = new Headers(headers);
  if (MUTATING_METHODS.has(method) && !stableHeaders.has('Idempotency-Key')) {
    stableHeaders.set('Idempotency-Key', newIdempotencyKey());
  }
  // The record version travels in X-Record-Version, not If-Match.
  //
  // If-Match is a transport-level precondition and a CDN is entitled to answer
  // it. Vercel's edge did exactly that: it refused a bare version with 412
  // outright, and for a quoted one it let the write through and then replaced
  // the 200 with a 412 on the way back — so the user saw "could not save"
  // while the change had in fact been made, and their next attempt failed with
  // a version conflict. A header with no standard meaning is inert to every
  // proxy in the path. The server still accepts If-Match for other callers.
  const ifMatch = stableHeaders.get('If-Match');
  if (ifMatch) {
    stableHeaders.delete('If-Match');
    stableHeaders.set('X-Record-Version', ifMatch.replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
  }

  let attempt = 0;
  const doFetch = async (): Promise<Response> => {
    attempt += 1;
    /*
     * Only claim JSON when there is JSON.
     *
     * The header went on every request, body or not, and Fastify refuses to
     * parse an empty body that says it is JSON — so any caller that sent a
     * mutating request with nothing in it got a 400 it could not explain.
     * Marking one notification read did exactly that, and had never worked:
     * the button was there, the request went out, and the row stayed unread.
     */
    const reqHeaders: Record<string, string> = {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...Object.fromEntries(stableHeaders.entries()),
    };
    if (stableHeaders.has('Idempotency-Key')) { delete reqHeaders['idempotency-key']; reqHeaders['Idempotency-Key'] = stableHeaders.get('Idempotency-Key')!; }
    const token = getAccessToken();
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    return fetchWithApiTiming(method, path, attempt, () =>
      fetch(`${getBaseUrl()}${path}`, {
        ...rest,
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? 30000),
        method,
        headers: reqHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };

  let res = await doFetch();

  if (res.status === 401 && !skipAuthRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch();
    } else if (restoreOwnSession()) {
      /*
       * The view-as session ran out or was stopped elsewhere. The
       * administrator is not logged out -- they are put back where they
       * were, and told why the screen changed under them.
       */
      throw new ApiClientError(401, {
        code: 'IMPERSONATION_ENDED',
        message: 'That view-as session has ended. You are yourself again.',
      });
    } else {
      /*
       * The session is over -- revoked by an administrator, timed out, or
       * ended by a change made in another tab. The screen is about to
       * change to the sign-in form, and it should say so rather than leave
       * somebody wondering what they pressed.
       */
      clearTokens();
      if (authNavigation.toLogin()) leaveLoginNotice('Your session has ended. Sign in again to continue.');
      throw new ApiClientError(401, {
        code: 'UNAUTHORIZED',
        message: 'Session expired. Please sign in again.',
      });
    }
  }

  const headerRequestId = res.headers?.get('x-request-id') ?? null;
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    // A 413 (over nginx's client_max_body_size, or the app's own bodyLimit)
    // never carries the {code,message} envelope: nginx's is its own HTML
    // error page, and Fastify's own is a generic "Bad request". Either way
    // toEnvelope(json, ...) would fall back to "Request failed" — the one
    // case worth naming specifically is a receipt too large to upload.
    if (res.status === 413) {
      throw new ApiClientError(413, {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'That file is too large to upload. Try a smaller file.',
        request_id: headerRequestId ?? undefined,
      });
    }
    throw new ApiClientError(res.status, toEnvelope(json, headerRequestId));
  }
  return { body: json, requestId: headerRequestId ?? undefined, status: res.status };
}

// ---------------------------------------------------------------------------
// Typed auth endpoints (thin wrappers over apiRequest)
// ---------------------------------------------------------------------------

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  mfa_required?: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  [key: string]: unknown;
}

export interface MeResponse {
  user: SessionUser;
  roles: string[];
  permissions: string[];
  /** §075: null unless an administrator is holding this session. */
  impersonation: {
    session_id: string | null;
    actor_id: string;
    actor_username: string;
  } | null;
}

/* ------------------------------------------------------------------ §075 */

export interface ImpersonationTarget {
  id: string;
  username: string;
  full_name: string | null;
  designation: string | null;
  roles: string[];
  permission_count: number;
  allowed: boolean;
  blocked_reason: string | null;
}

export async function fetchImpersonationTargets(q: string): Promise<ImpersonationTarget[]> {
  const { data } = await apiRequest<ImpersonationTarget[]>(
    `/api/v1/auth/impersonate/targets${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    { method: 'GET' },
  );
  return data;
}

export interface ImpersonationStarted {
  access_token: string;
  expires_at: string;
  session_id: string;
  subject: { id: string; username: string; roles: string[] };
  notices: string[];
}

export async function startImpersonationRequest(
  body: { user_id: string; reason: string; minutes?: number },
): Promise<ImpersonationStarted> {
  const { data } = await apiRequest<ImpersonationStarted>('/api/v1/auth/impersonate', {
    method: 'POST', body,
  });
  return data;
}

export async function stopImpersonationRequest(): Promise<{ ended: boolean }> {
  const { data } = await apiRequest<{ ended: boolean }>('/api/v1/auth/impersonate/stop', {
    method: 'POST',
    // If the borrowed token has already lapsed there is nothing to put back;
    // the caller restores the administrator's session either way.
    skipAuthRetry: true,
  });
  return data;
}

export async function loginRequest(username: string, password: string, totpCode?: string): Promise<LoginResponse> {
  const { data } = await apiRequest<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: { username, password, ...(totpCode ? { totp_code: totpCode } : {}) },
    skipAuthRetry: true,
  });
  return data;
}

export async function verifyMfaRequest(code: string): Promise<{ enabled: boolean }> {
  const { data } = await apiRequest<{ enabled: boolean }>('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: { code },
    skipAuthRetry: true,
  });
  return data;
}

export async function fetchMe(): Promise<MeResponse> {
  const { data } = await apiRequest<MeResponse>('/api/v1/auth/me', { method: 'GET' });
  return data;
}

/** Test-only helper: reset module token state between tests. */
export function __resetAuthStateForTests(): void {
  inMemoryAccessToken = null;
  inMemoryRefreshToken = null;
  refreshPromise = null;
  if (typeof globalThis.localStorage !== 'undefined') {
    try {
      (globalThis.localStorage as Storage).clear?.();
    } catch {
      /* noop */
    }
  }
}

/** Authenticated binary download; bearer tokens are sent only to our API origin. */
export async function downloadFile(path:string,fileName:string):Promise<void>{
 const target=new URL(path,getBaseUrl());if(target.origin!==new URL(getBaseUrl()).origin)throw new Error('Invalid download destination');
 let attempt=0;const fetchFile=()=>{attempt++;return fetchWithApiTiming('GET',path,attempt,()=>fetch(target,{headers:{Authorization:`Bearer ${getAccessToken()??''}`},signal:AbortSignal.timeout(30000)}));};
 let response=await fetchFile();if(response.status===401&&await tryRefresh())response=await fetchFile();
 if(!response.ok)throw new ApiClientError(response.status,toEnvelope(await response.json().catch(()=>null),response.headers.get('x-request-id')));
 const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=fileName;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
