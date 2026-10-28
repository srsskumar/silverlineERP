import { describe, expect, it } from 'vitest';
import { changePasswordSchema, loginSchema, mfaFloorRole, mfaRequired } from './auth.js';

describe('deciding who needs two-factor authentication', () => {
  const lead = { code: 'TEAM_LEAD', mfa_required: true };
  const field = { code: 'GT_USER', mfa_required: false };
  const root = { code: 'SUPER_ADMIN', mfa_required: true };

  it('follows the roles when the account says nothing', () => {
    expect(mfaRequired([lead])).toBe(true);
    expect(mfaRequired([field])).toBe(false);
  });

  it('takes the stricter of two roles', () => {
    // Somebody who is both a team lead and a field surveyor is a team lead.
    expect(mfaRequired([lead, field])).toBe(true);
  });

  it('lets an organisation exempt its field roles', () => {
    // The point of the setting: a rover operator reading a six-digit code off
    // a second device before every shift is a cost paid every morning.
    expect(mfaRequired([{ code: 'GT_USER', mfa_required: false }])).toBe(false);
  });

  it('lets one account be excused without excusing its role', () => {
    // "This particular phone cannot run an authenticator" is not a property
    // of a role.
    expect(mfaRequired([lead], 'EXEMPT')).toBe(false);
  });

  it('lets one account be held to it without holding its role to it', () => {
    // "This particular person handles payroll" likewise.
    expect(mfaRequired([field], 'REQUIRED')).toBe(true);
  });

  it('never excuses a super administrator, however it is asked', () => {
    // That account can grant itself the permission to change this setting,
    // so opting out would itself be the attack.
    expect(mfaRequired([root], 'EXEMPT')).toBe(true);
    expect(mfaRequired([{ ...root, mfa_required: false }], 'EXEMPT')).toBe(true);
    expect(mfaRequired([root, field], 'EXEMPT')).toBe(true);
  });

  it('names the roles that cannot be switched off', () => {
    expect(mfaFloorRole('SUPER_ADMIN')).toBe(true);
    expect(mfaFloorRole('ADMIN')).toBe(false);
    expect(mfaFloorRole('GT_USER')).toBe(false);
  });

  it('requires nothing of an account with no roles at all', () => {
    expect(mfaRequired([])).toBe(false);
  });
});

describe('password length', () => {
  // bcrypt reads the first 72 bytes and silently ignores the rest, so a
  // 128-character password was really a 72-character one that the person
  // believed was longer (C-10, 2026-10-28). The ceiling now says so.
  it('refuses a new password bcrypt would truncate', () => {
    const ok = changePasswordSchema.safeParse({ current_password: 'old-one', new_password: 'a'.repeat(72) });
    expect(ok.success).toBe(true);
    const long = changePasswordSchema.safeParse({ current_password: 'old-one', new_password: 'a'.repeat(73) });
    expect(long.success).toBe(false);
  });
  it('bounds what a sign-in attempt may send as a password', () => {
    expect(loginSchema.safeParse({ username: 'x', password: 'p'.repeat(256) }).success).toBe(true);
    expect(loginSchema.safeParse({ username: 'x', password: 'p'.repeat(257) }).success).toBe(false);
  });
});
