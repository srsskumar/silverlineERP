import { ApiClientError, apiRequest } from './apiClient';
import type { CursorPage } from './employees';

/**
 * S3 leave client (frozen contract).
 *
 *   GET  /api/v1/leave/types                                  → {data:[{id,code,name,is_paid,annual_entitlement,requires_balance}]}
 *   GET  /api/v1/leave/balances?employee_id=&period_year=     → {data:[...]}
 *   POST /api/v1/leave/balances {employee_id,leave_type_id,period_year,opening_balance} → upsert (leave.admin)
 *   POST /api/v1/leave/requests {leave_type_id,from_date,to_date,reason?} → 201 bare | 200 {applied:true,request} (same-key replay)
 *   GET  /api/v1/leave/requests?status=&mine=&approver_me=&employee_id=&limit=&cursor= → cursor page
 *   GET  /api/v1/leave/requests/:id                          → bare + approval_chain[] (approver ids only — no names)
 *   POST /api/v1/leave/requests/:id/decision {decision,note?} + If-Match → 200
 *   POST /api/v1/leave/requests/:id/cancel {reason?}         → 200 (own PENDING only)
 *
 * List responses tolerate `{data:[]}` envelopes and bare arrays (S1/S2 pattern).
 * NOTE: GET /:id carries approver *user ids* only — the contract has no users
 * endpoint, so the UI shows short ids and never invents names.
 */

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type LeaveDecision = 'APPROVE' | 'REJECT';

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  is_paid: boolean;
  annual_entitlement: number;
  requires_balance: boolean;
  [key: string]: unknown;
}

export interface LeaveBalance {
  id: string;
  employee_id: string;
  leave_type_id: string;
  leave_code: string;
  period_year: number;
  opening_balance: number;
  credits: number;
  consumed: number;
  adjustments: number;
  current_balance: number;
  [key: string]: unknown;
}

export interface ApprovalStep {
  step: number;
  approver_user_id: string;
  status: string;
  decided_at?: string | null;
  note?: string | null;
  [key: string]: unknown;
}

export interface LeaveRequest {
  id: string;
  employee_id: string;
  /** From the employee record, joined by the API. */
  employee_name?: string | null;
  employee_emp_no?: string | null;
  leave_type_id: string;
  leave_code: string;
  from_date: string;
  to_date: string;
  total_days: number;
  reason?: string | null;
  status: LeaveStatus | string;
  current_approver_id?: string | null;
  version: number;
  created_at?: string | null;
  approval_chain?: ApprovalStep[];
  [key: string]: unknown;
}

export type LeaveListView = 'mine' | 'approvals' | 'all';

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
export function normalizeLeaveTypes(body: unknown): LeaveType[] {
  return asArray(body) as LeaveType[];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeBalances(body: unknown): LeaveBalance[] {
  return asArray(body) as LeaveBalance[];
}

/** Normalize a requests-list payload tolerating `{data,next_cursor,has_more}` and bare arrays. */
export function normalizeRequestsPage(body: unknown): CursorPage<LeaveRequest> {
  if (Array.isArray(body)) return { data: body as LeaveRequest[], next_cursor: null, has_more: false };
  if (isRecord(body)) {
    const nested = 'data' in body ? (body as { data: unknown }).data : undefined;
    const rows = Array.isArray(nested) ? (nested as LeaveRequest[]) : [];
    const rec = body as Record<string, unknown>;
    return {
      data: rows,
      next_cursor: typeof rec.next_cursor === 'string' ? rec.next_cursor : null,
      has_more: rec.has_more === true,
    };
  }
  return { data: [], next_cursor: null, has_more: false };
}

export type FileRequestResult =
  | { kind: 'created'; applied: false; request: LeaveRequest }
  | { kind: 'applied'; applied: true; request: LeaveRequest };

/**
 * Normalize POST /leave/requests responses:
 *   201 → bare request object
 *   200 → {applied:true, request} (idempotent replay of the same Idempotency-Key)
 * Tolerates one `{data:...}` envelope level around either shape.
 */
export function normalizeFileRequestResponse(body: unknown): FileRequestResult {
  const raw = denest(body);
  if (isRecord(raw) && raw.applied === true && isRecord(raw.request)) {
    return { kind: 'applied', applied: true, request: raw.request as unknown as LeaveRequest };
  }
  if (isRecord(raw) && typeof raw.id === 'string') {
    return { kind: 'created', applied: false, request: raw as unknown as LeaveRequest };
  }
  throw new Error('Unrecognized file-request response shape');
}

/** Normalize GET /leave/requests/:id (bare object, possibly enveloped). */
export function normalizeLeaveRequest(body: unknown): LeaveRequest {
  const raw = denest(body);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as LeaveRequest;
  throw new Error('Unrecognized leave-request shape');
}

/**
 * GET /api/v1/leave/preview result (fix round 1, item 2): exactly what
 * filing this range would charge, from the same day-counting function
 * filing itself uses -- the client never computes this on its own.
 */
export interface LeavePreviewResult {
  leave_type_id: string;
  is_paid: boolean;
  from_date: string;
  to_date: string;
  total_days: number;
  years: Array<{ year: number; days: number }>;
}

export function buildPreviewQuery(params: {
  leave_type_id: string;
  from_date: string;
  to_date: string;
  employee_id?: string;
}): string {
  const search = new URLSearchParams({
    leave_type_id: params.leave_type_id,
    from_date: params.from_date,
    to_date: params.to_date,
  });
  if (params.employee_id) search.set('employee_id', params.employee_id);
  return `/api/v1/leave/preview?${search.toString()}`;
}

export async function previewLeave(params: {
  leave_type_id: string;
  from_date: string;
  to_date: string;
  employee_id?: string;
}): Promise<LeavePreviewResult> {
  const { data } = await apiRequest<LeavePreviewResult>(buildPreviewQuery(params), { method: 'GET' });
  return data;
}

export async function listTypes(): Promise<LeaveType[]> {
  const { data } = await apiRequest<unknown>('/api/v1/leave/types', { method: 'GET' });
  return normalizeLeaveTypes(data);
}

export interface BalancesParams {
  employee_id?: string;
  period_year?: number | string;
}

export function buildBalancesQuery(params: BalancesParams = {}): string {
  const search = new URLSearchParams();
  if (params.employee_id) search.set('employee_id', params.employee_id);
  if (params.period_year !== undefined && params.period_year !== '') {
    search.set('period_year', String(params.period_year));
  }
  const qs = search.toString();
  return `/api/v1/leave/balances${qs ? `?${qs}` : ''}`;
}

export async function listBalances(params: BalancesParams = {}): Promise<LeaveBalance[]> {
  const { data } = await apiRequest<unknown>(buildBalancesQuery(params), { method: 'GET' });
  return normalizeBalances(data);
}

export async function upsertBalance(input: {
  employee_id: string;
  leave_type_id: string;
  period_year: number;
  opening_balance: number;
}): Promise<LeaveBalance> {
  const { data } = await apiRequest<LeaveBalance>('/api/v1/leave/balances', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return data;
}

/** POST /api/v1/leave-balances/open-year result (R5-008). */
export interface OpenYearResult {
  year: number;
  created: number;
  /**
   * Rows that already existed but had never actually been opened -- a
   * balance row self-healed empty by filing a leave request whose share of
   * that year was zero days under the sandwich rule, with no manual
   * adjustment on top -- backfilled to the entitlement rather than left
   * stuck at 0 forever (fix round 1, item 1).
   */
  filled: number;
  skipped: number;
  total: number;
  dry_run: boolean;
}

/**
 * Bulk-opens next year's balances (leave.admin). No carry-forward — every
 * matching employee x balance-requiring type opens at the type's plain
 * annual entitlement (owner decision, 2026-09-24: unused balance lapses).
 * `dry_run: true` reports the counts without writing anything.
 *
 * `year` is optional: leave it out and the server resolves it to the org's
 * own current-year-plus-one, in the org's timezone, and echoes it back in
 * the result (fix round 1, item 5) -- the caller does not have to guess
 * "next year" from the browser clock.
 */
export async function openYearBalances(input: {
  year?: number;
  leave_type_ids?: string[];
  employee_ids?: string[];
  dry_run?: boolean;
}): Promise<OpenYearResult> {
  const qs = input.dry_run ? '?dry_run=1' : '';
  const body: Record<string, unknown> = {};
  if (input.year !== undefined) body.year = input.year;
  if (input.leave_type_ids?.length) body.leave_type_ids = input.leave_type_ids;
  if (input.employee_ids?.length) body.employee_ids = input.employee_ids;
  const { data } = await apiRequest<OpenYearResult>(`/api/v1/leave-balances/open-year${qs}`, {
    method: 'POST',
    body,
  });
  return data;
}

export interface ListRequestsParams {
  status?: string;
  mine?: string;
  approver_me?: string;
  employee_id?: string;
  limit?: number;
  cursor?: string | null;
}

export function buildRequestsQuery(params: ListRequestsParams = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.mine) search.set('mine', params.mine);
  if (params.approver_me) search.set('approver_me', params.approver_me);
  if (params.employee_id) search.set('employee_id', params.employee_id);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/leave/requests${qs ? `?${qs}` : ''}`;
}

/**
 * Map the list view to query params:
 *   mine      → mine=true
 *   approvals → approver_me=true
 *   all       → employee_id passthrough (optional filter)
 */
export function buildLeaveListParams(
  view: LeaveListView,
  opts: { status?: string; employee_id?: string; limit?: number; cursor?: string | null } = {},
): ListRequestsParams {
  const base: ListRequestsParams = {
    status: opts.status || undefined,
    limit: opts.limit,
    cursor: opts.cursor ?? undefined,
  };
  if (view === 'mine') return { ...base, mine: 'true' };
  if (view === 'approvals') return { ...base, approver_me: 'true' };
  return { ...base, employee_id: opts.employee_id || undefined };
}

export async function listRequests(params: ListRequestsParams = {}): Promise<CursorPage<LeaveRequest>> {
  const { data, request_id } = await apiRequest<unknown>(buildRequestsQuery(params), { method: 'GET' });
  return { ...normalizeRequestsPage(data), request_id };
}

export async function fileRequest(input: {
  leave_type_id: string;
  from_date: string;
  to_date: string;
  reason?: string;
}): Promise<FileRequestResult> {
  const { data } = await apiRequest<unknown>('/api/v1/leave/requests', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeFileRequestResponse(data);
}

export async function getRequest(id: string): Promise<LeaveRequest> {
  const { data } = await apiRequest<unknown>(`/api/v1/leave/requests/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeLeaveRequest(data);
}

export async function decideRequest(
  id: string,
  input: { decision: LeaveDecision; note?: string },
  version: number | string,
): Promise<LeaveRequest> {
  const { data } = await apiRequest<LeaveRequest>(
    `/api/v1/leave/requests/${encodeURIComponent(id)}/decision`,
    { method: 'POST', headers: { 'If-Match': String(version) }, body: input as unknown as Record<string, unknown> },
  );
  return data;
}

export async function cancelRequest(id: string, input: { reason?: string } = {}): Promise<LeaveRequest> {
  const { data } = await apiRequest<LeaveRequest>(
    `/api/v1/leave/requests/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: input as unknown as Record<string, unknown> },
  );
  return data;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Inclusive day count for a YYYY-MM-DD range (server re-computes; this is the
 * live client-side preview). Returns null when either date is unparseable;
 * returns ≤0 when from > to (callers treat that as invalid).
 */
export function inclusiveDays(from: string, to: string): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** Today as YYYY-MM-DD in local time (client-side backdate check; server re-validates). */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** True when `from` is strictly before today (backdated → reason required). */
export function isBackdated(from: string, today: string = todayLocal()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  return from < today;
}

/** True for unpaid / no-balance-check types (LOP skips the balance hint). */
export function isUnpaidType(t: Pick<LeaveType, 'code' | 'is_paid' | 'requires_balance'> | undefined | null): boolean {
  if (!t) return false;
  return t.code === 'LOP' || t.is_paid === false || t.requires_balance === false;
}

/** Find the balance row for a leave type, or undefined when none applies (e.g. LOP). */
export function findBalanceForType(
  balances: LeaveBalance[],
  type: Pick<LeaveType, 'id' | 'code' | 'is_paid' | 'requires_balance'> | undefined | null,
): LeaveBalance | undefined {
  if (!type || isUnpaidType(type)) return undefined;
  return balances.find((b) => b.leave_type_id === type.id || b.leave_code === type.code);
}

/** Total entitlement pool for a balance row (opening + credits + adjustments). */
export function balanceTotal(b: LeaveBalance): number {
  return (Number(b.opening_balance) || 0) + (Number(b.credits) || 0) + (Number(b.adjustments) || 0);
}

/** Render a day count as "1 day" / "N days"; "—" when missing/invalid. */
export function formatDays(totalDays: unknown): string {
  if (typeof totalDays !== 'number' || !Number.isFinite(totalDays) || totalDays < 0) return '—';
  return totalDays === 1 ? '1 day' : `${totalDays} days`;
}

export const statusBadgeTone: Record<string, 'warning' | 'success' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export function toneForLeaveStatus(status: string): 'warning' | 'success' | 'danger' | 'neutral' {
  return statusBadgeTone[status] ?? 'neutral';
}

/** Raw extra fields the server attached to an error envelope (see apiClient details). */
export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ApiClientError) {
    const details = error.details ?? {};
    // Server nests rule data under `extra` (e.g. {extra:{available}}) — merge
    // one level so parsers below work with either shape.
    const nested = details['extra'];
    return isRecord(nested) ? { ...details, ...nested } : details;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/** INSUFFICIENT_BALANCE carries `{available}` — null when absent/unparseable. */
export function parseInsufficientBalance(error: unknown): number | null {
  const raw = errorDetails(error).available;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** LEAVE_OVERLAP may carry conflicting request ids (`conflicting_ids` / `conflicting_request_ids`). */
export function parseOverlapIds(error: unknown): string[] {
  const d = errorDetails(error);
  return asStringArray(d.conflicting_ids ?? d.conflicting_request_ids ?? d.conflicting_dates);
}

/** ATTENDANCE_CONFLICT carries `{conflicting_dates: [...]}`. */
export function parseAttendanceConflictDates(error: unknown): string[] {
  return asStringArray(errorDetails(error).conflicting_dates);
}
