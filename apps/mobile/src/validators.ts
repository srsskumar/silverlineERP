/**
 * Dependency-free input validators for the mobile MVP.
 *
 * These mirror the backend zod contracts in packages/shared (auth.ts, s2.ts,
 * s3.ts, s4.ts) WITHOUT importing zod or @silverline/shared, so that:
 *  - Metro never needs workspace linking (deferred by brief), and
 *  - `tsx --test` / node:test can import this file with zero native deps.
 *
 * DRIFT RISK: if the backend schemas change, these hand-rolled checks must be
 * updated in lockstep. The field names and limits below cite the source
 * schema in comments.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOTP_RE = /^\d{6}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** YYYY-MM-DD and a real calendar date (mirrors shared dateStringSchema). */
export function isDateString(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m as number) - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === (m as number) - 1 &&
    dt.getUTCDate() === d
  );
}

function req(
  errors: FieldError[],
  field: string,
  value: unknown,
  message: string,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ field, message });
    return false;
  }
  return true;
}

function result(errors: FieldError[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

/** POST /api/v1/auth/login — shared loginSchema: username + password required. */
export function validateLogin(input: {
  username: string;
  password: string;
}): ValidationResult {
  const errors: FieldError[] = [];
  req(errors, "username", input.username, "Username is required");
  req(errors, "password", input.password, "Password is required");
  return result(errors);
}

/** POST /api/v1/auth/mfa/verify — shared mfaVerifySchema: { code: 6 digits }. */
export function validateMfaCode(code: string): ValidationResult {
  const errors: FieldError[] = [];
  if (!TOTP_RE.test(code)) {
    errors.push({ field: "code", message: "TOTP code must be exactly 6 digits" });
  }
  return result(errors);
}

/**
 * POST /api/v1/tasks — shared taskCreateSchema.
 * Only project_id + title are required (title-only quick-add is legal).
 */
export function validateTaskCreate(input: {
  project_id: string;
  title: string;
}): ValidationResult {
  const errors: FieldError[] = [];
  if (!isUuid(input.project_id)) {
    errors.push({ field: "project_id", message: "project_id must be a UUID" });
  }
  if (!req(errors, "title", input.title, "Title is required")) {
    // pushed above
  } else if ((input.title as string).trim().length > 500) {
    errors.push({ field: "title", message: "Title must be ≤ 500 characters" });
  }
  return result(errors);
}

/** POST /api/v1/tasks/:id/comments — shared taskCommentCreateSchema. */
export function validateComment(body: string): ValidationResult {
  const errors: FieldError[] = [];
  if (!req(errors, "body", body, "Body is required")) {
    // pushed above
  } else if ((body as string).length > 5000) {
    errors.push({ field: "body", message: "Body must be ≤ 5000 characters" });
  }
  return result(errors);
}

/**
 * POST /api/v1/leave/requests — shared leaveRequestCreateSchema.
 * leave_type_id + from/to dates required; to_date must not precede from_date
 * (backend enforces overlap/balance; this is the cheap client pre-check).
 */
export function validateLeaveRequest(input: {
  leave_type_id: string;
  from_date: string;
  to_date: string;
}): ValidationResult {
  const errors: FieldError[] = [];
  if (!isUuid(input.leave_type_id)) {
    errors.push({
      field: "leave_type_id",
      message: "leave_type_id must be a UUID",
    });
  }
  if (!isDateString(input.from_date)) {
    errors.push({
      field: "from_date",
      message: "Must be a date in YYYY-MM-DD format",
    });
  }
  if (!isDateString(input.to_date)) {
    errors.push({
      field: "to_date",
      message: "Must be a date in YYYY-MM-DD format",
    });
  }
  if (
    isDateString(input.from_date) &&
    isDateString(input.to_date) &&
    input.to_date < input.from_date
  ) {
    errors.push({
      field: "to_date",
      message: "to_date cannot be before from_date",
    });
  }
  return result(errors);
}

/**
 * POST /api/v1/attendance/exceptions — shared attendanceExceptionCreateSchema.
 */
export function validateAttendanceException(input: {
  employee_id: string;
  exception_type: string;
  reason: string;
}): ValidationResult {
  const errors: FieldError[] = [];
  if (!isUuid(input.employee_id)) {
    errors.push({ field: "employee_id", message: "employee_id must be a UUID" });
  }
  req(errors, "exception_type", input.exception_type, "Type is required");
  if (!req(errors, "reason", input.reason, "Reason is required")) {
    // pushed above
  } else if ((input.reason as string).length > 2000) {
    errors.push({ field: "reason", message: "Reason must be ≤ 2000 characters" });
  }
  return result(errors);
}
