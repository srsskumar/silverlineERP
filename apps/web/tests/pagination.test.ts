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
