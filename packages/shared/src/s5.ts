import { z } from "zod";
import type { RoleCode } from "./rbac.js";

/**
 * S5 contracts (Silverline ERP sprint S5): boards, saved filters, labels,
 * notifications inbox, SLA read-model.
 * ADDITIVE module — existing exports in other files are untouched.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const S5_PERMISSIONS = {
  BOARD_READ: "board.read",
  BOARD_MANAGE: "board.manage",
  FILTER_READ: "filter.read",
  FILTER_MANAGE: "filter.manage",
  LABEL_READ: "label.read",
  LABEL_MANAGE: "label.manage",
  NOTIFICATION_READ: "notification.read",
} as const;

export type S5PermissionCode =
  (typeof S5_PERMISSIONS)[keyof typeof S5_PERMISSIONS];

export const S5_ALL_PERMISSIONS: string[] = Object.values(S5_PERMISSIONS);

/**
 * Additive S5 grants per system role. The seeder unions these with the
 * S0 (`ROLE_PERMISSIONS`) + S1 (`S1_ROLE_GRANTS`) + S2 (`S2_ROLE_GRANTS`) +
 * S3 (`S3_ROLE_GRANTS`) + S4 (`S4_ROLE_GRANTS`) maps (left unchanged).
 */
export const S5_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S5_ALL_PERMISSIONS],
  ADMIN: [...S5_ALL_PERMISSIONS],
  PROJECT_MANAGER: [
    S5_PERMISSIONS.BOARD_READ,
    S5_PERMISSIONS.BOARD_MANAGE,
    S5_PERMISSIONS.LABEL_READ,
    S5_PERMISSIONS.LABEL_MANAGE,
    S5_PERMISSIONS.FILTER_READ,
    S5_PERMISSIONS.FILTER_MANAGE,
    S5_PERMISSIONS.NOTIFICATION_READ,
  ],
  TEAM_LEAD: [
    S5_PERMISSIONS.BOARD_READ,
    S5_PERMISSIONS.LABEL_READ,
    S5_PERMISSIONS.FILTER_READ,
    S5_PERMISSIONS.FILTER_MANAGE,
    S5_PERMISSIONS.NOTIFICATION_READ,
  ],
  EMPLOYEE: [
    S5_PERMISSIONS.BOARD_READ,
    S5_PERMISSIONS.FILTER_READ,
    S5_PERMISSIONS.FILTER_MANAGE,
    S5_PERMISSIONS.LABEL_READ,
    S5_PERMISSIONS.NOTIFICATION_READ,
  ],
  CLIENT_VIEWER: [
    S5_PERMISSIONS.BOARD_READ,
    S5_PERMISSIONS.NOTIFICATION_READ,
  ],
  AUDITOR: [S5_PERMISSIONS.BOARD_READ, S5_PERMISSIONS.NOTIFICATION_READ],
  HR_MANAGER: [S5_PERMISSIONS.NOTIFICATION_READ],
  PAYROLL_OFFICER: [S5_PERMISSIONS.NOTIFICATION_READ],
  INVENTORY_MANAGER: [S5_PERMISSIONS.NOTIFICATION_READ],
  // Every other role above holds notification.read -- the Inbox nav item is
  // shown to everyone, not gated per module, so a role missing it still sees
  // the tab and 403s the moment it opens. GOVT_OBSERVER, SALES_BD_EXECUTIVE
  // and BID_TENDER_MANAGER were the roles left with nothing at all (not even
  // this ambient one): GOVT_OBSERVER found live during the round-2 deep
  // walk's govt crawl (098, fd4a046); SALES_BD_EXECUTIVE and
  // BID_TENDER_MANAGER were the same bug shape, created by
  // 031_commercial_permissions.sql and never revisited (Task 5f, migration
  // 100 carries the same grant to an already-seeded database).
  GOVT_OBSERVER: [S5_PERMISSIONS.NOTIFICATION_READ],
  SALES_BD_EXECUTIVE: [S5_PERMISSIONS.NOTIFICATION_READ],
  BID_TENDER_MANAGER: [S5_PERMISSIONS.NOTIFICATION_READ],
};

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export const boardViewTypeSchema = z.enum(["LIST", "KANBAN"]);

export type BoardViewType = z.infer<typeof boardViewTypeSchema>;

/** One column inside a board create/replace payload. */
export const boardColumnInputSchema = z.object({
  status_code: z.string().min(1, "status_code is required").max(30),
  name: z.string().min(1).max(255).optional(),
  position: z.number().int().min(0).max(100000).optional(),
  wip_limit: z.number().int().min(0).max(100000).nullable().optional(),
  color: z.string().min(1).max(50).nullable().optional(),
});

export type BoardColumnInput = z.infer<typeof boardColumnInputSchema>;

/** POST /api/v1/boards */
export const boardCreateSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID"),
  name: z.string().min(1, "Name is required").max(255),
  view_type: boardViewTypeSchema,
  column_config: z.array(boardColumnInputSchema).max(50).optional(),
  filter_config: z.record(z.string(), z.unknown()).optional(),
});

export type BoardCreateInput = z.infer<typeof boardCreateSchema>;

/** PATCH /api/v1/boards/:id — config-only; never mutates tasks. */
export const boardPatchSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    filter_config: z.record(z.string(), z.unknown()).optional(),
    shared: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.filter_config !== undefined ||
      v.shared !== undefined,
    { message: "Nothing to update" },
  );

export type BoardPatchInput = z.infer<typeof boardPatchSchema>;

/** PUT /api/v1/boards/:id/columns — replaces the whole column set. */
export const boardColumnsReplaceSchema = z.object({
  columns: z.array(boardColumnInputSchema).max(50),
});

export type BoardColumnsReplaceInput = z.infer<
  typeof boardColumnsReplaceSchema
>;

// ---------------------------------------------------------------------------
// Saved filters (owner-private)
// ---------------------------------------------------------------------------

/** POST /api/v1/saved-filters */
export const savedFilterCreateSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID").optional(),
  name: z.string().min(1, "Name is required").max(255),
  query_definition: z.record(z.string(), z.unknown()),
  shared: z.boolean().default(false),
});

export type SavedFilterCreateInput = z.infer<typeof savedFilterCreateSchema>;

/** PATCH /api/v1/saved-filters/:id — owner-only (+ SUPER_ADMIN/ADMIN). */
export const savedFilterPatchSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    query_definition: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.query_definition !== undefined,
    { message: "Nothing to update" },
  );

export type SavedFilterPatchInput = z.infer<typeof savedFilterPatchSchema>;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** POST /api/v1/labels — project_id omitted means a global (org-wide) label. */
export const labelCreateSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID").optional(),
  name: z.string().min(1, "Name is required").max(100),
  color: z.string().min(1).max(50).nullable().optional(),
});

export type LabelCreateInput = z.infer<typeof labelCreateSchema>;

/** POST /api/v1/tasks/:id/labels */
export const taskLabelAttachSchema = z.object({
  label_id: z.string().uuid("label_id must be a UUID"),
});

export type TaskLabelAttachInput = z.infer<typeof taskLabelAttachSchema>;

// ---------------------------------------------------------------------------
// Notifications inbox (stored only, no push in S5)
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  "TASK_ASSIGNED",
  "MENTION",
  "LEAVE_DECIDED",
  "ATTENDANCE_DECIDED",
  // An exited employee's open tasks are unassigned in the same transaction
  // as the exit (owner decision 2026-09-24 #1); the project's manager is
  // told which tasks now need a new assignee. The `type` column's own check
  // constraint was dropped in 009_v2.sql and never restored, so this needs
  // no migration to be storable -- only this catalogue, which is what the
  // API layer (and the Inbox filter chips) validate against.
  "TASK_REASSIGN_NEEDED",
] as const;

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export type NotificationType = z.infer<typeof notificationTypeSchema>;

// ---------------------------------------------------------------------------
// SLA read-model (COMPUTED — no cron, no new task columns in S5)
// ---------------------------------------------------------------------------

export const SLA_STATUSES = ["ON_SCHEDULE", "AT_RISK", "OVERDUE"] as const;

export const slaStatusSchema = z.enum(SLA_STATUSES);

export type SlaStatus = z.infer<typeof slaStatusSchema>;

/** `?sla=` filter values on GET /api/v1/tasks (lowercase by convention). */
export const SLA_FILTERS = ["overdue", "at_risk", "on_schedule"] as const;

export const slaFilterSchema = z.enum(SLA_FILTERS);

export type SlaFilter = z.infer<typeof slaFilterSchema>;

/** Today in Asia/Kolkata as `YYYY-MM-DD` (single source for the SLA rule). */
export function istTodayString(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Pure SLA computer (single source shared by the API list/detail shapes and
 * the SQL filter): terminal (DONE/CANCELLED) → ON_SCHEDULE; null
 * planned_end_date → ON_SCHEDULE; end < today(IST) → OVERDUE; within 2 days
 * (today, +1, +2) → AT_RISK; else ON_SCHEDULE.
 */
export function computeSlaStatus(
  input: { status: string; planned_end_date: string | null | undefined },
  todayIst?: string,
): SlaStatus {
  if (input.status === "DONE" || input.status === "CANCELLED") {
    return "ON_SCHEDULE";
  }
  const end = input.planned_end_date;
  if (!end) {
    return "ON_SCHEDULE";
  }
  const today = todayIst ?? istTodayString();
  if (end < today) {
    return "OVERDUE";
  }
  const diffDays = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000,
  );
  if (diffDays <= 2) {
    return "AT_RISK";
  }
  return "ON_SCHEDULE";
}

// ---------------------------------------------------------------------------
// Machine-readable S5 rule codes returned as the error `code`
// ---------------------------------------------------------------------------

export const S5_RULE_CODES = {
  UNKNOWN_STATUS: "UNKNOWN_STATUS",
  LABEL_EXISTS: "LABEL_EXISTS",
  LABEL_SCOPE: "LABEL_SCOPE",
} as const;

export type S5RuleCode = (typeof S5_RULE_CODES)[keyof typeof S5_RULE_CODES];
