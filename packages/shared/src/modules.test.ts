import { describe, expect, it } from 'vitest';
import {
  resolveModuleVisibility,
  userModuleVisibilityQuerySchema,
  userModuleVisibilityUpdateSchema,
} from './modules.js';

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('userModuleVisibilityUpdateSchema', () => {
  it('needs at least one user and one change', () => {
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: [], changes: [{ module_code: 'my-work', visible: false }] }).success).toBe(false);
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: [guid(1)], changes: [] }).success).toBe(false);
  });
  it('caps a bulk update at 500 people', () => {
    const ids = Array.from({ length: 501 }, (_, i) => guid(i + 1));
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: ids, changes: [{ module_code: 'my-work', visible: true }] }).success).toBe(false);
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: ids.slice(0, 500), changes: [{ module_code: 'my-work', visible: true }] }).success).toBe(true);
  });
  it('rejects an id that is not a guid and accepts null for "follow the role"', () => {
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: ['nope'], changes: [{ module_code: 'my-work', visible: true }] }).success).toBe(false);
    expect(userModuleVisibilityUpdateSchema.safeParse({ user_ids: [guid(1)], changes: [{ module_code: 'my-work', visible: null }] }).success).toBe(true);
  });
});

describe('userModuleVisibilityQuerySchema', () => {
  it('defaults the status filter to ACTIVE and accepts ALL', () => {
    expect(userModuleVisibilityQuerySchema.parse({}).status).toBe('ACTIVE');
    expect(userModuleVisibilityQuerySchema.parse({ status: 'ALL' }).status).toBe('ALL');
    expect(userModuleVisibilityQuerySchema.safeParse({ status: 'SOMETIMES' }).success).toBe(false);
  });
});

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

  it('never shows a module the roles lack the permission for, whatever the rows say', () => {
    // A "show" switch cannot grant a screen the person's role cannot use: the
    // phone would render a tile that opens into 403s.
    const base = { roles: ['EMPLOYEE'], heldByRole: held({ EMPLOYEE: ['task.read'] }), superAdmin: false };
    const byUser = resolveModuleVisibility({ ...base, roleOverrides: new Map(), userOverrides: userRows({ payroll: true }) });
    expect(byUser.payroll).toEqual({ visible: false, source: 'default' });
    const byRole = resolveModuleVisibility({ ...base, roleOverrides: roleRows({ 'EMPLOYEE:payroll': true }), userOverrides: new Map() });
    expect(byRole.payroll).toEqual({ visible: false, source: 'default' });
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
