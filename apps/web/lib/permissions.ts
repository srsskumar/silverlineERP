/**
 * Permission codes mirrored from the backend RBAC seed (9 roles).
 * Frontend codes must stay in sync with `permissions.code` on the server;
 * the server remains the source of truth (per-button re-checks).
 */

export const PERMISSIONS = {
  // Backend-canonical dot codes (server is source of truth).
  // NOTE: there is no dashboard permission on the server — the Dashboard nav
  // item is auth-only (see AppShell). Do not re-add colon-style codes here;
  // they never match server-issued permissions and fail closed (hidden UI).
  AUTH_LOGIN: 'auth.login',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  AUDIT_READ: 'audit.read',
  // S1 frozen contract codes (dot-style; backend enforces these).
  ORG_UNITS_READ: 'org.units.read',
  ORG_UNITS_MANAGE: 'org.units.manage',
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_CREATE: 'employee.create',
  /**
   * Editing an employee.
   *
   * Deliberately the same code the API enforces on PATCH /employees/:id,
   * which is employee.create. There is no separate employee.update
   * permission — the constant used to name one, no role could ever hold it,
   * and the Edit button was invisible to every account in the system
   * including SUPER_ADMIN. The feature was built and unreachable.
   *
   * Whoever may bring somebody onto the register may correct what it says
   * about them; the destructive step is exiting them, which has its own
   * permission.
   */
  EMPLOYEE_UPDATE: 'employee.create',
  EMPLOYEE_EXIT: 'employee.exit',
  EMPLOYEE_REACTIVATE: 'employee.reactivate',
  EMPLOYEE_IMPORT: 'employee.import',
  DOCUMENT_READ: 'document.read',
  DOCUMENT_UPLOAD: 'document.upload',
  HOLIDAY_READ: 'holiday.read',
  HOLIDAY_MANAGE: 'holiday.manage',
  // S2 frozen contract codes (dot-style; backend enforces these).
  ATTENDANCE_PUNCH: 'attendance.punch',
  ATTENDANCE_READ: 'attendance.read',
  ATTENDANCE_DECIDE: 'attendance.decide',
  GEO_READ: 'geo.read',
  GEO_MANAGE: 'geo.manage',
  // S3 frozen contract codes (dot-style; backend enforces these).
  LEAVE_REQUEST: 'leave.request',
  LEAVE_DECIDE: 'leave.decide',
  LEAVE_READ: 'leave.read',
  LEAVE_ADMIN: 'leave.admin',
  // S4 frozen contract codes (dot-style; backend enforces these).
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_MANAGE: 'workspace.manage',
  PROJECT_CREATE: 'project.create',
  PROJECT_READ: 'project.read',
  PROJECT_UPDATE: 'project.update',
  PROJECT_CLOSE: 'project.close',
  TASK_CREATE: 'task.create',
  TASK_READ: 'task.read',
  TASK_UPDATE: 'task.update',
  TASK_TRANSITION: 'task.transition',
  TASK_ASSIGN: 'task.assign',
  TASK_COMMENT: 'task.comment',
  TASK_REORDER: 'task.reorder',
  // S5 frozen contract codes (dot-style; backend enforces these).
  BOARD_READ: 'board.read',
  BOARD_MANAGE: 'board.manage',
  FILTER_READ: 'filter.read',
  FILTER_MANAGE: 'filter.manage',
  LABEL_READ: 'label.read',
  LABEL_MANAGE: 'label.manage',
  // S6 frozen contract codes (dot-style; backend enforces these).
  DASHBOARD_READ: 'dashboard.read',
  REPORT_GENERATE: 'report.generate',
  // P1 payroll frozen contract codes (dot-style; backend enforces these).
  PAYROLL_READ: 'payroll.read',
  PAYROLL_GENERATE: 'payroll.generate',
  PAYROLL_APPROVE: 'payroll.approve',
  PAYROLL_LOCK: 'payroll.lock',
  PAYROLL_CONFIGURE: 'payroll.configure',
  PAYSLIP_READ: 'payslip.read',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionHolder {
  permissions?: string[] | null;
}

/** True when the holder's permission list contains the required code. */
export function hasPermission(holder: PermissionHolder | null | undefined, code: string): boolean {
  if (!holder || !Array.isArray(holder.permissions)) return false;
  return holder.permissions.includes(code);
}

/** True when the holder has at least one of the given codes. */
export function hasAnyPermission(
  holder: PermissionHolder | null | undefined,
  codes: readonly string[],
): boolean {
  if (!holder || !Array.isArray(holder.permissions)) return false;
  return codes.some((code) => holder.permissions!.includes(code));
}

/** True when the holder has every one of the given codes. */
export function hasAllPermissions(
  holder: PermissionHolder | null | undefined,
  codes: readonly string[],
): boolean {
  if (!holder || !Array.isArray(holder.permissions)) return false;
  return codes.every((code) => holder.permissions!.includes(code));
}
