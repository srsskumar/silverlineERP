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
  /**
   * Which of the shared MODULE_CATALOG's codes (packages/shared/src/modules.ts)
   * this user's roles show as visible, already OR'd across every role they
   * hold. UI-only, same invariant as the web admin screen it mirrors: a
   * `false` here hides a nav destination, never a permission — every route
   * this app calls keeps its own guard regardless of what this map says.
   * Optional because an older cached session (written before this field
   * existed) may not have it; absence reads as "show everything the
   * permission checks already allow" (see rbac.ts's canSeeModule).
   */
  modules?: Record<string, boolean>;
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

/**
 * Set your own password (§34).
 *
 * Not queued: this is a security action the person is waiting on, and a
 * password change replayed from an offline queue hours later would sign them
 * out at a moment they cannot explain.
 */
export async function changeOwnPassword(
  currentPassword: string, newPassword: string,
): Promise<void> {
  await apiFetch("/api/v1/auth/password", {
    method: "POST",
    body: { current_password: currentPassword, new_password: newPassword },
  });
}

// --- Survey ---------------------------------------------------------------------

/** One of the villages this person is crewed to today. */
export interface MyVillage {
  id: string;
  survey_project_id: string;
  /** The denominator for every extent-based percentage. Null when unknown. */
  total_extent_ac: number | null;
  village_name: string;
  village_code: string | null;
  mandal_name: string | null;
  district_name: string | null;
  project_name: string;
  stage_code: string;
  stage_label: string;
  /**
   * The programme's low-progress threshold in acres, or null when it sets
   * none. Carried to the device so the app applies the same rule the server
   * will, before the return goes into a queue that cannot ask questions.
   */
  low_progress_threshold_ac: number | null;
  /*
   * Ground truthing's plan, and whether it has been answered for already.
   *
   * The server refuses a day on a village whose GT is past its date with no
   * reason recorded. Carried here for the same reason the threshold is: the
   * outbox cannot put a question to anybody, and a refusal that arrives
   * tomorrow discards the day's work.
   */
  gt_expected_end_on: string | null;
  gt_completed_on: string | null;
  gt_state: string | null;
  gt_variance_reason: string | null;
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

/** A measure the day's return asks a quantity for. */
export interface SurveyMeasure {
  id: string;
  code: string;
  label: string;
  group_label: string | null;
  unit: string;
  /** EXTENT measures divide by the village extent; COUNT ones need a target. */
  basis: string;
  display_order: number;
}

export interface SurveyStage {
  id: string;
  code: string;
  label: string;
  display_order: number;
}

export async function getSurveyMeasures(): Promise<{
  measures: SurveyMeasure[];
  stages: SurveyStage[];
}> {
  const { data } = await cachedRead("getSurveyMeasures", () =>
    apiFetch<{ data: { measures: SurveyMeasure[]; stages: SurveyStage[] } }>(
      "/api/v1/survey/measures",
    ));
  const body = (data as { data?: { measures?: SurveyMeasure[]; stages?: SurveyStage[] } } | null);
  return { measures: body?.data?.measures ?? [], stages: body?.data?.stages ?? [] };
}

/** One instrument allocated to a village. */
export interface VillageRover {
  id: string;
  asset_id: string;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  category: string | null;
  /** Still allocated — released kit is history and is not asked about. */
  out: boolean;
}

/**
 * The kit allocated to a village.
 *
 * Returned whole, including the tripods and radios: filtering to survey
 * instruments is the caller's decision, and the count of everything else is
 * worth showing rather than silently dropping.
 */
export async function getVillageRovers(villageId: string): Promise<VillageRover[]> {
  const { data } = await cachedRead(`getVillageRovers:${villageId}`, () =>
    apiFetch<{ data: VillageRover[] }>(
      `/api/v1/survey/villages/${villageId}/rovers`,
    ));
  return (data as { data?: VillageRover[] } | null)?.data ?? [];
}

/** One rover's day, as the return records it. */
export interface RoverDayInput {
  asset_id: string;
  status: "UTILIZED" | "IDLE";
  idle_reason?: string | null;
  remarks?: string | null;
}

/**
 * One day's progress for one village.
 *
 * No cumulative field, here or anywhere: the running total is summed from
 * these and never typed. Mirrors surveyEntrySchema in packages/shared.
 */
export interface SurveyEntryInput {
  survey_village_id: string;
  entry_date: string;
  values: Record<string, number>;
  rovers?: RoverDayInput[];
  notes?: string | null;
  low_progress_reason?: string | null;
  low_progress_remarks?: string | null;
  /** Null and zero differ: null is "nobody was asked", zero is "nobody came". */
  govt_staff_present?: number | null;
  crew_present?: number | null;
  /** Why ground truthing has run past its date. Written onto the stage. */
  gt_variance_reason?: string | null;
  gt_variance_remarks?: string | null;
}

export async function postSurveyEntry(
  input: SurveyEntryInput,
  idempotencyKey?: string,
): Promise<unknown> {
  const { data } = await apiFetch("/api/v1/survey/entries", {
    method: "POST",
    body: input,
    idempotencyKey,
  });
  return asItem(data);
}

/** A control point already recorded for a village. */
export interface VillageGcp {
  id: string;
  point_code: string;
  latitude: number;
  longitude: number;
  elevation_m: number | null;
  easting_m: number | null;
  northing_m: number | null;
  grid_zone: string | null;
  remarks: string | null;
  established_on: string | null;
  recorded_by_name: string | null;
  /** Sanity-check codes from the server — advisory, never a refusal. */
  warnings?: string[];
}

export async function getVillageGcps(villageId: string): Promise<VillageGcp[]> {
  const { data } = await cachedRead(`getVillageGcps:${villageId}`, () =>
    apiFetch<{ data: VillageGcp[] }>(`/api/v1/survey/villages/${villageId}/gcps`));
  return (data as { data?: VillageGcp[] } | null)?.data ?? [];
}

export interface GcpInput {
  point_code: string;
  latitude: number;
  longitude: number;
  elevation_m?: number | null;
  easting_m?: number | null;
  northing_m?: number | null;
  grid_zone?: string | null;
  remarks?: string | null;
  established_on?: string | null;
}

export async function postVillageGcp(
  villageId: string,
  input: GcpInput,
  idempotencyKey?: string,
): Promise<unknown> {
  const { data } = await apiFetch(`/api/v1/survey/villages/${villageId}/gcps`, {
    method: "POST",
    body: input,
    idempotencyKey,
  });
  return asItem(data);
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
  /** WGS84 ellipsoidal altitude, metres, when the OS gives one. */
  altitude?: number;
  altitude_accuracy?: number;
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

// --- Documents (§46 register) -----------------------------------------------

/**
 * A register row — apps/api/src/modules/documents is a compliance INDEX of
 * licences, policies and certificates, not a file store: the bytes (where
 * they exist at all) stay in whichever module recorded them, and this module
 * has no download route of its own. There is nothing here to fetch bytes
 * for, so this client is read-only: the register and what needs renewing.
 */
export interface DocumentRow {
  id: string;
  title: string;
  type_code: string;
  type_label: string;
  category: string;
  owner_type: string;
  owner_id: string | null;
  reference_number: string | null;
  issuing_authority: string | null;
  issued_on: string | null;
  valid_from: string | null;
  expires_on: string | null;
  state: "VALID" | "EXPIRING" | "EXPIRED" | "SUPERSEDED" | string;
  days_remaining: number | null;
  blocks_operations: boolean;
  confidential: boolean;
  restricted: boolean;
  notes: string | null;
  version: number;
  [k: string]: unknown;
}

export interface DocumentSummary {
  blocking?: number;
  blocking_soon?: number;
  [k: string]: unknown;
}

export async function getDocuments(params?: {
  owner_type?: string;
  type_code?: string;
  category?: string;
  state?: string;
  blocking?: boolean;
}): Promise<{ items: DocumentRow[]; total: number; summary: DocumentSummary | null }> {
  const q = new URLSearchParams({ limit: "100" });
  if (params?.owner_type) q.set("owner_type", params.owner_type);
  if (params?.type_code) q.set("type_code", params.type_code);
  if (params?.category) q.set("category", params.category);
  if (params?.state) q.set("state", params.state);
  if (params?.blocking) q.set("blocking", "true");
  const { data } = await cachedRead(`getDocuments:${q.toString()}`, () =>
    apiFetch<{ data?: DocumentRow[]; total?: number; summary?: DocumentSummary }>(
      `/api/v1/documents?${q.toString()}`,
    ));
  const body = data as { data?: DocumentRow[]; total?: number; summary?: DocumentSummary } | null;
  return { items: body?.data ?? [], total: body?.total ?? 0, summary: body?.summary ?? null };
}

export async function getDocumentRenewals(
  withinDays = 60,
): Promise<{ items: DocumentRow[]; blocking: number; blockingSoon: number }> {
  const { data } = await cachedRead(`getDocumentRenewals:${withinDays}`, () =>
    apiFetch<{ data?: DocumentRow[]; blocking?: number; blocking_soon?: number }>(
      `/api/v1/documents/renewals?within_days=${withinDays}`,
    ));
  const body = data as { data?: DocumentRow[]; blocking?: number; blocking_soon?: number } | null;
  return {
    items: body?.data ?? [],
    blocking: body?.blocking ?? 0,
    blockingSoon: body?.blocking_soon ?? 0,
  };
}

export async function getDocument(
  id: string,
): Promise<DocumentRow & { supersedes: DocumentRow | null }> {
  const { data } = await cachedRead(`document:${id}`, () => apiFetch(`/api/v1/documents/${id}`));
  return asItem(data, "data");
}

// --- Approvals (§41) ---------------------------------------------------------

export interface ApprovalStep {
  id: string;
  sequence: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED" | string;
  approver_role: string | null;
  approver_user_id: string | null;
  acted_by: string | null;
  acted_by_username?: string | null;
  acted_at?: string | null;
  acted_on_behalf_of_username?: string | null;
  comments?: string | null;
  pending_since: string | null;
  sla_hours: number | null;
}

export interface ApprovalInstance {
  id: string;
  document_type: string;
  document_id: string;
  amount: number | string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "RECALLED" | "SUPERSEDED" | string;
  version: number;
  requested_by: string;
  requested_by_username?: string;
  project_code?: string | null;
  policy_name?: string | null;
  current_sequence?: number | null;
  created_at?: string;
  decided_at?: string | null;
  rejection_reason?: string | null;
  // Present only on /approvals/inbox rows, which join the step directly.
  step_id?: string;
  sequence?: number;
  pending_since?: string | null;
  sla_hours?: number | null;
  [k: string]: unknown;
}

/** The signed-in user's queue — steps only they (or their delegator) may act on next. */
export async function getApprovalInbox(): Promise<ApprovalInstance[]> {
  const { data } = await apiFetch<{ data?: ApprovalInstance[] }>("/api/v1/approvals/inbox");
  return asList<ApprovalInstance>(data);
}

/** This user's own requests (approval.read alone means "mine"; read_all sees everyone's). */
export async function getMyApprovals(params?: {
  status?: string;
  documentType?: string;
}): Promise<ApprovalInstance[]> {
  const q = new URLSearchParams({ limit: "100", mine: "true" });
  if (params?.status) q.set("status", params.status);
  if (params?.documentType) q.set("document_type", params.documentType);
  const { data } = await apiFetch<{ data?: ApprovalInstance[] }>(`/api/v1/approvals?${q.toString()}`);
  return asList<ApprovalInstance>(data);
}

export async function getApproval(
  id: string,
): Promise<ApprovalInstance & { steps: ApprovalStep[]; next_step: ApprovalStep | null }> {
  const { data } = await apiFetch(`/api/v1/approvals/${id}`);
  return asItem(data, "data");
}

/**
 * Approve or reject the step currently waiting on this user.
 *
 * REJECT requires `comments` (shared approvalDecisionSchema); APPROVE does
 * not. The server also refuses a self-approval (`SELF_APPROVAL`, 403) and an
 * out-of-sequence decision (`OUT_OF_SEQUENCE`) — this call surfaces both as an
 * ordinary ApiError for the screen to show.
 */
export async function postApprovalDecision(
  id: string,
  decision: "APPROVE" | "REJECT",
  version: number,
  comments?: string,
): Promise<ApprovalInstance> {
  const { data } = await apiFetch(`/api/v1/approvals/${id}/decision`, {
    method: "POST",
    headers: { "If-Match": String(version) },
    body: { decision, ...(comments ? { comments } : {}) },
  });
  return asItem<ApprovalInstance>(data, "data");
}

/** The requester withdraws their own request before it is decided. */
export async function postApprovalRecall(
  id: string,
  version: number,
  reason: string,
): Promise<ApprovalInstance> {
  const { data } = await apiFetch(`/api/v1/approvals/${id}/recall`, {
    method: "POST",
    headers: { "If-Match": String(version) },
    body: { reason },
  });
  return asItem<ApprovalInstance>(data, "data");
}

// --- Expenses (§16) ----------------------------------------------------------

export interface ExpenseLine {
  id?: string;
  category: string;
  expense_date: string;
  description: string;
  amount: number | string;
  units?: number | null;
  vendor_name?: string | null;
  invoice_no?: string | null;
  billable_to_client?: boolean;
  allowed_amount?: number | string;
  excess_amount?: number | string;
  policy_exception?: boolean;
  exception_notes?: string | null;
  [k: string]: unknown;
}

export interface ExpenseClaim {
  id: string;
  claim_no: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "REIMBURSED" | string;
  version: number;
  claim_date: string;
  purpose: string;
  total_claimed: number | string;
  total_allowed: number | string;
  total_excess: number | string;
  policy_exception: boolean;
  project_code?: string | null;
  reimbursed_amount?: number | string;
  lines?: ExpenseLine[];
  [k: string]: unknown;
}

export async function getExpenseClaims(params?: { status?: string }): Promise<ExpenseClaim[]> {
  const q = new URLSearchParams({ limit: "100" });
  if (params?.status) q.set("status", params.status);
  const { data } = await cachedRead(`getExpenseClaims:${q.toString()}`, () =>
    apiFetch<{ data?: ExpenseClaim[] }>(`/api/v1/expense-claims?${q.toString()}`));
  return asList<ExpenseClaim>(data);
}

export async function getExpenseClaim(id: string): Promise<ExpenseClaim> {
  const { data } = await cachedRead(`expense-claim:${id}`, () =>
    apiFetch(`/api/v1/expense-claims/${id}`));
  return asItem<ExpenseClaim>(data, "data");
}

/** Draft creation only — lines are frozen at this point; submit separately. */
export async function postExpenseClaim(
  input: {
    claim_no: string;
    claim_date: string;
    purpose: string;
    project_id?: string | null;
    lines: ExpenseLine[];
  },
  idempotencyKey?: string,
): Promise<ExpenseClaim> {
  const { data } = await apiFetch(`/api/v1/expense-claims`, {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem<ExpenseClaim>(data, "data");
}

export async function postExpenseClaimSubmit(
  id: string,
  version: number,
): Promise<ExpenseClaim> {
  const { data } = await apiFetch(`/api/v1/expense-claims/${id}/submit`, {
    method: "POST",
    headers: { "If-Match": String(version) },
  });
  return asItem<ExpenseClaim>(data, "data");
}

export async function postExpenseClaimWithdraw(
  id: string,
  version: number,
  reason: string,
): Promise<ExpenseClaim> {
  const { data } = await apiFetch(`/api/v1/expense-claims/${id}/withdraw`, {
    method: "POST",
    headers: { "If-Match": String(version) },
    body: { reason },
  });
  return asItem<ExpenseClaim>(data, "data");
}

// --- Inventory (§0 stock ledger) ----------------------------------------------

export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  low_stock_threshold: number | string;
  unit_cost: number | string;
  status: "ACTIVE" | "INACTIVE" | string;
  vendor_id?: string | null;
  /** Signed sum of every IN/OUT/transfer posted against this item. */
  available: string;
  version: number;
  [k: string]: unknown;
}

export interface StockTransaction {
  id: string;
  item_id: string;
  item_name?: string;
  direction: "IN" | "OUT";
  quantity: number | string;
  reference: string;
  project_id?: string | null;
  reason?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export async function getInventoryItems(params?: { search?: string }): Promise<InventoryItem[]> {
  const q = new URLSearchParams({ limit: "100" });
  if (params?.search) q.set("search", params.search);
  const { data } = await cachedRead(`getInventoryItems:${q.toString()}`, () =>
    apiFetch<{ data?: InventoryItem[] }>(`/api/v1/inventory/items?${q.toString()}`));
  return asList<InventoryItem>(data);
}

export async function getInventoryTransactions(itemId?: string): Promise<StockTransaction[]> {
  const q = new URLSearchParams({ limit: "50" });
  if (itemId) q.set("item_id", itemId);
  const { data } = await cachedRead(`getInventoryTransactions:${q.toString()}`, () =>
    apiFetch<{ data?: StockTransaction[] }>(`/api/v1/inventory/transactions?${q.toString()}`));
  return asList<StockTransaction>(data);
}

/** Posts a stock movement. Requires inventory.manage — inventory.read alone can only look. */
export async function postInventoryTransaction(
  input: {
    item_id: string;
    direction: "IN" | "OUT";
    quantity: number;
    reference: string;
    reason?: string;
    project_id?: string | null;
  },
  idempotencyKey?: string,
): Promise<StockTransaction & { available: string; low_stock: boolean }> {
  const { data } = await apiFetch(`/api/v1/inventory/transactions`, {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem(data, "data");
}

// --- CRM: Clients (§6.3) ------------------------------------------------------

export interface ClientRow {
  id: string;
  code: string;
  name: string;
  client_type: "GOVERNMENT" | "PRIVATE" | string;
  category?: string | null;
  state?: string | null;
  district?: string | null;
  mandal?: string | null;
  village?: string | null;
  address_line?: string | null;
  pincode?: string | null;
  website?: string | null;
  pan?: string | null;
  payment_terms?: string | null;
  credit_limit?: string | number | null;
  status?: string;
  version: number;
  [k: string]: unknown;
}

export interface ClientContact {
  id: string;
  name: string;
  designation?: string | null;
  department?: string | null;
  phone?: string | null;
  alternate_phone?: string | null;
  email?: string | null;
  contact_type?: string;
  [k: string]: unknown;
}

export async function getClients(params?: {
  search?: string;
  client_type?: string;
  status?: string;
}): Promise<{ items: ClientRow[]; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50" });
  if (params?.search) q.set("search", params.search);
  if (params?.client_type) q.set("client_type", params.client_type);
  if (params?.status) q.set("status", params.status);
  const { data } = await cachedRead(`getClients:${q.toString()}`, () =>
    apiFetch<{ data?: ClientRow[]; has_more?: boolean }>(`/api/v1/clients?${q.toString()}`));
  const body = data as { data?: ClientRow[]; has_more?: boolean } | null;
  return { items: body?.data ?? [], hasMore: body?.has_more ?? false };
}

export async function getClient(id: string): Promise<ClientRow & { contacts: ClientContact[] }> {
  const { data } = await cachedRead(`client:${id}`, () => apiFetch(`/api/v1/clients/${id}`));
  return asItem(data, "data");
}

/** One state's GST registration for a client (§6.5) — a client holds one per state. */
export interface GstRegistration {
  id: string;
  gstin: string;
  state_code: string;
  registration_type: string;
  is_primary: boolean;
  [k: string]: unknown;
}

export async function getClientGstRegistrations(clientId: string): Promise<GstRegistration[]> {
  const { data } = await cachedRead(`client-gst:${clientId}`, () =>
    apiFetch<{ data?: GstRegistration[] }>(`/api/v1/parties/client/${clientId}/gst-registrations`));
  return (data as { data?: GstRegistration[] } | null)?.data ?? [];
}

// --- CRM: Pipeline / leads (§7) ------------------------------------------------

export interface LeadRow {
  id: string;
  lead_no: string;
  organization_name: string;
  lead_type: "GOVERNMENT" | "PRIVATE" | string;
  stage: string;
  status: string;
  source: string;
  client_name?: string | null;
  estimated_value?: string | number | null;
  owner_id?: string | null;
  owner_username?: string | null;
  next_follow_up_date?: string | null;
  notes?: string | null;
  version: number;
  [k: string]: unknown;
}

export interface LeadDetail extends LeadRow {
  opportunities: unknown[];
  timeline: Array<{
    id: string;
    interaction_type: string;
    summary: string;
    occurred_at: string;
    logged_by_username?: string | null;
  }>;
  /** What the stage machine will accept next — never offer a move the server refuses. */
  allowed_stages: string[];
}

export async function getLeads(params?: {
  stage?: string;
  search?: string;
}): Promise<{ items: LeadRow[]; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50" });
  if (params?.stage) q.set("stage", params.stage);
  if (params?.search) q.set("search", params.search);
  const { data } = await cachedRead(`getLeads:${q.toString()}`, () =>
    apiFetch<{ data?: LeadRow[]; has_more?: boolean }>(`/api/v1/leads?${q.toString()}`));
  const body = data as { data?: LeadRow[]; has_more?: boolean } | null;
  return { items: body?.data ?? [], hasMore: body?.has_more ?? false };
}

/** §7.5 pipeline value by stage — the same shape the web board/report use. */
export async function getLeadsPipeline(): Promise<
  Array<{ stage: string; count: number; value: string }>
> {
  const { data } = await cachedRead("getLeadsPipeline", () =>
    apiFetch<{ data?: Array<{ stage: string; count: number; value: string }> }>(
      "/api/v1/leads/pipeline",
    ));
  return (data as { data?: Array<{ stage: string; count: number; value: string }> } | null)
    ?.data ?? [];
}

export async function getLead(id: string): Promise<LeadDetail> {
  const { data } = await cachedRead(`lead:${id}`, () => apiFetch(`/api/v1/leads/${id}`));
  return asItem<LeadDetail>(data, "data");
}

/**
 * §7.2 stage transition WITH If-Match. LOST/DISQUALIFIED require lost_reason
 * (mirrors leadStageSchema; see validateLeadStageChange in leadsFormat.ts).
 * CONVERTED is deliberately not offered here — it only happens through the
 * opportunity → tender → conversion pipeline, which is desktop work.
 */
export async function postLeadStage(
  id: string,
  stage: string,
  version: number,
  lostReason?: string,
): Promise<LeadRow> {
  const { data } = await apiFetch(`/api/v1/leads/${id}/stage`, {
    method: "POST",
    headers: { "If-Match": String(version) },
    body: { stage, ...(lostReason ? { lost_reason: lostReason } : {}) },
  });
  return asItem<LeadRow>(data, "data");
}

// --- Tenders (§8) — read-only on mobile ----------------------------------------

export interface TenderRow {
  id: string;
  tender_no: string;
  tender_type: string;
  status: string;
  client_id?: string | null;
  client_name?: string | null;
  department?: string | null;
  authority?: string | null;
  reference_number?: string | null;
  estimated_value?: string | number | null;
  bid_value?: string | number | null;
  closing_date?: string | null;
  opening_date?: string | null;
  submission_date?: string | null;
  outstanding_required?: number;
  version: number;
  [k: string]: unknown;
}

export interface TenderDetail extends TenderRow {
  eligibility: Array<{
    id: string;
    requirement_name: string;
    is_required: boolean;
    item_status: string;
  }>;
  corrigenda: unknown[];
  competitors: unknown[];
  instruments: unknown[];
  project: { id: string; code: string; name: string; status: string } | null;
  allowed_statuses: string[];
  outstanding_required: number;
}

export async function getTenders(params?: {
  status?: string;
  search?: string;
}): Promise<{ items: TenderRow[]; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50", sort: "closing" });
  if (params?.status) q.set("status", params.status);
  if (params?.search) q.set("search", params.search);
  const { data } = await cachedRead(`getTenders:${q.toString()}`, () =>
    apiFetch<{ data?: TenderRow[]; has_more?: boolean }>(`/api/v1/tenders?${q.toString()}`));
  const body = data as { data?: TenderRow[]; has_more?: boolean } | null;
  return { items: body?.data ?? [], hasMore: body?.has_more ?? false };
}

export async function getTender(id: string): Promise<TenderDetail> {
  const { data } = await cachedRead(`tender:${id}`, () => apiFetch(`/api/v1/tenders/${id}`));
  return asItem<TenderDetail>(data, "data");
}

// --- Employee directory (§1) — read-only on mobile -----------------------------

/**
 * A masked directory row. apps/api's employee list ALWAYS masks Aadhaar/PAN/
 * bank account to their last four digits, whoever asks (HR-15) — the full
 * numbers exist only on GET /employees/:id for a holder of employee.pii.read,
 * and that read is itself audited server-side. This client renders whatever
 * the server sends and never asks for more.
 */
export interface DirectoryEmployee {
  id: string;
  emp_no: string;
  first_name: string;
  last_name: string | null;
  phone: string;
  phone_secondary?: string | null;
  email: string | null;
  designation: string | null;
  department: string | null;
  status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "EXITED" | string;
  reports_to_name?: string | null;
  date_of_joining?: string | null;
  aadhaar_last4?: string | null;
  pan_last4?: string | null;
  bank_account_last4?: string | null;
  [k: string]: unknown;
}

export async function getEmployeeDirectory(params?: {
  q?: string;
  status?: string;
}): Promise<{ items: DirectoryEmployee[]; nextCursor: string | null; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50" });
  if (params?.q) q.set("q", params.q);
  if (params?.status) q.set("status", params.status);
  const { data } = await cachedRead(`getEmployeeDirectory:${q.toString()}`, () =>
    apiFetch<{ data?: DirectoryEmployee[]; next_cursor?: string | null; has_more?: boolean }>(
      `/api/v1/employees?${q.toString()}`,
    ));
  const body = data as
    | { data?: DirectoryEmployee[]; next_cursor?: string | null; has_more?: boolean }
    | null;
  return { items: body?.data ?? [], nextCursor: body?.next_cursor ?? null, hasMore: body?.has_more ?? false };
}

export async function getEmployee(id: string): Promise<DirectoryEmployee> {
  const { data } = await cachedRead(`employee:${id}`, () => apiFetch(`/api/v1/employees/${id}`));
  return asItem<DirectoryEmployee>(data);
}

// --- Attendance exceptions: decision only ---------------------------------------
//
// There is no GET /attendance/exceptions list or single-item route (apps/api's
// S2 contract gap — confirmed against apps/api/src/modules/attendance/routes.ts,
// which registers only POST .../exceptions and PATCH .../:id/decision). See
// attendanceExceptionsFormat.ts's header for how the web client and this one
// both work around it, from ids the caller already knows rather than a queue.

export interface AttendanceExceptionRow {
  id: string;
  employee_id: string;
  attendance_record_id: string | null;
  exception_type: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | string;
  version: number;
  submitted_by?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  work_date?: string | null;
  claimed_check_in?: string | null;
  claimed_check_out?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

/**
 * Decide an exception this device already knows the id (and version) of.
 * REJECT does not require `note` server-side (attendanceExceptionDecisionSchema
 * makes it optional either way) — unlike Approvals' rejection, so this screen
 * does not invent that requirement either.
 */
export async function postAttendanceExceptionDecision(
  id: string,
  decision: "APPROVE" | "REJECT",
  version: number,
  note?: string,
): Promise<AttendanceExceptionRow> {
  const { data } = await apiFetch(`/api/v1/attendance/exceptions/${id}/decision`, {
    method: "PATCH",
    headers: { "If-Match": String(version) },
    body: { decision, ...(note ? { note } : {}) },
  });
  return asItem<AttendanceExceptionRow>(data);
}

// --- RA bills / project finance (§15, §37.3) ---------------------------------

/**
 * Running-account billing is a project's own bill register: everything —
 * increments, deductions, advance recovery, the net payable — is computed
 * server-side from the measurement a bill claims and the project's deduction
 * policy. Nothing here composes a bill; this client only reads the register a
 * field or site manager checks a figure against. Raising, certifying and
 * disputing a bill stay on the web, where the measurement book and the
 * deduction policy are worked out.
 */
export interface RaBillDeduction {
  id: string;
  head: string;
  label: string;
  basis?: string | null;
  rate_pct?: number | string | null;
  amount: number | string;
  reason?: string | null;
  [k: string]: unknown;
}

export interface RaBillItem {
  id: string;
  boq_item_id: string;
  item_code?: string;
  description?: string;
  unit?: string;
  cumulative_quantity: number | string;
  previous_quantity: number | string;
  rate: number | string;
  this_amount: number | string;
  [k: string]: unknown;
}

export interface RaBill {
  id: string;
  project_id: string;
  bill_no: number;
  bill_type: "RA" | "FINAL" | string;
  status: "DRAFT" | "SUBMITTED" | "CERTIFIED" | "PAID" | "CANCELLED" | string;
  period_from?: string | null;
  period_to?: string | null;
  gross_value: number | string;
  gst_amount?: number | string;
  total_deductions?: number | string;
  net_payable: number | string;
  certified_amount?: number | string | null;
  certified_at?: string | null;
  submitted_at?: string | null;
  paid_at?: string | null;
  due_date?: string | null;
  disputed?: boolean;
  dispute_reason?: string | null;
  cancelled_reason?: string | null;
  version: number;
  items?: RaBillItem[];
  deductions?: RaBillDeduction[];
  allowed_statuses?: string[];
  [k: string]: unknown;
}

export async function getProjectRaBills(projectId: string): Promise<RaBill[]> {
  const { data } = await cachedRead(`getProjectRaBills:${projectId}`, () =>
    apiFetch<{ data?: RaBill[] }>(`/api/v1/projects/${projectId}/ra-bills`));
  return asList<RaBill>(data);
}

export async function getRaBill(id: string): Promise<RaBill> {
  const { data } = await cachedRead(`ra-bill:${id}`, () => apiFetch(`/api/v1/ra-bills/${id}`));
  return asItem<RaBill>(data, "data");
}

// --- Ledgers: receivables and payables ageing (§58) --------------------------

/**
 * Both ledgers report a live position — who owes us and how late, whom we
 * must pay and by when — computed fresh on every read. There is nothing to
 * post from a phone: a collections call or a payment run is a desk job with
 * the full client or vendor statement in front of it, not a field lookup.
 */
export interface AgeingBuckets {
  NOT_DUE: number;
  D1_30: number;
  D31_60: number;
  D61_90: number;
  OVER_90: number;
}

export interface AgeingTotals {
  buckets: AgeingBuckets;
  undated: number;
  disputed: number;
  retention: number;
  onHold: number;
  total: number;
  overdue: number;
}

export interface ArClientBill {
  bill_id: string;
  bill_no: number;
  bill_type: string;
  project_code?: string | null;
  project_name?: string | null;
  billed: number;
  settled: number;
  outstanding: number;
  retention: number;
  due_date: string | null;
  certified_at?: string | null;
  disputed: boolean;
  dispute_reason?: string | null;
  [k: string]: unknown;
}

export interface ArClient extends AgeingTotals {
  client_id: string | null;
  client_name: string;
  credit: {
    limit: number | null;
    outstanding: number;
    uninvoiced: number;
    exposure: number;
    headroom: number | null;
    breached: boolean;
    utilisationPct: number | null;
  };
  bills: ArClientBill[];
}

export interface ArAgeing extends AgeingTotals {
  as_of: string;
  dso: number | null;
  periodDays: number;
  clients: ArClient[];
}

export async function getArAgeing(params?: {
  as_of?: string;
  period_days?: number;
}): Promise<ArAgeing> {
  const q = new URLSearchParams();
  if (params?.as_of) q.set("as_of", params.as_of);
  if (params?.period_days) q.set("period_days", String(params.period_days));
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const { data } = await cachedRead(`getArAgeing:${suffix}`, () =>
    apiFetch<{ data?: ArAgeing }>(`/api/v1/ar/ageing${suffix}`));
  return asItem<ArAgeing>(data, "data");
}

export interface ApVendorInvoice {
  invoice_id: string;
  serial_number: string;
  total: number;
  settled: number;
  outstanding: number;
  contractual_due_date: string | null;
  statutory_due_date: string | null;
  effective_due_date: string | null;
  is_msme: boolean;
  days_overdue: number;
  accrued_interest: number;
  disputed: boolean;
  on_hold: boolean;
  hold_reason?: string | null;
  match_status?: string | null;
  has_purchase_order: boolean;
  open_run_no?: string | null;
  [k: string]: unknown;
}

export interface ApVendor extends AgeingTotals {
  vendor_id: string | null;
  vendor_name: string;
  accrued_interest: number;
  invoices: ApVendorInvoice[];
}

export interface ApAgeing extends AgeingTotals {
  as_of: string;
  msme_accrued_interest: number;
  msme_outstanding: number;
  vendors: ApVendor[];
}

export async function getApAgeing(params?: { as_of?: string }): Promise<ApAgeing> {
  const q = new URLSearchParams();
  if (params?.as_of) q.set("as_of", params.as_of);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  const { data } = await cachedRead(`getApAgeing:${suffix}`, () =>
    apiFetch<{ data?: ApAgeing }>(`/api/v1/ap/ageing${suffix}`));
  return asItem<ApAgeing>(data, "data");
}

// --- Procurement (§6.6, §13.2, §43) ------------------------------------------

export interface RequisitionLine {
  id?: string;
  line_no?: number;
  item_id?: string | null;
  description: string;
  unit: string;
  quantity: number | string;
  estimated_rate?: number | string | null;
  remarks?: string | null;
  [k: string]: unknown;
}

export interface Requisition {
  id: string;
  requisition_no: string;
  project_id?: string | null;
  project_code?: string | null;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CONVERTED" | "CANCELLED" | string;
  requested_by_username?: string;
  required_by?: string | null;
  justification: string;
  estimated_value: number | string;
  version: number;
  lines?: RequisitionLine[];
  purchase_orders?: Array<{ id: string; po_number: string; status: string; total_value: number | string }>;
  allowed_statuses?: string[];
  [k: string]: unknown;
}

export async function getRequisitions(params?: {
  status?: string;
  project_id?: string;
}): Promise<{ items: Requisition[]; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50" });
  if (params?.status) q.set("status", params.status);
  if (params?.project_id) q.set("project_id", params.project_id);
  const { data } = await cachedRead(`getRequisitions:${q.toString()}`, () =>
    apiFetch<{ data?: Requisition[]; has_more?: boolean }>(`/api/v1/requisitions?${q.toString()}`));
  const body = data as { data?: Requisition[]; has_more?: boolean } | null;
  return { items: body?.data ?? [], hasMore: body?.has_more ?? false };
}

export async function getRequisition(id: string): Promise<Requisition> {
  const { data } = await cachedRead(`requisition:${id}`, () => apiFetch(`/api/v1/requisitions/${id}`));
  return asItem<Requisition>(data, "data");
}

/** Draft creation only — a requisition is submitted for approval separately. */
export async function postRequisition(
  input: {
    requisition_no: string;
    project_id?: string | null;
    required_by?: string;
    justification: string;
    lines: RequisitionLine[];
  },
  idempotencyKey?: string,
): Promise<Requisition> {
  const { data } = await apiFetch(`/api/v1/requisitions`, {
    method: "POST",
    idempotencyKey,
    body: input,
  });
  return asItem<Requisition>(data, "data");
}

export async function postRequisitionSubmit(id: string, version: number): Promise<Requisition> {
  const { data } = await apiFetch(`/api/v1/requisitions/${id}/submit`, {
    method: "POST",
    headers: { "If-Match": String(version) },
  });
  return asItem<Requisition>(data, "data");
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  vendor_name?: string;
  project_id?: string | null;
  status: string;
  po_date: string;
  delivery_date?: string | null;
  total_value: number | string;
  version: number;
  lines?: unknown[];
  amendments?: unknown[];
  allowed_statuses?: string[];
  [k: string]: unknown;
}

export async function getPurchaseOrders(params?: {
  status?: string;
  vendor_id?: string;
}): Promise<{ items: PurchaseOrder[]; hasMore: boolean }> {
  const q = new URLSearchParams({ limit: "50" });
  if (params?.status) q.set("status", params.status);
  if (params?.vendor_id) q.set("vendor_id", params.vendor_id);
  const { data } = await cachedRead(`getPurchaseOrders:${q.toString()}`, () =>
    apiFetch<{ data?: PurchaseOrder[]; has_more?: boolean }>(`/api/v1/purchase-orders?${q.toString()}`));
  const body = data as { data?: PurchaseOrder[]; has_more?: boolean } | null;
  return { items: body?.data ?? [], hasMore: body?.has_more ?? false };
}

export async function getPurchaseOrder(id: string): Promise<PurchaseOrder> {
  const { data } = await cachedRead(`purchase-order:${id}`, () => apiFetch(`/api/v1/purchase-orders/${id}`));
  return asItem<PurchaseOrder>(data, "data");
}

// --- Payroll (P1) --------------------------------------------------------------

/**
 * The org-wide run register — status, period and totals per run — distinct
 * from the employee's own "My payslip" already on mobile (getEmployeesMe's
 * sibling, /api/v1/payslips/me, wired into the More tab's Payslip card). This
 * is the manager's view: is a run open, calculated, under review, approved or
 * locked, and what did it total. Generating, approving and locking a run stay
 * on the web — a period-close action, not a phone lookup.
 */
export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  status: "OPEN" | "VALIDATING" | "CALCULATED" | "REVIEW" | "APPROVED" | "LOCKED" | string;
  version: number;
  employee_count: number;
  total_gross: number;
  total_deductions: number;
  total_net: number;
  warnings: Array<{ type: string; employee_id: string; message: string }>;
  approved_by?: string | null;
  approved_at?: string | null;
  approve_note?: string | null;
  locked_by?: string | null;
  locked_at?: string | null;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

export async function getPayrollRuns(params?: {
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<Page<PayrollRun>> {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.cursor) q.set("cursor", params.cursor);
  q.set("limit", String(params?.limit ?? 20));
  const { data } = await cachedRead(`getPayrollRuns:${q.toString()}`, () =>
    apiFetch(`/api/v1/payroll/runs?${q.toString()}`));
  return asPage<PayrollRun>(data);
}

export async function getPayrollRun(id: string): Promise<PayrollRun> {
  const { data } = await cachedRead(`payroll-run:${id}`, () => apiFetch(`/api/v1/payroll/runs/${id}`));
  return asItem<PayrollRun>(data);
}

export interface PayrollRunPayslipRow {
  id: string;
  employee_id: string;
  emp_no: string;
  employee_name: string;
  gross: number;
  total_deductions: number;
  net_pay: number;
}

export async function getPayrollRunPayslips(
  runId: string,
  cursor?: string,
): Promise<Page<PayrollRunPayslipRow>> {
  const q = new URLSearchParams({ limit: "50" });
  if (cursor) q.set("cursor", cursor);
  const { data } = await cachedRead(`getPayrollRunPayslips:${runId}:${cursor ?? ""}`, () =>
    apiFetch(`/api/v1/payroll/runs/${runId}/payslips?${q.toString()}`));
  return asPage<PayrollRunPayslipRow>(data);
}

// --- Geo-fences: removed 2026-09-22 (Silverline has no geo-fencing) ---------
