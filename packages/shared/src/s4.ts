import { z } from "zod";
import type { RoleCode } from "./rbac.js";
import { dateStringSchema } from "./s1.js";

/**
 * S4 contracts (Silverline ERP sprint S4): workspaces, project types +
 * workflows, projects, tasks (status machine, dependencies, evidence,
 * comments + mentions).
 * ADDITIVE module — existing exports in other files are untouched.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const S4_PERMISSIONS = {
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
} as const;

export type S4PermissionCode =
  (typeof S4_PERMISSIONS)[keyof typeof S4_PERMISSIONS];

export const S4_ALL_PERMISSIONS: string[] = Object.values(S4_PERMISSIONS);

const PROJECT_ALL = [
  S4_PERMISSIONS.PROJECT_CREATE,
  S4_PERMISSIONS.PROJECT_READ,
  S4_PERMISSIONS.PROJECT_UPDATE,
  S4_PERMISSIONS.PROJECT_CLOSE,
];

const TASK_ALL = [
  S4_PERMISSIONS.TASK_CREATE,
  S4_PERMISSIONS.TASK_READ,
  S4_PERMISSIONS.TASK_UPDATE,
  S4_PERMISSIONS.TASK_TRANSITION,
  S4_PERMISSIONS.TASK_REORDER,
  S4_PERMISSIONS.TASK_ASSIGN,
  S4_PERMISSIONS.TASK_COMMENT,
];

/**
 * Additive S4 grants per system role. The seeder unions these with the
 * S0 (`ROLE_PERMISSIONS`) + S1 (`S1_ROLE_GRANTS`) + S2 (`S2_ROLE_GRANTS`) +
 * S3 (`S3_ROLE_GRANTS`) maps (left unchanged).
 */
export const S4_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S4_ALL_PERMISSIONS],
  ADMIN: [...S4_ALL_PERMISSIONS],
  PROJECT_MANAGER: [
    S4_PERMISSIONS.WORKSPACE_READ,
    S4_PERMISSIONS.WORKSPACE_MANAGE,
    ...PROJECT_ALL,
    ...TASK_ALL,
  ],
  TEAM_LEAD: [
    S4_PERMISSIONS.WORKSPACE_READ,
    S4_PERMISSIONS.PROJECT_READ,
    S4_PERMISSIONS.TASK_CREATE,
    S4_PERMISSIONS.TASK_READ,
    S4_PERMISSIONS.TASK_UPDATE,
    S4_PERMISSIONS.TASK_TRANSITION,
    S4_PERMISSIONS.TASK_ASSIGN,
    S4_PERMISSIONS.TASK_COMMENT,
  ],
  EMPLOYEE: [
    S4_PERMISSIONS.PROJECT_READ,
    S4_PERMISSIONS.TASK_READ,
    S4_PERMISSIONS.TASK_CREATE,
    // Own tasks only: the PATCH /tasks/:id route additionally requires
    // assignee == caller for holders of task.update without task.assign.
    S4_PERMISSIONS.TASK_UPDATE,
    S4_PERMISSIONS.TASK_TRANSITION,
    S4_PERMISSIONS.TASK_COMMENT,
  ],
  CLIENT_VIEWER: [S4_PERMISSIONS.PROJECT_READ, S4_PERMISSIONS.TASK_READ],
  AUDITOR: [S4_PERMISSIONS.PROJECT_READ, S4_PERMISSIONS.TASK_READ],
  HR_MANAGER: [],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: [],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[],
};

// ---------------------------------------------------------------------------
// Task status machine (frozen S4 workflow)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  "TO_DO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "BLOCKED",
  "CANCELLED",
] as const;

export const taskStatusSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Terminal task statuses: DONE, CANCELLED. */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  "DONE",
  "CANCELLED",
];

/** True when no further transitions leave this status. */
export function isTaskTerminalStatus(status: TaskStatus): boolean {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Default workflow seeded for every project type (frozen). */
export const DEFAULT_TASK_WORKFLOW: Record<TaskStatus, TaskStatus[]> = {
  TO_DO: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["IN_REVIEW", "BLOCKED", "TO_DO"],
  IN_REVIEW: ["DONE", "IN_PROGRESS"],
  BLOCKED: ["TO_DO", "IN_PROGRESS"],
  DONE: [],
  CANCELLED: [],
};

/** Workflow blob stored in `project_workflows` (statuses + edge map). */
export const taskWorkflowSchema = z.object({
  statuses: z.array(taskStatusSchema),
  allowed_transitions: z.record(z.array(taskStatusSchema)),
});

export type TaskWorkflow = z.infer<typeof taskWorkflowSchema>;

/** Deep copy of the frozen default workflow (safe to persist/mutate). */
export function defaultTaskWorkflow(): TaskWorkflow {
  return {
    statuses: [...TASK_STATUSES],
    allowed_transitions: Object.fromEntries(
      (Object.entries(DEFAULT_TASK_WORKFLOW) as Array<[TaskStatus, TaskStatus[]]>).map(
        ([k, v]) => [k, [...v]],
      ),
    ) as Record<TaskStatus, TaskStatus[]>,
  };
}

// ---------------------------------------------------------------------------
// Project statuses
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED_PENDING_CLOSE",
  "CLOSED",
  "CANCELLED",
] as const;

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/**
 * Frozen project lifecycle:
 * DRAFT→ACTIVE→ON_HOLD→ACTIVE→COMPLETED_PENDING_CLOSE→CLOSED,
 * plus CANCELLED from DRAFT/ACTIVE/ON_HOLD.
 */
export const PROJECT_STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["ON_HOLD", "COMPLETED_PENDING_CLOSE", "CANCELLED"],
  ON_HOLD: ["ACTIVE", "CANCELLED"],
  COMPLETED_PENDING_CLOSE: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

export const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export type Priority = z.infer<typeof prioritySchema>;

export const dependencyTypeSchema = z.enum(["FINISH_TO_START"]);

export type DependencyType = z.infer<typeof dependencyTypeSchema>;

/** Seeded project-type codes (both share the default workflow). */
export const PROJECT_TYPE_SEEDS = [
  { code: "general", name: "General" },
  { code: "fieldwork", name: "Field Work" },
] as const;

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** POST /api/v1/workspaces */
export const workspaceCreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  description: z.string().max(2000).optional(),
});

export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectBase = {
  description: z.string().max(5000).optional(),
  project_type_id: z.string().uuid("project_type_id must be a UUID").optional(),
  project_manager_id: z
    .string()
    .uuid("project_manager_id must be a UUID")
    .optional(),
  planned_start_date: dateStringSchema.optional(),
  planned_end_date: dateStringSchema.optional(),
  priority: prioritySchema.optional(),
};

/** POST /api/v1/projects */
export const projectCreateSchema = z.object({
  workspace_id: z.string().uuid("workspace_id must be a UUID"),
  code: z.string().min(1, "Code is required").max(50),
  name: z.string().min(1, "Name is required").max(255),
  ...projectBase,
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

/** PATCH /api/v1/projects/:id — status moves only along the frozen edges. */
export const projectPatchSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(5000).optional(),
    priority: prioritySchema.optional(),
    planned_start_date: dateStringSchema.optional(),
    planned_end_date: dateStringSchema.optional(),
    status: projectStatusSchema.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.priority !== undefined ||
      v.planned_start_date !== undefined ||
      v.planned_end_date !== undefined ||
      v.status !== undefined,
    { message: "Nothing to update" },
  );

export type ProjectPatchInput = z.infer<typeof projectPatchSchema>;

/** POST /api/v1/projects/:id/close */
export const projectCloseSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export type ProjectCloseInput = z.infer<typeof projectCloseSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const taskBase = {
  description: z.string().max(10000).optional(),
  planned_start_date: dateStringSchema.optional(),
  planned_end_date: dateStringSchema.optional(),
  priority: prioritySchema.optional(),
  estimated_hours: z.number().min(0).max(100000).optional(),
  village_id: z.string().uuid("village_id must be a UUID").optional(),
};

/**
 * POST /api/v1/tasks. Only `project_id` + `title` are required (quick-add);
 * everything else is optional. `assignee_id` is a user id whose linked
 * employee (if any) must be ACTIVE.
 */
export const taskCreateSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID"),
  title: z.string().min(1, "Title is required").max(500),
  assignee_id: z.string().uuid("assignee_id must be a UUID").optional(),
  parent_task_id: z.string().uuid("parent_task_id must be a UUID").optional(),
  ...taskBase,
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/**
 * PATCH /api/v1/tasks/:id. `status` is deliberately absent — status moves
 * only via the status endpoint (the route rejects a `status` key with 422
 * USE_STATUS_ENDPOINT); `assignee_id` moves only via the assign endpoint.
 */
export const taskPatchSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    priority: prioritySchema.optional(),
    planned_start_date: dateStringSchema.optional(),
    planned_end_date: dateStringSchema.optional(),
    estimated_hours: z.number().min(0).max(100000).optional(),
    village_id: z.string().uuid("village_id must be a UUID").optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.priority !== undefined ||
      v.planned_start_date !== undefined ||
      v.planned_end_date !== undefined ||
      v.estimated_hours !== undefined ||
      v.village_id !== undefined,
    { message: "Nothing to update" },
  );

export type TaskPatchInput = z.infer<typeof taskPatchSchema>;

/** PATCH /api/v1/tasks/:id/status */
export const taskStatusChangeSchema = z.object({
  status: taskStatusSchema,
  override: z.boolean().default(false),
  override_reason: z.string().max(2000).optional(),
});

export type TaskStatusChangeInput = z.infer<typeof taskStatusChangeSchema>;

/** PATCH /api/v1/tasks/:id/board-position */
export const taskBoardPositionSchema = z.object({
  board_position: z.number().int(),
});

export type TaskBoardPositionInput = z.infer<typeof taskBoardPositionSchema>;

/** POST /api/v1/tasks/:id/assign — the ONLY way to change `assignee_id`. */
export const taskAssignSchema = z.object({
  assignee_id: z.string().uuid("assignee_id must be a UUID"),
  reason: z.string().min(1, "Reason is required").max(2000),
});

export type TaskAssignInput = z.infer<typeof taskAssignSchema>;

/** POST /api/v1/tasks/:id/dependencies */
export const taskDependencyCreateSchema = z.object({
  predecessor_id: z.string().uuid("predecessor_id must be a UUID"),
  dependency_type: dependencyTypeSchema.default("FINISH_TO_START"),
});

export type TaskDependencyCreateInput = z.infer<
  typeof taskDependencyCreateSchema
>;

// ---------------------------------------------------------------------------
// Task evidence + comments
// ---------------------------------------------------------------------------

/** POST /api/v1/tasks/:id/evidence (local ./uploads driver, like S1 docs). */
export const taskEvidenceUploadSchema = z.object({
  evidence_type: z.string().min(1, "evidence_type is required").max(100),
  file_name: z.string().min(1, "file_name is required").max(255),
  content_base64: z.string().min(1, "content_base64 is required"),
});

export type TaskEvidenceUploadInput = z.infer<typeof taskEvidenceUploadSchema>;

/** Binary allowlist for S4 local evidence uploads (by file extension). */
export const ALLOWED_EVIDENCE_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
] as const;

/** S4 local-driver cap: 5 MiB of decoded binary per file. */
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** POST /api/v1/tasks/:id/comments — `@username` tokens become mentions. */
export const taskCommentCreateSchema = z.object({
  body: z.string().min(1, "Body is required").max(5000),
});

export type TaskCommentCreateInput = z.infer<typeof taskCommentCreateSchema>;

/** Matches `@username` mention tokens inside comment bodies. */
export const MENTION_TOKEN_PATTERN = /@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

/**
 * Extracts distinct mention usernames from a comment body (trailing dots
 * stripped so "@admin." mentions `admin`). Unknown names are ignored by the
 * route — only org-user matches become mention rows.
 */
export function extractMentionUsernames(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN_PATTERN)) {
    const token = (match[1] ?? "").replace(/\.+$/, "");
    if (token) {
      seen.add(token);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Machine-readable S4 rule codes returned as the error `code`
// ---------------------------------------------------------------------------

export const S4_RULE_CODES = {
  INVALID_PROJECT_STATUS: "INVALID_PROJECT_STATUS",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  SUBTASKS_OPEN: "SUBTASKS_OPEN",
  DEPENDENCY_BLOCKED: "DEPENDENCY_BLOCKED",
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
  SELF_DEPENDENCY: "SELF_DEPENDENCY",
  INVALID_DEPENDENCY: "INVALID_DEPENDENCY",
  ASSIGNEE_INACTIVE: "ASSIGNEE_INACTIVE",
  INVALID_PARENT: "INVALID_PARENT",
  USE_STATUS_ENDPOINT: "USE_STATUS_ENDPOINT",
  USE_ASSIGN_ENDPOINT: "USE_ASSIGN_ENDPOINT",
  PROJECT_HAS_OPEN_TASKS: "PROJECT_HAS_OPEN_TASKS",
  OVERRIDE_REASON_REQUIRED: "OVERRIDE_REASON_REQUIRED",
} as const;

export type S4RuleCode = (typeof S4_RULE_CODES)[keyof typeof S4_RULE_CODES];
