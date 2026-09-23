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

// --- Geo-fences: removed 2026-09-22 (Silverline has no geo-fencing) ---------
