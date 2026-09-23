import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApiClientError,
  __resetAuthStateForTests,
  apiRequest,
  getAccessToken,
  setTokens,
  uuidV4,
} from '../lib/apiClient';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('apiClient', () => {
  beforeEach(() => {
    __resetAuthStateForTests();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { ok: true } })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuthStateForTests();
  });

  it('attaches the Bearer access token when one is stored', async () => {
    setTokens('access-123', 'refresh-123');
    await apiRequest('/api/v1/auth/me');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer access-123');
  });

  it('sends no Authorization header when signed out', async () => {
    await apiRequest('/api/v1/auth/me');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('sends an Idempotency-Key header on POST', async () => {
    await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'u', password: 'p' },
      skipAuthRetry: true,
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(typeof init.headers['Idempotency-Key']).toBe('string');
    expect(init.headers['Idempotency-Key'].length).toBeGreaterThan(0);
  });

  it('does not send an Idempotency-Key header on GET', async () => {
    await apiRequest('/api/v1/auth/me');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers['Idempotency-Key']).toBeUndefined();
  });

  it('uuidV4 always produces a well-formed UUID', () => {
    for (let i = 0; i < 20; i += 1) expect(uuidV4()).toMatch(UUID_RE);
  });

  /*
   * crypto.randomUUID() is secure-context-only and throws on this site's
   * plain-HTTP origin. POST /leave/requests refuses anything that is not a
   * real UUID (422 MISSING_IDEMPOTENCY_KEY) -- so a key that merely looks
   * unique, like the old `${Date.now()}-${random}` fallback, is not enough.
   */
  it('still sends a real UUID when crypto.randomUUID is unavailable', async () => {
    const original = crypto.randomUUID;
    // @ts-expect-error -- simulating an insecure context, where the browser
    // does not expose this method at all.
    delete crypto.randomUUID;
    try {
      await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'u', password: 'p' },
        skipAuthRetry: true,
      });
    } finally {
      crypto.randomUUID = original;
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers['Idempotency-Key']).toMatch(UUID_RE);
  });

  it('on 401 refreshes once and retries the original request', async () => {
    setTokens('expired-access', 'valid-refresh');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh' });
      }
      const callsSoFar = fetchMock.mock.calls.length;
      if (callsSoFar === 1) {
        return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired', request_id: 'req-1' });
      }
      return jsonResponse(200, { data: { user: 'u' }, request_id: 'req-2' }, { 'x-request-id': 'req-2' });
    });

    const result = await apiRequest<{ user: string }>('/api/v1/auth/me');

    expect(result.data).toEqual({ user: 'u' });
    expect(result.request_id).toBe('req-2');
    // Original + refresh + retry = exactly 3 calls; refresh called exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith('/api/v1/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    // Retried request carries the new token.
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit & { headers: Record<string, string> }];
    expect(retryInit.headers.Authorization).toBe('Bearer new-access');
    expect(getAccessToken()).toBe('new-access');
  });

  it('throws a typed ApiClientError carrying the envelope on error responses', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        422,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          field_errors: [{ field: 'username', message: 'required' }],
          request_id: 'req-err-1',
          retryable: false,
        },
        { 'x-request-id': 'req-err-1' },
      ),
    );

    const err = await apiRequest('/api/v1/employees', { method: 'POST', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiClientError).status).toBe(422);
    expect((err as ApiClientError).requestId).toBe('req-err-1');
    expect((err as ApiClientError).retryable).toBe(false);
    expect((err as ApiClientError).fieldErrors).toEqual([{ field: 'username', message: 'required' }]);
  });

  it('logs out (clears tokens) and throws when refresh fails after a 401', async () => {
    setTokens('expired-access', 'bad-refresh');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if ((url as string).endsWith('/api/v1/auth/refresh')) {
        return jsonResponse(401, { code: 'INVALID_REFRESH', message: 'bad refresh' });
      }
      return jsonResponse(401, { code: 'TOKEN_EXPIRED', message: 'expired' });
    });

    const err = await apiRequest('/api/v1/auth/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe('UNAUTHORIZED');
    expect(getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('claiming JSON only when there is JSON', () => {
  /*
   * The Content-Type header went on every request, body or not, and Fastify
   * refuses to parse an empty body that says it is JSON. Every caller that
   * sent a mutating request with nothing in it got a 400 it could not
   * explain: marking one notification read, deleting a board, detaching a
   * label, deleting a task. The buttons were there, the requests went out,
   * and nothing happened.
   */
  const source = readFileSync(join(__dirname, '..', 'lib', 'apiClient.ts'), 'utf8');

  it('sets the header from the body, not unconditionally', () => {
    expect(source).toContain("...(body === undefined ? {} : { 'Content-Type': 'application/json' })");
  });

  it('no longer sets it for every request', () => {
    const headerBlock = source.slice(
      source.indexOf('const reqHeaders'),
      source.indexOf('const token = getAccessToken()'),
    );
    expect(headerBlock).not.toMatch(/^\s*'Content-Type': 'application\/json',$/m);
  });

  it('still sends a body when one is given', () => {
    expect(source).toContain('body: body === undefined ? undefined : JSON.stringify(body)');
  });
});
