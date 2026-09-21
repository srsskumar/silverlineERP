import { ApiClientError, apiRequest, apiRequestRaw } from './apiClient';

/**
 * S4 tasks client (frozen contract).
 *
 *   POST /api/v1/tasks {project_id,title,...} (title-only ok) → 201 TO_DO
 *   GET  /api/v1/tasks?project_id=&assignee_id=&assignee_me=&status=&q=
 *   GET  /api/v1/tasks/:id → {task, subtasks[], dependencies:{blocked_by,blocking}, allowed_next[]}
 *   PATCH /api/v1/tasks/:id fields (no status) + If-Match
 *   PATCH /api/v1/tasks/:id/status {status} → 200 | 422
 *     INVALID_TRANSITION {allowed_next} / SUBTASKS_OPEN / DEPENDENCY_BLOCKED {blocking} / USE_STATUS_ENDPOINT
 *     (override flow NOT in web S4 — the UI tells the user to ask their PM)
 *   PATCH /api/v1/tasks/:id/board-position — NOT in web S4 (S5)
 *   POST /api/v1/tasks/:id/assign {assignee_id,reason} (reason required)
 *   POST /api/v1/tasks/:id/dependencies {predecessor_id} / DELETE /:id/dependencies/:depId
 *   POST+GET /api/v1/tasks/:id/evidence {evidence_type,file_name,content_base64} (5MB client check, base64)
 *   POST+GET /api/v1/tasks/:id/comments {body} → {comment,mentioned_usernames[]}
 *
 * Task statuses: TO_DO/IN_PROGRESS/IN_REVIEW/DONE/BLOCKED/CANCELLED
 * (terminal: DONE/CANCELLED). List responses tolerate `{data:[]}` envelopes
 * and bare arrays; singles tolerate `{data:{...}}` and bare (S1–S3 pattern).
 * There is NO users endpoint in S4 — assignee inputs are user-ID (UUID) text
 * fields (see README gap note). Do NOT invent endpoints.
 */

export type TaskStatus =
  | 'TO_DO'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'DONE'
  | 'BLOCKED'
  | 'CANCELLED';

export interface TaskLabelRef {
  id: string;
  name: string;
  color?: string | null;
  [key: string]: unknown;
}

export type SlaStatusValue = 'ON_SCHEDULE' | 'AT_RISK' | 'OVERDUE';

export interface Task {
  id: string;
  project_id: string;
  parent_id?: string | null;
  title: string;
  description?: string | null;
  status: TaskStatus | string;
  assignee_id?: string | null;
  priority?: string | null;
  version: number;
  /** S5: labels attached to the task (may be absent on older rows). */
  labels?: TaskLabelRef[];
  /** S5: schedule health computed server-side (may be absent until S5 lands). */
  sla_status?: SlaStatusValue | string | null;
  /**
   * Statuses this task may move to, resolved server-side against the project's
   * workflow. Optional because older API builds omitted it on list rows; a
   * caller that finds it absent must fall back to attempting the transition
   * rather than blocking a legitimate move.
   */
  allowed_next?: string[];
  [key: string]: unknown;
}

export interface DependencyEdge {
  id?: string;
  /** Edge row id (server: dependency_id) — the correct :depId for DELETE. */
  dependency_id?: string;
  predecessor_id?: string;
  successor_id?: string;
  task_id?: string;
  title?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface TaskDependencies {
  blocked_by: DependencyEdge[];
  blocking: DependencyEdge[];
}

export interface TaskDetailData {
  task: Task;
  subtasks: Task[];
  dependencies: TaskDependencies;
  allowed_next: string[];
}

export interface TaskComment {
  id: string;
  author_user_id: string;
  author_username: string;
  body: string;
  created_at: string;
  [key: string]: unknown;
}

export interface TaskEvidence {
  id: string;
  evidence_type: string;
  file_name: string;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface PostCommentResult {
  comment: TaskComment;
  mentioned_usernames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip one `{data:...}` envelope level when the apiClient has not already done so. */
function denest(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

function asArray(body: unknown): unknown[] {
  const raw = denest(body);
  return Array.isArray(raw) ? raw : [];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeTasksPage(body: unknown): Task[] {
  return asArray(body).map((item) => {
    try {
      return normalizeTask(item);
    } catch {
      return item as Task;
    }
  });
}

/** Normalize a single task payload (bare object, possibly enveloped). */
export function normalizeTask(body: unknown): Task {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') {
    // Server names it parent_task_id; UI reads parent_id — bridge both.
    if (raw.parent_id == null && typeof raw.parent_task_id === 'string') {
      return { ...raw, parent_id: raw.parent_task_id } as unknown as Task;
    }
    return raw as unknown as Task;
  }
  throw new Error('Unrecognized task shape');
}

function asEdges(value: unknown): DependencyEdge[] {
  return Array.isArray(value) ? (value as DependencyEdge[]) : [];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/**
 * Normalize GET /tasks/:id. Tolerates `{task,subtasks,dependencies,allowed_next}`,
 * one `{data:...}` envelope level, and missing keys (defaulted to []).
 */
export function normalizeTaskDetail(body: unknown): TaskDetailData {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized task-detail shape');
  const taskRaw = isRecord(raw.task) ? raw.task : raw;
  if (!isRecord(taskRaw) || typeof taskRaw.id !== 'string') {
    throw new Error('Unrecognized task-detail shape');
  }
  const deps = isRecord(raw.dependencies) ? raw.dependencies : {};
  return {
    task: taskRaw as unknown as Task,
    subtasks: asArray(raw.subtasks) as Task[],
    dependencies: {
      blocked_by: asEdges((deps as Record<string, unknown>).blocked_by),
      blocking: asEdges((deps as Record<string, unknown>).blocking),
    },
    allowed_next: asStringArray(raw.allowed_next),
  };
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeComments(body: unknown): TaskComment[] {
  return asArray(body) as TaskComment[];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeEvidenceList(body: unknown): TaskEvidence[] {
  return asArray(body) as TaskEvidence[];
}

/**
 * Normalize POST /tasks/:id/comments responses:
 * `{comment, mentioned_usernames[]}`, tolerating one envelope level and a
 * missing `mentioned_usernames` (defaults to []).
 */
export function normalizePostCommentResponse(body: unknown): PostCommentResult {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized post-comment response shape');
  const commentRaw = isRecord(raw.comment) ? raw.comment : raw;
  if (!isRecord(commentRaw) || typeof commentRaw.id !== 'string') {
    throw new Error('Unrecognized post-comment response shape');
  }
  return {
    comment: commentRaw as unknown as TaskComment,
    mentioned_usernames: asStringArray(raw.mentioned_usernames),
  };
}

export interface ListTasksParams {
  sort?:string;
  cycle_id?:string;
  due_from?:string;
  due_to?:string;
  /*
   * When the work actually began and ended, as opposed to when it was planned
   * to. "What did we finish in August" is a question about these, and
   * answering it off planned dates reports a plan as a record.
   */
  started_from?:string;
  started_to?:string;
  finished_from?:string;
  finished_to?:string;
  priority?:string;
  mentioned_me?:string;
  custom_fields?:Record<string,unknown>;
  project_id?: string;
  assignee_id?: string;
  assignee_me?: string;
  status?: string;
  q?: string;
  /** S5: lowercase filter overdue|at_risk|on_schedule. */
  sla?: string;
  /** S5: label filter — serialized comma-joined. */
  label_ids?: string[] | string;
  limit?: number;
  cursor?: string | null;
}

export interface TasksCursorPage {
  tasks: Task[];
  next_cursor: string | null;
  has_more: boolean;
  request_id?: string;
}

/** Normalize a cursor page tolerating `{data,next_cursor,has_more}` and bare arrays. */
export function normalizeTasksCursorPage(body: unknown): TasksCursorPage {
  if (Array.isArray(body)) {
    return { tasks: normalizeTasksPage(body), next_cursor: null, has_more: false };
  }
  if (isRecord(body)) {
    const rec = body as Record<string, unknown>;
    const nested = 'data' in rec ? rec.data : undefined;
    const rows = Array.isArray(nested) ? nested : [];
    const inner = isRecord(nested) ? (nested as Record<string, unknown>) : null;
    const nextCursor =
      typeof rec.next_cursor === 'string'
        ? rec.next_cursor
        : inner && typeof inner.next_cursor === 'string'
          ? (inner.next_cursor as string)
          : null;
    const hasMore = rec.has_more === true || (inner ? inner.has_more === true : false);
    return {
      tasks: normalizeTasksPage(rows),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }
  return { tasks: [], next_cursor: null, has_more: false };
}

export function buildTasksQuery(params: ListTasksParams = {}): string {
  const search = new URLSearchParams();
  for(const key of ['cycle_id','due_from','due_to','started_from','started_to','finished_from','finished_to','priority','mentioned_me','sort'] as const)if(params[key])search.set(key,params[key]!);
  if(params.custom_fields&&Object.keys(params.custom_fields).length)search.set('custom_fields',JSON.stringify(params.custom_fields));
  if (params.project_id) search.set('project_id', params.project_id);
  if (params.assignee_id) search.set('assignee_id', params.assignee_id);
  if (params.assignee_me) search.set('assignee_me', params.assignee_me);
  if (params.status) search.set('status', params.status);
  if (params.q) search.set('q', params.q);
  if (params.sla) search.set('sla', params.sla);
  if (params.label_ids !== undefined) {
    const joined = Array.isArray(params.label_ids) ? params.label_ids.join(',') : params.label_ids;
    if (joined) search.set('label_ids', joined);
  }
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/tasks${qs ? `?${qs}` : ''}`;
}

export async function listTasks(params: ListTasksParams = {}): Promise<Task[]> {
  const { data } = await apiRequest<unknown>(buildTasksQuery(params), { method: 'GET' });
  return normalizeTasksPage(data);
}

/** Cursor-preserving variant (kanban "load more", my-work sections). */
export async function listTasksPage(params: ListTasksParams = {}): Promise<TasksCursorPage> {
  const raw = await apiRequestRaw(buildTasksQuery(params), { method: 'GET' });
  return { ...normalizeTasksCursorPage(raw.body), request_id: raw.requestId };
}

/**
 * S5 board-position reorder (assumed shape — see README S5 notes).
 * PATCH /api/v1/tasks/:id/board-position {position, board_id?, column_id?}
 * + If-Match when a version is supplied; 409 → caller refetches.
 */
export async function patchTaskBoardPosition(
  id: string,
  input: { position: number; board_id?: string; column_id?: string },
  version?: number | string,
): Promise<Task> {
  const headers: Record<string, string> = {};
  if (version !== undefined) headers['If-Match'] = String(version);
  // Server shape is {board_position} (shared taskBoardPositionSchema);
  // board_id/column_id are accepted by the caller for future use and dropped.
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(id)}/board-position`,
    { method: 'PATCH', headers, body: { board_position: input.position } },
  );
  return normalizeTask(data);
}

export async function createTask(input: Record<string, unknown>): Promise<Task> {
  const { data } = await apiRequest<unknown>('/api/v1/tasks', {
    method: 'POST',
    body: input,
  });
  return normalizeTask(data);
}

export async function getTask(id: string): Promise<TaskDetailData> {
  const { data } = await apiRequest<unknown>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeTaskDetail(data);
}

/** PATCH task fields (no status — use transitionTask) + If-Match versioning. */
export async function patchTask(
  id: string,
  patch: Record<string, unknown>,
  version: number | string,
): Promise<Task> {
  const { data } = await apiRequest<unknown>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch,
  });
  return normalizeTask(data);
}

export async function transitionTask(
  id: string,
  status: string,
  version?: number | string,
  /** Moving past unfinished predecessors: project.update and a reason. */
  override?: { override: true; override_reason: string },
): Promise<Task> {
  const headers: Record<string, string> = {};
  // The status endpoint requires If-Match (optimistic concurrency); without
  // it every call 422s with a generic "Validation failed".
  if (version !== undefined) headers['If-Match'] = String(version);
  const { data } = await apiRequest<unknown>(`/api/v1/tasks/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers,
    body: { status, ...(override ?? {}) },
  });
  return normalizeTask(data);
}

export async function assignTask(
  id: string,
  input: { assignee_id: string; reason: string },
): Promise<Task> {
  const { data } = await apiRequest<unknown>(`/api/v1/tasks/${encodeURIComponent(id)}/assign`, {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeTask(data);
}

export async function addDependency(id: string, predecessor_id: string): Promise<unknown> {
  const { data } = await apiRequest<unknown>(`/api/v1/tasks/${encodeURIComponent(id)}/dependencies`, {
    method: 'POST',
    body: { predecessor_id },
  });
  return data;
}

export async function removeDependency(id: string, depId: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(depId)}`,
    { method: 'DELETE' },
  );
}

export async function listEvidence(taskId: string): Promise<TaskEvidence[]> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/evidence`,
    { method: 'GET' },
  );
  return normalizeEvidenceList(data);
}

export async function uploadEvidence(
  taskId: string,
  input: { evidence_type: string; file_name: string; content_base64: string },
): Promise<TaskEvidence> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/evidence`,
    { method: 'POST', body: input as unknown as Record<string, unknown> },
  );
  const raw = denest(data);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as TaskEvidence;
  throw new Error('Unrecognized evidence-upload response shape');
}

export async function listComments(taskId: string): Promise<TaskComment[]> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
    { method: 'GET' },
  );
  return normalizeComments(data);
}

export async function postComment(taskId: string, body: string): Promise<PostCommentResult> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/comments`,
    { method: 'POST', body: { body } },
  );
  return normalizePostCommentResponse(data);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const taskStatusBadgeTone: Record<string, 'warning' | 'success' | 'danger' | 'neutral' | 'info'> = {
  TO_DO: 'neutral',
  IN_PROGRESS: 'info',
  IN_REVIEW: 'warning',
  DONE: 'success',
  BLOCKED: 'danger',
  CANCELLED: 'neutral',
};

export function toneForTaskStatus(
  status: string,
): 'warning' | 'success' | 'danger' | 'neutral' | 'info' {
  return taskStatusBadgeTone[status] ?? 'neutral';
}

/** Terminal task states — DONE/CANCELLED tasks accept no further transitions. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === 'DONE' || status === 'CANCELLED';
}

export type BoardMoveCheck =
  | { allowed: true }
  | { allowed: false; reason: string; allowedNext: string[] };

/**
 * Whether the board may move a task to `toStatus` without asking the server.
 *
 * The board renders a column per workflow status, including the terminal ones,
 * because finished work still has to be visible. That makes every column a drop
 * target, so a card could be dragged out of Done, move optimistically, fail
 * with a 422 and snap back — a move that appeared to work and then silently
 * undid itself.
 *
 * `allowed_next` is resolved server-side from the project's workflow and is now
 * returned on list rows. It is optional: an older API build, or a page cached
 * from before it was added, omits it. Treat absence as "let the server decide"
 * rather than blocking a legitimate move.
 */
export function canMoveTaskTo(task: Task, toStatus: string): BoardMoveCheck {
  const allowedNext = task.allowed_next;
  if (!allowedNext) return { allowed: true };
  if (allowedNext.includes(toStatus)) return { allowed: true };
  const from = String(task.status);
  return {
    allowed: false,
    allowedNext,
    reason: isTerminalTaskStatus(from)
      ? `${from} is a final status, so the task cannot be moved out of this column.`
      : `A task in ${from} cannot move straight to ${toStatus}.`,
  };
}

/** Raw extra fields the server attached to an error envelope (see apiClient details). */
export function taskErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ApiClientError) {
    const details = error.details ?? {};
    const nested = details['extra'];
    return isRecord(nested) ? { ...details, ...nested } : details;
  }
  return {};
}

/**
 * INVALID_TRANSITION carries `{allowed_next: [...]}` — [] when absent.
 * Callers fall back to the detail's `allowed_next` when the error carries none.
 */
export function parseInvalidTransition(error: unknown): string[] {
  return asStringArray(taskErrorDetails(error).allowed_next);
}

/**
 * DEPENDENCY_BLOCKED carries `{blocking: [...]}` (ids of blocking
 * predecessors) — [] when absent/unparseable.
 */
export function parseDependencyBlocked(error: unknown): string[] {
  const d = taskErrorDetails(error);
  return asStringArray(d.blocking ?? d.blocking_task_ids ?? d.predecessors);
}

/**
 * Resolve the DELETE `:depId` path segment for a dependency edge. The server
 * exposes the edge row id as `dependency_id` — always prefer it: `edge.id`
 * is the *task* id and DELETEs with it 404.
 */
export function dependencyEdgeKey(edge: DependencyEdge): string {
  const candidates = [edge.dependency_id, edge.predecessor_id, edge.task_id, edge.successor_id, edge.id];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

/** Human label for an edge when the server omits title/status (ids only). */
export function dependencyEdgeLabel(edge: DependencyEdge): string {
  if (typeof edge.title === 'string' && edge.title.length > 0) return edge.title;
  const id = dependencyEdgeKey(edge);
  return id || '(unknown dependency)';
}

export const MAX_TASK_EVIDENCE_BYTES = 5 * 1024 * 1024;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read file'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
