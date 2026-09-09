import { apiRequest, apiRequestRaw } from './apiClient';

export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
  request_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize a cursor page, tolerating `{data[], next_cursor, has_more}`
 * envelopes and bare arrays. Non-record rows are dropped (a single malformed
 * row must never crash a table). Cursor fields default to end-of-list.
 */
export function normalizeCursorPage<T>(body: unknown): Omit<CursorPage<T>, 'request_id'> {
  const rec = isRecord(body) ? body : null;
  const nested = rec && isRecord(rec.data) ? (rec.data as Record<string, unknown>) : null;
  const rows = Array.isArray(body) ? body : rec && Array.isArray(rec.data) ? rec.data : [];
  const nextCursor =
    (rec && typeof rec.next_cursor === 'string' ? rec.next_cursor : null) ??
    (nested && typeof nested.next_cursor === 'string' ? (nested.next_cursor as string) : null);
  const hasMore =
    (rec ? rec.has_more === true : false) || (nested ? nested.has_more === true : false);
  return {
    data: (rows as unknown[]).filter(isRecord) as T[],
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

export interface EmployeeListItem {
  id: string;
  emp_no: string;
  first_name: string;
  last_name?: string | null;
  phone?: string | null;
  phone_last4?: string | null;
  designation?: string | null;
  department?: string | null;
  status: string;
  district_id?: string | null;
  version: number;
  aadhaar?: string | null;
  aadhaar_last4?: string | null;
  pan?: string | null;
  pan_last4?: string | null;
  bank_account?: string | null;
  bank_account_last4?: string | null;
  phonepe_number?: string | null;
  salary_basic?: number | string | null;
  date_of_joining?: string | null;
  [key: string]: unknown;
}

export interface EmployeeDetail extends EmployeeListItem {
  father_name?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  phone_secondary?: string | null;
  email?: string | null;
  address?: string | null;
  mandal_id?: string | null;
  village_id?: string | null;
  site_id?: string | null;
  reports_to?: string | null;
  bank_name?: string | null;
  bank_ifsc?: string | null;
  education?: string | null;
  skills?: string[] | string | null;
  experience_years?: number | null;
  date_of_exit?: string | null;
  exit_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ListEmployeesParams {
  status?: string;
  district_id?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export function buildEmployeeQuery(params: ListEmployeesParams = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.district_id) search.set('district_id', params.district_id);
  if (params.q) search.set('q', params.q);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/employees${qs ? `?${qs}` : ''}`;
}

export async function listEmployees(params: ListEmployeesParams = {}): Promise<CursorPage<EmployeeListItem>> {
  const raw = await apiRequestRaw(buildEmployeeQuery(params), { method: 'GET' });
  return { ...normalizeCursorPage<EmployeeListItem>(raw.body), request_id: raw.requestId };
}

/** Drain cursor pages (bounded) — used by small lookups, not the main table. */
export async function fetchAllEmployees(
  params: Omit<ListEmployeesParams, 'cursor'> = {},
  maxPages = 10,
): Promise<EmployeeListItem[]> {
  const out: EmployeeListItem[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await listEmployees({ ...params, cursor: cursor ?? undefined });
    out.push(...res.data);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export async function createEmployee(input: Record<string, unknown>): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>('/api/v1/employees', {
    method: 'POST',
    body: input,
  });
  return data;
}

export async function getEmployee(id: string): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>(`/api/v1/employees/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return data;
}

export async function patchEmployee(
  id: string,
  patch: Record<string, unknown>,
  version: number | string,
): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>(`/api/v1/employees/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch,
  });
  return data;
}

export async function exitEmployee(
  id: string,
  input: { exit_date: string; reason: string },
): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>(`/api/v1/employees/${encodeURIComponent(id)}/exit`, {
    method: 'POST',
    body: input,
  });
  return data;
}

export async function reactivateEmployee(id: string, input: { reason: string }): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>(
    `/api/v1/employees/${encodeURIComponent(id)}/reactivate`,
    { method: 'POST', body: input },
  );
  return data;
}

export interface BulkImportError {
  index: number;
  emp_no?: string;
  errors: string[];
}

export interface BulkImportResult {
  dry_run?: boolean;
  validated?: number;
  imported: number;
  failed: number;
  errors: BulkImportError[];
}

export async function bulkImportEmployees(rows: Record<string, unknown>[], dryRun=false): Promise<BulkImportResult> {
  const { data } = await apiRequest<BulkImportResult>('/api/v1/employees/bulk-import', {
    method: 'POST',
    body: { rows, dry_run: dryRun },
  });
  return data;
}

export async function getMyEmployee(): Promise<EmployeeDetail> {
  const { data } = await apiRequest<EmployeeDetail>('/api/v1/employees/me', { method: 'GET' });
  return data;
}
