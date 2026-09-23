/**
 * RBAC for the mobile MVP — dependency-free.
 *
 * Permission dot-codes mirror the backend exactly:
 *  - S0 base map:        packages/shared/src/rbac.ts      (PERMISSIONS)
 *  - S2 attendance:      packages/shared/src/s2.ts        (S2_PERMISSIONS)
 *  - S3 leave:           packages/shared/src/s3.ts        (S3_PERMISSIONS)
 *  - S4 projects/tasks:  packages/shared/src/s4.ts        (S4_PERMISSIONS)
 *  - S5 boards/notifs:   packages/shared/src/s5.ts        (S5_PERMISSIONS)
 * Do NOT import @silverline/shared (Metro workspace linking is deferred);
 * if backend codes change, update here and note drift in README.
 */

export const PERMISSIONS = {
  AUTH_LOGIN: "auth.login",
  USERS_READ: "users.read",
  USERS_MANAGE: "users.manage",
  ROLES_READ: "roles.read",
  ROLES_MANAGE: "roles.manage",
  AUDIT_READ: "audit.read",
  EMPLOYEES_READ: "employees.read",
  EMPLOYEES_MANAGE: "employees.manage",
  // S2 (geo.read / geo.manage retired with the geo-fence, 2026-09-22)
  ATTENDANCE_PUNCH: "attendance.punch",
  ATTENDANCE_READ: "attendance.read",
  ATTENDANCE_DECIDE: "attendance.decide",
  // S3
  LEAVE_REQUEST: "leave.request",
  LEAVE_READ: "leave.read",
  LEAVE_DECIDE: "leave.decide",
  LEAVE_ADMIN: "leave.admin",
  LEAVE_MANAGE: "leave.manage",
  // S4
  WORKSPACE_READ: "workspace.read",
  WORKSPACE_MANAGE: "workspace.manage",
  PROJECT_CREATE: "project.create",
  PROJECT_READ: "project.read",
  PROJECT_UPDATE: "project.update",
  PROJECT_CLOSE: "project.close",
  TASK_CREATE: "task.create",
  TASK_READ: "task.read",
  TASK_UPDATE: "task.update",
  TASK_TRANSITION: "task.transition",
  TASK_REORDER: "task.reorder",
  TASK_ASSIGN: "task.assign",
  TASK_COMMENT: "task.comment",
  // S5
  BOARD_READ: "board.read",
  BOARD_MANAGE: "board.manage",
  FILTER_READ: "filter.read",
  FILTER_MANAGE: "filter.manage",
  LABEL_READ: "label.read",
  LABEL_MANAGE: "label.manage",
  NOTIFICATION_READ: "notification.read",
  // S0 business
  INVENTORY_READ: "inventory.read",
  INVENTORY_MANAGE: "inventory.manage",
  PAYROLL_READ: "payroll.read",
  PAYROLL_MANAGE: "payroll.manage",
  // S59 land survey. Entry covers the day's return and the control points
  // recorded standing on them; the master list and the targets completion is
  // measured against are survey.manage and survey.target, neither of which
  // the app asks for.
  SURVEY_READ: "survey.read",
  SURVEY_ENTER: "survey.enter",
  // Assets tab (mirrors apps/api's asset.* codes; no S-number of its own).
  ASSET_READ: "asset.read",
  ASSET_MANAGE: "asset.manage",
} as const;

export type PermissionCode =
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * True when `granted` contains `required`. Accepts a single code or a list
 * (list = ALL required). SUPER_ADMIN/ADMIN-style wildcards: the backend
 * expands roles server-side, so the mobile client only ever sees the flat
 * `permissions[]` array from GET /api/v1/auth/me.
 */
export function can(
  granted: readonly string[] | undefined | null,
  required: string | readonly string[],
): boolean {
  if (!granted) return false;
  const need = Array.isArray(required) ? required : [required];
  return need.every((p) => granted.includes(p as string));
}

export type TabKey = "home" | "attendance" | "tasks" | "leave" | "assets" | "survey" | "more";

/**
 * Which permissions gate each bottom tab's *content*.
 * Tabs themselves always render (5-tab layout is fixed); screens that lack
 * permission show a locked-state message instead of data.
 */
export const TAB_PERMISSIONS: Record<TabKey, string[]> = {
  home: [],
  attendance: [PERMISSIONS.ATTENDANCE_PUNCH, PERMISSIONS.ATTENDANCE_READ],
  tasks: [PERMISSIONS.TASK_READ],
  leave: [PERMISSIONS.LEAVE_REQUEST, PERMISSIONS.LEAVE_READ],
  assets: [PERMISSIONS.ASSET_READ],
  /*
   * Read gates the tab; entry gates the forms inside it. They differ on
   * purpose: an auditor or a client viewer may be on a village's crew list
   * and hold only survey.read, and a screen that shows them the work and says
   * plainly that they cannot record against it beats a form that refuses on
   * submit.
   */
  survey: [PERMISSIONS.SURVEY_READ],
  more: [],
};

/** Leave approvals inbox requires decide rights. */
export const LEAVE_APPROVER_PERMISSIONS: readonly string[] = [
  PERMISSIONS.LEAVE_DECIDE,
  PERMISSIONS.LEAVE_ADMIN,
  PERMISSIONS.LEAVE_MANAGE,
];

/** Attendance exception decision requires decide rights. */
export const ATTENDANCE_DECIDER_PERMISSIONS: readonly string[] = [
  PERMISSIONS.ATTENDANCE_DECIDE,
];

/** True if the user may see ANY of the given codes (for inbox gating). */
export function canAny(
  granted: readonly string[] | undefined | null,
  codes: readonly string[],
): boolean {
  if (!granted) return false;
  return codes.some((c) => granted.includes(c as string));
}

/*
 * Module visibility (round 2 of the mobile rollout).
 *
 * GET /api/v1/auth/me now returns a top-level `modules: Record<string,
 * boolean>` -- one entry per code in the shared MODULE_CATALOG
 * (packages/shared/src/modules.ts), already resolved for the caller's own
 * roles and OR'd across every role they hold, exactly the way the web admin
 * screen resolves it.
 *
 * This is a UI convenience layered OVER the permission system, exactly as on
 * the web: hiding a module here narrows what this client renders, and must
 * never be the only thing standing between a screen and its data -- the
 * server keeps every permission and scope check it already had. So this is
 * combined with the existing permission checks (`can`/`canAny` above), never
 * used in their place: visibility can only narrow, never widen, what a
 * permission already allows.
 */

/**
 * Whether the signed-in user's roles show `code` as visible.
 *
 * `modules` is undefined before /auth/me has ever answered (a cold app, or a
 * cached session predating this field) and can be missing an individual code
 * (one added to the catalog after this device last synced). Both read as
 * "not yet known" and default to visible, so a slow network or a stale cache
 * never narrows a screen beyond what the permission check already allowed —
 * only an admin's explicit `false` hides anything.
 */
export function canSeeModule(
  modules: Record<string, boolean> | undefined | null,
  code: string,
): boolean {
  if (!modules) return true;
  return modules[code] !== false;
}

/**
 * The module-catalog code each bottom tab is narrowed by, on top of the
 * permission check TAB_PERMISSIONS already applies to its content.
 *
 * Home and More have no one-to-one catalog entry — Home is a personal
 * landing page stitched from several modules, and More is the launcher for
 * everything else in the catalog — so neither appears here and neither is
 * ever hidden by module visibility.
 */
export const TAB_MODULE_CODES: Partial<Record<TabKey, string>> = {
  attendance: "attendance",
  tasks: "my-work",
  leave: "leave",
  assets: "assets",
  survey: "survey",
};
