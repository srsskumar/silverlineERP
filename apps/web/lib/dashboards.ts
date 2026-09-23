import { apiRequest } from './apiClient';

/**
 * S6 dashboards client (frozen contract).
 *
 *   GET /api/v1/dashboards/role/:role → {template, generated_at, widgets:[{key,title,value,link?}]}
 *     :role ∈ super_admin|admin|hr_manager|project_manager|team_lead|employee|client_viewer|auditor;
 *     caller must hold it (else 403 — surfaced inline, never thrown through a shell gate).
 *     Response may include scope_note (string, rendered as an info banner when present).
 *     Server caches 60s (generated_at tells freshness — rendered as "updated Xs ago").
 *   GET /api/v1/dashboards/my-work → {assigned_open, assigned_overdue:[...],
 *     pending_approvals:{leave:[...], exceptions_count}, unread_count}
 *
 * Envelope tolerance as before: apiRequest unwraps one `{data:...}` level;
 * normalizers below additionally tolerate a nested `{data:{...}}` level and
 * bare payloads (backend timing — endpoints may 404 until the API lands).
 */

export const DASHBOARD_ROLES = [
  'super_admin',
  'admin',
  'payroll_officer',
  'inventory_manager',
  'hr_manager',
  'project_manager',
  'team_lead',
  'employee',
  'client_viewer',
  'auditor',
] as const;

export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

/** Human labels for the template selector dropdown. */
export const TEMPLATE_LABELS: Record<DashboardRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  payroll_officer: 'Payroll Officer',
  inventory_manager: 'Inventory Manager',
  hr_manager: 'HR Manager',
  project_manager: 'Project Manager',
  team_lead: 'Team Lead',
  employee: 'Employee',
  client_viewer: 'Client Viewer',
  auditor: 'Auditor',
};

/**
 * Default-template priority (first held role wins).
 * NOTE: client_viewer sorts last on purpose — it is the most restricted
 * template and only becomes the default when the session holds nothing else.
 */
export const ROLE_PRIORITY: DashboardRole[] = [
  'super_admin',
  'admin',
  'payroll_officer',
  'inventory_manager',
  'hr_manager',
  'project_manager',
  'team_lead',
  'employee',
  'auditor',
  'client_viewer',
];

/** Dashboard queries mirror the 60s server cache; keep 5min GC. */
export const DASHBOARD_STALE_TIME = 60_000;
export const DASHBOARD_GC_TIME = 5 * 60_000;

export interface DashboardWidget {
  key: string;
  title: string;
  value: string | number;
  link?: string | null;
  [key: string]: unknown;
}

export interface RoleDashboard {
  template: string;
  generated_at: string | null;
  widgets: DashboardWidget[];
  scope_note?: string | null;
  request_id?: string;
}

export interface MyWorkOverdueTask {
  id: string;
  title: string;
  project_id: string;
  planned_end_date?: string | null;
  [key: string]: unknown;
}

export interface MyWorkLeaveApproval {
  id: string;
  employee_id: string;
  employee_name?: string | null;
  employee_emp_no?: string | null;
  from_date: string;
  to_date: string;
  [key: string]: unknown;
}

export interface MyWorkSummary {
  assigned_open: number;
  assigned_overdue: MyWorkOverdueTask[];
  pending_approvals: {
    leave: MyWorkLeaveApproval[];
    exceptions_count: number;
  };
  unread_count: number;
  request_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip up to two `{data:...}` envelope levels (apiRequest strips one already). */
function denest(body: unknown): unknown {
  let raw = body;
  for (let i = 0; i < 2; i += 1) {
    if (isRecord(raw) && 'data' in raw) raw = (raw as { data: unknown }).data;
    else break;
  }
  return raw;
}

/**
 * Normalize a session role token to a dashboard template key.
 * Sessions may carry UPPER_SNAKE (`HR_MANAGER`) or lowercase (`hr_manager`).
 * Returns null for unknown tokens (never throws — unknown roles are skipped).
 */
export function normalizeRole(raw: unknown): DashboardRole | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return (DASHBOARD_ROLES as readonly string[]).includes(key) ? (key as DashboardRole) : null;
}

/**
 * Map session roles (UPPER or lower) to held dashboard templates,
 * de-duplicated and sorted by ROLE_PRIORITY.
 */
export function sessionRolesToTemplates(roles: readonly unknown[]): DashboardRole[] {
  const held = new Set<DashboardRole>();
  for (const r of roles) {
    const t = normalizeRole(r);
    if (t) held.add(t);
  }
  return ROLE_PRIORITY.filter((r) => held.has(r));
}

/** Default template = first held role in ROLE_PRIORITY, else null. */
export function selectDefaultTemplate(roles: readonly unknown[]): DashboardRole | null {
  const templates = sessionRolesToTemplates(roles);
  return templates.length > 0 ? templates[0] : null;
}

function toWidget(raw: unknown): DashboardWidget | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.key !== 'string' || typeof raw.title !== 'string') return null;
  if (typeof raw.value !== 'string' && typeof raw.value !== 'number') return null;
  return {
    ...raw,
    key: raw.key,
    title: raw.title,
    value: raw.value,
    link: typeof raw.link === 'string' ? raw.link : null,
  } as DashboardWidget;
}

/** Normalize GET /dashboards/role/:role (envelope/bare tolerant). */
export function normalizeRoleDashboard(body: unknown): RoleDashboard {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized dashboard shape');
  const template = typeof raw.template === 'string' ? raw.template : '';
  if (!template) throw new Error('Unrecognized dashboard shape');
  const widgetsRaw = Array.isArray(raw.widgets) ? raw.widgets : [];
  const widgets: DashboardWidget[] = [];
  for (const w of widgetsRaw) {
    const parsed = toWidget(w);
    if (parsed) widgets.push(parsed);
  }
  const generatedAt = typeof raw.generated_at === 'string' ? raw.generated_at : null;
  const scopeNote = typeof raw.scope_note === 'string' && raw.scope_note.length > 0 ? raw.scope_note : null;
  return { template, generated_at: generatedAt, widgets, scope_note: scopeNote };
}

export async function listWidgets(template: string): Promise<RoleDashboard> {
  const raw = await apiRequest<unknown>(
    `/api/v1/dashboards/role/${encodeURIComponent(template)}`,
    { method: 'GET' },
  );
  // apiRequest unwraps one envelope level; the normalizer tolerates the rest.
  return { ...normalizeRoleDashboard(raw.data), request_id: raw.request_id };
}

/** Normalize GET /dashboards/my-work (envelope/bare tolerant, missing keys defaulted). */
export function normalizeMyWork(body: unknown): MyWorkSummary {
  const raw = denest(body);
  const rec = isRecord(raw) ? raw : {};
  const assignedOpen =
    typeof rec.assigned_open === 'number' && Number.isFinite(rec.assigned_open)
      ? rec.assigned_open
      : 0;
  const overdueRaw = Array.isArray(rec.assigned_overdue) ? rec.assigned_overdue : [];
  const assigned_overdue: MyWorkOverdueTask[] = overdueRaw.filter(
    (t): t is MyWorkOverdueTask =>
      isRecord(t) && typeof t.id === 'string' && typeof t.title === 'string',
  ) as MyWorkOverdueTask[];
  const approvalsRec = isRecord(rec.pending_approvals) ? rec.pending_approvals : {};
  const leaveRaw = Array.isArray(approvalsRec.leave) ? approvalsRec.leave : [];
  const leave: MyWorkLeaveApproval[] = leaveRaw.filter(
    (l): l is MyWorkLeaveApproval => isRecord(l) && typeof l.id === 'string',
  ) as MyWorkLeaveApproval[];
  const exceptionsCount =
    typeof approvalsRec.exceptions_count === 'number' && Number.isFinite(approvalsRec.exceptions_count)
      ? approvalsRec.exceptions_count
      : 0;
  const unread =
    typeof rec.unread_count === 'number' && Number.isFinite(rec.unread_count) ? rec.unread_count : 0;
  return {
    assigned_open: assignedOpen,
    assigned_overdue: assigned_overdue,
    pending_approvals: { leave, exceptions_count: exceptionsCount },
    unread_count: unread,
  };
}

export async function getMyWork(): Promise<MyWorkSummary> {
  const raw = await apiRequest<unknown>('/api/v1/dashboards/my-work', { method: 'GET' });
  return { ...normalizeMyWork(raw.data), request_id: raw.request_id };
}

// ---------------------------------------------------------------------------
// Pure display helpers (unit-tested)
// ---------------------------------------------------------------------------

export type WidgetTone = 'danger' | 'info' | 'success' | 'warning' | 'neutral';

/**
 * Coloring for widget keys ("overdue" → danger; "pct"/"percent"/"rate"/
 * "utilization" → info; "open"/"pending"/"approval" → warning;
 * "done"/"completed"/"approved"/"present" → success; else neutral).
 * Unknown keys never throw — they fall back to neutral.
 */
export function widgetTone(key: unknown): WidgetTone {
  const k = String(key ?? '').toLowerCase();
  if (k.includes('overdue')) return 'danger';
  if (k.includes('pct') || k.includes('percent') || k.includes('rate') || k.includes('utilization'))
    return 'info';
  if (k.includes('open') || k.includes('pending') || k.includes('approval')) return 'warning';
  if (
    k.includes('done') ||
    k.includes('completed') ||
    k.includes('approved') ||
    k.includes('present')
  )
    return 'success';
  return 'neutral';
}

/**
 * Compact stat formatting for chips: locale-grouped integers, 2dp for
 * fractional percents, em-dash for missing/non-numeric values.
 */
export function formatStat(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value.toLocaleString('en-IN') : value.toFixed(2);
  }
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return '—';
}

/**
 * Relative freshness for `generated_at` (server cache is 60s):
 * "updated 12s ago" / "updated 3m ago" / "updated 2h ago" / "updated 4d ago".
 * Missing/unparseable input → "updated time unknown"; future skew → "updated just now".
 */
export function formatGeneratedAt(
  generatedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!generatedAt) return 'updated time unknown';
  const parsed = Date.parse(generatedAt);
  if (Number.isNaN(parsed)) return 'updated time unknown';
  const diffSec = Math.floor((nowMs - parsed) / 1000);
  if (diffSec < 0) return 'updated just now';
  if (diffSec < 5) return 'updated just now';
  if (diffSec < 60) return `updated ${diffSec}s ago`;
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}
