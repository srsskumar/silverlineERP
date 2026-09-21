import { describe, expect, it } from 'vitest';
import {
  canImpersonate,
  impersonationBlocks,
  impersonateSchema,
  IMPERSONATION_ROLE_GRANTS,
  IMPERSONATION_MAX_MINUTES,
} from './impersonation.js';
import { ROLE_CODES } from './rbac.js';

const admin = {
  id: 'a',
  roles: ['ADMIN'],
  permissions: ['admin.impersonate', 'survey.read', 'survey.enter', 'projects.read'],
};

describe('canImpersonate', () => {
  it('lets an administrator hold the session of somebody strictly below them', () => {
    expect(canImpersonate(admin, { id: 'b', roles: ['EMPLOYEE'], permissions: ['survey.read'] }))
      .toEqual({ ok: true });
  });

  it('refuses anybody without the permission, whatever else they hold', () => {
    const pm = { id: 'p', roles: ['PROJECT_MANAGER'], permissions: ['survey.read', 'survey.manage'] };
    const verdict = canImpersonate(pm, { id: 'b', roles: ['EMPLOYEE'], permissions: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not allowed/i);
  });

  it('refuses to make you yourself', () => {
    expect(canImpersonate(admin, { id: 'a', roles: ['ADMIN'], permissions: admin.permissions }).ok).toBe(false);
  });

  it('names the super administrator case rather than listing permissions', () => {
    const verdict = canImpersonate(admin, {
      id: 'b', roles: ['SUPER_ADMIN'], permissions: [...admin.permissions],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/super administrator/i);
  });

  it('refuses any subject who can do something the actor cannot -- this is the escalation guard', () => {
    const verdict = canImpersonate(admin, {
      id: 'b', roles: ['PAYROLL_OFFICER'], permissions: ['payroll.manage'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('payroll.manage');
  });

  it('counts the rest rather than printing all of them', () => {
    const verdict = canImpersonate(admin, {
      id: 'b', roles: ['X'], permissions: ['a.1', 'a.2', 'a.3', 'a.4', 'a.5'],
    });
    expect(verdict.reason).toMatch(/and 2 more/);
  });

  it('lets a super administrator hold a super administrator session, since nothing is gained', () => {
    const su = { id: 's', roles: ['SUPER_ADMIN'], permissions: ['admin.impersonate', 'payroll.manage'] };
    expect(canImpersonate(su, { id: 't', roles: ['SUPER_ADMIN'], permissions: ['payroll.manage'] }).ok).toBe(true);
  });
});

describe('the forbidden path list', () => {
  it('keeps the account holder\'s own credentials theirs', () => {
    expect(impersonationBlocks('/api/v1/auth/password')).toBe(true);
    expect(impersonationBlocks('/api/v1/auth/mfa/disable')).toBe(true);
    expect(impersonationBlocks('/api/v1/auth/refresh')).toBe(true);
  });

  it('refuses to let an impersonated session start another one', () => {
    expect(impersonationBlocks('/api/v1/auth/impersonate')).toBe(true);
  });

  it('always leaves the way out open', () => {
    expect(impersonationBlocks('/api/v1/auth/impersonate/stop')).toBe(false);
    expect(impersonationBlocks('/api/v1/auth/me')).toBe(false);
  });

  it('is not fooled by a query string or a trailing slash', () => {
    expect(impersonationBlocks('/api/v1/auth/mfa/setup/')).toBe(true);
    expect(impersonationBlocks('/api/v1/auth/refresh?x=1')).toBe(true);
  });

  it('does not block ordinary work', () => {
    expect(impersonationBlocks('/api/v1/survey/projects')).toBe(false);
  });
});

describe('the grant map', () => {
  it('names every role, so a new one has to say out loud that it does not get this', () => {
    for (const code of ROLE_CODES) expect(IMPERSONATION_ROLE_GRANTS[code]).toBeDefined();
  });

  it('gives it to the two administrator roles and nobody else', () => {
    const holders = ROLE_CODES.filter((c) => IMPERSONATION_ROLE_GRANTS[c].length > 0);
    expect(holders).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });
});

describe('the request', () => {
  it('insists on a reason that says something', () => {
    const bad = impersonateSchema.safeParse({ user_id: '11111111-1111-1111-1111-111111111111', reason: 'test' });
    expect(bad.success).toBe(false);
  });

  it('caps how long a single session may run', () => {
    const tooLong = impersonateSchema.safeParse({
      user_id: '11111111-1111-1111-1111-111111111111',
      reason: 'Checking what the Kurnool team lead can see',
      minutes: IMPERSONATION_MAX_MINUTES + 1,
    });
    expect(tooLong.success).toBe(false);
  });
});
