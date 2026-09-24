/**
 * D-015: one submission, one Idempotency-Key, however many clicks.
 *
 * The client minted a fresh key per call, so a double-click on "Reimburse"
 * sent two different keys and the server, correctly, did the work twice. A
 * second identical write issued while the first is still in flight is the
 * same submission and now carries the same key, so the server serialises it
 * and replays the first answer. Once the first settles, a new submission
 * gets a new key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthStateForTests, apiRequest, setTokens } from '../lib/apiClient';

type Init = RequestInit & { headers: Record<string, string> };

describe('Idempotency-Key per submission (D-015)', () => {
  let release: () => void = () => {};
  beforeEach(() => {
    __resetAuthStateForTests();
    setTokens('a', 'r');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      const done = () => resolve(new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200, headers: { 'Content-Type': 'application/json' } }));
      const prev = release;
      release = () => { prev(); done(); };
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); __resetAuthStateForTests(); release = () => {}; });

  const keys = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => (c[1] as Init).headers['Idempotency-Key']);

  it('gives a double-click on the same write the same key', async () => {
    const body = { amount: 600, paid_on: '2026-09-24', mode: 'NEFT' };
    const a = apiRequest('/api/v1/expense-claims/x/reimburse', { method: 'POST', body });
    const b = apiRequest('/api/v1/expense-claims/x/reimburse', { method: 'POST', body: { ...body } });
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);
    const [k1, k2] = keys();
    expect(k1).toBeTruthy();
    expect(k2).toBe(k1);
  });

  it('gives a different write, or the next submission, a new key', async () => {
    const a = apiRequest('/api/v1/x', { method: 'POST', body: { n: 1 } });
    const b = apiRequest('/api/v1/x', { method: 'POST', body: { n: 2 } });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);
    const c = apiRequest('/api/v1/x', { method: 'POST', body: { n: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await c;
    const [k1, k2, k3] = keys();
    expect(k2).not.toBe(k1);
    expect(k3).not.toBe(k1);
  });
});
