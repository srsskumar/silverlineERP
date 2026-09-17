import { describe, expect, it } from 'vitest';
import { S3_ROLE_GRANTS, S3_PERMISSIONS } from './s3.js';

describe('payroll and the leave that changes the pay', () => {
  it('lets a payroll officer read leave, because loss of pay is computed from it', () => {
    // They hold payroll.approve and payroll.lock: signing off a deduction
    // whose basis you cannot see is an approval nobody can check.
    expect(S3_ROLE_GRANTS.PAYROLL_OFFICER).toContain(S3_PERMISSIONS.LEAVE_READ);
  });

  it('does not let them approve, cancel or alter leave', () => {
    // Reading what drives the number is not the same as deciding it, and
    // the person who computes pay should not also grant the leave.
    expect(S3_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain(S3_PERMISSIONS.LEAVE_DECIDE);
    expect(S3_ROLE_GRANTS.PAYROLL_OFFICER).not.toContain(S3_PERMISSIONS.LEAVE_REQUEST);
  });
});
