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
}

function redirectToLogin(): void {
  if (isBrowser() && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
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

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
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
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
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
    } else {
      clearTokens();
      redirectToLogin();
      throw new ApiClientError(401, {
        code: 'UNAUTHORIZED',
        message: 'Session expired. Please sign in again.',
      });
    }
  }

  const headerRequestId = res.headers?.get('x-request-id') ?? null;
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
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
