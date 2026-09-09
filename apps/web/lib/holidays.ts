import { apiRequest } from './apiClient';

export interface Holiday {
  id: string;
  date: string;
  name: string;
  type: string;
  scope_type?: string | null;
  scope_id?: string | null;
  [key: string]: unknown;
}

export function buildHolidaysQuery(params: { year?: number | string } = {}): string {
  const search = new URLSearchParams();
  if (params.year) search.set('year', String(params.year));
  const qs = search.toString();
  return `/api/v1/holidays${qs ? `?${qs}` : ''}`;
}

export async function listHolidays(params: { year?: number | string } = {}): Promise<Holiday[]> {
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
