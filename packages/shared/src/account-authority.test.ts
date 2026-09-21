import { describe, expect, it } from 'vitest';
import * as shared from './index.js';
import { canImpersonate, canManageAccount } from './impersonation.js';
import { ROLE_CODES, SENSITIVE_PERMISSIONS, type RoleCode } from './rbac.js';

/**
 * Who may administer whose account, against the seeded role grants.
 *
 * Built from every *_ROLE_GRANTS map the seed unions, so adding a grant to a
 * role -- or a code to SENSITIVE_PERMISSIONS -- that quietly stops HR
 * resetting ordinary staff fails here rather than at the help desk.
 */
const maps = Object.entries(shared)
  .filter(([name]) => /ROLE_GRANTS$|^ROLE_PERMISSIONS$/.test(name))
  .map(([, value]) => value as Record<RoleCode, string[]>);

function principal(role: RoleCode) {
  return { id: role, roles: [role], permissions: [...new Set(maps.flatMap((m) => m[role] ?? []))] };
}

describe('canManageAccount', () => {
  it.each(['EMPLOYEE', 'TEAM_LEAD', 'PROJECT_MANAGER', 'HR_MANAGER'] as RoleCode[])(
    'lets an HR manager administer %s', (role) => {
      expect(canManageAccount(principal('HR_MANAGER'), principal(role)).ok).toBe(true);
    });

  it.each(['ADMIN', 'SUPER_ADMIN', 'PAYROLL_OFFICER'] as RoleCode[])(
    'keeps an HR manager away from %s', (role) => {
      expect(canManageAccount(principal('HR_MANAGER'), principal(role)).ok).toBe(false);
    });

  it('keeps an administrator away from a super administrator', () => {
    expect(canManageAccount(principal('ADMIN'), principal('SUPER_ADMIN')).ok).toBe(false);
    expect(canManageAccount(principal('SUPER_ADMIN'), principal('ADMIN')).ok).toBe(true);
  });

  it('leaves view-as strict: every permission counts there', () => {
    const admin = principal('ADMIN');
    // HR cannot hold view-as at all, but the subset rule itself is unchanged:
    const subject = { id: 'x', roles: ['EMPLOYEE'], permissions: ['task.read'] };
    const actor = { id: 'y', roles: ['ADMIN'], permissions: ['admin.impersonate'] };
    expect(canImpersonate(actor, subject).ok).toBe(false);
    expect(canImpersonate(admin, principal('EMPLOYEE')).ok).toBe(true);
  });

  it('names only real permission codes', () => {
    const known = new Set(ROLE_CODES.flatMap((r) => principal(r).permissions));
    for (const code of SENSITIVE_PERMISSIONS) expect(known.has(code), code).toBe(true);
  });
});
