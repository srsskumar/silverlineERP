import { z } from 'zod';

export const loginSchema = z.object({
  // A username or a mobile number (§34). Still called `username` because
  // that is the field the API takes; what it accepts is wider.
  username: z
    .string()
    .min(1, 'Enter your username or mobile number')
    .max(100, 'That is too long to be either'),
  password: z
    .string()
    .min(1, 'Password is required')
    .max(200, 'Password must be at most 200 characters'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;

export const mfaSchema = z.object({
  token: z
    .string()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
});

export type MfaFormValues = z.infer<typeof mfaSchema>;

// ---------------------------------------------------------------------------
// S1 masters (frozen contract). Field names are snake_case to match the API.
// ---------------------------------------------------------------------------

/** E.164-ish: optional leading +, 8–15 digits, first digit non-zero. */
export const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
/** Strict calendar date YYYY-MM-DD. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateString = (message = 'Use YYYY-MM-DD') =>
  z
    .string()
    .trim()
    .regex(DATE_RE, message)
    .refine((v) => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), {
      message: 'Enter a valid calendar date',
    });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().trim().max(max).optional());

const optionalPhone = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(z.string().regex(PHONE_RE, 'Enter a valid phone number').optional());

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(z.string().email('Enter a valid email').max(255).optional());

const optionalDate = dateString().optional().or(z.literal('').transform(() => undefined)).pipe(dateString().optional());

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const EMPLOYEE_STATUSES = ['DRAFT', 'ACTIVE', 'ON_LEAVE', 'EXITED', 'TERMINATED'] as const;
export const ORG_UNIT_TYPES = ['district', 'division', 'mandal', 'village', 'site'] as const;
export const ORG_UNIT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

const employeeBaseFields = {
  emp_no: z.string().trim().min(1, 'Employee number is required').max(50),
  first_name: z.string().trim().min(1, 'First name is required').max(100),
  last_name: optionalText(100),
  father_name: optionalText(200),
  date_of_birth: optionalDate,
  gender: z.enum(GENDERS).optional(),
  phone: z.string().trim().regex(PHONE_RE, 'Enter a valid phone number'),
  phone_secondary: optionalPhone,
  email: optionalEmail,
  aadhaar: z
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(
      z
        .string()
        .regex(/^\d{12}$/, 'Aadhaar must be 12 digits')
        .optional(),
    ),
  pan: z
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(
      z
        .string()
        .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must look like ABCDE1234F')
        .optional(),
    ),
  address: optionalText(1000),
  district_id: optionalText(100),
  mandal_id: optionalText(100),
  village_id: optionalText(100),
  site_id: optionalText(100),
  designation: optionalText(100),
  /**
   * The list entry behind the title, when it came from the list.
   *
   * Sent alongside the text rather than instead of it: every payslip and
   * export already reads the text, and a record whose title only resolves
   * through a join prints blank wherever the join was forgotten.
   */
  designation_id: z.string().uuid().nullable().optional(),
  department: optionalText(100),
  date_of_joining: dateString('Date of joining must be YYYY-MM-DD'),
  reports_to: optionalText(100),
  salary_basic: z.coerce.number().nonnegative('Salary must be 0 or more').optional(),
  bank_name: optionalText(100),
  bank_account: optionalText(50),
  bank_ifsc: z
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(
      z
        .string()
        .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must look like ABCD0123456')
        .optional(),
    ),
  phonepe_number: optionalPhone,
  education: optionalText(500),
  skills: z.union([z.array(z.string().trim().min(1)).max(50), z.string().trim().max(2000)]).optional(),
  experience_years: z.coerce.number().min(0).max(60).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
};

function checkDobVsDoj<T extends { date_of_birth?: string; date_of_joining?: string }>(
  v: T,
  ctx: z.RefinementCtx,
): void {
  if (v.date_of_birth && v.date_of_joining && v.date_of_birth > v.date_of_joining) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['date_of_birth'],
      message: 'Date of birth must be on or before date of joining',
    });
  }
}

export const employeeCreateSchema = z.object(employeeBaseFields).superRefine(checkDobVsDoj);
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

export const employeeUpdateSchema = z.object(employeeBaseFields).partial().superRefine(checkDobVsDoj);
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

export const employeeExitSchema = z
  .object({
    exit_date: dateString('Exit date must be YYYY-MM-DD'),
    reason: z.string().trim().min(1, 'Reason is required').max(500),
    date_of_joining: dateString().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.date_of_joining && v.exit_date < v.date_of_joining) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exit_date'],
        message: 'Exit date cannot be before date of joining',
      });
    }
  });
export type EmployeeExitInput = z.infer<typeof employeeExitSchema>;

export const employeeReactivateSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(500),
});
export type EmployeeReactivateInput = z.infer<typeof employeeReactivateSchema>;

/** One CSV/API import row: required identity fields, everything else optional. */
export const importRowSchema = z
  .object(employeeBaseFields)
  .partial()
  .required({ emp_no: true, first_name: true, phone: true, date_of_joining: true })
  .superRefine(checkDobVsDoj);
export type ImportRowInput = z.infer<typeof importRowSchema>;

export const orgUnitSchema = z.object({
  type: z.enum(ORG_UNIT_TYPES, { errorMap: () => ({ message: 'Pick a location type' }) }),
  code: z.string().trim().min(1, 'Code is required').max(50),
  name: z.string().trim().min(1, 'Name is required').max(255),
  parent_id: z.string().trim().min(1).max(100).optional().nullable(),
});
export type OrgUnitInput = z.infer<typeof orgUnitSchema>;

export const orgUnitUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  status: z.enum(ORG_UNIT_STATUSES).optional(),
});
export type OrgUnitUpdateInput = z.infer<typeof orgUnitUpdateSchema>;

export const holidaySchema = z
  .object({
    date: dateString('Holiday date must be YYYY-MM-DD'),
    name: z.string().trim().min(1, 'Name is required').max(255),
    type: z.string().trim().min(1, 'Type is required').max(50),
    scope_type: z.enum(ORG_UNIT_TYPES).optional(),
    scope_id: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scope_id && !v.scope_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope_type'],
        message: 'Scope type is required when a scope is selected',
      });
    }
  });
export type HolidayInput = z.infer<typeof holidaySchema>;

export const documentUploadSchema = z.object({
  doc_type: z.string().trim().min(1, 'Document type is required').max(100),
  file_name: z.string().trim().min(1, 'File name is required').max(255),
  content_base64: z.string().min(1, 'File content is required'),
});
export type DocumentUploadInput = z.infer<typeof documentUploadSchema>;

// ---------------------------------------------------------------------------
// S2 attendance + geo-fences (frozen contract). Snake_case to match the API.
// ---------------------------------------------------------------------------

export const GEOMETRY_TYPES = ['circle', 'polygon'] as const;
export const PUNCH_EVENT_TYPES = ['CHECK_IN', 'CHECK_OUT'] as const;
export const RECORD_STATUSES = ['PRESENT', 'PARTIAL', 'ABSENT', 'VIOLATION'] as const;
export const EXCEPTION_TYPES = [
  'MISSED_PUNCH',
  'LATE_CHECKIN',
  'EARLY_CHECKOUT',
  'OUTSIDE_GEOFENCE',
  'REGULARIZATION',
  'SYSTEM_FLAG',
] as const;
export const EXCEPTION_DECISIONS = ['APPROVE', 'REJECT'] as const;

export interface ParsedPoint {
  lat: number;
  lng: number;
}

export type PolygonParseResult =
  | { ok: true; points: ParsedPoint[] }
  | { ok: false; error: string };

/**
 * Parse the polygon textarea format: one "lat,lng" pair per line.
 * Returns the first error encountered (line-numbered) or the points.
 * Callers enforce the ≥3-point minimum via `ok` + length check.
 */
export function parsePolygonTextarea(text: string): PolygonParseResult {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: 'Enter at least 3 points, one "lat,lng" per line' };
  const points: ParsedPoint[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts.length !== 2) {
      return { ok: false, error: `Line ${i + 1}: use "lat,lng" format` };
    }
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: `Line ${i + 1}: lat and lng must be numbers` };
    }
    if (lat < -90 || lat > 90) return { ok: false, error: `Line ${i + 1}: lat must be between -90 and 90` };
    if (lng < -180 || lng > 180) return { ok: false, error: `Line ${i + 1}: lng must be between -180 and 180` };
    points.push({ lat, lng });
  }
  if (points.length < 3) return { ok: false, error: `Polygon needs at least 3 points (got ${points.length})` };
  return { ok: true, points };
}

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalCoercedNumber = z.preprocess(emptyToUndefined, z.coerce.number().optional());
const optionalTolerance = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(0, 'Must be 0 or more').max(100_000).optional(),
);

export const fenceSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(255),
    scope_type: z.enum(ORG_UNIT_TYPES, { errorMap: () => ({ message: 'Pick a scope type' }) }),
    scope_id: z.string().trim().min(1, 'Scope is required').max(100),
    geometry_type: z.enum(GEOMETRY_TYPES, { errorMap: () => ({ message: 'Pick circle or polygon' }) }),
    circle_lat: optionalCoercedNumber,
    circle_lng: optionalCoercedNumber,
    radius_m: optionalCoercedNumber,
    polygon_text: z.string().optional().or(z.literal('').transform(() => undefined)).pipe(z.string().optional()),
    tolerance_meters: optionalTolerance,
    accuracy_threshold_meters: optionalTolerance,
  })
  .superRefine((v, ctx) => {
    if (v.geometry_type === 'circle') {
      if (v.circle_lat === undefined || v.circle_lat < -90 || v.circle_lat > 90) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['circle_lat'], message: 'Lat must be between -90 and 90' });
      }
      if (v.circle_lng === undefined || v.circle_lng < -180 || v.circle_lng > 180) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['circle_lng'], message: 'Lng must be between -180 and 180' });
      }
      if (v.radius_m === undefined || !(v.radius_m > 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['radius_m'], message: 'Radius must be greater than 0' });
      }
    } else {
      const parsed = parsePolygonTextarea(v.polygon_text ?? '');
      if (!parsed.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['polygon_text'], message: parsed.error });
      }
    }
  });
export type FenceFormInput = z.infer<typeof fenceSchema>;

export const punchFormSchema = z.object({
  employee_id: z.string().trim().min(1, 'Pick an employee'),
  event_type: z.enum(PUNCH_EVENT_TYPES),
  latitude: optionalCoercedNumber,
  longitude: optionalCoercedNumber,
  gps_accuracy: optionalCoercedNumber,
});
export type PunchFormInput = z.infer<typeof punchFormSchema>;

export const exceptionSchema = z.object({
  employee_id: z.string().trim().min(1, 'Employee is required').max(100),
  attendance_record_id: z.string().trim().min(1).max(100).optional().nullable(),
  exception_type: z.enum(EXCEPTION_TYPES, { errorMap: () => ({ message: 'Pick an exception type' }) }),
  reason: z.string().trim().min(1, 'Reason is required').max(2000),
  document_id: z.string().trim().min(1).max(100).optional().nullable(),
});
export type ExceptionFormInput = z.infer<typeof exceptionSchema>;

export const decisionSchema = z.object({
  decision: z.enum(EXCEPTION_DECISIONS),
  note: z.string().trim().max(1000).optional().nullable(),
});
export type DecisionFormInput = z.infer<typeof decisionSchema>;

const optionalTime = z.string().trim().min(1).max(100).optional().nullable();

export const regularizeSchema = z
  .object({
    employee_id: z.string().trim().min(1, 'Employee is required').max(100),
    work_date: dateString('Work date must be YYYY-MM-DD'),
    claimed_check_in: optionalTime,
    claimed_check_out: optionalTime,
    reason: z.string().trim().min(1, 'Reason is required').max(2000),
  })
  .superRefine((v, ctx) => {
    if (!v.claimed_check_in && !v.claimed_check_out) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimed_check_in'],
        message: 'Provide at least one claimed time (check-in or check-out)',
      });
    }
  });
export type RegularizeFormInput = z.infer<typeof regularizeSchema>;

// ---------------------------------------------------------------------------
// S3 leave (frozen contract). Snake_case to match the API.
// ---------------------------------------------------------------------------

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const LEAVE_DECISIONS = ['APPROVE', 'REJECT'] as const;

/** Local YYYY-MM-DD (client-side backdate check only — the server re-validates). */
function todayLocalString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * File-leave form: type required, from ≤ to, reason required when the range
 * starts before today (backdated). The backdate rule is a client-side
 * convenience — the server re-validates (REASON_REQUIRED).
 */
export const leaveRequestSchema = z
  .object({
    leave_type_id: z.string().trim().min(1, 'Pick a leave type'),
    from_date: dateString('From date must be YYYY-MM-DD'),
    to_date: dateString('To date must be YYYY-MM-DD'),
    reason: z.string().trim().max(2000, 'Reason must be at most 2000 characters').optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.from_date && v.to_date && v.from_date > v.to_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to_date'],
        message: 'To date must be on or after from date',
      });
    }
    if (v.from_date && v.from_date < todayLocalString() && !v.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Reason is required for backdated leave (server re-validates)',
      });
    }
  });
export type LeaveRequestFormInput = z.infer<typeof leaveRequestSchema>;

/** Leave decision: note required when rejecting (server enforces NOTE_REQUIRED). */
export const leaveDecisionSchema = z
  .object({
    decision: z.enum(LEAVE_DECISIONS),
    note: z.string().trim().max(1000, 'Note must be at most 1000 characters').optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'REJECT' && !v.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'A note is required when rejecting',
      });
    }
  });
export type LeaveDecisionFormInput = z.infer<typeof leaveDecisionSchema>;

/** Admin balance adjust (upsert): opening balance must be 0 or more. */
export const leaveBalanceSchema = z.object({
  employee_id: z.string().trim().min(1, 'Employee is required').max(100),
  leave_type_id: z.string().trim().min(1, 'Pick a leave type'),
  period_year: z.coerce.number().int('Year must be a whole number').min(2000).max(2100),
  opening_balance: z.coerce.number().min(0, 'Opening balance must be 0 or more'),
});
export type LeaveBalanceFormInput = z.infer<typeof leaveBalanceSchema>;

// ---------------------------------------------------------------------------
// S4 projects + tasks (frozen contract). Snake_case to match the API.
//
// NOTE (S4 gap — no users directory endpoint): assignee / project-manager
// inputs are user-ID (UUID) text fields. There is no server-side user search
// in S4, so the client validates UUID shape only. See apps/web/README.md.
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED_PENDING_CLOSE',
  'CLOSED',
  'CANCELLED',
] as const;

export const TASK_STATUSES = [
  'TO_DO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'BLOCKED',
  'CANCELLED',
] as const;

/** Non-empty UUID text (user ids); empty string is treated as absent by optionalUuid. */
const userUuid = (message = 'Enter a valid user ID (UUID)') =>
  z.string().trim().uuid(message);

const optionalUuid = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(userUuid('Enter a valid user ID (UUID)').optional());

const optionalS4Date = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(
    z
      .string()
      .trim()
      .regex(DATE_RE, 'Use YYYY-MM-DD')
      .optional(),
  );

const optionalS4Text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().trim().max(max).optional());

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  description: optionalS4Text(2000),
});
export type WorkspaceFormInput = z.infer<typeof workspaceSchema>;

export const projectSchema = z
  .object({
    workspace_id: z.string().trim().min(1, 'Pick a workspace'),
    code: z.string().trim().min(1, 'Code is required').max(50),
    name: z.string().trim().min(1, 'Name is required').max(255),
    project_type_id: optionalS4Text(100),
    description: optionalS4Text(2000),
    project_manager_id: optionalUuid,
    planned_start_date: optionalS4Date,
    planned_end_date: optionalS4Date,
    priority: optionalS4Text(50),
    // §8 / §8.8: government and private work run differently, so the track is
    // recorded rather than inferred from whether a tender happens to be linked.
    project_kind: z.union([z.literal(''), z.enum(['GOVERNMENT', 'PRIVATE'])]).optional(),
    client_id: optionalUuid,
    contract_value: optionalS4Text(20),
    work_order_number: optionalS4Text(100),
  })
  .superRefine((v, ctx) => {
    if (v.planned_start_date && v.planned_end_date && v.planned_start_date > v.planned_end_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planned_end_date'],
        message: 'Planned end date must be on or after the planned start date',
      });
    }
    if (v.contract_value && !Number.isFinite(Number(v.contract_value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contract_value'],
        message: 'Contract value must be a number',
      });
    }
    // A work order is the government client's instruction to start. It has no
    // meaning on a private job, where the equivalent is a signed proposal.
    if (v.work_order_number && v.project_kind === 'PRIVATE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['work_order_number'],
        message: 'A work order number belongs to government work',
      });
    }
  });
export type ProjectFormInput = z.infer<typeof projectSchema>;

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: optionalS4Text(2000),
  project_manager_id: optionalUuid,
  planned_start_date: optionalS4Date,
  planned_end_date: optionalS4Date,
  priority: optionalS4Text(50),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>;

/** Quick-add: title-only is valid (project is fixed by the page context). */
export const taskQuickAddSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(500),
});
export type TaskQuickAddInput = z.infer<typeof taskQuickAddSchema>;

/** PATCH task fields — status is excluded (use the status endpoint). Strict: rejects `status` rather than silently dropping it. */
export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(500).optional(),
    description: optionalS4Text(5000),
    priority: optionalS4Text(50),
  })
  .strict();
export type TaskPatchInput = z.infer<typeof taskPatchSchema>;

export const statusSchema = z.object({
  status: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Pick a status'),
});
export type StatusFormInput = z.infer<typeof statusSchema>;

/** Assign: reason is required server-side — enforce it client-side too. */
export const assignSchema = z.object({
  assignee_id: userUuid('Enter a valid user ID (UUID) — paste it; there is no users directory in S4'),
  reason: z.string().trim().min(1, 'Reason is required').max(2000),
});
export type AssignFormInput = z.infer<typeof assignSchema>;

export const dependencySchema = z.object({
  predecessor_id: userUuid('Enter a valid predecessor task ID (UUID)'),
});
export type DependencyFormInput = z.infer<typeof dependencySchema>;

/** Task evidence upload payload (file checks live in checkEvidenceFile). */
export const evidenceSchema = z.object({
  evidence_type: z.string().trim().min(1, 'Evidence type is required').max(100),
  file_name: z.string().trim().min(1, 'File name is required').max(255),
  content_base64: z.string().min(1, 'File content is required'),
});
export type EvidenceFormInput = z.infer<typeof evidenceSchema>;

/** 5MB client-side cap (mirrors the documents cap). */
export const MAX_TASK_EVIDENCE_BYTES = 5 * 1024 * 1024;

/** Allowlist of evidence file extensions (lowercase, without the dot). */
export const EVIDENCE_ALLOWED_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'csv',
  'log',
] as const;

/** True when the file name carries an allowlisted extension. */
export function evidenceExtensionOk(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return false;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (EVIDENCE_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Client-side evidence file gate: 5MB cap + extension allowlist.
 * Returns an error message, or null when the file is acceptable.
 */
export function checkEvidenceFile(file: { size: number; name: string }): string | null {
  if (file.size > MAX_TASK_EVIDENCE_BYTES) {
    return `File is ${(file.size / 1024 / 1024).toFixed(1)}MB; maximum is 5MB.`;
  }
  if (!evidenceExtensionOk(file.name)) {
    return `“.${file.name.split('.').pop()?.toLowerCase() ?? ''}” files are not accepted — allowed: ${(EVIDENCE_ALLOWED_EXTENSIONS as readonly string[]).join(', ')}.`;
  }
  return null;
}

/** Hint shown under the comment box (server extracts @mentions from the body). */
export const MENTION_HINT_TEXT = 'Tip: use @username to mention teammates — mentioned names are confirmed after posting.';

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(5000, 'Comment must be at most 5000 characters'),
});
export type CommentFormInput = z.infer<typeof commentSchema>;

// ---------------------------------------------------------------------------
// S5 boards + saved filters + labels (frozen contract). Snake_case to match the API.
// ---------------------------------------------------------------------------

export const BOARD_VIEW_TYPES = ['LIST', 'KANBAN'] as const;

export const boardSchema = z.object({
  project_id: z.string().trim().min(1, 'Project is required'),
  name: z.string().trim().min(1, 'Name is required').max(255),
  view_type: z.enum(BOARD_VIEW_TYPES, { errorMap: () => ({ message: 'Pick LIST or KANBAN' }) }),
  column_config: z.unknown().optional(),
  filter_config: z.unknown().optional(),
});
export type BoardFormInput = z.infer<typeof boardSchema>;

export const boardColumnSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  status_code: z.string().trim().min(1, 'Status is required').max(50),
  name: z.string().trim().min(1, 'Name is required').max(100),
  position: z.coerce.number().int().min(0).max(1000),
  wip_limit: z.coerce.number().int().min(1).max(1000).optional().nullable(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => undefined))
    .pipe(
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB')
        .optional(),
    ),
});
export type BoardColumnInput = z.infer<typeof boardColumnSchema>;

export const boardColumnsSchema = z.object({
  columns: z.array(boardColumnSchema).min(1, 'Add at least one column').max(50),
});
export type BoardColumnsFormInput = z.infer<typeof boardColumnsSchema>;

/** Hex color gate shared by label + column color inputs. */
export const LABEL_HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isLabelColorValid(color: unknown): boolean {
  return typeof color === 'string' && LABEL_HEX_RE.test(color.trim());
}

export const labelSchema = z.object({
  project_id: z.string().trim().min(1).max(100).optional().nullable(),
  name: z.string().trim().min(1, 'Name is required').max(100),
  color: z
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(
      z
        .string()
        .regex(LABEL_HEX_RE, 'Use #RRGGBB (e.g. #2f5bff)')
        .optional(),
    ),
});
export type LabelFormInput = z.infer<typeof labelSchema>;

export const savedFilterQuerySchema = z.object({
  status: z.string().trim().max(50).optional(),
  q: z.string().trim().max(500).optional(),
  assignee_me: z.string().trim().max(10).optional(),
  label_ids: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  sla: z.string().trim().max(50).optional(),
});

export const savedFilterSchema = z.object({
  project_id: z.string().trim().min(1).max(100).optional().nullable(),
  name: z.string().trim().min(1, 'Name is required').max(255),
  query_definition: savedFilterQuerySchema.passthrough(),
});
export type SavedFilterFormInput = z.infer<typeof savedFilterSchema>;

// ---------------------------------------------------------------------------
// P1 payroll (frozen contract). Snake_case to match the API.
// ---------------------------------------------------------------------------

/** Server-side period cap (PERIOD_TOO_LONG beyond this inclusive span). */
export const MAX_PAYROLL_PERIOD_DAYS = 62;

const PAYROLL_DAY_MS = 86_400_000;

function payrollSpanDays(start: string, end: string): number | null {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return null;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / PAYROLL_DAY_MS) + 1;
}

/**
 * Payroll run period: start ≤ end and an inclusive span of at most 62 days.
 * The server re-validates (PERIOD_TOO_LONG / OVERLAPPING_RUN).
 */
export const payrollPeriodSchema = z
  .object({
    period_start: dateString('Period start must be YYYY-MM-DD'),
    period_end: dateString('Period end must be YYYY-MM-DD'),
  })
  .superRefine((v, ctx) => {
    if (v.period_start && v.period_end) {
      if (v.period_start > v.period_end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['period_end'],
          message: 'Period end must be on or after period start',
        });
        return;
      }
      const span = payrollSpanDays(v.period_start, v.period_end);
      if (span !== null && span > MAX_PAYROLL_PERIOD_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['period_end'],
          message: `Period is ${span} days; maximum is ${MAX_PAYROLL_PERIOD_DAYS} days (PERIOD_TOO_LONG)`,
        });
      }
    }
  });
export type PayrollPeriodInput = z.infer<typeof payrollPeriodSchema>;

/** Alias for the run-period schema (start ≤ end, ≤62d span). */
export const periodSchema = payrollPeriodSchema;
export type PeriodInput = PayrollPeriodInput;

/** Payroll policy: per-day divisor 1..31, PF percent 0..100. */
export const payrollPolicySchema = z.object({
  per_day_divisor: z.coerce
    .number()
    .int('Divisor must be a whole number')
    .min(1, 'Divisor must be between 1 and 31')
    .max(31, 'Divisor must be between 1 and 31'),
  pf_pct: z.coerce.number().min(0, 'PF % must be between 0 and 100').max(100, 'PF % must be between 0 and 100'),
});
export type PayrollPolicyInput = z.infer<typeof payrollPolicySchema>;

/** Alias for the policy schema. */
export const policySchema = payrollPolicySchema;
export type PolicyInput = PayrollPolicyInput;

/** Approve note: optional free text (server accepts `{note?}`). */
export const approveNoteSchema = z
  .string()
  .trim()
  .max(1000, 'Note must be at most 1000 characters')
  .optional()
  .nullable();
export type ApproveNoteInput = z.infer<typeof approveNoteSchema>;

/** REVIEW → APPROVED payload (note optional). */
export const payrollApproveSchema = z.object({
  note: approveNoteSchema,
});
export type PayrollApproveInput = z.infer<typeof payrollApproveSchema>;

/** LOCKED → APPROVED payload (reason required — the reopen branch). */
export const payrollReopenSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(2000, 'Reason must be at most 2000 characters'),
});
export type PayrollReopenInput = z.infer<typeof payrollReopenSchema>;

/** Alias for the reopen schema (reason required). */
export const reopenSchema = payrollReopenSchema;
export type ReopenInput = PayrollReopenInput;

// ---------------------------------------------------------------------------
// S6 reports (frozen contract). Type-only UI — format fixed csv, no filters.
// ---------------------------------------------------------------------------

export const REPORT_TYPES = ['employees', 'attendance', 'tasks', 'leave','inventory','assets','invoices','payroll','projects','cycles','audit'] as const;

export const reportSchema = z.object({
  type: z.enum(REPORT_TYPES, { errorMap: () => ({ message: 'Pick a report type' }) }),
});
export type ReportFormInput = z.infer<typeof reportSchema>;
