import {deviceId} from "../device/registration";
import { cachedRead } from "../sync/db";
/**
 * Typed endpoint wrappers over apiFetch. All paths carry the /api/v1 prefix.
 *
 * Contract assumptions (verified against apps/api routes + packages/shared;
 * full table in README):
 *  - login { username, password, totp_code? } → { access_token,
 *    refresh_token, mfa_required } | { mfa_required: true }
 *  - mfa verify body is { code } (shared mfaVerifySchema); a { token }
 *    alias is ALSO accepted here and mapped to { code }.
 *  - status advance REQUIRES If-Match: <version> (missing → 428-class 422
 *    from ifMatchVersion). Always send it.
 *  - evidence upload is plain base64 JSON POST /tasks/:id/evidence
 *    { evidence_type, file_name, content_base64 } — NO R2 presign endpoint
 *    exists; see sync/queue.ts + README upgrade path.
 */

import { apiFetch, asItem, asList, asPage, type Page } from "./client";
import type { CircleGeometry, PolygonGeometry, FenceShape } from "@silverline/shared";
import type { MonitoredFence } from "../device/geofencing";

// --- Auth -------------------------------------------------------------------

export interface LoginOk {
  access_token: string;
  refresh_token: string;
  mfa_required: false;
  user?: unknown;
}
export interface LoginMfa {
  mfa_required: true;
}
export type LoginResponse = LoginOk | LoginMfa;

export async function postLogin(
  username: string,
  password: string,
  totpCode?: string,
): Promise<LoginResponse> {
  const { data } = await apiFetch<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    noAuthRetry: true,
    body: {
      username,
      password,
      device_id:await deviceId(),
      ...(totpCode ? { totp_code: totpCode } : {}),
    },
  });
  return data;
}

/** Accepts { code } (backend truth) or { token } (brief shorthand). */
export async function postMfaVerify(
  codeOrToken: string,
): Promise<{ enabled?: boolean; mfa_enabled?: boolean }> {
  const { data } = await apiFetch("/api/v1/auth/mfa/verify", {
    method: "POST",
    body: { code: codeOrToken },
  });
  return asItem(data);
}

export async function postLogout(refreshToken?: string): Promise<void> {
  await apiFetch("/api/v1/auth/logout", {
    method: "POST",
    body: refreshToken ? { refresh_token: refreshToken } : {},
  }).catch(() => undefined);
}

export interface MeResponse {
  user: {
    id: string;
    username: string;
    email: string | null;
    phone: string | null;
    org_id: string;
    auth_status: string;
    mfa_enabled: boolean;
    mfa_enrollment_required?:boolean;
    timezone?:string;
    last_login_at: string | null;
  };
  roles: string[];
  permissions: string[];
}

export async function getMe(): Promise<MeResponse> {
  const { data } = await apiFetch<MeResponse>("/api/v1/auth/me");
  return data;
}

// --- Employees ---------------------------------------------------------------

export interface Employee {
  id: string;
  employee_no?: string;
  full_name?: string;
  name?: string;
  status?: string;
  [k: string]: unknown;
}

export async function getEmployeesMe(): Promise<Employee> {
  const { data } = await cachedRead("getEmployeesMe", () => apiFetch("/api/v1/employees/me"));
  return asItem<Employee>(data, "employee");
}

// --- Survey ---------------------------------------------------------------------

/** One of the villages this person is crewed to today. */
export interface MyVillage {
  id: string;
  village_name: string;
  village_code: string | null;
  mandal_name: string | null;
  district_name: string | null;
  project_name: string;
  stage_code: string;
  stage_label: string;
  /** Whether today's progress return has already been filed for it. */
  filed_today: boolean;
}

/**
 * The villages this person is working, and what is outstanding on them.
 *
 * The punch screen needs this before the punch, not after: checking out of a
 * field day asks for the day's return, and the app has to know which village
 * that is and whether it is already in.
 */
export async function getMyVillages(): Promise<{ villages: MyVillage[]; workDate: string }> {
  const { data } = await cachedRead("getMyVillages", () =>
    apiFetch<{ data: MyVillage[]; work_date: string }>("/api/v1/survey/me/villages"));
  const body = data as { data?: MyVillage[]; work_date?: string } | null;
  return { villages: body?.data ?? [], workDate: body?.work_date ?? "" };
}

// --- Attendance ----------------------------------------------------------------

export type AttendanceEventType = "CHECK_IN" | "CHECK_OUT";

export interface AttendanceEventInput {
  employee_id: string;
  event_type: AttendanceEventType;
  client_timestamp: string;
  /** Which village this punch is for. Absent on an office or training day. */
  survey_village_id?: string;
  /** Why the day's return is not being filed at punch-out. */
  progress_deferred_reason?: string;
  progress_deferred_remarks?: string;
  /** Set by the sync engine when this punch is a replay, not a live one. */
  queued_offline?: boolean;
  latitude?: number;
  longitude?: number;
  gps_accuracy?: number;
  mock_location?: boolean;
  device_id?: string;
  app_version?: string;
}

export interface AttendancePunchResult {
  kind: "ACCEPTED" | "ALREADY_APPLIED" | "REVIEW";
  event?: unknown;
  record?: unknown;
  code?: string;
  exception_id?: string;
  message?: string;
}

export async function postAttendanceEvent(
  input: AttendanceEventInput,
  idempotencyKey?: string,
): Promise<{ result: AttendancePunchResult; status: number }> {
  const { data: json, status } = await apiFetch<Record<string, unknown>>("/api/v1/attendance/events", {method:"POST",body:input,idempotencyKey});
  const res = { status, ok: true };
  if (res.status === 202 || json?.review === "REQUIRES_REVIEW") {
    return {
      status: res.status,
      result: {
        kind: "REVIEW",
        code: typeof json?.code === "string" ? json.code : undefined,
        exception_id:
          typeof json?.exception_id === "string" ? json.exception_id : undefined,
        message: typeof json?.message === "string" ? json.message : undefined,
      },
    };
  }
  if (!res.ok) {
    const { ApiError } = await import("./client");
    throw new ApiError({
      status: res.status,
      code: typeof json?.code === "string" ? json.code : "REQUEST_FAILED",
      message:
        typeof json?.message === "string"
          ? json.message
          : `Punch failed (${res.status})`,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  if (res.status === 200 && json?.applied === true) {
    return {
      status: 200,
      result: { kind: "ALREADY_APPLIED", event: json.event, record: json.record },
    };
  }
  return {
    status: res.status,
    result: { kind: "ACCEPTED", event: json?.event, record: json?.record },
  };
}

export interface AttendanceRecord {
  id: string;
  work_date?: string;
  status?: string;
  [k: string]: unknown;
}

export async function getAttendanceRecords(params?: {
  employee_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<AttendanceRecord[]> {
  const q = new URLSearchParams();
  if (params?.employee_id) q.set("employee_id", params.employee_id);
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  if (params?.limit) q.set("limit", String(params.limit));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const { data } = await cachedRead("getAttendanceRecords"+JSON.stringify(params??{}), () => apiFetch(
    `/api/v1/attendance/me${suffix}`,
  ));
  return asList<AttendanceRecord>(data);
}

export interface AttendanceExceptionInput {
  employee_id: string;
  attendance_record_id?: string;
  exception_type: string;
  reason: string;
}

export async function postAttendanceException(
  input: AttendanceExceptionInput,
  idempotencyKey?: string,
): Promise<unknown> {
  const { data } = await apiFetch("/api/v1/attendance/exceptions", {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return data;
}

// --- Tasks -------------------------------------------------------------------

export interface Task {
  id: string;
  title: string;
  status: string;
  version: number;
  project_id?: string;
  assignee_id?: string | null;
  allowed_next?: string[];
  [k: string]: unknown;
}

export interface TaskDetail extends Task {
  subtasks?: Array<{ id: string; title: string; status: string }>;
  dependencies?: unknown;
}

export async function getTasks(params?: {
  project_id?: string;
  assignee_me?: boolean;
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<Page<Task>> {
  const q = new URLSearchParams();
  if (params?.project_id) q.set("project_id", params.project_id);
  if (params?.assignee_me) q.set("assignee_me", "true");
  if (params?.status) q.set("status", params.status);
  if (params?.cursor) q.set("cursor", params.cursor);
  q.set("limit", String(params?.limit ?? 20));
  const { data } = await cachedRead("getTasks"+JSON.stringify(params??{}), () => apiFetch(`/api/v1/tasks?${q.toString()}`));
  return asPage<Task>(data);
}

export async function getTask(id: string): Promise<TaskDetail> {
  const { data } = await cachedRead(`task:${id}`,()=>apiFetch(`/api/v1/tasks/${id}`));
  return asItem<TaskDetail>(data, "task");
}

export async function postTask(input: {
  project_id: string;
  title: string;
  description?: string;
}, idempotencyKey?: string): Promise<Task> {
  const { data } = await apiFetch("/api/v1/tasks", {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem<Task>(data, "task");
}

/**
 * Fwd-only status advance WITH If-Match (backend 409s on stale version —
 * callers must pass the version from the last GET).
 */
export async function patchTaskStatus(
  id: string,
  status: string,
  version: number,
  idempotencyKey?: string,
): Promise<Task> {
  const { data } = await apiFetch(`/api/v1/tasks/${id}/status`, {
    method: "PATCH",
    idempotencyKey,
    headers: { "If-Match": String(version) },
    body: { status },
  });
  return asItem<Task>(data, "task");
}

export interface TaskComment {
  id: string;
  body: string;
  author_username?: string;
  created_at?: string;
  [k: string]: unknown;
}

export async function getTaskComments(id: string): Promise<TaskComment[]> {
  const { data } = await cachedRead(`task-comments:${id}`,()=>apiFetch(`/api/v1/tasks/${id}/comments`));
  return asList<TaskComment>(data);
}

export async function postTaskComment(
  id: string,
  body: string,
  idempotencyKey?: string,
): Promise<TaskComment> {
  const { data } = await apiFetch(`/api/v1/tasks/${id}/comments`, {
    method: "POST",
    idempotencyKey,
    body: { body },
  });
  return asItem<TaskComment>(data, "comment");
}

/** Plain base64 JSON upload (local ./uploads driver, ≤5MB decoded). */
export async function postTaskEvidence(
  id: string,
  input: { evidence_type: string; file_name: string; content_base64: string },
  idempotencyKey?: string,
): Promise<unknown> {
  const { data } = await apiFetch(`/api/v1/tasks/${id}/evidence`, {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem(data, "evidence");
}

// --- Leave -------------------------------------------------------------------

export interface LeaveBalance {
  leave_type_id?: string;
  leave_type_code?: string;
  code?: string;
  available?: number;
  opening_balance?: number;
  [k: string]: unknown;
}

export async function getLeaveBalances(): Promise<LeaveBalance[]> {
  const { data } = await cachedRead("getLeaveBalances", () => apiFetch("/api/v1/leave/balances"));
  return asList<LeaveBalance>(data);
}

export interface LeaveType {
  id: string;
  code: string;
  name?: string;
  [k: string]: unknown;
}

export async function getLeaveTypes(): Promise<LeaveType[]> {
  const { data } = await cachedRead("getLeaveTypes", () => apiFetch("/api/v1/leave/types"));
  return asList<LeaveType>(data);
}

export interface LeaveRequest {
  id: string;
  status: string;
  version?: number;
  [k: string]: unknown;
}

export async function postLeaveRequest(input: {
  leave_type_id: string;
  from_date: string;
  to_date: string;
  reason?: string;
}, idempotencyKey?: string): Promise<LeaveRequest> {
  const { data } = await apiFetch("/api/v1/leave/requests", {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem<LeaveRequest>(data, "request");
}

export async function getLeaveRequests(params?: {
  mine?: boolean;
  status?: string;
}): Promise<LeaveRequest[]> {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const { data } = await cachedRead("getLeaveRequests"+JSON.stringify(params??{}), () => apiFetch(`/api/v1/leave/requests${suffix}`));
  return asList<LeaveRequest>(data);
}

/** Approver decision WITH If-Match (same 409 semantics as tasks). */
export async function postLeaveDecision(
  id: string,
  decision: "APPROVE" | "REJECT",
  version: number,
  note?: string,
): Promise<unknown> {
  const { data } = await apiFetch(`/api/v1/leave/requests/${id}/decision`, {
    method: "POST",
    headers: { "If-Match": String(version) },
    body: { decision, ...(note ? { note } : {}) },
  });
  return data;
}

// --- Notifications ------------------------------------------------------------

export interface AppNotification {
  id: string;
  title?: string;
  body?: string;
  type?: string;
  entity_type?: string;
  entity_id?: string;
  read_at?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export async function getNotifications(unread?: boolean): Promise<Page<AppNotification>> {
  const q = unread ? "?unread=true" : "";
  const { data } = await apiFetch(`/api/v1/notifications${q}`);
  return asPage<AppNotification>(data);
}

export async function patchNotificationRead(id: string): Promise<void> {
  await apiFetch(`/api/v1/notifications/${id}/read`, { method: "PATCH" });
}

// --- Projects ------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  code?: string;
  status?: string;
  [k: string]: unknown;
}

export async function getProjects(): Promise<Project[]> {
  const { data } = await cachedRead("getProjects", () => apiFetch("/api/v1/projects?limit=100"));
  return asList<Project>(data);
}

// --- Geo-fences -------------------------------------------------------------

export interface GeoFence {
  id: string;
  name: string;
  scope_type: string | null;
  scope_id: string | null;
  geometry_type: "circle" | "polygon";
  geometry: CircleGeometry | PolygonGeometry;
  tolerance_meters: number;
  accuracy_threshold_meters: number | null;
  status: string;
  version: number;
}

/**
 * Active fences for the signed-in employee's assigned site/location chain,
 * cached so a field user out of signal can still see the applicable boundary.
 */
export async function getGeoFences(limit = 100): Promise<GeoFence[]> {
  return cachedRead("geo-fences", async () => {
    const { data } = await apiFetch<unknown>(`/api/v1/geo-fences/effective?limit=${limit}`, {
      method: "GET",
    });
    return asPage<GeoFence>(data).items;
  });
}

/** Circle fences reshaped for OS region monitoring; polygons are excluded. */
export function toMonitoredFences(fences: readonly GeoFence[]): MonitoredFence[] {
  const out: MonitoredFence[] = [];
  for (const f of fences) {
    if (f.geometry_type !== "circle") continue;
    if (f.status && f.status !== "ACTIVE") continue;
    const g = f.geometry as CircleGeometry;
    out.push({
      id: f.id,
      name: f.name,
      latitude: g.lat,
      longitude: g.lng,
      // Tolerance widens the fence server-side, so monitor the same radius the
      // server will accept — otherwise the OS fires exit while the punch is
      // still inside tolerance.
      radius_m: g.radius_m + (f.tolerance_meters ?? 0),
    });
  }
  return out;
}

/** Fence shapes for on-device containment checks (circles and polygons). */
export function toFenceShapes(
  fences: readonly GeoFence[],
): { id: string; name: string; shape: FenceShape }[] {
  return fences
    .filter((f) => !f.status || f.status === "ACTIVE")
    .map((f) => ({
      id: f.id,
      name: f.name,
      shape: {
        geometry_type: f.geometry_type,
        geometry: f.geometry,
        tolerance_meters: f.tolerance_meters ?? null,
      },
    }));
}
