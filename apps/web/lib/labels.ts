import { apiRequest } from './apiClient';

/**
 * S5 labels client (frozen contract).
 *
 *   POST /api/v1/labels {project_id?,name,color?} → 201 (409 LABEL_EXISTS)
 *   GET  /api/v1/labels?project_id= → {data:[{id,name,color}]}
 *   POST /api/v1/tasks/:id/labels {label_id} → 201
 *   DELETE /api/v1/tasks/:id/labels/:labelId → 204
 *
 * There is no label PATCH/DELETE endpoint in S5 — the manager is create+list
 * only (409s display the server message). Perms: label.read / label.manage.
 */

export interface Label {
  id: string;
  name: string;
  color?: string | null;
  project_id?: string | null;
  [key: string]: unknown;
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

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeLabels(body: unknown): Label[] {
  return asArray(body) as Label[];
}

/** Normalize a single label payload (bare object, possibly enveloped). */
export function normalizeLabel(body: unknown): Label {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as Label;
  throw new Error('Unrecognized label shape');
}

export function buildLabelsQuery(params: { project_id?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.project_id) search.set('project_id', params.project_id);
  const qs = search.toString();
  return `/api/v1/labels${qs ? `?${qs}` : ''}`;
}

export async function listLabels(projectId?: string): Promise<Label[]> {
  const { data } = await apiRequest<unknown>(buildLabelsQuery({ project_id: projectId }), {
    method: 'GET',
  });
  return normalizeLabels(data);
}

export async function createLabel(input: {
  project_id?: string;
  name: string;
  color?: string;
}): Promise<Label> {
  const { data } = await apiRequest<unknown>('/api/v1/labels', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeLabel(data);
}

export async function attachTaskLabel(taskId: string, labelId: string): Promise<unknown> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/labels`,
    { method: 'POST', body: { label_id: labelId } },
  );
  return data;
}

export async function detachTaskLabel(taskId: string, labelId: string): Promise<void> {
  await apiRequest<unknown>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/labels/${encodeURIComponent(labelId)}`,
    { method: 'DELETE' },
  );
}
