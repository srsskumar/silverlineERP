import { randomUUID } from "expo-crypto";
/**
 * fetch wrapper for the single Silverline API (same backend as web).
 *
 * - Base URL from EXPO_PUBLIC_API_URL at bundle time (Expo bakes `process.env`
 *   at bundle time; dev machines on LAN must rebuild/reload after changing
 *   it — see README "LAN setup"). Default http://localhost:3101.
 * - All routes under /api/v1 (callers pass the path WITH that prefix).
 * - Bearer attach from SecureStore; Idempotency-Key (crypto.randomUUID) on
 *   every POST/PATCH unless the caller supplies one.
 * - 401 → single refresh attempt → retry once → else logout + typed ApiError.
 * - Tolerant reads: helpers accept enveloped AND bare payloads.
 */

import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  saveTokens,
} from "../device/auth";

function baseUrl(): string {
  const raw =
    process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3101";
  return raw.replace(/\/+$/, "");
}

export function apiBaseUrl(): string {
  return baseUrl();
}

const DEV_API_LOGS = typeof __DEV__ !== "undefined" && __DEV__;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

class ApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`API request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "ApiTimeoutError";
  }
}

function safeLogPath(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

async function fetchWithApiTiming(
  method: string,
  path: string,
  attempt: number,
  request: () => Promise<Response>,
): Promise<Response> {
  if (!DEV_API_LOGS) return request();
  const startedAt = Date.now();
  const route = safeLogPath(path);
  console.debug(`[api] request ${method} ${route}`, { attempt });
  try {
    const response = await request();
    console.info(`[api] response ${method} ${route}`, {
      attempt,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      request_id: response.headers.get("x-request-id") ?? undefined,
    });
    return response;
  } catch (error) {
    console.warn(`[api] network error ${method} ${route}`, {
      attempt,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Network request failed",
    });
    throw error;
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  upstreamSignal?: AbortSignal | null,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ApiTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface ApiFieldError {
  field: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  fieldErrors: ApiFieldError[];
  requestId: string | null;
  retryable: boolean;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: ApiFieldError[];
    requestId?: string | null;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.fieldErrors = args.fieldErrors ?? [];
    this.requestId = args.requestId ?? null;
    this.retryable = args.retryable ?? false;
  }
}

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
  /** Override / supply the idempotency key for POST/PATCH. */
  idempotencyKey?: string;
  /** Skip the 401→refresh→retry cycle (used by the refresh call itself). */
  noAuthRetry?: boolean;
  /** Hard transport deadline. Defaults to 12 seconds. */
  timeoutMs?: number;
}

type LogoutHook = (reason?:string) => void | Promise<void>;
let logoutHook: LogoutHook | null = null;
/** AuthProvider registers this so a dead refresh forces sign-out. */
export function onAuthLogout(hook: LogoutHook | null): void {
  logoutHook = hook;
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const rt = await getRefreshToken();
      if (!rt) return false;
      // NOTE: actual backend path is /api/v1/auth/refresh (the brief's
      // "/auth/refresh" shorthand omits the /api/v1 prefix — assumed same).
      const res = await fetchWithApiTiming("POST", "/api/v1/auth/refresh", 1, () =>
        fetchWithTimeout(`${baseUrl()}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        }, DEFAULT_REQUEST_TIMEOUT_MS),
      );
      if (res.status === 429 || res.status >= 500) throw new ApiError({ status: res.status, code: "REFRESH_UNAVAILABLE", message: "Connection unavailable. Retry when online.", retryable: true });
      if (!res.ok) {
        const error=await res.json().catch(()=>({})) as {code?:string};
        if(error.code==='DEVICE_REVOKED'){await logoutHook?.('DEVICE_REVOKED');await clearTokens();}
        return false;
      }
      const json = (await res.json().catch(() => null)) as {
        access_token?: string;
        refresh_token?: string;
      } | null;
      if (!json?.access_token || !json?.refresh_token) return false;
      await saveTokens(json.access_token, json.refresh_token);
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError({ status: 0, code: "NETWORK_ERROR", message: "Session refresh needs a connection", retryable: true });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function newIdempotencyKey(): string { return randomUUID(); }

export async function apiFetch<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: T; requestId: string | null; status: number }> {
  const {
    body,
    headers: optionHeaders,
    idempotencyKey,
    noAuthRetry = false,
    signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ...requestInit
  } = opts;
  const method = (requestInit.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(optionHeaders ?? {}),
  };
  if ((method === "POST" || method === "PATCH" || method === "PUT") && !headers["Idempotency-Key"]) {
    headers["Idempotency-Key"] = idempotencyKey ?? newIdempotencyKey();
  }

  let attempt = 0;
  const doFetch = async (): Promise<Response> => {
    attempt += 1;
    const token = await getAccessToken();
    const h: Record<string, string> = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    return fetchWithApiTiming(method, path, attempt, () =>
      fetchWithTimeout(`${baseUrl()}${path}`, {
        ...requestInit,
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      }, timeoutMs, signal),
    );
  };

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    throw new ApiError({
      status: 0,
      code: err instanceof ApiTimeoutError ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
      message: err instanceof ApiTimeoutError
        ? `Cannot reach ${baseUrl()}. Check that the API is running and this device is on the same network.`
        : err instanceof Error ? err.message : "Network request failed",
      retryable: true,
    });
  }

  if (res.status === 401 && !noAuthRetry) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      try {
        res = await doFetch();
      } catch (err) {
        throw new ApiError({
          status: 0,
          code: err instanceof ApiTimeoutError ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
          message: err instanceof ApiTimeoutError
            ? `Cannot reach ${baseUrl()}. Check that the API is running and this device is on the same network.`
            : err instanceof Error ? err.message : "Network request failed",
          retryable: true,
        });
      }
    }
    if (res.status === 401) {
      await clearTokens();
      await logoutHook?.();
      throw new ApiError({
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Session expired — signed out",
        requestId: res.headers.get("x-request-id"),
      });
    }
  }

  const requestId =
    res.headers.get("x-request-id") ?? res.headers.get("x-requestId");
  if(res.ok&&res.headers.get("content-type")?.includes("application/pdf")){return {data:new Uint8Array(await res.arrayBuffer()) as T,requestId,status:res.status};}
  const json = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const env =
      (typeof json === "object" && json !== null ? json : {}) as Record<
        string,
        unknown
      >;
    const fieldErrors = Array.isArray(env.field_errors)
      ? (env.field_errors as ApiFieldError[])
      : Array.isArray(env.fieldErrors)
        ? (env.fieldErrors as ApiFieldError[])
        : [];
    throw new ApiError({
      status: res.status,
      code:
        typeof env.code === "string"
          ? env.code
          : res.status === 422
            ? "VALIDATION_ERROR"
            : "REQUEST_FAILED",
      message:
        typeof env.message === "string"
          ? env.message
          : `Request failed (${res.status})`,
      fieldErrors,
      requestId:
        typeof env.request_id === "string"
          ? env.request_id
          : (requestId ?? null),
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  return { data: json as T, requestId: requestId ?? null, status: res.status };
}

// --- Tolerant readers (enveloped AND bare) ----------------------------------

/** List endpoints: { data: [...] } or bare [...]. */
export function asList<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (typeof json === "object" && json !== null) {
    const value = json as Record<string, unknown>;
    if (Array.isArray(value.data)) return value.data as T[];
    if (Array.isArray(value.items)) return value.items as T[];
  }
  return [];
}

/** Item endpoints: { <key>: {...} } or the bare object. */
export function asItem<T>(json: unknown, key?: string): T {
  if (key && typeof json === "object" && json !== null && key in json) {
    return (json as Record<string, unknown>)[key] as T;
  }
  return json as T;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Cursor pages: { data, next_cursor, has_more } or bare arrays. */
export function asPage<T>(json: unknown): Page<T> {
  if (Array.isArray(json)) {
    return { items: json as T[], nextCursor: null, hasMore: false };
  }
  const o = (typeof json === "object" && json !== null ? json : {}) as Record<
    string,
    unknown
  >;
  const items = Array.isArray(o.data)
    ? (o.data as T[])
    : Array.isArray(o.items)
      ? (o.items as T[])
      : [];
  const nextCursor =
    typeof o.next_cursor === "string" ? o.next_cursor : null;
  const hasMore = o.has_more === true || nextCursor !== null;
  return { items, nextCursor, hasMore };
}
