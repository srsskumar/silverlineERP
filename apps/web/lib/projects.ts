import { ApiClientError, apiRequest, apiRequestRaw } from './apiClient';

/**
 * S4 workspaces + projects client (frozen contract).
 *
 *   POST /api/v1/workspaces {name,description?} → 201 bare
 *   GET  /api/v1/workspaces → {data:[{id,name,description,status}]}
 *   GET  /api/v1/workspaces/:id
 *   GET  /api/v1/project-types → {data:[{id,code,name,workflow:{statuses[],allowed_transitions{}}}]}
 *   POST /api/v1/projects {workspace_id,code,name,project_type_id?,description?,project_manager_id?,planned_*?,priority?} → 201 DRAFT
 *   GET  /api/v1/projects?status=&workspace_id=&q=
 *   GET  /api/v1/projects/:id → {project, workflow, counts:{total,open,done}}
 *   PATCH /api/v1/projects/:id + If-Match (status rule enforced server-side)
 *   POST /api/v1/projects/:id/close {reason?} → 200 | 422 PROJECT_HAS_OPEN_TASKS {open_count}
 *
 * List responses tolerate `{data:[]}` envelopes and bare arrays; singles
 * tolerate `{data:{...}}` envelopes and bare objects (S1/S2/S3 pattern).
 * Permission codes: workspace.read/manage, project.create/read/update/close.
 */

export type ProjectStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'ON_HOLD'
  | 'COMPLETED_PENDING_CLOSE'
  | 'CLOSED'
  | 'CANCELLED';

export interface Workspace {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  [key: string]: unknown;
}

export interface ProjectTypeWorkflow {
  statuses: string[];
  allowed_transitions: Record<string, string[]>;
  [key: string]: unknown;
}

export interface ProjectType {
  id: string;
  code: string;
  name: string;
  workflow: ProjectTypeWorkflow;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  workspace_id: string;
  code: string;
  name: string;
  project_type_id?: string | null;
  description?: string | null;
  project_manager_id?: string | null;
  priority?: string | null;
  status: ProjectStatus | string;
  version: number;
  [key: string]: unknown;
}

export interface ProjectCounts {
  total: number;
  open: number;
  done: number;
  [key: string]: unknown;
}

export interface ProjectDetailData {
  project: Project;
  workflow: ProjectTypeWorkflow | Record<string, unknown>;
  counts: ProjectCounts;
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
export function normalizeWorkspaces(body: unknown): Workspace[] {
  return asArray(body) as Workspace[];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeProjectTypes(body: unknown): ProjectType[] {
  return asArray(body) as ProjectType[];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeProjectsPage(body: unknown): Project[] {
  return asArray(body) as Project[];
}

/** Normalize GET /workspaces/:id (bare object, possibly enveloped). */
export function normalizeWorkspace(body: unknown): Workspace {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as Workspace;
  throw new Error('Unrecognized workspace shape');
}

/** Normalize a single project payload (bare object, possibly enveloped). */
export function normalizeProject(body: unknown): Project {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as Project;
  throw new Error('Unrecognized project shape');
}

function toCounts(raw: unknown): ProjectCounts {
  const base = { total: 0, open: 0, done: 0 };
  if (!isRecord(raw)) return base;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    ...raw,
    total: num(raw.total),
    open: num(raw.open),
    done: num(raw.done),
  };
}

/**
 * Normalize GET /projects/:id. The contract nests the row under `project`
 * with `workflow` + `counts:{total,open,done}` siblings; tolerate a flat
 * shape (row fields + workflow/counts siblings) and one envelope level.
 */
export function normalizeProjectDetail(body: unknown): ProjectDetailData {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized project-detail shape');
  const nested = isRecord(raw.project) ? raw.project : raw;
  if (!isRecord(nested) || typeof nested.id !== 'string') {
    throw new Error('Unrecognized project-detail shape');
  }
  return {
    project: nested as unknown as Project,
    workflow: (isRecord(raw.workflow) ? raw.workflow : {}) as ProjectTypeWorkflow | Record<string, unknown>,
    counts: toCounts(raw.counts),
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const { data } = await apiRequest<unknown>('/api/v1/workspaces', { method: 'GET' });
  return normalizeWorkspaces(data);
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
}): Promise<Workspace> {
  const { data } = await apiRequest<Workspace>('/api/v1/workspaces', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return data;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const { data } = await apiRequest<unknown>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeWorkspace(data);
}

export async function listProjectTypes(): Promise<ProjectType[]> {
  const { data } = await apiRequest<unknown>('/api/v1/project-types', { method: 'GET' });
  return normalizeProjectTypes(data);
}

export interface ListProjectsParams {
  status?: string;
  workspace_id?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export function buildProjectsQuery(params: ListProjectsParams = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.workspace_id) search.set('workspace_id', params.workspace_id);
  if (params.q) search.set('q', params.q);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/projects${qs ? `?${qs}` : ''}`;
}

/** The API caps a page at 100 and defaults to 20 when no limit is sent. */
const PROJECTS_PAGE_SIZE = 100;
/** 100 requests x 100 rows. A guard against a cursor that never terminates. */
const PROJECTS_MAX_PAGES = 100;

/**
 * List every project the caller can see, following `next_cursor` to the end.
 *
 * Sending no limit used to take the server default of 20, and nothing followed
 * the cursor, so the dashboard board picker and the projects page silently
 * showed only the 20 most recently created projects with no hint that more
 * existed. Pass an explicit `limit` or `cursor` to fetch a single page instead.
 *
 * apiRequestRaw, not apiRequest: unwrap() keeps only `data` and discards the
 * `next_cursor`/`has_more` siblings this loop reads.
 */
export async function listProjects(params: ListProjectsParams = {}): Promise<Project[]> {
  const singlePage = params.limit !== undefined || params.cursor !== undefined;
  const all: Project[] = [];
  let cursor = params.cursor;
  for (let fetched = 0; fetched < PROJECTS_MAX_PAGES; fetched += 1) {
    const path = buildProjectsQuery({
      ...params,
      limit: params.limit ?? PROJECTS_PAGE_SIZE,
      cursor,
    });
    const { body } = await apiRequestRaw(path, { method: 'GET' });
    all.push(...normalizeProjectsPage(body));
    if (singlePage) break;
    const page = body as { has_more?: boolean; next_cursor?: string | null };
    if (!page?.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return all;
}

export async function createProject(input: Record<string, unknown>): Promise<Project> {
  const { data } = await apiRequest<unknown>('/api/v1/projects', {
    method: 'POST',
    body: input,
  });
  return normalizeProject(data);
}

export async function getProject(id: string): Promise<ProjectDetailData> {
  const { data } = await apiRequest<unknown>(`/api/v1/projects/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeProjectDetail(data);
}

export async function patchProject(
  id: string,
  patch: Record<string, unknown>,
  version: number | string,
): Promise<Project> {
  const { data } = await apiRequest<unknown>(`/api/v1/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch,
  });
  return normalizeProject(data);
}

export async function closeProject(
  id: string,
  input: { reason?: string } = {},
): Promise<Project> {
  const { data } = await apiRequest<unknown>(`/api/v1/projects/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeProject(data);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const projectStatusBadgeTone: Record<string, 'warning' | 'success' | 'danger' | 'neutral' | 'info'> = {
  DRAFT: 'neutral',
  ACTIVE: 'info',
  ON_HOLD: 'warning',
  COMPLETED_PENDING_CLOSE: 'warning',
  CLOSED: 'success',
  CANCELLED: 'danger',
};

export function toneForProjectStatus(
  status: string,
): 'warning' | 'success' | 'danger' | 'neutral' | 'info' {
  return projectStatusBadgeTone[status] ?? 'neutral';
}

/** Terminal project states — closed/cancelled projects accept no further transitions. */
export function isTerminalProjectStatus(status: string): boolean {
  return status === 'CLOSED' || status === 'CANCELLED';
}

/** Raw extra fields the server attached to an error envelope (see apiClient details). */
export function projectErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ApiClientError) {
    const details = error.details ?? {};
    const nested = details['extra'];
    return isRecord(nested) ? { ...details, ...nested } : details;
  }
  return {};
}

/**
 * PROJECT_HAS_OPEN_TASKS carries `{open_count}` — null when absent/unparseable.
 * Returned by POST /projects/:id/close when open tasks remain.
 */
export function parseProjectOpenTasks(error: unknown): number | null {
  const raw = projectErrorDetails(error).open_count;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
