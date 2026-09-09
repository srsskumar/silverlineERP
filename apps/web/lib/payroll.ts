import { ApiClientError, apiRequest } from './apiClient';
import { PERMISSIONS } from './permissions';

/**
 * P1 payroll client (frozen contract).
 *
 *   GET/PATCH /api/v1/payroll/policy {per_day_divisor, pf_pct}
 *   POST /api/v1/payroll/runs {period_start, period_end} → 201 OPEN
 *     (PERIOD_TOO_LONG / OVERLAPPING_RUN 422)
 *   GET  /api/v1/payroll/runs?status=
 *   GET  /api/v1/payroll/runs/:id → run + totals + warnings[]
 *   POST /:id/calculate     → CALCULATED (NO_ATTENDANCE_DATA 422)
 *   POST /:id/submit-review → REVIEW
 *   POST /:id/approve {note?} → APPROVED
 *   POST /:id/lock          → LOCKED
 *   POST /:id/reopen {reason} → APPROVED (reopen branch out of LOCKED)
 *   Wrong-state transitions → 422 RUN_SEALED (message names the expected state).
 *   GET  /:id/payslips → {data:[{id,employee_id,emp_no,employee_name,gross,total_deductions,net_pay}]}
 *   GET  /api/v1/payslips/me?period_start=&period_end= → full slip
 *     (404 NO_PAYSLIP / NO_EMPLOYEE_LINK).
 *
 * No version / If-Match on run transitions in P1 — the state machine is the
 * guard. List/single responses tolerate `{data:...}` envelopes and bare
 * payloads (S1/S2 pattern).
 */

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  'OPEN',
  'VALIDATING',
  'CALCULATED',
  'REVIEW',
  'APPROVED',
  'LOCKED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Canonical display order for the stepper (OPEN → … → LOCKED). */
export const RUN_STATUS_FLOW: readonly string[] = RUN_STATUSES;

/** Position of a status in the flow; -1 for unknown statuses. */
export function runStatusIndex(status: string): number {
  return RUN_STATUS_FLOW.indexOf(status);
}

export type RunTransitionEndpoint = 'calculate' | 'submit-review' | 'approve' | 'lock' | 'reopen';

export interface RunAction {
  label: string;
  endpoint: RunTransitionEndpoint;
  /** Permission code gating the button (exact server code). */
  perm: string;
}

/**
 * Next state-machine action for a run, or null when the run is in a
 * non-actionable state (VALIDATING is transitional; unknown statuses have
 * no mapped transition). Reopen (LOCKED → APPROVED) is gated by
 * `payroll.lock` — the same authority that seals the run unseals it.
 */
export function nextAction(run: { status: string } | string | null | undefined): RunAction | null {
  const status = typeof run === 'string' ? run : run?.status;
  switch (status) {
    case 'OPEN':
      return { label: 'Calculate', endpoint: 'calculate', perm: PERMISSIONS.PAYROLL_GENERATE };
    case 'VALIDATING':
      return null;
    case 'CALCULATED':
      return { label: 'Submit for review', endpoint: 'submit-review', perm: PERMISSIONS.PAYROLL_GENERATE };
    case 'REVIEW':
      return { label: 'Approve', endpoint: 'approve', perm: PERMISSIONS.PAYROLL_APPROVE };
    case 'APPROVED':
      return { label: 'Lock', endpoint: 'lock', perm: PERMISSIONS.PAYROLL_LOCK };
    case 'LOCKED':
      return { label: 'Reopen', endpoint: 'reopen', perm: PERMISSIONS.PAYROLL_LOCK };
    default:
      return null;
  }
}

export const runStatusTone: Record<string, 'warning' | 'success' | 'danger' | 'neutral' | 'info'> = {
  OPEN: 'neutral',
  VALIDATING: 'info',
  CALCULATED: 'info',
  REVIEW: 'warning',
  APPROVED: 'success',
  LOCKED: 'neutral',
};

export function toneForRunStatus(status: string): 'warning' | 'success' | 'danger' | 'neutral' | 'info' {
  return runStatusTone[status] ?? 'neutral';
}

/** Display tone for a calculation warning code. */
export function warningTone(code: string): 'warning' | 'danger' | 'info' | 'neutral' {
  if (code === 'NO_SALARY') return 'danger';
  if (code === 'NO_RECORDS') return 'warning';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Money + period helpers (display only)
// ---------------------------------------------------------------------------

/** INR money formatter (en-IN, 2dp); "—" for missing/non-numeric values. */
export function inr(value: unknown): string {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

const DAY_MS = 86_400_000;

function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Inclusive calendar-day span for a YYYY-MM-DD range. Null when either date
 * is unparseable; ≤0 when start > end (callers treat that as invalid).
 */
export function periodSpanDays(start: string, end: string): number | null {
  const a = parseDay(start);
  const b = parseDay(end);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** First day (YYYY-MM-DD) of the month containing `d` (local time). */
export function firstDayOfMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

/** Last day (YYYY-MM-DD) of the month containing `d` (local time). */
export function lastDayOfMonth(d: Date = new Date()): string {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(last)}`;
}

/** "2026-09-01 → 2026-09-30" range label. */
export function formatPeriod(start: string, end: string): string {
  return `${start} → ${end}`;
}

// ---------------------------------------------------------------------------
// Shapes + normalizers
// ---------------------------------------------------------------------------

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

export interface PayrollPolicy {
  per_day_divisor: number;
  pf_pct: number;
  [key: string]: unknown;
}

/** Tolerate enveloped and bare policy payloads. */
export function normalizePolicy(body: unknown): PayrollPolicy {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized payroll-policy shape');
  return raw as unknown as PayrollPolicy;
}

export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  status: string;
  version?: number;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface PayrollTotals {
  gross: number;
  total_deductions: number;
  net_pay: number;
  headcount: number;
  [key: string]: unknown;
}

export interface PayrollWarning {
  code: string;
  message: string;
  employee_id?: string | null;
  [key: string]: unknown;
}

export interface RunDetail {
  run: PayrollRun;
  totals: PayrollTotals | null;
  warnings: PayrollWarning[];
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizeRunsPage(body: unknown): PayrollRun[] {
  return asArray(body) as PayrollRun[];
}

/**
 * Normalize GET /payroll/runs/:id. Tolerates `{run,totals,warnings[]}` and
 * flat `{id,status,…,totals?,warnings?}` shapes, each optionally enveloped.
 */
export function normalizeRunDetail(body: unknown): RunDetail {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized payroll-run shape');
  const nested = isRecord(raw.run) ? (raw.run as Record<string, unknown>) : null;
  const runSource = nested && typeof nested.id === 'string' ? nested : raw;
  if (typeof runSource.id !== 'string' || typeof runSource.status !== 'string') {
    throw new Error('Unrecognized payroll-run shape');
  }
  const totalsSource = isRecord(raw.totals) ? raw.totals : null;
  const warningsSource = Array.isArray(raw.warnings) ? raw.warnings : [];
  // Server names the discriminator `type`; UI reads `code` — bridge both.
  const warnings = (warningsSource as Record<string, unknown>[]).map((w) => ({
    ...w,
    code: typeof w.code === 'string' ? w.code : (w.type as string | undefined),
  })) as PayrollWarning[];
  return {
    run: runSource as unknown as PayrollRun,
    totals: totalsSource ? (totalsSource as unknown as PayrollTotals) : null,
    warnings,
  };
}

export interface PayslipRow {
  id: string;
  employee_id: string;
  emp_no: string;
  employee_name: string;
  gross: number;
  total_deductions: number;
  net_pay: number;
  [key: string]: unknown;
}

/** Tolerate `{data:[...]}` envelopes and bare arrays. */
export function normalizePayslipsPage(body: unknown): PayslipRow[] {
  return asArray(body) as PayslipRow[];
}

export interface MyPayslip {
  id: string;
  period: { start: string; end: string };
  run_status: string;
  employee: { emp_no: string; name: string; designation?: string | null };
  earnings: Record<string, number>;
  deductions: Record<string, number>;
  gross: number;
  total_deductions: number;
  net_pay: number;
  version: number;
  [key: string]: unknown;
}

/** Normalize GET /payroll/payslips/me (bare or enveloped). */
export function normalizeMyPayslip(body: unknown): MyPayslip {
  const raw = denest(body);
  if (!isRecord(raw) || typeof raw.id !== 'string') {
    throw new Error('Unrecognized payslip shape');
  }
  return raw as unknown as MyPayslip;
}

// ---------------------------------------------------------------------------
// Error parsers (codes ride on ApiClientError.code; extras on .details)
// ---------------------------------------------------------------------------

/** Raw extra fields the server attached to an error envelope (incl. nested `extra`). */
export function payrollErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ApiClientError) {
    const details = error.details ?? {};
    const nested = details['extra'];
    return isRecord(nested) ? { ...details, ...nested } : details;
  }
  return {};
}

function codeOf(error: unknown): string | null {
  return error instanceof ApiClientError ? error.code : null;
}

/** True for wrong-state transition rejections (message names the expected state). */
export function isRunSealed(error: unknown): boolean {
  return codeOf(error) === 'RUN_SEALED';
}

/**
 * Extract the expected state named by a RUN_SEALED message
 * (e.g. "Run must be CALCULATED to submit for review" → "CALCULATED").
 * Null when the code differs or no known status token is present.
 */
export function parseRunSealedExpected(error: unknown): string | null {
  if (!isRunSealed(error)) return null;
  const message = error instanceof ApiClientError ? error.message : '';
  const match = String(message).match(/\b(OPEN|VALIDATING|CALCULATED|REVIEW|APPROVED|LOCKED)\b/);
  return match ? match[1] : null;
}

/** True when calculation found no attendance data for the period. */
export function isNoAttendanceData(error: unknown): boolean {
  return codeOf(error) === 'NO_ATTENDANCE_DATA';
}

/** True when the requested period overlaps an existing run. */
export function isOverlappingRun(error: unknown): boolean {
  return codeOf(error) === 'OVERLAPPING_RUN';
}

/** True when the requested period exceeds the server-side length cap. */
export function isPeriodTooLong(error: unknown): boolean {
  return codeOf(error) === 'PERIOD_TOO_LONG';
}

/** True when no payslip exists for the requested period (own slip). */
export function isNoPayslip(error: unknown): boolean {
  return codeOf(error) === 'NO_PAYSLIP';
}

/** True when the caller has no linked employee record (own slip). */
export function isNoEmployeeLink(error: unknown): boolean {
  return codeOf(error) === 'NO_EMPLOYEE_LINK';
}

// ---------------------------------------------------------------------------
// Typed endpoints (thin wrappers over apiRequest)
// ---------------------------------------------------------------------------

export async function getPolicy(): Promise<PayrollPolicy> {
  const { data } = await apiRequest<unknown>('/api/v1/payroll/policy', { method: 'GET' });
  return normalizePolicy(data);
}

export async function updatePolicy(input: {
  per_day_divisor: number;
  pf_pct: number;
}): Promise<PayrollPolicy> {
  const { data } = await apiRequest<unknown>('/api/v1/payroll/policy', {
    method: 'PATCH',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizePolicy(data);
}

export interface ListRunsParams {
  status?: string;
}

export function buildRunsQuery(params: ListRunsParams = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  const qs = search.toString();
  return `/api/v1/payroll/runs${qs ? `?${qs}` : ''}`;
}

export async function listRuns(params: ListRunsParams = {}): Promise<PayrollRun[]> {
  const { data } = await apiRequest<unknown>(buildRunsQuery(params), { method: 'GET' });
  return normalizeRunsPage(data);
}

export async function createRun(input: {
  period_start: string;
  period_end: string;
}): Promise<RunDetail> {
  const { data } = await apiRequest<unknown>('/api/v1/payroll/runs', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return normalizeRunDetail(data);
}

export async function getRun(id: string): Promise<RunDetail> {
  const { data } = await apiRequest<unknown>(`/api/v1/payroll/runs/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeRunDetail(data);
}

function runTransitionPath(id: string, endpoint: RunTransitionEndpoint): string {
  return `/api/v1/payroll/runs/${encodeURIComponent(id)}/${endpoint}`;
}

async function transitionRun(
  id: string,
  endpoint: RunTransitionEndpoint,
  body?: Record<string, unknown>,
): Promise<RunDetail> {
  const { data } = await apiRequest<unknown>(runTransitionPath(id, endpoint), {
    method: 'POST',
    ...(body ? { body } : {}),
  });
  return normalizeRunDetail(data);
}

/** OPEN → CALCULATED (422 NO_ATTENDANCE_DATA when the period has no attendance). */
export async function calculateRun(id: string): Promise<RunDetail> {
  return transitionRun(id, 'calculate');
}

/** CALCULATED → REVIEW. */
export async function submitReviewRun(id: string): Promise<RunDetail> {
  return transitionRun(id, 'submit-review');
}

/** REVIEW → APPROVED (note optional). */
export async function approveRun(id: string, input: { note?: string } = {}): Promise<RunDetail> {
  const body: Record<string, unknown> = {};
  if (input.note?.trim()) body.note = input.note.trim();
  return transitionRun(id, 'approve', body);
}

/** APPROVED → LOCKED. */
export async function lockRun(id: string): Promise<RunDetail> {
  return transitionRun(id, 'lock');
}

/** LOCKED → APPROVED (reason required — the reopen branch). */
export async function reopenRun(id: string, input: { reason: string; recalculate?:boolean }): Promise<RunDetail> {
  return transitionRun(id, 'reopen', input);
}

export async function listPayslips(runId: string): Promise<PayslipRow[]> {
  const { data } = await apiRequest<unknown>(
    `/api/v1/payroll/runs/${encodeURIComponent(runId)}/payslips`,
    { method: 'GET' },
  );
  return normalizePayslipsPage(data);
}

export interface MyPayslipParams {
  period_start: string;
  period_end: string;
}

export function buildMyPayslipQuery(params: MyPayslipParams): string {
  const search = new URLSearchParams();
  search.set('period_start', params.period_start);
  search.set('period_end', params.period_end);
  return `/api/v1/payslips/me?${search.toString()}`;
}

export async function getMyPayslip(params: MyPayslipParams): Promise<MyPayslip> {
  const { data } = await apiRequest<unknown>(buildMyPayslipQuery(params), { method: 'GET' });
  return normalizeMyPayslip(data);
}
