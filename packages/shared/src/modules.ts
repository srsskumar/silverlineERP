/**
 * The module catalog: what an administrator can show or hide, per role.
 *
 * This is the list of destinations in the application shell -- one entry per
 * item in `apps/web/lib/nav.ts`'s `NAV_GROUPS` -- kept here, once, so a web
 * client and a mobile client filter the same nav from the same list instead
 * of each guessing at what "the modules" are.
 *
 * IMPORTANT -- this is a UI convenience, never a security boundary. See the
 * comment on `MODULE_VISIBILITY_IS_NOT_A_PERMISSION` below and the tests
 * that pin it: hiding a module changes what a client renders, never what the
 * server allows. A role that holds the module's permission still gets a
 * normal 200 from the API when it is called directly, whatever this catalog
 * or an admin's override says.
 *
 * Kept in lock-step with `nav.ts` by `apps/web/tests/module-catalog.test.ts`,
 * which flattens `NAV_GROUPS` and compares it against this list entry for
 * entry -- so a permission string, a `requires`, or an `anyOf` that drifts
 * between the two fails a test rather than silently mis-gating a screen.
 */

import { z } from 'zod';
import { cursorPageQuerySchema } from './pagination.js';
import { EMPLOYEE_STATUSES } from './s1.js';

export interface ModuleCatalogEntry {
  /** Stable identifier, independent of the href nav.ts happens to use. */
  code: string;
  label: string;
  /** The nav.ts group heading this destination sits under. */
  group: string;
  /**
   * The permission this destination is named after.
   *
   * Absent for exactly one destination: `/security`, where somebody changes
   * their own password and enrols in MFA. It has no permission gate in
   * nav.ts because gating it could lock out the very user the system is
   * forcing to enrol, and this catalog does not invent one it would then
   * have to defend hiding.
   */
  permission?: string;
  /** Other permissions the destination needs before it can render at all. */
  requires?: string[];
  /** Alternative permissions that, alone, also make the destination worth opening. */
  anyOf?: string[];
}

export const MODULE_CATALOG: ModuleCatalogEntry[] = [
  { code: 'dashboard', label: 'Dashboard', group: 'Overview',
    permission: 'dashboard.read', requires: ['project.read', 'board.read'] },

  { code: 'my-work', label: 'My work', group: 'Work', permission: 'task.read' },
  { code: 'inbox', label: 'Inbox', group: 'Work', permission: 'notification.read' },
  { code: 'projects', label: 'Projects', group: 'Work', permission: 'project.read' },
  { code: 'planning', label: 'Planning', group: 'Work',
    permission: 'cycle.read', requires: ['project.read'] },
  { code: 'reports', label: 'Reports', group: 'Work', permission: 'report.generate' },

  { code: 'pipeline', label: 'Pipeline', group: 'Commercial', permission: 'lead.read' },
  { code: 'tenders', label: 'Tenders', group: 'Commercial', permission: 'tender.read' },
  { code: 'clients', label: 'Clients', group: 'Commercial', permission: 'client.read' },

  { code: 'approvals', label: 'Approvals', group: 'Finance', permission: 'approval.read' },
  { code: 'approval-policies', label: 'Approval policies', group: 'Finance', permission: 'approval.configure' },
  { code: 'procurement', label: 'Procurement', group: 'Finance', permission: 'requisition.read' },
  { code: 'expenses', label: 'Expenses', group: 'Finance', permission: 'expense.read' },
  { code: 'cost-heads', label: 'Cost heads', group: 'Finance', permission: 'costhead.read' },
  { code: 'project-finance', label: 'Project finance', group: 'Finance',
    permission: 'rabill.read', requires: ['project.read'] },
  { code: 'receivables', label: 'Receivables', group: 'Finance', permission: 'ar.read' },
  { code: 'payables', label: 'Payables', group: 'Finance', permission: 'ap.read' },
  { code: 'payments', label: 'Payments', group: 'Finance', permission: 'payment.read' },
  { code: 'bank-reconciliation', label: 'Bank reconciliation', group: 'Finance', permission: 'bank.read' },
  { code: 'financial-periods', label: 'Financial periods', group: 'Finance', permission: 'period.read' },

  { code: 'employees', label: 'Directory', group: 'People', permission: 'employee.read' },
  { code: 'attendance', label: 'Attendance', group: 'People',
    permission: 'attendance.read', anyOf: ['attendance.punch'] },
  { code: 'attendance-exceptions', label: 'Exceptions', group: 'People',
    permission: 'attendance.read' },
  { code: 'shifts', label: 'Shifts', group: 'People', permission: 'roster.read' },
  { code: 'leave', label: 'Leave', group: 'People', permission: 'leave.request' },
  { code: 'payroll', label: 'Payroll', group: 'People', permission: 'payroll.read' },
  { code: 'my-payslip', label: 'My payslip', group: 'People', permission: 'payslip.read' },

  { code: 'documents', label: 'Documents', group: 'Operations', permission: 'document.read' },
  { code: 'survey', label: 'Land survey', group: 'Operations', permission: 'survey.read', anyOf: ['survey.dashboard'] },
  { code: 'inventory', label: 'Inventory', group: 'Operations', permission: 'inventory.read' },
  { code: 'assets', label: 'Assets', group: 'Operations', permission: 'asset.read' },
  { code: 'asset-movements', label: 'Asset movements', group: 'Operations',
    permission: 'asset.read' },
  { code: 'analytics', label: 'Analytics', group: 'Operations',
    permission: 'analytics.read', requires: ['project.read'] },
  { code: 'automation', label: 'Automation', group: 'Operations', permission: 'automation.read' },

  { code: 'org-locations', label: 'Locations', group: 'Organisation',
    permission: 'org.units.read' },
  { code: 'org-holidays', label: 'Holidays', group: 'Organisation', permission: 'holiday.read' },
  { code: 'admin', label: 'Administration', group: 'Organisation', permission: 'users.read' },
  { code: 'admin-import-templates', label: 'Upload & download', group: 'Organisation',
    permission: 'users.read' },
  { code: 'configuration', label: 'Configuration', group: 'Organisation',
    permission: 'admin.configure' },
  { code: 'audit', label: 'Audit trail', group: 'Organisation', permission: 'audit.read' },
  // No permission: see the field comment above.
  { code: 'security', label: 'Security', group: 'Organisation' },
];

/**
 * Fast lookup, keyed the way the visibility table and the API responses are.
 */
export const MODULE_CATALOG_BY_CODE: Readonly<Record<string, ModuleCatalogEntry>> =
  Object.fromEntries(MODULE_CATALOG.map(m => [m.code, m]));

export const MODULE_CODES: readonly string[] = MODULE_CATALOG.map(m => m.code);

/**
 * Module visibility is a UI convenience layered on top of the real
 * permission system -- never a replacement for it.
 *
 * Hiding a module must never be the only thing standing between a role and
 * its data: every existing route keeps the permission and scope checks it
 * already has, untouched. A role with visibility switched off for a module
 * but that still holds the permission the module is named after gets an
 * ordinary 200 from the API if it calls the route directly -- this catalog,
 * and the `role_module_visibility` table it describes, change only what a
 * client chooses to render.
 *
 * This constant exists to be grepped, and its name is asserted on by the
 * security-invariant test in the API test suite.
 */
export const MODULE_VISIBILITY_IS_NOT_A_PERMISSION = true;

export type VisibilitySource = 'user' | 'role' | 'default';
export interface ResolvedModule { visible: boolean; source: VisibilitySource }

/**
 * What one person sees, decided once for `/auth/me` and the Configuration
 * screen alike: their own row, else their roles' rows, else whether a role
 * holds the module's permission -- the same rule `navItemVisible` applies on
 * the web (named permission or any `anyOf`, and every `requires`). Visible if
 * ANY role shows it: a person with two roles is not stuck with the stricter
 * view. A super administrator sees everything, whatever the rows say; it is
 * the role that puts a wrong rule right.
 */
export function resolveModuleVisibility(input: {
  roles: readonly string[];
  heldByRole: ReadonlyMap<string, ReadonlySet<string>>;
  /** `${roleCode}:${moduleCode}` -> visible */
  roleOverrides: ReadonlyMap<string, boolean>;
  /** moduleCode -> visible */
  userOverrides: ReadonlyMap<string, boolean>;
  superAdmin: boolean;
}): Record<string, ResolvedModule> {
  const out: Record<string, ResolvedModule> = {};
  for (const m of MODULE_CATALOG) {
    if (input.superAdmin) { out[m.code] = { visible: true, source: 'default' }; continue; }
    // Whether a role may use the module at all: the named permission or any
    // alternative, and every `requires`. A "show" switch never grants a
    // screen the person's roles cannot use -- the phone would render a tile
    // that opens into refusals.
    const permits = (roleCode: string): boolean => {
      const held = input.heldByRole.get(roleCode);
      const named = !m.permission || (held?.has(m.permission) ?? false);
      const alternative = (m.anyOf ?? []).some((code) => held?.has(code) ?? false);
      if (!named && !alternative) return false;
      return (m.requires ?? []).every((code) => held?.has(code) ?? false);
    };
    if (!input.roles.some(permits)) { out[m.code] = { visible: false, source: 'default' }; continue; }
    const own = input.userOverrides.get(m.code);
    if (own !== undefined) { out[m.code] = { visible: own, source: 'user' }; continue; }
    let visible = false;
    let fromRow = false;
    for (const roleCode of input.roles) {
      const row = input.roleOverrides.get(`${roleCode}:${m.code}`);
      if (row !== undefined) { fromRow = true; if (row) visible = true; continue; }
      if (permits(roleCode)) visible = true;
    }
    out[m.code] = { visible, source: fromRow ? 'role' : 'default' };
  }
  return out;
}

/** Filters for the Configuration screen's Employees view (one row per login). */
export const userModuleVisibilityQuerySchema = cursorPageQuerySchema.extend({
  role_code: z.string().min(1).max(100).optional(),
  district_id: z.string().guid().optional(),
  /** Employee status; `ALL` also lists logins with no employee record. */
  status: z.enum([...EMPLOYEE_STATUSES, 'ALL']).default('ACTIVE'),
  q: z.string().trim().min(1).max(200).optional(),
});

/**
 * One bulk change: the selected people and, per module, show / hide / follow
 * the role (`null` clears the person's row). Capped so a mistaken "select
 * all" cannot rewrite an organisation in one call.
 */
export const userModuleVisibilityUpdateSchema = z.object({
  user_ids: z.array(z.string().guid()).min(1).max(500),
  changes: z.array(z.object({
    module_code: z.string().min(1).max(64),
    visible: z.boolean().nullable(),
  })).min(1).max(MODULE_CATALOG.length),
});
export type UserModuleVisibilityUpdate = z.infer<typeof userModuleVisibilityUpdateSchema>;
