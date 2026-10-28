import { describe, expect, it } from 'vitest';
import { reportCreateSchema } from './s6.js';

/*
 * `filters` was an unbounded record of unknowns: whatever arrived was
 * persisted into the report registry and every schedule row, and echoed
 * back, limited only by the 8 MiB body cap (B-2, 2026-10-28). Only a
 * handful of keys are ever read, so the shape is now said out loud.
 */
describe('report filters', () => {
  const base = { type: 'inventory', format: 'csv' } as const;
  it('accepts the filters the routes actually read', () => {
    const r = reportCreateSchema.safeParse({ ...base, filters: { project_id: '11111111-1111-1111-1111-111111111111', employee_id: '22222222-2222-2222-2222-222222222222', assignee_id: '33333333-3333-3333-3333-333333333333', from: '2031-03-10', to: '2031-03-10', status: 'APPROVED', department: 'Survey' } });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });
  it('refuses a filter object with keys nobody reads, or too many of them', () => {
    expect(reportCreateSchema.safeParse({ ...base, filters: { anything: 'goes' } }).success).toBe(false);
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`k${i}`] = 'v';
    expect(reportCreateSchema.safeParse({ ...base, filters: wide }).success).toBe(false);
  });
  it('refuses a filter value of the wrong shape', () => {
    expect(reportCreateSchema.safeParse({ ...base, filters: { project_id: 'x'.repeat(5000) } }).success).toBe(false);
    expect(reportCreateSchema.safeParse({ ...base, filters: { from: 'yesterday' } }).success).toBe(false);
    expect(reportCreateSchema.safeParse({ ...base, filters: { status: 'x'.repeat(65) } }).success).toBe(false);
  });
});
