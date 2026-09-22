import { describe, expect, it, vi } from 'vitest';

const apiRequest = vi.fn(async (_url: string, _init: unknown) => ({ data: { data: [], has_more: false, next_cursor: null }, request_id: 'r' }));
vi.mock('../lib/apiClient', () => ({ apiRequest: (u: string, i: unknown) => apiRequest(u, i) }));

const { listMyRecords, buildRecordsQuery } = await import('../lib/attendance');

/*
 * The punch clock read the supervisor's register to find today's record and
 * was refused for everybody without attendance.read -- so an EMPLOYEE was
 * always told "not punched in" and their second press was a duplicate. The
 * person's own days come from /attendance/me, which needs no grant.
 */
describe('listMyRecords', () => {
  it('asks for the signed-in person\'s own days, not the register', async () => {
    await listMyRecords({ from: '2026-09-22', to: '2026-09-22', limit: 1 });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const url = apiRequest.mock.calls[0][0];
    expect(url).toBe('/api/v1/attendance/me?from=2026-09-22&to=2026-09-22&limit=1');
    expect(url).not.toContain('employee_id');
  });

  it('keeps the register query for the register', () => {
    expect(buildRecordsQuery({ employee_id: 'e1', from: '2026-09-01' })).toBe('/api/v1/attendance/records?employee_id=e1&from=2026-09-01');
  });
});
