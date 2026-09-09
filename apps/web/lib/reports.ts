import { apiRequest, getBaseUrl } from './apiClient';
import { PERMISSIONS } from './permissions';

/**
 * S6 reports client (frozen contract).
 *
 *   POST /api/v1/reports {type:employees|attendance|tasks|leave, format:"csv", filters?} → 201 {id,status,rows,download_url}
 *   GET <download_url> → csv file (href built absolute via downloadReportUrl).
 *
 * Perms vary by type — 403s are surfaced inline in the form, never through a
 * shell gate. S6 UI is type-only (no filters); filter support is deferred
 * (see README S6 notes). Reports are capped at 5000 rows; the registry is
 * in-memory (see README).
 */

export const REPORT_TYPES = ['employees', 'attendance', 'tasks', 'leave','inventory','assets','invoices','payroll','projects','cycles','audit'] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** S6 report format is fixed to csv (no UI control). */
export const REPORT_FORMAT = 'csv' as const;

/** Server-side row cap (README S6 limits note). */
export const REPORT_ROW_LIMIT = 5000;

export interface ReportTypeMeta {
  type: ReportType;
  label: string;
  /** Permission required to generate this report type (exact server codes). */
  permission: string;
}

/** Report type → required permission mapping used for per-type gating. */
export const REPORT_TYPE_META: ReportTypeMeta[] = [
 {type:'projects',label:'Project progress',permission:'project.read'},
 {type:'cycles',label:'Cycle velocity',permission:'cycle.read'},
 {type:'audit',label:'Audit trail',permission:'audit.read'},
  {type:'inventory',label:'Inventory',permission:'inventory.read'},
  {type:'assets',label:'Assets',permission:'asset.manage'},
  {type:'invoices',label:'Invoices',permission:'inventory.read'},
  {type:'payroll',label:'Payroll',permission:'payroll.read'},
  { type: 'employees', label: 'Employees', permission: PERMISSIONS.EMPLOYEE_READ },
  { type: 'attendance', label: 'Attendance', permission: PERMISSIONS.ATTENDANCE_READ },
  { type: 'tasks', label: 'Tasks', permission: PERMISSIONS.TASK_READ },
  { type: 'leave', label: 'Leave', permission: PERMISSIONS.LEAVE_READ },
];

export const REPORT_TYPE_PERMISSION: Record<ReportType, string> = {
 projects:'project.read',cycles:'cycle.read',audit:'audit.read',
 inventory:'inventory.read',assets:'asset.manage',invoices:'inventory.read',payroll:'payroll.read',
  employees: PERMISSIONS.EMPLOYEE_READ,
  attendance: PERMISSIONS.ATTENDANCE_READ,
  tasks: PERMISSIONS.TASK_READ,
  leave: PERMISSIONS.LEAVE_READ,
};

/** Required permission for a report type (undefined for unknown types). */
export function reportTypePermission(type: string): string | undefined {
  if (type === 'employees') return REPORT_TYPE_PERMISSION.employees;
  if (type === 'attendance') return REPORT_TYPE_PERMISSION.attendance;
  if (type === 'tasks') return REPORT_TYPE_PERMISSION.tasks;
  if (type === 'leave') return REPORT_TYPE_PERMISSION.leave;
  return REPORT_TYPE_META.find(t=>t.type===type)?.permission;
}

/** True when the permission list holds the code for `type`. */
export function canGenerateReportType(
  permissions: readonly string[] | null | undefined,
  type: string,
): boolean {
  const required = reportTypePermission(type);
  if (!required || !Array.isArray(permissions)) return false;
  return permissions.includes(required);
}

/** Subset of REPORT_TYPE_META the permission list is allowed to generate. */
export function reportTypesForPermissions(
  permissions: readonly string[] | null | undefined,
): ReportTypeMeta[] {
  if (!Array.isArray(permissions)) return [];
  return REPORT_TYPE_META.filter((m) => permissions.includes(m.permission));
}

export interface GenerateReportInput {
  type: ReportType;
  filters?: Record<string, unknown>;
  format?:"csv"|"xlsx"|"pdf";
}

export interface ReportJob {
  id: string;
  status: string;
  rows: number;
  download_url: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip one `{data:...}` envelope level when the apiClient has not already done so. */
function denest(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

/** Normalize POST /reports responses (201 bare `{id,status,rows,download_url}`, envelope-tolerant). */
export function normalizeReportJob(body: unknown): ReportJob {
  const raw = denest(body);
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.download_url !== 'string') {
    throw new Error('Unrecognized report shape');
  }
  const rows = typeof raw.rows === 'number' && Number.isFinite(raw.rows) ? raw.rows : 0;
  return {
    ...raw,
    id: raw.id,
    status: typeof raw.status === 'string' ? raw.status : 'ready',
    rows,
    download_url: raw.download_url,
  } as ReportJob;
}

export async function generateReport(input: GenerateReportInput): Promise<ReportJob> {
  const { data } = await apiRequest<unknown>('/api/v1/reports', {
    method: 'POST',
    body: { type: input.type, format: input.format??REPORT_FORMAT, ...(input.filters ? { filters: input.filters } : {}) },
  });
  return normalizeReportJob(data);
}

/**
 * Absolute href for `<a href download>`: `${baseURL}${download_url}`.
 * Pass-through when the server already returns an absolute URL.
 */
export function downloadReportUrl(downloadUrl: string): string {
  const path = String(downloadUrl ?? '');
  if (/^https?:\/\//i.test(path)) return path;
  const base = getBaseUrl();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
