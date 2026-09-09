import { apiRequest, apiRequestRaw } from './apiClient';
import { normalizeCursorPage, type CursorPage } from './employees';

export type OrgUnitType = 'district' | 'mandal' | 'village' | 'site';

export interface OrgUnit {
  id: string;
  type: OrgUnitType;
  code: string;
  name: string;
  parent_id: string | null;
  status: string;
  version: number;
  [key: string]: unknown;
}

export interface ListOrgUnitsParams {
  type?: string;
  parent_id?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export function buildOrgUnitsQuery(params: ListOrgUnitsParams = {}): string {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.parent_id) search.set('parent_id', params.parent_id);
  if (params.q) search.set('q', params.q);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/org/units${qs ? `?${qs}` : ''}`;
}

export async function listOrgUnits(params: ListOrgUnitsParams = {}): Promise<CursorPage<OrgUnit>> {
  const raw = await apiRequestRaw(buildOrgUnitsQuery(params), { method: 'GET' });
  return { ...normalizeCursorPage<OrgUnit>(raw.body), request_id: raw.requestId };
}

export async function fetchAllOrgUnits(
  params: Omit<ListOrgUnitsParams, 'cursor'> = {},
  maxPages = 10,
): Promise<OrgUnit[]> {
  const out: OrgUnit[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await listOrgUnits({ ...params, cursor: cursor ?? undefined });
    out.push(...res.data);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export async function createOrgUnit(input: {
  type: string;
  code: string;
  name: string;
  parent_id?: string | null;
}): Promise<OrgUnit> {
  const { data } = await apiRequest<OrgUnit>('/api/v1/org/units', { method: 'POST', body: input });
  return data;
}

export async function getOrgUnit(id: string): Promise<OrgUnit> {
  const { data } = await apiRequest<OrgUnit>(`/api/v1/org/units/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return data;
}

export async function patchOrgUnit(
  id: string,
  patch: { name?: string; status?: string },
  version: number | string,
): Promise<OrgUnit> {
  const { data } = await apiRequest<OrgUnit>(`/api/v1/org/units/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch,
  });
  return data;
}
