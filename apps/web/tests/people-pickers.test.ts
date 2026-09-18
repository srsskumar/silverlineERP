import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignablePeople, type Person } from '../lib/people';

/**
 * Who a picker may offer.
 *
 * Offering somebody who left in March as this week's assignee gets the write
 * refused later with an error nobody expected — and on the survey crew screen
 * the server already refuses a leaver, so the picker was setting people up to
 * fail.
 */
const person = (over: Partial<Person>): Person => ({
  id: 'u1', username: 'someone', employee_id: 'e1', emp_no: 'EMP001',
  name: 'Someone', employee_status: 'ACTIVE', ...over,
});

describe('assignablePeople', () => {
  it('keeps people who are still employed', () => {
    expect(assignablePeople([person({ employee_status: 'ACTIVE' })])).toHaveLength(1);
  });

  it('drops everyone who is not', () => {
    // The four states production actually holds besides ACTIVE.
    for (const status of ['EXITED', 'SUSPENDED', 'DRAFT', 'TERMINATED']) {
      expect(assignablePeople([person({ employee_status: status })]), status).toHaveLength(0);
    }
  });

  it('keeps an account with no employee record', () => {
    // An administrator or service login is not an inactive employee, and
    // removing them would make the people who mostly assign work
    // unassignable themselves.
    expect(assignablePeople([person({ employee_id: null, employee_status: null })]))
      .toHaveLength(1);
  });

  it('survives having nothing to filter', () => {
    expect(assignablePeople(undefined)).toEqual([]);
    expect(assignablePeople([])).toEqual([]);
  });
});

describe('every picker actually applies it', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('filters the people-based pickers', () => {
    // Pinned by file, because the filter is one call that is easy to drop
    // and produces no visible failure until somebody assigns work to a
    // leaver.
    for (const file of ['components/AssignDialog.tsx', 'app/approvals/delegations/page.tsx']) {
      expect(read(file), file).toContain('assignablePeople(');
    }
  });

  it('asks the server for active employees where the list comes from the directory', () => {
    expect(read('components/survey/VillageDetail.tsx')).toContain('status=ACTIVE');
    expect(read('app/admin/page.tsx')).toContain('status=ACTIVE');
    expect(read('app/geo-fences/page.tsx')).toContain("status: 'ACTIVE'");
    expect(read('components/EmployeeForm.tsx')).toContain("status: 'ACTIVE'");
  });

  it('leaves name resolution alone', () => {
    // The audit trail and closed tasks still have to show who did the work,
    // so the fetch keeps everybody and only the pickers filter.
    const audit = read('app/audit/page.tsx');
    expect(audit).toContain('listPeople');
    expect(audit).not.toContain('assignablePeople');
  });
});
