import { describe, expect, it } from 'vitest';
import { normalizeCursorPage } from '../lib/employees';

describe('normalizeCursorPage', () => {
  it('parses a full envelope with cursor', () => {
    const page = normalizeCursorPage<{ id: string }>({
      data: [{ id: 'a' }, { id: 'b' }],
      next_cursor: 'cur123',
      has_more: true,
    });
    expect(page.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.next_cursor).toBe('cur123');
    expect(page.has_more).toBe(true);
  });

  it('tolerates a bare array (no cursor)', () => {
    const page = normalizeCursorPage<{ id: string }>([{ id: 'a' }]);
    expect(page.data).toEqual([{ id: 'a' }]);
    expect(page.next_cursor).toBeNull();
    expect(page.has_more).toBe(false);
  });

  it('drops non-record rows instead of crashing tables', () => {
    const page = normalizeCursorPage<{ id: string }>({
      data: [{ id: 'a' }, null, undefined, 'x', 42, { id: 'b' }],
      next_cursor: null,
      has_more: false,
    });
    expect(page.data).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('defaults missing fields to end-of-list', () => {
    expect(normalizeCursorPage(null)).toEqual({ data: [], next_cursor: null, has_more: false });
    expect(normalizeCursorPage({})).toEqual({ data: [], next_cursor: null, has_more: false });
    expect(normalizeCursorPage({ data: [{ id: 'a' }] })).toEqual({
      data: [{ id: 'a' }],
      next_cursor: null,
      has_more: false,
    });
  });
});

describe('client page-size requests stay within the API contract', () => {
  // The API rejects limit > 100 (packages/shared pagination schema). Five call
  // sites shipped limit: 200, so the district/mandal/village dropdowns 422'd on
  // every load and silently rendered empty. Fail the build if that comes back.
  it('no source file requests a page size above the server maximum', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(full)) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/limit:\s*(\d+)|limit=(\d+)/g)) {
          const value = Number(m[1] ?? m[2]);
          if (value > 100) offenders.push(`${full}: limit ${value}`);
        }
      }
    };
    for (const root of ['app', 'components', 'lib']) walk(root);
    expect(offenders).toEqual([]);
  });
});
