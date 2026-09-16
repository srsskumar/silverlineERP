import { describe, expect, it } from 'vitest';
import {
  ROLE_CODES, ROLE_PERMISSIONS,
  S1_ROLE_GRANTS, S2_ROLE_GRANTS, S3_ROLE_GRANTS, S4_ROLE_GRANTS, S5_ROLE_GRANTS,
  S6_ROLE_GRANTS, P1_ROLE_GRANTS, V2_ROLE_GRANTS, CRM_ROLE_GRANTS, BILLING_ROLE_GRANTS,
  APPROVAL_ROLE_GRANTS, PROCUREMENT_ROLE_GRANTS, COST_CONTROL_ROLE_GRANTS,
  EXPENSE_ROLE_GRANTS, FINANCE_ROLE_GRANTS, INVENTORY_ROLE_GRANTS,
  ALLOCATION_ROLE_GRANTS, LEDGER_ROLE_GRANTS, DOCUMENT_ROLE_GRANTS, SURVEY_ROLE_GRANTS,
  type RoleCode,
} from '@silverline/shared';
import { NAV_GROUPS, QUICK_CREATE } from '../lib/nav';
import { landingRoute, canOpen } from '../lib/landing';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

/**
 * The permissions a role really holds, assembled the way the seed assembles
 * them. Testing against a hand-written list would only compare this file to
 * itself, and the bug this suite exists to catch was precisely a role whose
 * real grants did not match what a screen assumed.
 */
const MAPS = [
  ROLE_PERMISSIONS, S1_ROLE_GRANTS, S2_ROLE_GRANTS, S3_ROLE_GRANTS, S4_ROLE_GRANTS,
  S5_ROLE_GRANTS, S6_ROLE_GRANTS, P1_ROLE_GRANTS, V2_ROLE_GRANTS, CRM_ROLE_GRANTS,
  BILLING_ROLE_GRANTS, APPROVAL_ROLE_GRANTS, PROCUREMENT_ROLE_GRANTS,
  COST_CONTROL_ROLE_GRANTS, EXPENSE_ROLE_GRANTS, FINANCE_ROLE_GRANTS,
  INVENTORY_ROLE_GRANTS, ALLOCATION_ROLE_GRANTS, LEDGER_ROLE_GRANTS,
  DOCUMENT_ROLE_GRANTS, SURVEY_ROLE_GRANTS,
] as Array<Partial<Record<RoleCode, string[]>>>;

function permissionsFor(role: RoleCode): string[] {
  const out = new Set<string>();
  for (const map of MAPS) for (const p of map[role] ?? []) out.add(p);
  return [...out];
}

const ROLES = ROLE_CODES as readonly RoleCode[];

describe('every destination is gated', () => {
  it('gives every navigation item a permission, bar the one deliberate exception', () => {
    // /security is where somebody changes their own password and enrols in
    // MFA. Gating it would lock out the very user the system is forcing to
    // enrol. Everything else must declare what it needs.
    const ungated = NAV_GROUPS.flatMap(g => g.items).filter(i => !i.permission).map(i => i.href);
    expect(ungated).toEqual(['/security']);
  });

  it('gives every quick-create action a permission', () => {
    // A create button that appears for someone who cannot create is a button
    // that exists to produce a 403.
    for (const item of QUICK_CREATE) {
      expect(item.permission, `${item.href} has no permission gate`).toBeTruthy();
    }
  });

  it('never offers a create action without the read access to reach it', () => {
    for (const role of ROLES) {
      const perms = permissionsFor(role);
      for (const action of QUICK_CREATE) {
        if (!hasPermission({ permissions: perms }, action.permission!)) continue;
        // The action is offered, so the page it leads to must be openable.
        expect(
          canOpen(perms, action.href),
          `${role} is offered "${action.label}" but cannot open ${action.href}`,
        ).toBe(true);
      }
    }
  });
});

describe('where a role lands after signing in', () => {
  it('sends every role somewhere it can actually open', () => {
    // The reported bug: signing in and being shown "Insufficient permissions".
    for (const role of ROLES) {
      const perms = permissionsFor(role);
      const route = landingRoute(perms);
      expect(canOpen(perms, route), `${role} lands on ${route}, which it cannot open`).toBe(true);
    }
  });

  it('never lands a role on the board dashboard unless the board will load', () => {
    // dashboard.read alone is not enough: the page reads projects and boards.
    // HR, payroll and inventory hold the first and not the other two, and
    // every one of them used to land on a refusal.
    for (const role of ROLES) {
      const perms = permissionsFor(role);
      if (landingRoute(perms) !== '/dashboard') continue;
      expect(hasPermission({ permissions: perms }, PERMISSIONS.PROJECT_READ), role).toBe(true);
      expect(hasPermission({ permissions: perms }, PERMISSIONS.BOARD_READ), role).toBe(true);
    }
  });

  it('falls back to a page any signed-in user can open', () => {
    // A role holding nothing at all still has to go somewhere.
    expect(landingRoute([])).toBe('/security');
    expect(landingRoute(undefined)).toBe('/security');
  });

  it('prefers the dashboard for a role that can use it', () => {
    const admin = permissionsFor('ADMIN');
    expect(landingRoute(admin)).toBe('/dashboard');
  });
});

describe('the roles that were broken', () => {
  /**
   * These four are the report. Each held dashboard.read or nothing at all and
   * was redirected to a board it could not load. The assertion is not that
   * they now see a board — they should not — but that they land somewhere
   * real.
   */
  const previouslyBroken: RoleCode[] = [
    'HR_MANAGER', 'PAYROLL_OFFICER', 'INVENTORY_MANAGER', 'BID_TENDER_MANAGER',
  ];

  for (const role of previouslyBroken) {
    it(`${role} lands on a working page`, () => {
      const perms = permissionsFor(role);
      const route = landingRoute(perms);
      expect(route).not.toBe('/dashboard');
      expect(canOpen(perms, route)).toBe(true);
      // And it is a real destination, not the fallback of last resort.
      expect(route).not.toBe('/security');
    });
  }

  it('leaves the board to the roles that do project work', () => {
    for (const role of ['ADMIN', 'PROJECT_MANAGER', 'TEAM_LEAD', 'EMPLOYEE'] as RoleCode[]) {
      const perms = permissionsFor(role);
      expect(hasPermission({ permissions: perms }, PERMISSIONS.PROJECT_READ), role).toBe(true);
      expect(hasPermission({ permissions: perms }, PERMISSIONS.BOARD_READ), role).toBe(true);
    }
  });
});

describe('what each role can see', () => {
  it('shows a narrower role strictly less than a broader one', () => {
    // An employee must never see a destination an admin cannot.
    const employee = new Set(
      NAV_GROUPS.flatMap(g => g.items)
        .filter(i => !i.permission || hasPermission({ permissions: permissionsFor('EMPLOYEE') }, i.permission))
        .map(i => i.href));
    const admin = new Set(
      NAV_GROUPS.flatMap(g => g.items)
        .filter(i => !i.permission || hasPermission({ permissions: permissionsFor('ADMIN') }, i.permission))
        .map(i => i.href));
    for (const href of employee) expect(admin.has(href), `employee sees ${href}, admin does not`).toBe(true);
    expect(admin.size).toBeGreaterThan(employee.size);
  });

  it('keeps payroll and finance away from a field employee', () => {
    const perms = permissionsFor('EMPLOYEE');
    for (const href of ['/payroll', '/receivables', '/payables', '/admin', '/procurement']) {
      expect(canOpen(perms, href), `EMPLOYEE should not reach ${href}`).toBe(false);
    }
  });

  it('gives every role at least one destination', () => {
    // A role that can sign in and see an empty sidebar is a role nobody can
    // use, and the sidebar now correctly renders nothing rather than lying.
    for (const role of ROLES) {
      const perms = permissionsFor(role);
      const visible = NAV_GROUPS.flatMap(g => g.items)
        .filter(i => !i.permission || hasPermission({ permissions: perms }, i.permission));
      expect(visible.length, `${role} sees no navigation at all`).toBeGreaterThan(0);
    }
  });
});
