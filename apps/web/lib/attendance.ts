import { apiRequest, apiRequestRaw } from './apiClient';
import type { CursorPage } from './employees';

/**
 * S2 attendance client (frozen contract).
 *
 * Punch flow (POST /api/v1/attendance/events, Idempotency-Key REQUIRED):
 *   201 → {event, record, decision:"ACCEPTED"}  (fresh punch applied)
 *   200 → {applied:true, event, record}         (idempotent replay of same key)
 *   202 → {review:"REQUIRES_REVIEW", code, exception_id, message} (routed to review)
 *   422 → error envelope with code EMPLOYEE_INACTIVE | FUTURE_PUNCH |
 *         CHECKOUT_WITHOUT_CHECKIN | DUPLICATE_CHECKIN | RECORD_CLOSED |
 *         MISSING_IDEMPOTENCY_KEY (surfaced as ApiClientError).
 *
 * Records list tolerates both `{data:[...]}` envelopes and bare arrays
 * (same tolerance pattern as S1 documents).
 *
 * NOTE (S2 contract gap): there is NO `GET /attendance/exceptions` list
 * endpoint. The exceptions queue UI therefore works from known exception
 * ids only — ids returned by fileException, by 202 punch responses
 * (exception_id), or entered manually. A server-side list endpoint is an
 * S3 backend gap; see apps/web/README.md.
 */

export type PunchEventType = 'CHECK_IN' | 'CHECK_OUT';
export type RecordStatus = 'PRESENT' | 'PARTIAL' | 'ABSENT';
export type ExceptionType =
  | 'MISSED_PUNCH'
  | 'LATE_CHECKIN'
  | 'EARLY_CHECKOUT'
  /** Legacy: raised while geo-fencing existed (removed 2026-09-22). Never filed anew. */
  | 'OUTSIDE_GEOFENCE'
  | 'REGULARIZATION'
  | 'SYSTEM_FLAG';
export type ExceptionDecision = 'APPROVE' | 'REJECT';

export interface AttendanceEvent {
  id: string;
  employee_id: string;
  event_type: PunchEventType;
  client_timestamp: string;
  latitude?: number | null;
  longitude?: number | null;
  gps_accuracy?: number | null;
  [key: string]: unknown;
}

export interface AttendanceRecord {
  id: string;
  employee_id: string;
  work_date: string;
  status: RecordStatus | string;
  check_in_at?: string | null;
  check_out_at?: string | null;
  total_hours?: number | null;
  version: number;
  [key: string]: unknown;
}

export interface AttendanceException {
  id: string;
  employee_id: string;
  attendance_record_id?: string | null;
  exception_type: ExceptionType | string;
  reason: string;
  status?: string;
  version: number;
  [key: string]: unknown;
}

export interface PunchInput {
  employee_id: string;
  event_type: PunchEventType;
  client_timestamp: string;
  latitude?: number;
  longitude?: number;
  gps_accuracy?: number;
  mock_location?: boolean;
  device_id?: string;
  app_version?: string;
}

export type PunchResult =
  | { kind: 'accepted'; event: AttendanceEvent; record: AttendanceRecord }
  | { kind: 'applied'; applied: true; event: AttendanceEvent; record: AttendanceRecord }
  | { kind: 'review'; code: string; exception_id: string | null; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip one `{data:...}` envelope level if present (apiClient usually does this already). */
function denest(body: unknown): unknown {
  if (isRecord(body) && isRecord(body.data) && ('event' in body.data || 'record' in body.data || 'review' in body.data || 'decision' in body.data || 'applied' in body.data)) {
    return body.data;
  }
  return body;
}

/**
 * Normalize a punch response body into a discriminated PunchResult by
 * presence of the `decision` / `applied` / `review` keys (i.e. 201 / 200 /
 * 202 respectively). Throws on unrecognized shapes.
 */
export function normalizePunchResponse(body: unknown): PunchResult {
  const raw = denest(body);
  if (!isRecord(raw)) throw new Error('Unrecognized punch response shape');
  if (raw.review === 'REQUIRES_REVIEW' || ('code' in raw && 'exception_id' in raw && !('event' in raw))) {
    return {
      kind: 'review',
      code: typeof raw.code === 'string' ? raw.code : 'REQUIRES_REVIEW',
      exception_id: typeof raw.exception_id === 'string' ? raw.exception_id : null,
      message: typeof raw.message === 'string' ? raw.message : 'Punch routed to review.',
    };
  }
  if (raw.applied === true && isRecord(raw.event) && isRecord(raw.record)) {
    return {
      kind: 'applied',
      applied: true,
      event: raw.event as unknown as AttendanceEvent,
      record: raw.record as unknown as AttendanceRecord,
    };
  }
  if (isRecord(raw.event) && isRecord(raw.record)) {
    return {
      kind: 'accepted',
      event: raw.event as unknown as AttendanceEvent,
      record: raw.record as unknown as AttendanceRecord,
    };
  }
  throw new Error('Unrecognized punch response shape');
}

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/**
 * POST a punch event. Always sends an explicit Idempotency-Key (generated
 * when the caller does not supply one) so retries/replays are safe; the
 * shared apiClient would otherwise mint a fresh key per attempt.
 */
export async function punchEvent(input: PunchInput, opts?: { idempotencyKey?: string }): Promise<PunchResult> {
  const { data } = await apiRequest<unknown>('/api/v1/attendance/events', {
    method: 'POST',
    headers: { 'Idempotency-Key': opts?.idempotencyKey ?? newIdempotencyKey() },
    body: input as unknown as Record<string, unknown>,
  });
  return normalizePunchResponse(data);
}

export interface ListRecordsParams {
  employee_id?: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
  cursor?: string | null;
}

export function buildRecordsQuery(params: ListRecordsParams = {}): string {
  const search = new URLSearchParams();
  if (params.employee_id) search.set('employee_id', params.employee_id);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.status) search.set('status', params.status);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  const qs = search.toString();
  return `/api/v1/attendance/records${qs ? `?${qs}` : ''}`;
}

/** Normalize a records-list payload tolerating `{data, next_cursor, has_more}` and bare arrays. */
export function normalizeRecordsPage(body: unknown): CursorPage<AttendanceRecord> {
  if (Array.isArray(body)) return { data: body, next_cursor: null, has_more: false };
  if (isRecord(body)) {
    const nested = body.data;
    const rows = Array.isArray(nested) ? (nested as AttendanceRecord[]) : Array.isArray(body) ? [] : [];
    return {
      data: rows,
      next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
      has_more: body.has_more === true,
    };
  }
  return { data: [], next_cursor: null, has_more: false };
}

export async function listRecords(params: ListRecordsParams = {}): Promise<CursorPage<AttendanceRecord>> {
  const { data, request_id } = await apiRequest<unknown>(buildRecordsQuery(params), { method: 'GET' });
  return { ...normalizeRecordsPage(data), request_id };
}

/**
 * Your own days, without the supervisor's grant.
 *
 * GET /attendance/records needs attendance.read, which an EMPLOYEE does not
 * hold; the server answers their own history at /attendance/me instead. The
 * punch clock read the register, was refused, and told everybody who could
 * only punch that they had not punched in yet -- so their second press of
 * the day was refused as a duplicate.
 */
export async function listMyRecords(
  params: Omit<ListRecordsParams, 'employee_id'> = {},
): Promise<CursorPage<AttendanceRecord>> {
  const url = buildRecordsQuery(params).replace('/api/v1/attendance/records', '/api/v1/attendance/me');
  const { data, request_id } = await apiRequest<unknown>(url, { method: 'GET' });
  return { ...normalizeRecordsPage(data), request_id };
}

export interface RecordDetail {
  record: AttendanceRecord;
  events: AttendanceEvent[];
}

/**
 * Normalize GET /attendance/records/:id tolerating:
 * `{record, events[]}`, `{data:{record, events[]}}`, and flat
 * `{...recordFields, events:[]}` shapes.
 */
export function normalizeRecordDetail(body: unknown): RecordDetail {
  const raw = isRecord(body) && isRecord(body.data) && !Array.isArray(body.data) ? body.data : body;
  if (isRecord(raw) && isRecord(raw.record)) {
    const events = Array.isArray(raw.events) ? (raw.events as AttendanceEvent[]) : [];
    return { record: raw.record as unknown as AttendanceRecord, events };
  }
  if (isRecord(raw) && Array.isArray(raw.events)) {
    const { events, ...rest } = raw;
    return { record: rest as unknown as AttendanceRecord, events: events as AttendanceEvent[] };
  }
  throw new Error('Unrecognized record-detail shape');
}

export async function getRecord(id: string): Promise<RecordDetail> {
  const { data } = await apiRequest<unknown>(`/api/v1/attendance/records/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return normalizeRecordDetail(data);
}

export async function fileException(input: {
  employee_id: string;
  attendance_record_id?: string;
  exception_type: string;
  reason: string;
  document_id?: string;
}): Promise<AttendanceException> {
  const { data } = await apiRequest<AttendanceException>('/api/v1/attendance/exceptions', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return data;
}

export async function decideException(
  id: string,
  input: { decision: ExceptionDecision; note?: string },
  version: number | string,
): Promise<AttendanceException> {
  const { data } = await apiRequest<AttendanceException>(
    `/api/v1/attendance/exceptions/${encodeURIComponent(id)}/decision`,
    { method: 'PATCH', headers: { 'If-Match': String(version) }, body: input as unknown as Record<string, unknown> },
  );
  return data;
}

export async function regularize(input: {
  employee_id: string;
  work_date: string;
  claimed_check_in?: string;
  claimed_check_out?: string;
  reason: string;
}): Promise<AttendanceException> {
  const { data } = await apiRequest<AttendanceException>('/api/v1/attendance/regularize', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return data;
}

/** Render total_hours (decimal hours) as "7h 30m"; "—" when absent/invalid. */
export function formatHours(totalHours: unknown): string {
  if (typeof totalHours !== 'number' || !Number.isFinite(totalHours) || totalHours < 0) return '—';
  const totalMinutes = Math.round(totalHours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0 && m === 0) return '0m';
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** One positioned punch, shaped for the operations map. */
export interface AttendanceMapEvent {
  id: string;
  employee_id: string;
  event_type: string;
  at: string;
  lat: number;
  lng: number;
  /** Precomputed server-side so the map colours by one field. */
  outcome: 'ok' | 'review';
}

/**
 * Positioned punches for the map. Separate from listRecords because records
 * carry no coordinates — only the underlying events do.
 */
export async function listMapEvents(params: {
  employee_id?: string;
  from?: string;
  to?: string;
  limit?: number;
} = {}): Promise<{ data: AttendanceMapEvent[]; truncated: boolean }> {
  const search = new URLSearchParams();
  if (params.employee_id) search.set('employee_id', params.employee_id);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  search.set('limit', String(params.limit ?? 1000));
  // apiRequestRaw, not apiRequest: the unwrap in apiRequest strips the `data`
  // envelope and discards its siblings, which would drop `truncated` — the one
  // signal telling the user the map is showing a partial set.
  const { body } = await apiRequestRaw(`/api/v1/attendance/events/map?${search.toString()}`);
  const envelope = (body ?? {}) as { data?: AttendanceMapEvent[]; truncated?: boolean };
  return {
    data: Array.isArray(envelope.data) ? envelope.data : [],
    truncated: envelope.truncated === true,
  };
}
