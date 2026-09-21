/**
 * The directory's status filter offers only statuses the API accepts (HR-4).
 *
 * It used to offer ON_LEAVE and TERMINATED, which no employee can have, and
 * leave out SUSPENDED, which many do. Picking either phantom came back 422,
 * and there was no way to list the suspended.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMPLOYEE_FILTER_STATUSES } from '@/lib/employees';

describe('employee status filter', () => {
  it('matches the statuses an employee can actually hold', () => {
    expect([...EMPLOYEE_FILTER_STATUSES]).toEqual(['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXITED']);
  });

  it('is what the directory screen offers', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../app/employees/page.tsx', import.meta.url)),
      'utf8',
    );
    expect(page).toContain('EMPLOYEE_FILTER_STATUSES.map');
    expect(page).not.toMatch(/'ON_LEAVE'|'TERMINATED'/);
  });
});
