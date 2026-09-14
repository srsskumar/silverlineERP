import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Regression cover for two defects that shipped to production together and
 * both trace back to the same root cause: `apiRequest` unwraps a `{data:...}`
 * envelope and throws away its siblings.
 *
 *  1. GET /insights/projects/:id/workforce returns a *business* field named
 *     `data` alongside status/scope_note/model_version. Unwrapped, the
 *     component received the inner array, read `.data.data` off it (undefined),
 *     and `.length` took down the whole Analytics page behind an error
 *     boundary — "Cannot read properties of undefined (reading 'length')".
 *
 *  2. GET /projects returns `{data, next_cursor, has_more}`. Unwrapped, the
 *     cursor was invisible, so listProjects() fetched exactly one page — and
 *     since it sent no limit, that page was the server default of 20. The
 *     dashboard board picker and the projects page silently showed 20 of 53
 *     projects with no indication that more existed.
 */

const requests: string[] = [];
let responses: unknown[] = [];

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return {
    ...actual,
    apiRequestRaw: vi.fn(async (path: string) => {
      requests.push(path);
      return { body: responses.shift() ?? { data: [] }, status: 200 };
    }),
    apiRequest: vi.fn(async () => ({ data: undefined })),
  };
});

const { listProjects, buildProjectsQuery } = await import('../lib/projects');

afterEach(() => {
  requests.length = 0;
  responses = [];
});

describe('listProjects pagination', () => {
  it('asks for a full page instead of taking the server default of 20', async () => {
    responses = [{ data: [{ id: 'p1' }], has_more: false, next_cursor: null }];
    await listProjects();
    expect(requests[0]).toContain('limit=100');
  });

  it('follows next_cursor until the list is exhausted', async () => {
    responses = [
      { data: [{ id: 'p1' }, { id: 'p2' }], has_more: true, next_cursor: 'cur1' },
      { data: [{ id: 'p3' }], has_more: true, next_cursor: 'cur2' },
      { data: [{ id: 'p4' }], has_more: false, next_cursor: null },
    ];
    const all = await listProjects();
    expect(all.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain('cursor=cur1');
    expect(requests[2]).toContain('cursor=cur2');
  });

  it('stops at one page when the caller pins a limit or cursor', async () => {
    responses = [{ data: [{ id: 'p1' }], has_more: true, next_cursor: 'cur1' }];
    await listProjects({ limit: 5 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('limit=5');
  });

  it('stops rather than looping forever on a cursor that never terminates', async () => {
    responses = Array.from({ length: 500 }, () => ({
      data: [{ id: 'p' }],
      has_more: true,
      next_cursor: 'same-cursor-forever',
    }));
    await listProjects();
    expect(requests.length).toBeLessThanOrEqual(100);
  });

  it('keeps the documented filter params on the query string', () => {
    const q = buildProjectsQuery({ status: 'ACTIVE', workspace_id: 'ws_1', q: 'road', limit: 100 });
    expect(q).toContain('status=ACTIVE');
    expect(q).toContain('workspace_id=ws_1');
    expect(q).toContain('q=road');
    expect(q).toContain('limit=100');
  });
});

describe('workforce advisory envelope', () => {
  // Mirrors the exact server payload from
  // apps/api/src/modules/analytics/routes.ts — a business field named `data`
  // sitting next to the fields the Workforce panel renders.
  const payload = {
    advisory: true,
    model_version: 'workforce-rules-v1',
    prediction_timestamp: '2026-09-14T00:00:00.000Z',
    confidence: null,
    status: 'AVAILABLE',
    scope_note: 'Workload includes only tasks visible in your scope.',
    data: [{ id: 'u1', username: 'user_one', visible_open_tasks: 1 }],
  };

  it('reaches the panel with its siblings intact when read raw', () => {
    // apiRequestRaw hands back the body untouched — this is what Advisories
    // reads now, and every field below is one the panel puts on screen.
    const body = payload as Record<string, unknown>;
    expect(body.scope_note).toBeTruthy();
    expect(body.model_version).toBe('workforce-rules-v1');
    expect(body.status).toBe('AVAILABLE');
    expect((body.data as unknown[]).length).toBe(1);
  });

  it('loses those siblings and breaks `.data.data` when unwrapped', () => {
    // What apiRequest's unwrap() did: return the inner `data` and discard the
    // rest. The panel then read `.data.data` off an array (undefined) and
    // `.length` threw, taking the whole Analytics page down.
    const unwrapped = payload.data as unknown as Record<string, unknown>;
    expect(unwrapped.scope_note).toBeUndefined();
    expect(unwrapped.model_version).toBeUndefined();
    expect(unwrapped.data).toBeUndefined();
    expect(() => (unwrapped.data as unknown[]).length).toThrow(TypeError);
  });
});
