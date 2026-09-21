import {dateStringSchema, businessDay} from "@silverline/shared";
import {validateCustomFields} from "../../common/customFields.js";
import {encodeBlob, readBlob} from "../../common/blobStore.js";
import {scanUpload} from "../../common/fileSafety.js";
import {mutationRoute} from "../../common/mutationRoute.js";
import {projectRestriction} from "../../common/scopedReads.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ALLOWED_EVIDENCE_EXTENSIONS,
  ApiError,
  DEFAULT_TASK_WORKFLOW,
  MAX_EVIDENCE_BYTES,
  PROJECT_STATUS_TRANSITIONS,
  S4_PERMISSIONS,
  computeSlaStatus,
  cursorPageQuerySchema,
  decodeCursor,
  defaultTaskWorkflow,
  encodeCursor,
  extractMentionUsernames,
  projectCloseSchema,
  projectCategorySchema,
  projectCreateSchema,
  projectPatchSchema,
  taskAssignSchema,
  taskBoardPositionSchema,
  taskCommentCreateSchema,
  taskCreateSchema,
  taskDependencyCreateSchema,
  taskEvidenceUploadSchema,
  taskPatchSchema,
  taskStatusChangeSchema,
  toFieldErrors,
  workspaceCreateSchema,
  type ProjectStatus,
  type TaskStatus,
  type TaskWorkflow,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { resolveScopes, taskScopeClause } from "../../common/scopes.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import {
  idempotencyKeyOf,
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";
import { encryptPii, decryptPii, redactPiiForAudit } from "../../common/crypto.js";
import { emitNotification } from "../s5/notify.js";
import { parseIfMatch } from '../../common/ifMatch.js';

export interface WorkRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const WS_READ = S4_PERMISSIONS.WORKSPACE_READ;
const WS_MANAGE = S4_PERMISSIONS.WORKSPACE_MANAGE;
const P_CREATE = S4_PERMISSIONS.PROJECT_CREATE;
const P_READ = S4_PERMISSIONS.PROJECT_READ;
const P_UPDATE = S4_PERMISSIONS.PROJECT_UPDATE;
const P_CLOSE = S4_PERMISSIONS.PROJECT_CLOSE;
const T_CREATE = S4_PERMISSIONS.TASK_CREATE;
const T_READ = S4_PERMISSIONS.TASK_READ;
const T_UPDATE = S4_PERMISSIONS.TASK_UPDATE;
const T_TRANSITION = S4_PERMISSIONS.TASK_TRANSITION;
const T_REORDER = S4_PERMISSIONS.TASK_REORDER;
const T_ASSIGN = S4_PERMISSIONS.TASK_ASSIGN;
const T_COMMENT = S4_PERMISSIONS.TASK_COMMENT;

// ---------------------------------------------------------------------------
// Small helpers (mirroring the leave/employees modules)
// ---------------------------------------------------------------------------

function dateOnly(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * The Indian calendar day an instant fell on.
 *
 * The trigger stamps actual start and end in UTC. A crew that closed a task
 * at 01:00 IST closed it that day, not the day before, and the filter that
 * pulls "finished in August" has to agree with them.
 */
function istDay(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  return businessDay(v instanceof Date ? v : new Date(v));
}

function isoOrNull(v: Date | string | null): string | null {
  return v === null || v === undefined ? null : iso(v);
}


/** Error envelope plus a machine-readable rule detail (top-level extras). */
function sendRuleError(
  reply: FastifyReply,
  requestId: string,
  args: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Array<{ field: string; message: string }>;
    extra?: Record<string, unknown>;
  },
): FastifyReply {
  return reply.status(args.status).send({
    code: args.code,
    message: args.message,
    field_errors: args.fieldErrors ?? [],
    request_id: requestId,
    retryable: false,
    ...(args.extra ?? {}),
  });
}

function isTrueFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function uploadsDir(): string {
  return process.env["UPLOADS_DIR"] ?? join(process.cwd(), "uploads");
}

function decodeBase64Strict(input: string): Buffer {
  const compact = input.replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [{ field: "content_base64", message: "Invalid base64 content" }],
    });
  }
  const buf = Buffer.from(compact, "base64");
  if (buf.length === 0 || buf.toString("base64") !== compact) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [{ field: "content_base64", message: "Invalid base64 content" }],
    });
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Row types + shapes (snake_case, mirroring S1/S2/S3 conventions)
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const WORKSPACE_COLS = `id, org_id, name, description, status, version,
  created_at, updated_at`;

function toWorkspaceShape(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function toWorkspaceListItem(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
  };
}

interface ProjectTypeRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
}

function toProjectTypeShape(
  row: ProjectTypeRow,
  workflow: TaskWorkflow,
): {
  id: string;
  code: string;
  name: string;
  workflow: TaskWorkflow;
} {
  return { id: row.id, code: row.code, name: row.name, workflow };
}

interface ProjectRow {
  id: string;
  org_id: string;
  workspace_id: string;
  code: string;
  name: string;
  description: string | null;
  project_type_id: string | null;
  project_manager_id: string | null;
  planned_start_date: Date | string | null;
  planned_end_date: Date | string | null;
  priority: string;
  status: string;
  // The commercial facts (§6.2, §8, §37). Set either by a tender or proposal
  // conversion or directly on the project.
  project_kind: string | null;
  client_id: string | null;
  project_category_id: string | null;
  contract_value: string | number | null;
  contract_gst_included: boolean | null;
  contract_gst_rate: string | number | null;
  work_order_number: string | null;
  tender_id: string | null;
  proposal_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

// tender_id and proposal_id are read-only here — they are written only by the
// conversion (§8.7) and are what makes a converted project traceable. Leaving
// them out of the response meant a government project looked identical to a
// private one in every screen.
const PROJECT_COLS = `id, org_id, workspace_id, code, name, description,
  project_type_id, project_manager_id, planned_start_date, planned_end_date,
  priority, status, project_kind, client_id, project_category_id, contract_value,
  contract_gst_included, contract_gst_rate, work_order_number,
  tender_id, proposal_id, version, created_at, updated_at`;

function toProjectShape(row: ProjectRow) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    code: row.code,
    name: row.name,
    description: row.description,
    project_type_id: row.project_type_id,
    project_manager_id: row.project_manager_id,
    planned_start_date: dateOnly(row.planned_start_date),
    planned_end_date: dateOnly(row.planned_end_date),
    priority: row.priority,
    status: row.status,
    project_kind: row.project_kind,
    client_id: row.client_id,
    project_category_id: row.project_category_id,
    contract_value: row.contract_value === null ? null : Number(row.contract_value),
    contract_gst_included: row.contract_gst_included,
    contract_gst_rate: row.contract_gst_rate === null ? null : Number(row.contract_gst_rate),
    work_order_number: row.work_order_number,
    tender_id: row.tender_id,
    proposal_id: row.proposal_id,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

interface TaskRow {
  sort_key?:string;
  sla_status?: import("@silverline/shared").SlaStatus;
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  assignee_id: string | null;
  parent_task_id: string | null;
  village_id: string | null;
  planned_start_date: Date | string | null;
  planned_end_date: Date | string | null;
  actual_start_at: Date | string | null;
  actual_end_at: Date | string | null;
  priority: string;
  estimated_hours: string | number | null;
  board_position: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const TASK_COLS = `id, org_id, project_id, title, description, status,
  assignee_id, parent_task_id, village_id, planned_start_date,
  planned_end_date, actual_start_at, actual_end_at,
  priority, estimated_hours, board_position, version,
  created_at, updated_at,task_sla(status,planned_end_date,project_id) AS sla_status`;

function toTaskShape(row: TaskRow, labels: LabelShape[] = []) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee_id: row.assignee_id,
    parent_task_id: row.parent_task_id,
    village_id: row.village_id,
    planned_start_date: dateOnly(row.planned_start_date),
    planned_end_date: dateOnly(row.planned_end_date),
    // Stamped by the status trigger, never entered. Read as the Indian
    // calendar day the work started and ended on.
    actual_start_on: istDay(row.actual_start_at),
    actual_end_on: istDay(row.actual_end_at),
    actual_start_at: isoOrNull(row.actual_start_at),
    actual_end_at: isoOrNull(row.actual_end_at),
    priority: row.priority,
    estimated_hours:
      row.estimated_hours === null || row.estimated_hours === undefined
        ? null
        : Number(row.estimated_hours),
    board_position: Number(row.board_position),
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    // S5 additive read-model: label join (empty default) + computed SLA.
    labels,
    sla_status: row.sla_status ?? computeSlaStatus({
      status: row.status,
      planned_end_date: dateOnly(row.planned_end_date),
    }),
  };
}

/** Label item embedded on task shapes (join; empty array default). */
interface LabelShape {
  id: string;
  name: string;
  color: string | null;
}

/** Labels for a batch of tasks (single query; deterministic name order). */
async function taskLabelsFor(
  pool: Pool,
  taskIds: string[],
): Promise<Map<string, LabelShape[]>> {
  const map = new Map<string, LabelShape[]>();
  if (taskIds.length === 0) {
    return map;
  }
  const res = await pool.query(
    `SELECT tl.task_id, l.id, l.name, l.color
     FROM task_labels tl
     JOIN labels l ON l.id = tl.label_id
     WHERE tl.task_id = ANY($1::uuid[])
     ORDER BY l.name ASC, l.id ASC`,
    [taskIds],
  );
  for (const r of res.rows as Array<{
    task_id: string;
    id: string;
    name: string;
    color: string | null;
  }>) {
    const list = map.get(r.task_id) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.task_id, list);
  }
  return map;
}

/**
 * SQL for the S5 `?sla=` task filter — same rule as computeSlaStatus, with
 * IST today from `(now() AT TIME ZONE 'Asia/Kolkata')::date`.
 */
function slaFilterClause(sla:string):string {const status=sla==='overdue'?'OVERDUE':sla==='at_risk'?'AT_RISK':'ON_SCHEDULE';return `task_sla(status,planned_end_date,project_id)='${status}'`;}

interface TaskRef {
  id: string;
  title: string;
  status: string;
}

/** Task ref with the dependency edge id (for DELETE /tasks/:id/dependencies/:depId). */
interface DependencyRef extends TaskRef {
  dependency_id: string;
}

interface DependencyRow {
  id: string;
  predecessor_id: string;
  successor_id: string;
  dependency_type: string;
  created_at: Date | string;
}

function toDependencyShape(row: DependencyRow) {
  return {
    id: row.id,
    predecessor_id: row.predecessor_id,
    successor_id: row.successor_id,
    dependency_type: row.dependency_type,
    created_at: iso(row.created_at),
  };
}

interface EvidenceRow {
  id: string;
  evidence_type: string;
  file_name: string;
  file_size: number;
  checksum: string;
  created_at: Date | string;
}

function toEvidenceShape(row: EvidenceRow) {
  return {
    id: row.id,
    evidence_type: row.evidence_type,
    file_name: row.file_name,
    file_size: Number(row.file_size),
    checksum: row.checksum,
    created_at: iso(row.created_at),
  };
}

interface CommentRow {
  id: string;
  author_user_id: string | null;
  author_username: string | null;
  body: string;
  created_at: Date | string;
}

function toCommentShape(row: CommentRow) {
  return {
    id: row.id,
    author_user_id: row.author_user_id,
    author_username: row.author_username,
    body: row.body,
    created_at: iso(row.created_at),
  };
}

interface PageCursor {
  created_at: string;
  id: string;
}

const projectListQuerySchema = cursorPageQuerySchema.extend({
  status: z
    .enum(["DRAFT", "ACTIVE", "ON_HOLD", "COMPLETED_PENDING_CLOSE", "CLOSED", "CANCELLED"])
    .optional(),
  workspace_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
});

const taskListQuerySchema = cursorPageQuerySchema.extend({
  sort:z.enum(["created_desc","due_asc","priority_desc","title_asc"]).default("created_desc"),
  project_id: z.string().uuid().optional(),
  assignee_id: z.string().uuid().optional(),
  assignee_me: z.coerce.string().optional(),
  status: z.string().regex(/^[A-Z][A-Z0-9_]{0,29}$/)
    .optional(),
  sla: z.enum(["overdue", "at_risk", "on_schedule"]).optional(),
  cycle_id:z.string().uuid().optional(),
  due_from:dateStringSchema.optional(),due_to:dateStringSchema.optional(),
  /*
   * When work actually began and ended, as opposed to when it was planned to.
   * A programme is billed and reviewed on what happened, so the dates that
   * answer "what did we finish in August" are these, not the planned pair.
   */
  started_from:dateStringSchema.optional(),started_to:dateStringSchema.optional(),
  finished_from:dateStringSchema.optional(),finished_to:dateStringSchema.optional(),
  priority:z.enum(['LOW','MEDIUM','HIGH','URGENT']).optional(),
  mentioned_me:z.enum(['true','false']).optional(),
  custom_fields:z.string().max(5000).transform((value,ctx)=>{try{return JSON.parse(value);}catch{ctx.addIssue({code:'custom',message:'Use valid JSON for custom fields'});return z.NEVER;}}).pipe(z.record(z.union([z.string().max(5000),z.number().finite(),z.boolean(),z.array(z.string()).max(100)]))).optional(),
  q: z.string().min(1).max(200).optional(),
  /** Comma-separated label UUIDs — task must carry ANY of them (web FilterBar). */
  label_ids: z.string().min(1).max(2000).optional(),
});

/** Roles held by people outside the organisation (clients, government observers). */
const EXTERNAL_ROLES = new Set(["CLIENT_VIEWER", "GOVT_OBSERVER"]);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerWorkRoutes(
  app: FastifyInstance,
  opts: WorkRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canManageWs = requirePermission(authenticate, WS_MANAGE);
  const canReadWs = requirePermission(authenticate, WS_READ);
  const canCreateProject = requirePermission(authenticate, P_CREATE);
  const canReadProject = requirePermission(authenticate, P_READ);
  const canUpdateProject = requirePermission(authenticate, P_UPDATE);
  const canCloseProject = requirePermission(authenticate, P_CLOSE);
  const canCreateTask = requirePermission(authenticate, T_CREATE);
  const canReadTask = requirePermission(authenticate, T_READ);
  const canUpdateTask = requirePermission(authenticate, T_UPDATE);
  const canTransitionTask = requirePermission(authenticate, T_TRANSITION);
  const canReorderTask = requirePermission(authenticate, T_REORDER);
  const canAssignTask = requirePermission(authenticate, T_ASSIGN);
  const canCommentTask = requirePermission(authenticate, T_COMMENT);

  const metaOf = (req: {
    ip: string;
    headers: Record<string, unknown>;
    requestId: string;
  }) => ({
    ip: req.ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
    requestId: req.requestId,
  });

  async function findWorkspace(
    orgId: string,
    id: string,
  ): Promise<WorkspaceRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${WORKSPACE_COLS} FROM workspaces WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as WorkspaceRow | undefined;
  }

  async function findProject(
    orgId: string,
    id: string,
  ): Promise<ProjectRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as ProjectRow | undefined;
  }

  async function findTask(orgId: string, id: string): Promise<TaskRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${TASK_COLS} FROM tasks WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as TaskRow | undefined;
  }

  /** Workflow for a project: its type's seeded workflow, else the default. */
  async function workflowForProject(row: ProjectRow, db: Pick<Pool, "query"> = opts.pool): Promise<TaskWorkflow> {
    const override=await db.query('SELECT statuses,allowed_transitions FROM project_workflow_overrides WHERE project_id=$1',[row.id]);
    if(override.rowCount)return override.rows[0] as TaskWorkflow;
    if (!row.project_type_id) {
      return defaultTaskWorkflow();
    }
    const res = await db.query(
      `SELECT statuses, allowed_transitions FROM project_workflows
       WHERE project_type_id = $1::uuid`,
      [row.project_type_id],
    );
    const wf = res.rows[0] as
      | { statuses: unknown; allowed_transitions: unknown }
      | undefined;
    if (!wf) {
      return defaultTaskWorkflow();
    }
    return {
      statuses: Array.isArray(wf.statuses)
        ? (wf.statuses as TaskStatus[])
        : [...wf.statuses as TaskStatus[]],
      allowed_transitions: (wf.allowed_transitions ?? {}) as Record<
        string,
        TaskStatus[]
      >,
    };
  }

  function allowedNext(
    workflow: TaskWorkflow,
    status: string,
  ): TaskStatus[] {
    const fromMap = (
      workflow.allowed_transitions as Record<string, TaskStatus[]>
    )[status];
    if (Array.isArray(fromMap)) {
      return fromMap;
    }
    return DEFAULT_TASK_WORKFLOW[status as TaskStatus] ?? [];
  }

  /**
   * `allowed_next` for a page of tasks. The kanban board picks its drop
   * targets from list rows, so a list that omits `allowed_next` leaves the
   * client guessing and it offers moves the status endpoint then refuses
   * (DONE and CANCELLED are terminal — see TASK_TERMINAL_STATUSES). One
   * lookup for the whole page, not one per task: the override row wins over
   * the project type's workflow, and the frozen default fills in for both.
   */
  async function allowedNextForTasks(
    rows: TaskRow[],
  ): Promise<Map<string, TaskStatus[]>> {
    const byTask = new Map<string, TaskStatus[]>();
    const projectIds = [...new Set(rows.map((r) => r.project_id))];
    if (projectIds.length === 0) {
      return byTask;
    }
    const res = await opts.pool.query(
      `SELECT p.id,
              COALESCE(o.statuses, w.statuses) AS statuses,
              COALESCE(o.allowed_transitions, w.allowed_transitions) AS allowed_transitions
       FROM projects p
       LEFT JOIN project_workflow_overrides o ON o.project_id = p.id
       LEFT JOIN project_workflows w ON w.project_type_id = p.project_type_id
       WHERE p.id = ANY($1::uuid[])`,
      [projectIds],
    );
    const fallback = defaultTaskWorkflow();
    const byProject = new Map<string, TaskWorkflow>();
    for (const r of res.rows as Array<{
      id: string;
      statuses: unknown;
      allowed_transitions: unknown;
    }>) {
      byProject.set(r.id, {
        statuses: Array.isArray(r.statuses)
          ? (r.statuses as TaskStatus[])
          : [...fallback.statuses],
        allowed_transitions: (r.allowed_transitions ?? {
          ...fallback.allowed_transitions,
        }) as Record<string, TaskStatus[]>,
      });
    }
    for (const row of rows) {
      byTask.set(
        row.id,
        allowedNext(byProject.get(row.project_id) ?? fallback, row.status),
      );
    }
    return byTask;
  }

  /**
   * Assignee rule: must be an in-org user; when the user has a linked
   * employee that employee must be ACTIVE — otherwise 422 ASSIGNEE_INACTIVE.
   * Returns true when the assignee is usable (sends the error otherwise).
   */
  async function checkAssignee(
    reply: FastifyReply,
    requestId: string,
    orgId: string,
    assigneeId: string,
  ): Promise<boolean> {
    const u = await opts.pool.query(
      "SELECT id, employee_id FROM users WHERE id = $1::uuid AND org_id = $2",
      [assigneeId, orgId],
    );
    const user = u.rows[0] as
      | { id: string; employee_id: string | null }
      | undefined;
    if (!user) {
      sendError(reply, requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Assignee not found",
      });
      return false;
    }
    if (user.employee_id) {
      const e = await opts.pool.query(
        "SELECT status FROM employees WHERE id = $1::uuid",
        [user.employee_id],
      );
      const emp = e.rows[0] as { status: string } | undefined;
      if (!emp || emp.status !== "ACTIVE") {
        sendRuleError(reply, requestId, {
          status: 422,
          code: "ASSIGNEE_INACTIVE",
          message: "Assignee's linked employee is not ACTIVE",
          fieldErrors: [
            { field: "assignee_id", message: "Assignee must be an ACTIVE employee" },
          ],
        });
        return false;
      }
    }
    return true;
  }

  /** village_id must reference an in-org village unit (404/422 otherwise). */
  async function checkVillage(
    reply: FastifyReply,
    requestId: string,
    orgId: string,
    villageId: string,
  ): Promise<boolean> {
    const res = await opts.pool.query(
      "SELECT id, type FROM org_units WHERE id = $1::uuid AND org_id = $2",
      [villageId, orgId],
    );
    const row = res.rows[0] as { id: string; type: string } | undefined;
    if (!row) {
      sendError(reply, requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Village not found",
      });
      return false;
    }
    if (row.type !== "village") {
      sendError(reply, requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [
          { field: "village_id", message: "village_id must reference a village unit" },
        ],
      });
      return false;
    }
    return true;
  }

  async function taskCounts(projectId: string): Promise<{
    total: number;
    open: number;
    done: number;
  }> {
    const res = await opts.pool.query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'DONE')::int AS done,
         COUNT(*) FILTER (WHERE status NOT IN ('DONE', 'CANCELLED'))::int AS open
       FROM tasks WHERE project_id = $1::uuid`,
      [projectId],
    );
    const row = res.rows[0] as { total: number; open: number; done: number };
    return { total: row.total, open: row.open, done: row.done };
  }

  // ------------------------------------------------ POST /workspaces
  app.post("/api/v1/workspaces", { preHandler: canManageWs }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (await replayIfSeen(db, req, reply)) {
      return;
    }
    const parsed = workspaceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const ins = await db.query(
      `INSERT INTO workspaces (org_id, name, description, status, created_by, updated_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4::uuid, $4::uuid)
       RETURNING ${WORKSPACE_COLS}`,
      [user.orgId, parsed.data.name, parsed.data.description ?? null, user.id],
    );
    const row = ins.rows[0] as WorkspaceRow;
    const body = toWorkspaceShape(row);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "workspace.create",
      entityType: "workspace",
      entityId: row.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(db, req, user.id, 201, body);
    return reply.status(201).send(body);
  
});});

  // ------------------------------------------------ GET /workspaces
  app.get("/api/v1/workspaces", { preHandler: canReadWs }, async (req, reply) => {
    const parsed = cursorPageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { limit, cursor } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (cursor) {
      const decoded = decodeCursor<PageCursor>(cursor);
      if (!decoded) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
          ],
        });
      }
      values.push(decoded.created_at, decoded.id);
      clauses.push(
        `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT ${WORKSPACE_COLS} FROM workspaces WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const rows = res.rows as WorkspaceRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toWorkspaceListItem),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
          : null,
      has_more: hasMore,
    });
  });

  // ------------------------------------------------ GET /workspaces/:id
  app.get("/api/v1/workspaces/:id", { preHandler: canReadWs }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    const row = await findWorkspace(user.orgId, id);
    if (!row) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
    }
    return reply.status(200).send(toWorkspaceShape(row));
  });

  // ------------------------------------------------- GET /people
  //
  // Who work can be assigned to, by name.
  //
  // Tasks are assigned to a user, but people are known by their employee
  // record, so this joins the two and returns the name the rest of the
  // business uses. Without it the only list of users was /admin/users, gated
  // on users.read — which a project manager does not hold — so every assign
  // and project-manager field asked for a raw UUID that somebody had to look
  // up elsewhere and paste.
  //
  // Deliberately narrow: a colleague's display name, sign-in name and
  // employee number. No contact details, nothing that is not already on a
  // task card.
  //
  // For staff, not for outsiders (AUTH-6). It is the whole organisation's
  // staff list, and it was open to any signed-in account -- a client's
  // viewer login or a government observer could read every name and
  // employee number in it. Not gated on a single permission, because the
  // readers are everybody who works here: an employee reads it to put names
  // on their comment thread and their leave approvals, a payroll officer on
  // an approval timeline, a team lead in the assign picker, and no one
  // permission is held by all of them. What the outsiders have in common is
  // their roles, so that is the test: an account needs at least one role
  // that is not an external one. Screens that call it fall back to a short
  // id when it is refused.
  app.get("/api/v1/people", { preHandler: authenticate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
      });
    }
    if (!user.roles.some((r) => !EXTERNAL_ROLES.has(r))) {
      return sendError(reply, req.requestId, {
        status: 403, code: "FORBIDDEN",
        message: "The staff directory is for people who work in the organisation",
      });
    }
    // The same page cap as every other list. A picker wants the whole
    // directory, but it gets there by paging like everything else rather than
    // by this one route having a private limit nobody else knows about.
    const q = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 100));
    const offset = Math.max(0, Number(q.offset) || 0);
    const rows = (await opts.pool.query(
      `SELECT u.id, u.username, u.employee_id,
              e.emp_no,
              trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name,
              e.status AS employee_status
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id AND e.org_id = u.org_id
       WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE'
       ORDER BY COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), u.username)
       LIMIT $2 OFFSET $3`,
      [user.orgId, limit + 1, offset],
    )).rows;
    const data = rows.slice(0, limit).map((r) => ({
      id: r.id,
      username: r.username,
      employee_id: r.employee_id,
      emp_no: r.emp_no,
      // The name to show. Falls back to the sign-in name for an account with
      // no employee record — a service or admin login — rather than blank.
      name: (r.employee_name && String(r.employee_name).trim()) || r.username,
      employee_status: r.employee_status,
    }));
    return reply.status(200).send({ data, has_more: rows.length > limit });
  });

  // ------------------------------------- project categories (§6.2 masters)
  //
  // What the work is about — drones, CCTV, survey equipment — as a second
  // dimension to the project type, which is how it is contracted. Read by
  // anyone who can see projects; created by anyone who can create one, so the
  // Projects screen can add a missing category without a trip to an admin
  // area and without anybody keying a free-text value that never matches.
  app.get("/api/v1/project-categories", { preHandler: authenticate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
      });
    }
    const res = await opts.pool.query(
      `SELECT id, code, name, description, active, version, created_at, updated_at
       FROM project_categories WHERE org_id = $1 ORDER BY name ASC`,
      [user.orgId],
    );
    return reply.status(200).send({ data: res.rows });
  });

  app.post("/api/v1/project-categories", { preHandler: canCreateProject }, async (req, reply) => {
    return mutationRoute(opts.pool, req, reply, async (db, reply) => {
      if (await replayIfSeen(db, req, reply)) return;
      const parsed = projectCategorySchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser!;
      const d = parsed.data;
      const clash = await db.query(
        "SELECT id, name FROM project_categories WHERE org_id = $1 AND code = $2",
        [user.orgId, d.code],
      );
      if (clash.rowCount) {
        // Returning the existing row rather than an error: the caller is a
        // person adding a category from a form, and "Drones already exists"
        // with no way forward is a worse answer than simply using it.
        return reply.status(200).send({ data: clash.rows[0] });
      }
      const ins = await db.query(
        `INSERT INTO project_categories (org_id, code, name, description, active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::uuid, $6::uuid)
         RETURNING id, code, name, description, active, version, created_at, updated_at`,
        [user.orgId, d.code, d.name, d.description ?? null, d.active, user.id],
      );
      const row = ins.rows[0];
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId, actorId: user.id, impersonatorId: user.impersonator?.id ?? null, actorIp: meta.ip,
        actorUserAgent: meta.userAgent, action: "project_category.create",
        entityType: "project_category", entityId: row.id,
        afterState: row, requestId: req.requestId,
      });
      await storeIdempotentResponse(db, req, user.id, 201, row);
      return reply.status(201).send({ data: row });
    });
  });

  // ------------------------------------------------ GET /project-types
  app.get("/api/v1/project-types", { preHandler: authenticate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const res = await opts.pool.query(
      `SELECT t.id, t.org_id, t.code, t.name, w.statuses, w.allowed_transitions
       FROM project_types t
       LEFT JOIN project_workflows w ON w.project_type_id = t.id
       WHERE t.org_id = $1
       ORDER BY t.code ASC`,
      [user.orgId],
    );
    const fallback = defaultTaskWorkflow();
    const data = (res.rows as Array<ProjectTypeRow & {
      statuses: unknown;
      allowed_transitions: unknown;
    }>).map((r) =>
      toProjectTypeShape(r, {
        statuses: Array.isArray(r.statuses)
          ? (r.statuses as TaskStatus[])
          : [...fallback.statuses],
        allowed_transitions: (r.allowed_transitions ?? {
          ...fallback.allowed_transitions,
        }) as Record<string, TaskStatus[]>,
      }),
    );
    return reply.status(200).send({ data });
  });

  // ------------------------------------------------ POST /projects
  app.post("/api/v1/projects", { preHandler: canCreateProject }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (await replayIfSeen(db, req, reply)) {
      return;
    }
    const parsed = projectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const d = parsed.data;
    const ws = await findWorkspace(user.orgId, d.workspace_id);
    if (!ws) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
    }
    if (d.project_type_id) {
      const t = await db.query(
        "SELECT id FROM project_types WHERE id = $1::uuid AND org_id = $2",
        [d.project_type_id, user.orgId],
      );
      if ((t.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project type not found",
        });
      }
    }
    if (d.project_manager_id) {
      const pm = await db.query(
        "SELECT id FROM users WHERE id = $1::uuid AND org_id = $2",
        [d.project_manager_id, user.orgId],
      );
      if ((pm.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project manager not found",
        });
      }
    }
    if (d.client_id) {
      // Scoped to the tenant, like every other foreign key here. The column's
      // own constraint only checks that the row exists, which would happily
      // link a client belonging to another organisation.
      const cl = await db.query(
        "SELECT id FROM clients WHERE id = $1::uuid AND org_id = $2",
        [d.client_id, user.orgId],
      );
      if ((cl.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Client not found",
        });
      }
    }
    if (d.project_category_id) {
      const cat = await db.query(
        "SELECT id FROM project_categories WHERE id = $1::uuid AND org_id = $2",
        [d.project_category_id, user.orgId],
      );
      if ((cat.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project category not found",
        });
      }
    }
    let row: ProjectRow;
    try {
      const ins = await db.query(
        `INSERT INTO projects
           (org_id, workspace_id, code, name, description, project_type_id,
            project_manager_id, planned_start_date, planned_end_date,
            priority, status, project_kind, client_id, project_category_id,
            contract_value, contract_gst_included, contract_gst_rate,
            work_order_number, created_by, updated_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9, $10,
           'DRAFT', $11, $12::uuid, $13::uuid, $14, $15, $16, $17, $18::uuid, $18::uuid)
         RETURNING ${PROJECT_COLS}`,
        [
          user.orgId,
          d.workspace_id,
          d.code,
          d.name,
          d.description ?? null,
          d.project_type_id ?? null,
          d.project_manager_id ?? null,
          d.planned_start_date ?? null,
          d.planned_end_date ?? null,
          d.priority ?? "MEDIUM",
          d.project_kind ?? null,
          d.client_id ?? null,
          d.project_category_id ?? null,
          d.contract_value ?? null,
          d.contract_gst_included ?? null,
          d.contract_gst_rate ?? null,
          d.work_order_number ?? null,
          user.id,
        ],
      );
      row = ins.rows[0] as ProjectRow;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "CONFLICT",
          message: "Project code already exists in this organization",
          fieldErrors: [{ field: "code", message: "Code already exists in this org" }],
        });
      }
      throw err;
    }
    const body = toProjectShape(row);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "project.create",
      entityType: "project",
      entityId: row.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(db, req, user.id, 201, body);
    return reply.status(201).send(body);
  
});});

  // ------------------------------------------------ GET /projects
  app.get("/api/v1/projects", { preHandler: canReadProject }, async (req, reply) => {
    const parsed = projectListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { limit, cursor, status, workspace_id, q } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    clauses.push(await projectRestriction(opts.pool,user,values));
    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (workspace_id) {
      values.push(workspace_id);
      clauses.push(`workspace_id = $${values.length}::uuid`);
    }
    if (q) {
      values.push(`%${q}%`);
      clauses.push(
        `(code ILIKE $${values.length} OR name ILIKE $${values.length})`,
      );
    }
    if (cursor) {
      const decoded = decodeCursor<PageCursor>(cursor);
      if (!decoded) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
          ],
        });
      }
      values.push(decoded.created_at, decoded.id);
      clauses.push(
        `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT ${PROJECT_COLS} FROM projects WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const rows = res.rows as ProjectRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toProjectShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
          : null,
      has_more: hasMore,
    });
  });

  // ------------------------------------------------ GET /projects/:id
  app.get("/api/v1/projects/:id", { preHandler: canReadProject }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    const row = await findProject(user.orgId, id);
    if (!row) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Project not found",
      });
    }
    const workflow = await workflowForProject(row);
    const counts = await taskCounts(row.id);
    return reply.status(200).send({
      ...toProjectShape(row),
      workflow,
      counts,
    });
  });

  // ------------------------------------------------ PATCH /projects/:id
  app.patch("/api/v1/projects/:id", { preHandler: canUpdateProject }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = projectPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const expectedVersion = parseIfMatch(req);
    const { id } = req.params as { id: string };
    const cur = await findProject(user.orgId, id);
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Project not found",
      });
    }
    if (cur.version !== expectedVersion) {
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${cur.version})`,
      });
    }
    const d = parsed.data;
    if (
      d.status &&
      d.status !== cur.status &&
      !((PROJECT_STATUS_TRANSITIONS[cur.status as ProjectStatus] ?? []) as string[]).includes(
        d.status,
      )
    ) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "INVALID_PROJECT_STATUS",
        message: `Cannot transition project from ${cur.status} to ${d.status}`,
        fieldErrors: [
          { field: "status", message: `Invalid transition from ${cur.status}` },
        ],
        extra: {
          allowed_next:
            PROJECT_STATUS_TRANSITIONS[cur.status as ProjectStatus] ?? [],
        },
      });
    }
    if (d.client_id) {
      // Scoped to the tenant, like every other foreign key here. The column's
      // own constraint only checks that the row exists, which would happily
      // link a client belonging to another organisation.
      const cl = await db.query(
        "SELECT id FROM clients WHERE id = $1::uuid AND org_id = $2",
        [d.client_id, user.orgId],
      );
      if ((cl.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Client not found",
        });
      }
    }
    if (d.project_category_id) {
      const cat = await db.query(
        "SELECT id FROM project_categories WHERE id = $1::uuid AND org_id = $2",
        [d.project_category_id, user.orgId],
      );
      if ((cat.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project category not found",
        });
      }
    }
    const upd = await db.query(
      `UPDATE projects SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         priority = COALESCE($5, priority),
         planned_start_date = COALESCE($6, planned_start_date),
         planned_end_date = COALESCE($7, planned_end_date),
         status = COALESCE($8, status),
         project_kind = COALESCE($9, project_kind),
         client_id = COALESCE($10::uuid, client_id),
         project_category_id = COALESCE($11::uuid, project_category_id),
         contract_value = COALESCE($12, contract_value),
         contract_gst_included = COALESCE($13, contract_gst_included),
         contract_gst_rate = COALESCE($14, contract_gst_rate),
         work_order_number = COALESCE($15, work_order_number),
         updated_by = $16::uuid, updated_at = NOW(), version = version + 1
       WHERE id = $1::uuid AND org_id = $2 AND version = $17
       RETURNING ${PROJECT_COLS}`,
      [
        id,
        user.orgId,
        d.name ?? null,
        d.description ?? null,
        d.priority ?? null,
        d.planned_start_date ?? null,
        d.planned_end_date ?? null,
        d.status ?? null,
        d.project_kind ?? null,
        d.client_id ?? null,
        d.project_category_id ?? null,
        d.contract_value ?? null,
        d.contract_gst_included ?? null,
        d.contract_gst_rate ?? null,
        d.work_order_number ?? null,
        user.id,
        expectedVersion,
      ],
    );
    const row = upd.rows[0] as ProjectRow | undefined;
    if (!row) {
      const latest = await findProject(user.orgId, id);
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
      });
    }
    const body = toProjectShape(row);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "project.update",
      entityType: "project",
      entityId: row.id,
      beforeState: redactPiiForAudit(toProjectShape(cur)),
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});

  // ------------------------------------------------ POST /projects/:id/close
  app.post("/api/v1/projects/:id/close", { preHandler: canCloseProject }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = projectCloseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    await db.query('SELECT id FROM projects WHERE org_id=$1 AND id=$2 FOR UPDATE',[user.orgId,id]);
    const cur = await findProject(user.orgId, id);
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Project not found",
      });
    }
    if (cur.status === "CLOSED") {
      return reply.status(200).send(toProjectShape(cur));
    }
    if (cur.status === "CANCELLED") {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "INVALID_PROJECT_STATUS",
        message: "Cannot close a cancelled project",
        fieldErrors: [{ field: "status", message: "Project is CANCELLED" }],
      });
    }
    const counts = await taskCounts(cur.id);
    if (counts.open > 0) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "PROJECT_HAS_OPEN_TASKS",
        message: `Project has ${counts.open} open task(s); complete or cancel them first`,
        extra: { open_count: counts.open },
      });
    }
    const upd = await db.query(
      `UPDATE projects SET status = 'CLOSED', updated_by = $3::uuid,
         updated_at = NOW(), version = version + 1
       WHERE id = $1::uuid AND org_id = $2
       RETURNING ${PROJECT_COLS}`,
      [id, user.orgId, user.id],
    );
    const row = upd.rows[0] as ProjectRow;
    const body = toProjectShape(row);
    const meta = metaOf(req);
    const reason = parsed.data.reason?.trim() ? parsed.data.reason.trim() : null;
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "project.close",
      entityType: "project",
      entityId: row.id,
      beforeState: redactPiiForAudit(toProjectShape(cur)),
      afterState: redactPiiForAudit(body),
      reason,
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});

  // ------------------------------------------------ POST /tasks
  app.post("/api/v1/tasks", { preHandler: canCreateTask }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (await replayIfSeen(db, req, reply)) {
      return;
    }
    const parsed = taskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const d = parsed.data;
    await db.query('SELECT id FROM projects WHERE org_id=$1 AND id=$2 FOR UPDATE',[user.orgId,d.project_id]);
    const project = await findProject(user.orgId, d.project_id);
    if (!project) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Project not found",
      });
    }
    if(['CLOSED','CANCELLED'].includes(project.status))return sendError(reply,req.requestId,{status:409,code:'PROJECT_INACTIVE',message:'Tasks cannot be added to a closed project'});
    if (d.parent_task_id) {
      const parent = await findTask(user.orgId, d.parent_task_id);
      if (!parent || parent.project_id !== project.id) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "INVALID_PARENT",
          message: "Parent task must exist in the same project",
          fieldErrors: [
            { field: "parent_task_id", message: "Parent task must be in the same project" },
          ],
        });
      }
    }
    if (d.assignee_id) {
      const ok = await checkAssignee(reply, req.requestId, user.orgId, d.assignee_id);
      if (!ok) {
        return;
      }
    }
    if (d.village_id) {
      const ok = await checkVillage(reply, req.requestId, user.orgId, d.village_id);
      if (!ok) {
        return;
      }
    }
    const ins = await db.query(
      `INSERT INTO tasks
         (org_id, project_id, title, description, status, assignee_id,
          parent_task_id, village_id, planned_start_date, planned_end_date,
          priority, estimated_hours, board_position, created_by, updated_by)
       VALUES ($1, $2::uuid, $3, $4, 'TO_DO', $5::uuid, $6::uuid, $7::uuid,
         $8, $9, $10, $11, 0, $12::uuid, $12::uuid)
       RETURNING ${TASK_COLS}`,
      [
        user.orgId,
        project.id,
        d.title,
        d.description ?? null,
        d.assignee_id ?? null,
        d.parent_task_id ?? null,
        d.village_id ?? null,
        d.planned_start_date ?? null,
        d.planned_end_date ?? null,
        d.priority ?? "MEDIUM",
        d.estimated_hours ?? null,
        user.id,
      ],
    );
    const row = ins.rows[0] as TaskRow;
    const labelsByTask = await taskLabelsFor(db, [row.id]);
    const body = toTaskShape(row, labelsByTask.get(row.id) ?? []);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "task.create",
      entityType: "task",
      entityId: row.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(db, req, user.id, 201, body);
    return reply.status(201).send(body);
  
});});

  // ------------------------------------------------ GET /tasks
  app.get("/api/v1/tasks", { preHandler: canReadTask }, async (req, reply) => {
    const parsed = taskListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { limit, cursor, project_id, assignee_id, assignee_me, status, sla, q, label_ids } =
      parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    // PRD §4.1 scope enforcement: null-scope assignments see everything;
    // project|district|mandal|village|team assignments union-restrict rows.
    // Exception: an explicitly self-scoped query (own assigned tasks) always
    // sees the caller's work — geo/project scopes must not hide tasks that
    // lack a village or sit outside the caller's scope (Jira "my issues").
    const selfScoped =
      isTrueFlag(assignee_me) || (typeof assignee_id === "string" && assignee_id === user.id);
    const scopes = resolveScopes(user.scopes ?? []);
    if (!scopes.global && !selfScoped) {
      clauses.push(
        await taskScopeClause(opts.pool, user.orgId, scopes, values),
      );
    }
    if (project_id) {
      values.push(project_id);
      clauses.push(`project_id = $${values.length}::uuid`);
    }
    if (isTrueFlag(assignee_me)) {
      values.push(user.id);
      clauses.push(`assignee_id = $${values.length}::uuid`);
    } else if (assignee_id) {
      values.push(assignee_id);
      clauses.push(`assignee_id = $${values.length}::uuid`);
    }
    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (sla) {
      clauses.push(slaFilterClause(sla));
    }
    if (q) {
      values.push(`%${q}%`);
      clauses.push(
        `(title ILIKE $${values.length} OR description ILIKE $${values.length})`,
      );
    }
    if (label_ids) {
      const ids = label_ids
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s));
      if (ids.length > 0) {
        values.push(ids);
        clauses.push(
          `EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = tasks.id AND tl.label_id = ANY($${values.length}::uuid[]))`,
        );
      }
    }
    for(const key of ['cycle_id','priority'] as const){if(parsed.data[key]){values.push(parsed.data[key]);clauses.push(`${key}=$${values.length}`);}}
    if(parsed.data.due_from){values.push(parsed.data.due_from);clauses.push(`planned_end_date >= $${values.length}::date`);}
    if(parsed.data.due_to){values.push(parsed.data.due_to);clauses.push(`planned_end_date <= $${values.length}::date`);}
    /*
     * Actual dates are stamped in UTC by the status trigger; the filter is a
     * calendar day in India. Convert before comparing or a task finished at
     * 02:00 IST lands on the previous day for the person who finished it.
     */
    if(parsed.data.started_from){values.push(parsed.data.started_from);clauses.push(`(actual_start_at AT TIME ZONE 'Asia/Kolkata')::date >= $${values.length}::date`);}
    if(parsed.data.started_to){values.push(parsed.data.started_to);clauses.push(`(actual_start_at AT TIME ZONE 'Asia/Kolkata')::date <= $${values.length}::date`);}
    if(parsed.data.finished_from){values.push(parsed.data.finished_from);clauses.push(`(actual_end_at AT TIME ZONE 'Asia/Kolkata')::date >= $${values.length}::date`);}
    if(parsed.data.finished_to){values.push(parsed.data.finished_to);clauses.push(`(actual_end_at AT TIME ZONE 'Asia/Kolkata')::date <= $${values.length}::date`);}
    if(parsed.data.custom_fields){values.push(JSON.stringify(parsed.data.custom_fields));clauses.push(`custom_fields @> $${values.length}::jsonb`);}
    if(parsed.data.mentioned_me==='true'){values.push(user.id);clauses.push(`EXISTS(SELECT 1 FROM mentions m JOIN comments c ON c.id=m.comment_id WHERE c.task_id=tasks.id AND m.mentioned_user_id=$${values.length})`);}
    const sort=parsed.data.sort,sortExpression=sort==='due_asc'?"COALESCE(planned_end_date::text,'9999-12-31')":sort==='priority_desc'?"CASE priority WHEN 'URGENT' THEN '0' WHEN 'HIGH' THEN '1' WHEN 'MEDIUM' THEN '2' ELSE '3' END":"lower(title)";
    if(cursor&&sort!=='created_desc'){
      const decoded=decodeCursor<{id:string;sort:string;key:string}>(cursor);
      if(!decoded||decoded.sort!==sort||!z.string().uuid().safeParse(decoded.id).success||typeof decoded.key!=='string'||decoded.key.length>1000)return sendError(reply,req.requestId,{status:422,code:'VALIDATION_ERROR',message:'Invalid cursor for this sort'});
      values.push(decoded.key,decoded.id);clauses.push(`((${sortExpression}) COLLATE "C",id)>($${values.length-1}::text COLLATE "C",$${values.length}::uuid)`);
    }
    if (cursor&&sort==='created_desc') {
      const decoded = decodeCursor<PageCursor>(cursor);
      if (!decoded) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
          ],
        });
      }
      values.push(decoded.created_at, decoded.id);
      clauses.push(
        `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT ${TASK_COLS}${sort!=='created_desc'?`,(${sortExpression}) AS sort_key`:""} FROM tasks WHERE ${clauses.join(" AND ")}
       ORDER BY ${sort==='created_desc'?'created_at DESC,id DESC':`(${sortExpression}) COLLATE "C",id`} LIMIT $${values.length}`,
      values as string[],
    );
    const rows = res.rows as TaskRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const labelsByTask = await taskLabelsFor(
      opts.pool,
      page.map((r) => r.id),
    );
    const nextByTask = await allowedNextForTasks(page);
    return reply.status(200).send({
      data: page.map((r) => ({
        ...toTaskShape(r, labelsByTask.get(r.id) ?? []),
        allowed_next: nextByTask.get(r.id) ?? [],
      })),
      next_cursor:
        hasMore && last
          ? encodeCursor(sort==='created_desc'?{created_at:iso(last.created_at),id:last.id}:{sort,key:last.sort_key,id:last.id})
          : null,
      has_more: hasMore,
    });
  });

  /** Detail payload: bare task + subtasks + dependency refs + allowed_next. */
  async function toTaskDetail(row: TaskRow) {
    const project = await opts.pool.query(
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1::uuid`,
      [row.project_id],
    );
    const projectRow = project.rows[0] as ProjectRow | undefined;
    const workflow = projectRow
      ? await workflowForProject(projectRow)
      : defaultTaskWorkflow();
    const subs = await opts.pool.query(
      "SELECT id, title, status FROM tasks WHERE parent_task_id = $1::uuid ORDER BY created_at ASC, id ASC",
      [row.id],
    );
    const blockedBy = await opts.pool.query(
      `SELECT d.id AS dependency_id, t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.predecessor_id
       WHERE d.successor_id = $1::uuid ORDER BY d.created_at ASC, t.id ASC`,
      [row.id],
    );
    const blocking = await opts.pool.query(
      `SELECT d.id AS dependency_id, t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.successor_id
       WHERE d.predecessor_id = $1::uuid ORDER BY d.created_at ASC, t.id ASC`,
      [row.id],
    );
    const labelsByTask = await taskLabelsFor(opts.pool, [row.id]);
    /*
     * Everybody else working this task (§note 13).
     *
     * The owner stays on the task row and answers for it; these are the
     * people helping. Named here rather than as ids, because a list of
     * UUIDs is not an answer to "who is on this".
     */
    const collaborators = await opts.pool.query(
      `SELECT c.user_id, u.username,
              COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), u.username)
                AS name,
              e.emp_no, c.added_at
         FROM task_collaborators c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
        WHERE c.task_id = $1::uuid
        ORDER BY name`,
      [row.id],
    );
    return {
      ...toTaskShape(row, labelsByTask.get(row.id) ?? []),
      collaborators: collaborators.rows,
      subtasks: (subs.rows as TaskRef[]).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
      })),
      dependencies: {
        blocked_by: (blockedBy.rows as DependencyRef[]).map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          dependency_id: s.dependency_id,
        })),
        blocking: (blocking.rows as DependencyRef[]).map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          dependency_id: s.dependency_id,
        })),
      },
      allowed_next: allowedNext(workflow, row.status),
    };
  }

  /* ------------------------------------------ collaborators (§note 13) */

  /**
   * Put somebody else on a task.
   *
   * The owner stays the owner — the person the task is on, who answers for
   * it — and this is everybody else working it. Behind the same permission as
   * assigning, because deciding who works what is one decision whichever end
   * of it you are at.
   */
  app.post("/api/v1/tasks/:id/collaborators", { preHandler: canAssignTask },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const body = req.body as { user_id?: string };
      if (!body?.user_id || !/^[0-9a-f-]{36}$/i.test(body.user_id)) {
        return sendError(reply, req.requestId, {
          status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
          fieldErrors: [{ field: "user_id", message: "Choose somebody to add" }],
        });
      }
      const task = await findTask(user.orgId, id);
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404, code: "NOT_FOUND", message: "Task not found",
        });
      }
      if (String(task.assignee_id ?? "") === body.user_id) {
        return sendError(reply, req.requestId, {
          status: 409, code: "ALREADY_OWNER",
          message: "That person already owns this task, so they are already on it.",
        });
      }
      const person = (await opts.pool.query(
        "SELECT id FROM users WHERE id = $1::uuid AND org_id = $2 AND auth_status = 'ACTIVE'",
        [body.user_id, user.orgId],
      )).rows[0];
      if (!person) {
        return sendError(reply, req.requestId, {
          status: 422, code: "UNKNOWN_USER",
          message: "That account is not active in this organisation.",
        });
      }
      const added = await opts.pool.query(
        `INSERT INTO task_collaborators(org_id, task_id, user_id, added_by)
         VALUES($1,$2::uuid,$3::uuid,$4)
         ON CONFLICT (task_id, user_id) DO NOTHING
         RETURNING *`,
        [user.orgId, id, body.user_id, user.id],
      );
      if (!added.rowCount) {
        // Pressing the button twice is not a second kind of involvement.
        return reply.status(200).send({ data: { already: true } });
      }
      await writeAudit(opts.pool, {
        orgId: user.orgId, actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        action: "task.collaborator.add", entityType: "task", entityId: id,
        afterState: { user_id: body.user_id }, requestId: req.requestId,
      });
      return reply.status(201).send({ data: added.rows[0] });
    });

  app.delete("/api/v1/tasks/:id/collaborators/:userId", { preHandler: canAssignTask },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
        });
      }
      const { id, userId } = req.params as { id: string; userId: string };
      const gone = await opts.pool.query(
        `DELETE FROM task_collaborators
          WHERE org_id = $1 AND task_id = $2::uuid AND user_id = $3::uuid RETURNING *`,
        [user.orgId, id, userId],
      );
      if (!gone.rowCount) {
        return sendError(reply, req.requestId, {
          status: 404, code: "NOT_FOUND",
          message: "They are not on this task. Reload to see who is.",
        });
      }
      await writeAudit(opts.pool, {
        orgId: user.orgId, actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        action: "task.collaborator.remove", entityType: "task", entityId: id,
        beforeState: gone.rows[0], requestId: req.requestId,
      });
      return reply.status(200).send({ data: { removed: true } });
    });

  // ------------------------------------------------ GET /tasks/:id
  app.get("/api/v1/tasks/:id", { preHandler: canReadTask }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    const row = await findTask(user.orgId, id);
    if (!row) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Task not found",
      });
    }
    return reply.status(200).send(await toTaskDetail(row));
  });

  // ------------------------------------------------ PATCH /tasks/:id
  app.patch("/api/v1/tasks/:id", { preHandler: canUpdateTask }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if ("status" in raw) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "USE_STATUS_ENDPOINT",
        message: "Status moves only via PATCH /tasks/:id/status",
        fieldErrors: [
          { field: "status", message: "Use the status endpoint to change status" },
        ],
      });
    }
    if ("assignee_id" in raw || "assignee" in raw) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "USE_ASSIGN_ENDPOINT",
        message: "Assignee changes only via POST /tasks/:id/assign",
        fieldErrors: [
          { field: "assignee_id", message: "Use the assign endpoint to change assignee" },
        ],
      });
    }
    const parsed = taskPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const expectedVersion = parseIfMatch(req);
    const { id } = req.params as { id: string };
    const cur = await findTask(user.orgId, id);
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Task not found",
      });
    }
    // EMPLOYEE self-service (PRD §4): holders of task.update WITHOUT
    // task.assign (i.e. pure EMPLOYEEs, not TL/PM/ADMINs) may only update
    // tasks assigned to themselves.
    /*
     * The owner, or somebody put on it to help (§note 13).
     *
     * Being a collaborator has to mean being able to work the task, or it
     * means nothing at all — the whole point of adding somebody is that they
     * do some of it.
     */
    const isCollaborator = cur.assignee_id === user.id ? false : Boolean((await opts.pool.query(
      "SELECT 1 FROM task_collaborators WHERE task_id = $1::uuid AND user_id = $2::uuid",
      [cur.id, user.id],
    )).rowCount);
    if (!user.permissions.includes(T_ASSIGN)
      && cur.assignee_id !== user.id && !isCollaborator) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `That task belongs to somebody else. You can update a task assigned to you or one you have been added to; anything else needs the "task.assign" permission.`,
      });
    }
    if (cur.version !== expectedVersion) {
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${cur.version})`,
      });
    }
    const d = parsed.data;
    if (d.village_id) {
      const ok = await checkVillage(reply, req.requestId, user.orgId, d.village_id);
      if (!ok) {
        return;
      }
    }
    const upd = await db.query(
      `UPDATE tasks SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         priority = COALESCE($5, priority),
         planned_start_date = COALESCE($6, planned_start_date),
         planned_end_date = COALESCE($7, planned_end_date),
         estimated_hours = COALESCE($8, estimated_hours),
         village_id = COALESCE($9::uuid, village_id),
         updated_by = $10::uuid, updated_at = NOW(), version = version + 1
       WHERE id = $1::uuid AND org_id = $2 AND version = $11
       RETURNING ${TASK_COLS}`,
      [
        id,
        user.orgId,
        d.title ?? null,
        d.description ?? null,
        d.priority ?? null,
        d.planned_start_date ?? null,
        d.planned_end_date ?? null,
        d.estimated_hours ?? null,
        d.village_id ?? null,
        user.id,
        expectedVersion,
      ],
    );
    const row = upd.rows[0] as TaskRow | undefined;
    if (!row) {
      const latest = await findTask(user.orgId, id);
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
      });
    }
    const labelsByTask = await taskLabelsFor(db, [row.id]);
    const body = toTaskShape(row, labelsByTask.get(row.id) ?? []);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "task.update",
      entityType: "task",
      entityId: row.id,
      beforeState: redactPiiForAudit(toTaskShape(cur)),
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});

  // ------------------------------------------------ PATCH /tasks/:id/status
  app.patch(
    "/api/v1/tasks/:id/status",
    { preHandler: canTransitionTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskStatusChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const expectedVersion = parseIfMatch(req);
      const { id } = req.params as { id: string };
      const snapshot = await findTask(user.orgId, id);
      // All task lifecycle and project planning changes lock project before task.
      if(snapshot)await db.query('SELECT id FROM projects WHERE id=$1 AND org_id=$2 FOR UPDATE',[snapshot.project_id,user.orgId]);
      const cur=(await db.query(`SELECT ${TASK_COLS},custom_fields FROM tasks WHERE id=$1 AND org_id=$2 FOR UPDATE`,[id,user.orgId])).rows[0] as (TaskRow & {custom_fields:Record<string,unknown>})|undefined;
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      if (cur.version !== expectedVersion) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${cur.version})`,
        });
      }
      const { status: target, override, override_reason } = parsed.data;
      const projectRes = await db.query(
        `SELECT ${PROJECT_COLS} FROM projects WHERE id = $1::uuid`,
        [cur.project_id],
      );
      const projectRow = projectRes.rows[0] as ProjectRow | undefined;
      const workflow = projectRow
        ? await workflowForProject(projectRow,db)
        : defaultTaskWorkflow();
      const next = allowedNext(workflow, cur.status);
      if (target !== cur.status && !next.includes(target)) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "INVALID_TRANSITION",
          message: `Cannot transition task from ${cur.status} to ${target}`,
          fieldErrors: [
            { field: "status", message: `Invalid transition from ${cur.status}` },
          ],
          extra: { allowed_next: next },
        });
      }

      // DONE requires every direct subtask to be terminal.
      if (target === "DONE") {
        const openSubs = await db.query(
          `SELECT id FROM tasks
           WHERE parent_task_id = $1::uuid AND status NOT IN ('DONE', 'CANCELLED')
           ORDER BY created_at ASC, id ASC`,
          [cur.id],
        );
        if ((openSubs.rowCount ?? 0) > 0) {
          return sendRuleError(reply, req.requestId, {
            status: 422,
            code: "SUBTASKS_OPEN",
            message: "Task has open subtasks; complete or cancel them first",
            extra: {
              open_subtask_ids: (openSubs.rows as Array<{ id: string }>).map(
                (r) => r.id,
              ),
            },
          });
        }
      }

      // Gated statuses require FINISH_TO_START predecessors to be DONE,
      // unless overridden by a project.update holder with a reason.
      let overridden = false;
      if (
        !["TO_DO", "BLOCKED", "CANCELLED"].includes(target) &&
        target !== cur.status
      ) {
        const blocking = await db.query(
          `SELECT t.id FROM task_dependencies d
           JOIN tasks t ON t.id = d.predecessor_id
           WHERE d.successor_id = $1::uuid
             AND d.dependency_type = 'FINISH_TO_START'
             AND t.status <> 'DONE'
           ORDER BY t.created_at ASC, t.id ASC`,
          [cur.id],
        );
        const blockingIds = (blocking.rows as Array<{ id: string }>).map(
          (r) => r.id,
        );
        if (blockingIds.length > 0) {
          const reason = override_reason?.trim() ? override_reason.trim() : null;
          if (!override) {
            return sendRuleError(reply, req.requestId, {
              status: 422,
              code: "DEPENDENCY_BLOCKED",
              message: "Incomplete predecessor dependencies block this transition",
              extra: { blocking: blockingIds },
            });
          }
          if (!user.permissions.includes(P_UPDATE)) {
            return sendError(reply, req.requestId, {
              status: 403,
              code: "FORBIDDEN",
              message:
                `Changing a project needs the "project.update" permission. An administrator can add it to your role under Administration \u2192 Roles.`,
            });
          }
          if (!reason) {
            return sendRuleError(reply, req.requestId, {
              status: 422,
              code: "OVERRIDE_REASON_REQUIRED",
              message: "override_reason is required when overriding dependencies",
              fieldErrors: [
                { field: "override_reason", message: "A reason is required to override" },
              ],
            });
          }
          overridden = true;
        }
      }

      if(target!==cur.status && !["TO_DO","BLOCKED","CANCELLED"].includes(target))await validateCustomFields(db,cur.project_id,user.orgId,cur.custom_fields);
      const upd = await db.query(
        `UPDATE tasks SET status = $3, updated_by = $4::uuid,
           updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2 AND version = $5
         RETURNING ${TASK_COLS}`,
        [id, user.orgId, target, user.id, expectedVersion],
      );
      const row = upd.rows[0] as TaskRow | undefined;
      if (!row) {
        const latest = await findTask(user.orgId, id);
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
        });
      }
      const labelsByTask = await taskLabelsFor(db, [row.id]);
      const body = toTaskShape(row, labelsByTask.get(row.id) ?? []);
      const meta = metaOf(req);
      const reason = override_reason?.trim() ? override_reason.trim() : null;
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: overridden ? "task.status.override" : "task.status.change",
        entityType: "task",
        entityId: row.id,
        beforeState: redactPiiForAudit(toTaskShape(cur)),
        afterState: redactPiiForAudit(body),
        reason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  // ------------------------------------------------ PATCH /tasks/:id/board-position
  app.patch(
    "/api/v1/tasks/:id/board-position",
    { preHandler: canReorderTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskBoardPositionSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const expectedVersion = parseIfMatch(req);
      const { id } = req.params as { id: string };
      const cur = await findTask(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      if (cur.version !== expectedVersion) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${cur.version})`,
        });
      }
      const upd = await db.query(
        `UPDATE tasks SET board_position = $3, updated_by = $4::uuid,
           updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2 AND version = $5
         RETURNING ${TASK_COLS}`,
        [id, user.orgId, parsed.data.board_position, user.id, expectedVersion],
      );
      const row = upd.rows[0] as TaskRow | undefined;
      if (!row) {
        const latest = await findTask(user.orgId, id);
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
        });
      }
      const labelsByTask = await taskLabelsFor(db, [row.id]);
      const body = toTaskShape(row, labelsByTask.get(row.id) ?? []);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.reorder",
        entityType: "task",
        entityId: row.id,
        beforeState: redactPiiForAudit(toTaskShape(cur)),
        afterState: redactPiiForAudit(body),
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  // ------------------------------------------------ POST /tasks/:id/assign
  app.post(
    "/api/v1/tasks/:id/assign",
    { preHandler: canAssignTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskAssignSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findTask(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      /*
       * Work on a closed or cancelled project is finished work (BR-02).
       * Creating a task there is already refused; handing an existing one to
       * somebody reopened it by the side door, and put it on their list for
       * a project nobody is running. Read under a share lock so a close
       * landing at the same moment cannot slip between the check and the
       * write.
       */
      const project = (await db.query(
        "SELECT status FROM projects WHERE id = $1::uuid AND org_id = $2 FOR SHARE",
        [cur.project_id, user.orgId],
      )).rows[0] as { status: string } | undefined;
      if (project && ["CLOSED", "CANCELLED"].includes(project.status)) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "PROJECT_INACTIVE",
          message: `This project is ${project.status.toLowerCase()}, so its tasks cannot be reassigned. `
            + "Reopen the project first if the work is not finished.",
        });
      }
      const ok = await checkAssignee(
        reply,
        req.requestId,
        user.orgId,
        parsed.data.assignee_id,
      );
      if (!ok) {
        return;
      }
      const reason = parsed.data.reason.trim();
      const upd = await db.query(
        `UPDATE tasks SET assignee_id = $3::uuid, updated_by = $4::uuid,
           updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${TASK_COLS}`,
        [id, user.orgId, parsed.data.assignee_id, user.id],
      );
      const row = upd.rows[0] as TaskRow;
      const labelsByTask = await taskLabelsFor(db, [row.id]);
      const body = toTaskShape(row, labelsByTask.get(row.id) ?? []);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.assign",
        entityType: "task",
        entityId: row.id,
        beforeState: redactPiiForAudit(toTaskShape(cur)),
        afterState: redactPiiForAudit(body),
        reason,
        requestId: req.requestId,
      });
      // S5 inbox (best-effort): TASK_ASSIGNED to the new assignee. Titles and
      // bodies use usernames only — never aadhaar/bank or other PII.
      await emitNotification(db, {
        orgId: user.orgId,
        recipientId: parsed.data.assignee_id,
        type: "TASK_ASSIGNED",
        title: "You were assigned a task",
        body: `${user.username} assigned task '${row.title}' to you`,
        entityType: "task",
        entityId: row.id,
      });
      return reply.status(200).send(body);
    
});},
  );

  /**
   * True when adding predecessor→successor would close a dependency cycle
   * (i.e. the successor already reaches the predecessor downstream).
   */
  async function wouldCycle(
    db: Pick<Pool, "query">,
    projectId: string,
    predecessorId: string,
    successorId: string,
  ): Promise<boolean> {
    // Read in the caller's transaction, after it has locked the project: a
    // read through the pool sees neither the lock nor anything the
    // transaction has written.
    const res = await db.query(
      `SELECT d.predecessor_id, d.successor_id FROM task_dependencies d
       JOIN tasks t ON t.id = d.successor_id
       WHERE t.project_id = $1::uuid`,
      [projectId],
    );
    const adj = new Map<string, string[]>();
    for (const r of res.rows as Array<{
      predecessor_id: string;
      successor_id: string;
    }>) {
      const list = adj.get(r.predecessor_id) ?? [];
      list.push(r.successor_id);
      adj.set(r.predecessor_id, list);
    }
    const seen = new Set<string>([successorId]);
    const stack = [successorId];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const nxt of adj.get(cur) ?? []) {
        if (nxt === predecessorId) {
          return true;
        }
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  }

  // ------------------------------------------------ POST /tasks/:id/dependencies
  app.post(
    "/api/v1/tasks/:id/dependencies",
    { preHandler: canUpdateTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskDependencyCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const successor = await findTask(user.orgId, id);
      if (!successor) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const { predecessor_id, dependency_type } = parsed.data;
      if (predecessor_id === successor.id) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "SELF_DEPENDENCY",
          message: "A task cannot depend on itself",
          fieldErrors: [
            { field: "predecessor_id", message: "A task cannot depend on itself" },
          ],
        });
      }
      const predecessor = await findTask(user.orgId, predecessor_id);
      if (!predecessor) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Predecessor task not found",
        });
      }
      if (predecessor.project_id !== successor.project_id) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "INVALID_DEPENDENCY",
          message: "Dependencies must stay within the same project",
          fieldErrors: [
            {
              field: "predecessor_id",
              message: "Predecessor must be in the same project",
            },
          ],
        });
      }
      /*
       * The project row is the lock the whole graph hangs off (WORK-18).
       *
       * The cycle check reads every edge in the project and then inserts one.
       * Two requests adding A->B and B->A at the same moment each read a
       * graph without the other's edge, each found no cycle, and both
       * committed one. Serialising edge additions per project makes the
       * second read see the first edge.
       */
      await db.query(
        "SELECT id FROM projects WHERE id = $1::uuid AND org_id = $2 FOR UPDATE",
        [successor.project_id, user.orgId],
      );
      if (await wouldCycle(db, successor.project_id, predecessor_id, successor.id)) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "DEPENDENCY_CYCLE",
          message: "This dependency would create a cycle",
          fieldErrors: [
            { field: "predecessor_id", message: "Dependency would create a cycle" },
          ],
        });
      }
      let dep: DependencyRow;
      try {
        const ins = await db.query(
          `INSERT INTO task_dependencies
             (predecessor_id, successor_id, dependency_type, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
           RETURNING id, predecessor_id, successor_id, dependency_type, created_at`,
          [predecessor_id, successor.id, dependency_type, user.id],
        );
        dep = ins.rows[0] as DependencyRow;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          return sendError(reply, req.requestId, {
            status: 409,
            code: "CONFLICT",
            message: "Dependency already exists",
          });
        }
        throw err;
      }
      const body = toDependencyShape(dep);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.dependency.add",
        entityType: "task_dependency",
        entityId: dep.id,
        afterState: redactPiiForAudit(body),
        requestId: req.requestId,
      });
      return reply.status(201).send(body);
    
});},
  );

  // ------------------------------------------------ DELETE /tasks/:id/dependencies/:depId
  app.delete(
    "/api/v1/tasks/:id/dependencies/:depId",
    { preHandler: canUpdateTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id, depId } = req.params as { id: string; depId: string };
      const successor = await findTask(user.orgId, id);
      if (!successor) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const existing = await db.query(
        `SELECT d.id FROM task_dependencies d
         JOIN tasks t ON t.id = d.successor_id
         WHERE d.id = $1::uuid AND d.successor_id = $2::uuid AND t.org_id = $3`,
        [depId, successor.id, user.orgId],
      );
      if ((existing.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Dependency not found",
        });
      }
      await db.query("DELETE FROM task_dependencies WHERE id = $1::uuid", [
        depId,
      ]);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.dependency.remove",
        entityType: "task_dependency",
        entityId: depId,
        requestId: req.requestId,
      });
      return reply.status(204).send();
    
});},
  );

  // ------------------------------------------------ POST /tasks/:id/evidence
  app.post(
    "/api/v1/tasks/:id/evidence",
    { preHandler: canUpdateTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskEvidenceUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const task = await findTask(user.orgId, id);
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const { evidence_type, file_name, content_base64 } = parsed.data;
      const ext = file_name.split(".").pop()?.toLowerCase() ?? "";
      if (
        !file_name.includes(".") ||
        !(ALLOWED_EVIDENCE_EXTENSIONS as readonly string[]).includes(ext)
      ) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            {
              field: "file_name",
              message: `Only ${ALLOWED_EVIDENCE_EXTENSIONS.join(", ")} files are allowed`,
            },
          ],
        });
      }
      const binary = decodeBase64Strict(content_base64);
      if (binary.length > MAX_EVIDENCE_BYTES) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "File exceeds the 5MB limit",
          fieldErrors: [
            { field: "content_base64", message: "File exceeds the 5MB limit" },
          ],
        });
      }
      await scanUpload(binary,ext,app.appConfig.nodeEnv==='production');
      const checksum = createHash("sha256").update(binary).digest("hex");
      const docIdRes = await db.query("SELECT gen_random_uuid() AS id");
      const docId = (docIdRes.rows[0] as { id: string }).id;
      const ins = await db.query(
        `INSERT INTO task_evidence
           (id, org_id, task_id, evidence_type, file_name, content_encrypted,
            file_size, mime_type, checksum, created_by)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid)
         RETURNING id, evidence_type, file_name, file_size, checksum, created_at`,
        [
          docId,
          user.orgId,
          id,
          evidence_type,
          file_name,
          encodeBlob(binary),
          binary.length,
          MIME_BY_EXT[ext] ?? "application/octet-stream",
          checksum,
          user.id,
        ],
      );
      const row = ins.rows[0] as EvidenceRow;
      const body = toEvidenceShape(row);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.evidence.upload",
        entityType: "task_evidence",
        entityId: row.id,
        afterState: body,
        requestId: req.requestId,
      });
      return reply.status(201).send(body);
    
});},
  );

  app.get('/api/v1/tasks/:id/evidence/:evidenceId/download',{preHandler:canReadTask},async(req,reply)=>{
    const {id,evidenceId}=req.params as {id:string;evidenceId:string},user=req.authUser!;
    const result=await opts.pool.query('SELECT * FROM task_evidence WHERE id=$1 AND task_id=$2 AND org_id=$3',[evidenceId,id,user.orgId]);
    const row=result.rows[0];if(!row)throw new ApiError({status:404,code:'NOT_FOUND',message:'Evidence not found'});
    const content=await readBlob(row);
    if(!content)throw new ApiError({status:404,code:'NOT_FOUND',message:'Evidence content is no longer available'});
    await writeAudit(opts.pool,{orgId:user.orgId,actorId:user.id,action:'task.evidence.download',entityType:'task_evidence',entityId:evidenceId,requestId:req.requestId});
    return reply.header('Content-Type',row.mime_type).header('X-Content-Type-Options','nosniff').header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(row.file_name)).send(content);
  });

  // ------------------------------------------------ GET /tasks/:id/evidence
  app.get(
    "/api/v1/tasks/:id/evidence",
    { preHandler: canReadTask },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const task = await findTask(user.orgId, id);
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const res = await opts.pool.query(
        `SELECT id, evidence_type, file_name, file_size, checksum, created_at
         FROM task_evidence
         WHERE task_id = $1::uuid
         ORDER BY created_at DESC, id DESC`,
        [id],
      );
      return reply
        .status(200)
        .send({ data: (res.rows as EvidenceRow[]).map(toEvidenceShape) });
    },
  );

  // ------------------------------------------------ POST /tasks/:id/comments
  app.post(
    "/api/v1/tasks/:id/comments",
    { preHandler: canCommentTask },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskCommentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const task = await findTask(user.orgId, id);
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const body = parsed.data.body;
      const ins = await db.query(
        `INSERT INTO comments (org_id, task_id, author_user_id, body)
         VALUES ($1, $2::uuid, $3::uuid, $4)
         RETURNING id, author_user_id, body, created_at`,
        [user.orgId, id, user.id, body],
      );
      const commentId = (ins.rows[0] as { id: string }).id;

      // @username tokens → mention rows for matching org users; unknown ignored.
      const tokens = extractMentionUsernames(body);
      let mentionedUsernames: string[] = [];
      if (tokens.length > 0) {
        const matched = await db.query(
          "SELECT id, username FROM users WHERE org_id = $1 AND username = ANY($2)",
          [user.orgId, tokens],
        );
        const rows = matched.rows as Array<{ id: string; username: string }>;
        for (const m of rows) {
          await db.query(
            `INSERT INTO mentions (comment_id, mentioned_user_id)
             VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
            [commentId, m.id],
          );
        }
        mentionedUsernames = rows.map((m) => m.username).sort();
        // S5 inbox (best-effort): MENTION for each mentioned user except a
        // self-mention. Usernames only — never PII.
        for (const m of rows) {
          if (m.id === user.id) {
            continue;
          }
          await emitNotification(db, {
            orgId: user.orgId,
            recipientId: m.id,
            type: "MENTION",
            title: "You were mentioned in a task comment",
            body: `${user.username} mentioned you in task '${task.title}'`,
            entityType: "comment",
            entityId: commentId,
          });
        }
      }

      const detail = (
        await db.query(
          `SELECT c.id, c.author_user_id, u.username AS author_username,
             c.body, c.created_at
           FROM comments c
           LEFT JOIN users u ON u.id = c.author_user_id
           WHERE c.id = $1::uuid`,
          [commentId],
        )
      ).rows[0] as CommentRow;
      const payload = {
        comment: toCommentShape(detail),
        mentioned_usernames: mentionedUsernames,
      };
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.comment.create",
        entityType: "comment",
        entityId: commentId,
        afterState: redactPiiForAudit(payload),
        requestId: req.requestId,
      });
      return reply.status(201).send(payload);
    
});},
  );

  // ------------------------------------------------ GET /tasks/:id/comments
  app.get(
    "/api/v1/tasks/:id/comments",
    { preHandler: canReadTask },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const task = await findTask(user.orgId, id);
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const res = await opts.pool.query(
        `SELECT c.id, c.author_user_id, u.username AS author_username,
           c.body, c.created_at
         FROM comments c
         LEFT JOIN users u ON u.id = c.author_user_id
         WHERE c.task_id = $1::uuid
         ORDER BY c.created_at ASC, c.id ASC`,
        [id],
      );
      return reply
        .status(200)
        .send({ data: (res.rows as CommentRow[]).map(toCommentShape) });
    },
  );
}
