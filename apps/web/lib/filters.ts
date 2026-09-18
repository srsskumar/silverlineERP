import { apiRequest } from './apiClient';
import type { ListTasksParams } from './tasks';

/**
 * S5 saved filters (owner-private; server stores `query_definition` opaque JSON).
 *
 *   POST /api/v1/saved-filters {project_id?,name,query_definition} → 201
 *   GET  /api/v1/saved-filters?project_id= → {data: own (+shared)}
 *   PATCH /api/v1/saved-filters/:id (own) + DELETE (own)
 *
 * Web-side query shape (YOUR choice per contract — documented here and in the
 * README; the server never interprets it):
 *
 *   { status?: string; q?: string; assignee_me?: "true"; label_ids?: string[]; sla?: "overdue"|"at_risk"|"on_schedule" }
 *
 * The `labels` key is accepted as an alias for `label_ids` when reading rows
 * written by older clients. Perms: filter.read / filter.manage.
 */

export interface SavedFilterQuery {
  status?: string;
  q?: string;
  assignee_me?: string;
  label_ids?: string[];
  sla?: string;
  [key: string]: unknown;
}

export interface SavedFilter {
  id: string;
  name: string;
  project_id?: string | null;
  query: SavedFilterQuery;
  version: number;
  [key: string]: unknown;
}

export interface CreateSavedFilterInput {
  project_id?: string;
  shared?:boolean;
  name: string;
  query_definition: SavedFilterQuery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denest(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

function asArray(body: unknown): unknown[] {
  const raw = denest(body);
  return Array.isArray(raw) ? raw : [];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/**
 * Normalize an opaque query_definition into the web-side query shape.
 * Tolerates the `labels` alias, comma-joined label strings, and unknown keys
 * (passed through untouched so round-trips are lossless for known keys).
 */
export function normalizeFilterQuery(raw: unknown): SavedFilterQuery {
  if (!isRecord(raw)) return {};
  const labelIds = asStringArray(raw.label_ids ?? raw.labels);
  // Support comma-joined single strings ("a,b") written by hand.
  const expanded: string[] = [];
  for (const entry of labelIds) {
    for (const part of entry.split(',')) {
      const trimmed = part.trim();
      if (trimmed) expanded.push(trimmed);
    }
  }
  const out: SavedFilterQuery = { ...raw };
  if (typeof raw.status === 'string' && raw.status) out.status = raw.status;
  else delete out.status;
  if (typeof raw.q === 'string' && raw.q) out.q = raw.q;
  else delete out.q;
  if (typeof raw.assignee_me === 'string' && raw.assignee_me) out.assignee_me = raw.assignee_me;
  else delete out.assignee_me;
  if (typeof raw.sla === 'string' && raw.sla) out.sla = raw.sla;
  else delete out.sla;
  if (expanded.length > 0) out.label_ids = expanded;
  else delete out.label_ids;
  delete out.labels;
  return out;
}

/** Opaque definition bytes for create/patch (the server stores them as-is). */
export function filterQueryToDefinition(query: SavedFilterQuery): SavedFilterQuery {
  return normalizeFilterQuery({ ...query });
}

/** Parse stored definition bytes back into the web-side query shape. */
export function definitionToQuery(definition: unknown): SavedFilterQuery {
  return normalizeFilterQuery(definition);
}

/** Normalize a single saved-filter row (bare or enveloped). */
export function normalizeSavedFilter(body: unknown): SavedFilter {
  const raw = denest(body);
  if (!isRecord(raw) || typeof raw.id !== 'string') throw new Error('Unrecognized saved-filter shape');
  const def = isRecord(raw.query_definition)
    ? raw.query_definition
    : isRecord(raw.query)
      ? raw.query
      : {};
  const version = typeof raw.version === 'number' ? raw.version : 1;
  return {
    ...raw,
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    project_id: typeof raw.project_id === 'string' ? raw.project_id : null,
    query: normalizeFilterQuery(def),
    version,
  } as unknown as SavedFilter;
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeSavedFiltersPage(body: unknown): SavedFilter[] {
  return asArray(body).map((item) => {
    try {
      return normalizeSavedFilter(item);
    } catch {
      return item as SavedFilter;
    }
  });
}

/**
 * Apply a saved filter to task-list params (pure round-trip partner of
 * filterQueryToDefinition). Only known keys are mapped; unknown keys ride
 * along on the query object but never reach the task endpoint.
 */
export function applySavedFilter(filter: SavedFilter): ListTasksParams {
  const q = filter.query ?? {};
  const params: ListTasksParams = {};
  for(const key of ['cycle_id','due_from','due_to','started_from','started_to','finished_from','finished_to','priority','mentioned_me','assignee_id','sort'] as const)if(typeof q[key]==='string'&&q[key])params[key]=q[key] as string;
  if(isRecord(q.custom_fields))params.custom_fields=q.custom_fields;
  if (typeof q.status === 'string' && q.status) params.status = q.status;
  if (typeof q.q === 'string' && q.q) params.q = q.q;
  if (typeof q.assignee_me === 'string' && q.assignee_me) params.assignee_me = q.assignee_me;
  if (Array.isArray(q.label_ids) && q.label_ids.length > 0) {
    params.label_ids = [...q.label_ids];
  }
  if (typeof q.sla === 'string' && q.sla) params.sla = q.sla;
  return params;
}

/** Build the current UI filter state into a storable query (round-trip pure). */
export function buildFilterQuery(input: {
  status?: string;
  q?: string;
  assignee_me?: boolean | string;
  label_ids?: string[];
  sla?: string;
  extra?: ListTasksParams;
}): SavedFilterQuery {
  const out: SavedFilterQuery = normalizeFilterQuery(input.extra ?? {});
  if (input.status) out.status = input.status;
  if (input.q?.trim()) out.q = input.q.trim();
  if (input.assignee_me === true || input.assignee_me === 'true') out.assignee_me = 'true';
  if (input.label_ids && input.label_ids.length > 0) out.label_ids = [...input.label_ids];
  if (input.sla) out.sla = input.sla;
  return out;
}

export function buildSavedFiltersQuery(params: { project_id?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.project_id) search.set('project_id', params.project_id);
  const qs = search.toString();
  return `/api/v1/saved-filters${qs ? `?${qs}` : ''}`;
}

export async function listSavedFilters(projectId?: string): Promise<SavedFilter[]> {
  const { data } = await apiRequest<unknown>(buildSavedFiltersQuery({ project_id: projectId }), {
    method: 'GET',
  });
  return normalizeSavedFiltersPage(data);
}

export async function createSavedFilter(input: CreateSavedFilterInput): Promise<SavedFilter> {
  const { data } = await apiRequest<unknown>('/api/v1/saved-filters', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeSavedFilter(data);
}

export async function patchSavedFilter(
  id: string,
  patch: { name?: string; query_definition?: SavedFilterQuery },
  version?: number | string,
): Promise<SavedFilter> {
  const headers: Record<string, string> = {};
  if (version !== undefined) headers['If-Match'] = String(version);
  const { data } = await apiRequest<unknown>(`/api/v1/saved-filters/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers,
    body: patch as unknown as Record<string, unknown>,
  });
  return normalizeSavedFilter(data);
}

export async function deleteSavedFilter(id: string): Promise<void> {
  await apiRequest<unknown>(`/api/v1/saved-filters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
