import { apiRequest } from './apiClient';

export interface Holiday {
  id: string;
  date: string;
  name: string;
  type: string;
  scope_type?: string | null;
  scope_id?: string | null;
  /** The unit the scope points at; the list looks it up. */
  scope_name?: string | null;
  /** A-012: withdrawn (PATCH active=false) rather than deleted. */
  active?: boolean;
  [key: string]: unknown;
}

export function buildHolidaysQuery(params: { year?: number | string; includeInactive?: boolean } = {}): string {
  const search = new URLSearchParams();
  if (params.year) search.set('year', String(params.year));
  if (params.includeInactive) search.set('include_inactive', 'true');
  const qs = search.toString();
  return `/api/v1/holidays${qs ? `?${qs}` : ''}`;
}

export async function listHolidays(params: { year?: number | string; includeInactive?: boolean } = {}): Promise<Holiday[]> {
  const { data } = await apiRequest<Holiday[] | { data: Holiday[] }>(buildHolidaysQuery(params), {
    method: 'GET',
  });
  if (Array.isArray(data)) return data;
  const nested = (data as { data?: Holiday[] }).data;
  return Array.isArray(nested) ? nested : [];
}

export async function createHoliday(input: {
  date: string;
  name: string;
  type: string;
  scope_type?: string | null;
  scope_id?: string | null;
}): Promise<Holiday> {
  const { data } = await apiRequest<Holiday>('/api/v1/holidays', { method: 'POST', body: input });
  return data;
}

export async function updateHoliday(
  id: string,
  body: { date?: string; name?: string; type?: string; active?: boolean; reason: string },
): Promise<Holiday> {
  const { data } = await apiRequest<Holiday>(`/api/v1/holidays/${id}`, { method: 'PATCH', body });
  return data;
}

/**
 * The PATCH body for an edit: only the fields that actually changed from
 * what the holiday already had, plus the reason (always required, always
 * freshly typed — never treated as "unchanged").
 */
export function holidayEditPatchBody(
  original: Pick<Holiday, 'date' | 'name' | 'type'>,
  edited: { date: string; name: string; type: string; reason: string },
): { date?: string; name?: string; type?: string; reason: string } {
  const body: { date?: string; name?: string; type?: string; reason: string } = { reason: edited.reason };
  if (edited.date !== original.date) body.date = edited.date;
  if (edited.name !== original.name) body.name = edited.name;
  if (edited.type !== original.type) body.type = edited.type;
  return body;
}
