import { describe, expect, it } from 'vitest';
import { resolveModuleVisibility } from './modules.js';

/*
 * One function decides what a person sees: their own row, else their roles'
 * rows, else whether a role holds the module's permission. /auth/me and the
 * Configuration screen both call it, so the two can never disagree.
 */
const held = (pairs: Record<string, string[]>) =>
  new Map(Object.entries(pairs).map(([role, perms]) => [role, new Set(perms)] as const));
const roleRows = (rows: Record<string, boolean>) => new Map(Object.entries(rows));
const userRows = (rows: Record<string, boolean>) => new Map(Object.entries(rows));

describe('resolveModuleVisibility', () => {
  it('lets a user row win over a role row and over the permission default', () => {
    const out = resolveModuleVisibility({
      roles: ['EMPLOYEE'],
      heldByRole: held({ EMPLOYEE: ['task.read'] }),
      roleOverrides: roleRows({ 'EMPLOYEE:my-work': true }),
      userOverrides: userRows({ 'my-work': false }),
      superAdmin: false,
    });
    expect(out['my-work']).toEqual({ visible: false, source: 'user' });
  });

  it('shows a module when either of two roles shows it', () => {
    const out = resolveModuleVisibility({
      roles: ['A', 'B'],
      heldByRole: held({ A: [], B: ['task.read'] }),
      roleOverrides: roleRows({ 'A:my-work': false }),
      userOverrides: new Map(),
      superAdmin: false,
    });
    expect(out['my-work']).toEqual({ visible: true, source: 'role' });
  });

  it('shows a super administrator everything, whatever the rows say', () => {
    const out = resolveModuleVisibility({
      roles: ['SUPER_ADMIN'],
      heldByRole: held({ SUPER_ADMIN: [] }),
      roleOverrides: roleRows({ 'SUPER_ADMIN:my-work': false }),
      userOverrides: userRows({ 'my-work': false }),
      superAdmin: true,
    });
    expect(out['my-work']).toEqual({ visible: true, source: 'default' });
    expect(Object.values(out).every((m) => m.visible)).toBe(true);
  });

  it('hides a module nobody holds the permission for, with source default', () => {
    const out = resolveModuleVisibility({
      roles: ['EMPLOYEE'],
      heldByRole: held({ EMPLOYEE: ['task.read'] }),
      roleOverrides: new Map(),
      userOverrides: new Map(),
      superAdmin: false,
    });
    expect(out.dashboard).toEqual({ visible: false, source: 'default' });
    expect(out['my-work']).toEqual({ visible: true, source: 'default' });
  });

  it('needs no permission for security', () => {
    const out = resolveModuleVisibility({
      roles: ['EMPLOYEE'],
      heldByRole: held({ EMPLOYEE: [] }),
      roleOverrides: new Map(),
      userOverrides: new Map(),
      superAdmin: false,
    });
    expect(out.security).toEqual({ visible: true, source: 'default' });
  });
});
