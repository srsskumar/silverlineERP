/**
 * RBAC role codes, permission codes, and the `can()` helper.
 * NOTE: the S0 brief says "9 role codes" but lists 10 — all 10 listed codes
 * are seeded below.
 */

export const ROLE_CODES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PAYROLL_OFFICER",
  "INVENTORY_MANAGER",
  "HR_MANAGER",
  "PROJECT_MANAGER",
  "TEAM_LEAD",
  "EMPLOYEE",
  "CLIENT_VIEWER",
  "AUDITOR",
  // §4 adds four roles for the tender domain; these two own the
  // commercial spine. Procurement Officer and Finance User arrive with
  // their own modules rather than as unused codes.
  "SALES_BD_EXECUTIVE",
  "BID_TENDER_MANAGER",
  /*
   * Somebody from the department, given the land survey dashboard (§071).
   *
   * A role in this list rather than one the migration creates on its own,
   * because every grant map below is keyed on this list — so adding it here
   * forces each module to say out loud what an observer gets from it, and
   * the answer is almost always nothing. A role that exists in the database
   * and not in this list is exactly the drift the seed comment warns about.
   */
  "GOVT_OBSERVER",
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const PERMISSIONS = {
  AUTH_LOGIN: "auth.login",
  USERS_READ: "users.read",
  USERS_MANAGE: "users.manage",
  ROLES_READ: "roles.read",
  ROLES_MANAGE: "roles.manage",
  AUDIT_READ: "audit.read",
  EMPLOYEES_READ: "employees.read",
  EMPLOYEES_MANAGE: "employees.manage",
  ATTENDANCE_READ: "attendance.read",
  ATTENDANCE_MANAGE: "attendance.manage",
  LEAVE_READ: "leave.read",
  LEAVE_MANAGE: "leave.manage",
  PROJECTS_READ: "projects.read",
  PROJECTS_MANAGE: "projects.manage",
  TASKS_READ: "tasks.read",
  TASKS_MANAGE: "tasks.manage",
  INVENTORY_READ: "inventory.read",
  INVENTORY_MANAGE: "inventory.manage",
  PAYROLL_READ: "payroll.read",
  PAYROLL_MANAGE: "payroll.manage",
} as const;

export type PermissionCode =
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSIONS);

/**
 * Seed permission map: which permissions each system role grants.
 * EMPLOYEE is deliberately minimal and does NOT include audit.read.
 *
 * PRD §4 contract (S0 slice): PAYROLL_OFFICER is payroll-only (+ login) —
 * no employee/attendance/task codes. INVENTORY_MANAGER holds its own
 * (currently unenforced) inventory codes + login only — no employee,
 * project, or other business codes. HR/PM/TL extras are ambient reads
 * kept for self-service; see the S1..P1 grant maps.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...ALL_PERMISSIONS],
  ADMIN: [...ALL_PERMISSIONS],
  PAYROLL_OFFICER: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.PAYROLL_READ,
    PERMISSIONS.PAYROLL_MANAGE,
  ],
  INVENTORY_MANAGER: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_MANAGE,
  ],
  HR_MANAGER: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.EMPLOYEES_READ,
    PERMISSIONS.EMPLOYEES_MANAGE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_MANAGE,
    PERMISSIONS.ATTENDANCE_READ,
  ],
  PROJECT_MANAGER: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.PROJECTS_READ,
    PERMISSIONS.PROJECTS_MANAGE,
    PERMISSIONS.TASKS_READ,
    PERMISSIONS.TASKS_MANAGE,
    PERMISSIONS.EMPLOYEES_READ,
  ],
  TEAM_LEAD: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.TASKS_READ,
    PERMISSIONS.TASKS_MANAGE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.PROJECTS_READ,
  ],
  EMPLOYEE: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.TASKS_READ,
  ],
  CLIENT_VIEWER: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.PROJECTS_READ,
    PERMISSIONS.TASKS_READ,
  ],
  AUDITOR: [
    PERMISSIONS.AUTH_LOGIN,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.EMPLOYEES_READ,
  ],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[],
  /* An observer holds survey.dashboard and nothing else (§071). */
  GOVT_OBSERVER: [],
};

/**
 * Returns true when `userPermissions` grants `required` (single code or all of a list).
 */
export function can(
  userPermissions: readonly string[],
  required: string | readonly string[],
): boolean {
  if (typeof required === "string") {
    return userPermissions.includes(required);
  }
  return required.every((p: string) => userPermissions.includes(p));
}
