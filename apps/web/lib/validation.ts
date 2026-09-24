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

/**
 * Money: a non-negative amount with at most 2 decimal places, validated on the
 * raw string before it is coerced to a number — `Number('12.345')` loses
 * nothing on its own, so the decimal-place check has to run before that
 * conversion, not after it.
 */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

const moneyField = (message = 'Enter an amount of 0 or more, with at most 2 decimal places') =>
  z.coerce
    .string()
    .trim()
    .regex(MONEY_RE, message)
    .transform((v) => Number(v));

const optionalMoneyField = (message = 'Enter an amount of 0 or more, with at most 2 decimal places') =>
  z.coerce
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined))
    .transform((v) => (v === '' ? undefined : v))
    .pipe(z.string().regex(MONEY_RE, message).transform((v) => Number(v)).optional());

/** Money that must be strictly positive (an advance, a fixed deduction). */
const positiveMoneyField = (message = 'Enter an amount greater than 0, with at most 2 decimal places') =>
  moneyField(message).refine((v) => v > 0, message);

/**
 * An optional enum backed by a `<select>` (A-008/A-009).
 *
 * `z.enum(values).optional()` only treats `undefined` as "not set" — the
 * `""` a native `<select>`'s blank first option submits fails enum
 * validation instead of being treated as unset, which blocks the whole form
 * (not just that field) the moment the picker is left on its placeholder.
 * Every other optional field in this file already tolerates `""` this way;
 * enum fields need the same treatment.
 */
const optionalEnum = <T extends [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .optional()
    .or(z.literal('').transform(() => undefined))
    .pipe(z.enum(values).optional());

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
  gender: optionalEnum(GENDERS),
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
  status: optionalEnum(EMPLOYEE_STATUSES),
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

// Same shape as reactivate — mirrors the API's employeeActivateSchema /
// employeeSuspendSchema (packages/shared/src/s1.ts), both `{ reason }` only.
export const employeeActivateSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(500),
});
export type EmployeeActivateInput = z.infer<typeof employeeActivateSchema>;

export const employeeSuspendSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(500),
});
export type EmployeeSuspendInput = z.infer<typeof employeeSuspendSchema>;

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

// Must mirror the API's holidayTypeSchema (packages/shared/src/s1.ts) exactly —
// a client that accepts a value the server doesn't (e.g. the old free-text
// "PUBLIC"/"FESTIVAL" placeholder) turns every such submission into a
// guaranteed 422 (A-007).
export const HOLIDAY_TYPES = ['national', 'regional', 'local', 'weekly_off', 'manual'] as const;

// Humanised labels for the Type picker. The submitted value is still the raw
// server enum member above — only the text shown in the <option> changes.
export const HOLIDAY_TYPE_LABELS: Record<(typeof HOLIDAY_TYPES)[number], string> = {
  national: 'National',
  regional: 'Regional',
  local: 'Local',
  weekly_off: 'Weekly off',
  manual: 'Manual',
};

export const holidaySchema = z
  .object({
    date: dateString('Holiday date must be YYYY-MM-DD'),
    name: z.string().trim().min(1, 'Name is required').max(255),
    type: z.enum(HOLIDAY_TYPES, { errorMap: () => ({ message: 'Pick a holiday type' }) }),
    scope_type: optionalEnum(ORG_UNIT_TYPES),
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
// S2 attendance (frozen contract). Snake_case to match the API.
//
// No geo-fencing (decision 2026-09-22): the fence form, its polygon parser
// and the VIOLATION status are gone. OUTSIDE_GEOFENCE can no longer be filed;
// rows that already carry it are labelled through EXCEPTION_TYPE_LABELS.
// ---------------------------------------------------------------------------

export const PUNCH_EVENT_TYPES = ['CHECK_IN', 'CHECK_OUT'] as const;
export const RECORD_STATUSES = ['PRESENT', 'PARTIAL', 'ABSENT'] as const;
export const EXCEPTION_TYPES = [
  'MISSED_PUNCH',
  'LATE_CHECKIN',
  'EARLY_CHECKOUT',
  'REGULARIZATION',
  'SYSTEM_FLAG',
] as const;
export const EXCEPTION_DECISIONS = ['APPROVE', 'REJECT'] as const;

/** Labels for every exception type a stored row may carry, including the retired one. */
export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  MISSED_PUNCH: 'Missed punch',
  LATE_CHECKIN: 'Late check-in',
  EARLY_CHECKOUT: 'Early check-out',
  REGULARIZATION: 'Regularization',
  SYSTEM_FLAG: 'System flag',
  OUTSIDE_GEOFENCE: 'Outside geo-fence (legacy)',
};

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optionalCoercedNumber = z.preprocess(emptyToUndefined, z.coerce.number().optional());

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

// ---------------------------------------------------------------------------
// Procurement creation forms (Task 5a, B-005). Field lists are cross-checked
// against apps/api/src/modules/procurement/routes.ts's zod schemas
// (packages/shared/src/procurement.ts) so nothing typed here is silently
// stripped server-side.
// ---------------------------------------------------------------------------

export const requisitionLineSchema = z.object({
  item_id: optionalUuid,
  description: z.string().trim().min(1, 'Description is required').max(255),
  unit: z.string().trim().min(1, 'Unit is required').max(20),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
  estimated_rate: optionalMoneyField(),
  remarks: optionalText(500),
});
export type RequisitionLineInput = z.infer<typeof requisitionLineSchema>;

export const requisitionSchema = z.object({
  requisition_no: z.string().trim().min(1, 'Requisition number is required').max(50),
  project_id: optionalUuid,
  required_by: optionalDate,
  justification: z.string().trim().min(1, 'Justification is required').max(2000),
  lines: z.array(requisitionLineSchema).min(1, 'Add at least one line'),
});
export type RequisitionFormInput = z.infer<typeof requisitionSchema>;

const HSN_RE = /^[0-9]{4,8}$/;
const PLACE_OF_SUPPLY_RE = /^[0-9]{2}$/;

const optionalHsn = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(z.string().regex(HSN_RE, 'HSN/SAC is 4 to 8 digits').optional());

const optionalPlaceOfSupply = z
  .string()
  .trim()
  .optional()
  .or(z.literal('').transform(() => undefined))
  .transform((v) => (v === '' ? undefined : v))
  .pipe(z.string().regex(PLACE_OF_SUPPLY_RE, 'Place of supply is a two-digit state code').optional());

export const purchaseOrderLineSchema = z.object({
  item_id: optionalUuid,
  requisition_line_id: optionalUuid,
  description: z.string().trim().min(1, 'Description is required').max(255),
  hsn_sac: optionalHsn,
  unit: z.string().trim().min(1, 'Unit is required').max(20),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
  unit_rate: moneyField('Enter a rate of 0 or more, with at most 2 decimal places'),
  gst_rate_pct: z.coerce
    .number()
    .min(0, 'GST % must be between 0 and 28')
    .max(28, 'GST % must be between 0 and 28')
    .default(0),
  remarks: optionalText(500),
});
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineSchema>;

export const purchaseOrderSchema = z.object({
  po_number: z.string().trim().min(1, 'Order number is required').max(50),
  vendor_id: z.string().trim().uuid('Choose a vendor'),
  requisition_id: optionalUuid,
  project_id: optionalUuid,
  po_date: dateString('Order date must be YYYY-MM-DD'),
  delivery_date: optionalDate,
  payment_terms: optionalText(200),
  delivery_address: optionalText(1000),
  place_of_supply: optionalPlaceOfSupply,
  scope_override_reason: optionalText(1000),
  lines: z.array(purchaseOrderLineSchema).min(1, 'Add at least one line'),
});
export type PurchaseOrderFormInput = z.infer<typeof purchaseOrderSchema>;

export const grnLineSchema = z
  .object({
    po_line_id: z.string().trim().uuid('Pick a line'),
    received_quantity: z.coerce.number().min(0, 'Received quantity must be 0 or more'),
    accepted_quantity: z.coerce.number().min(0, 'Accepted quantity must be 0 or more'),
    rejection_reason: optionalText(500),
    remarks: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.accepted_quantity > v.received_quantity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accepted_quantity'],
        message: 'More cannot be accepted than was received',
      });
    }
    if (v.received_quantity > v.accepted_quantity && !v.rejection_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejection_reason'],
        message: 'Say why the balance was rejected',
      });
    }
  });
export type GrnLineInput = z.infer<typeof grnLineSchema>;

/**
 * `over_receipt_reason` is not part of the API's `grnSchema` — the route reads
 * it straight off the raw request body (see procurement/routes.ts) — but it
 * has to travel in the same JSON object, so it is validated here too.
 */
export const grnSchema = z.object({
  grn_no: z.string().trim().min(1, 'Receipt number is required').max(50),
  purchase_order_id: z.string().trim().uuid('Pick a purchase order'),
  received_date: dateString('Received date must be YYYY-MM-DD'),
  challan_no: optionalText(50),
  vehicle_no: optionalText(20),
  over_receipt_reason: optionalText(1000),
  lines: z.array(grnLineSchema).min(1, 'Add at least one line'),
});
export type GrnFormInput = z.infer<typeof grnSchema>;

export const rfqLineSchema = z.object({
  item_id: optionalUuid,
  description: z.string().trim().min(1, 'Description is required').max(255),
  unit: z.string().trim().min(1, 'Unit is required').max(20),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
});
export type RfqLineInput = z.infer<typeof rfqLineSchema>;

export const rfqSchema = z.object({
  rfq_no: z.string().trim().min(1, 'RFQ number is required').max(50),
  requisition_id: optionalUuid,
  project_id: optionalUuid,
  due_date: dateString('Due date must be YYYY-MM-DD'),
  scope: optionalText(4000),
  vendor_ids: z
    .array(z.string().trim().uuid('Choose a vendor'))
    .min(2, 'Invite at least two vendors')
    .max(20, 'At most 20 vendors'),
  lines: z.array(rfqLineSchema).min(1, 'Add at least one line'),
});
export type RfqFormInput = z.infer<typeof rfqSchema>;

// ---------------------------------------------------------------------------
// Billing creation forms (Task 5a, B-007). Field lists are cross-checked
// against apps/api/src/modules/billing/routes.ts's zod schemas
// (packages/shared/src/ra-billing.ts).
// ---------------------------------------------------------------------------

export const raBillLineSchema = z.object({
  boq_item_id: z.string().trim().uuid('Pick a BOQ item'),
  cumulative_quantity: z.coerce.number().min(0, 'Cumulative quantity must be 0 or more'),
  remarks: optionalText(500),
});
export type RaBillLineInput = z.infer<typeof raBillLineSchema>;

export const RA_BILL_DEDUCTION_HEADS = ['LIQUIDATED_DAMAGES', 'PENALTY', 'OTHER'] as const;

export const raBillFixedDeductionSchema = z.object({
  head: z.enum(RA_BILL_DEDUCTION_HEADS, { errorMap: () => ({ message: 'Pick a deduction head' }) }),
  label: z.string().trim().min(1, 'Label is required').max(150),
  amount: positiveMoneyField('Enter an amount greater than 0, with at most 2 decimal places'),
  reason: z.string().trim().min(1, 'Reason is required').max(1000),
});
export type RaBillFixedDeductionInput = z.infer<typeof raBillFixedDeductionSchema>;

export const raBillSchema = z
  .object({
    project_id: z.string().trim().uuid('Pick a project'),
    bill_type: z.enum(['RA', 'FINAL']).default('RA'),
    period_from: dateString('Period start must be YYYY-MM-DD'),
    period_to: dateString('Period end must be YYYY-MM-DD'),
    measurement_book_ref: optionalText(100),
    remarks: optionalText(4000),
    lines: z.array(raBillLineSchema).min(1, 'Add at least one measured item'),
    fixed_deductions: z.array(raBillFixedDeductionSchema).max(20).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.period_from && v.period_to && v.period_to < v.period_from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['period_to'],
        message: 'The period cannot end before it starts',
      });
    }
  });
export type RaBillFormInput = z.infer<typeof raBillSchema>;

export const ADVANCE_TYPES = ['MOBILISATION', 'MATERIAL', 'PLANT'] as const;

export const advanceSchema = z.object({
  project_id: z.string().trim().uuid('Pick a project'),
  advance_type: z.enum(ADVANCE_TYPES, { errorMap: () => ({ message: 'Pick an advance type' }) }),
  amount: positiveMoneyField('Enter an amount greater than 0, with at most 2 decimal places'),
  paid_on: dateString('Paid-on date must be YYYY-MM-DD'),
  recovery_pct: z.coerce
    .number()
    .min(0.01, 'Recovery % must be greater than 0')
    .max(100, 'Recovery % must be at most 100'),
  bank_guarantee_id: optionalUuid,
  remarks: optionalText(1000),
});
export type AdvanceFormInput = z.infer<typeof advanceSchema>;

/** POST /api/v1/payment-runs/:id/execute (B-002) — mirrors paymentRunExecuteSchema. */
export const paymentRunExecuteSchema = z.object({
  paid_on: dateString('Paid-on date must be YYYY-MM-DD'),
  bank_reference: z
    .string()
    .trim()
    .min(1, 'Enter the bank reference (UTR/cheque number)')
    .max(100, 'Bank reference must be at most 100 characters'),
  note: optionalText(1000),
});
export type PaymentRunExecuteFormInput = z.infer<typeof paymentRunExecuteSchema>;

// ---------------------------------------------------------------------------
// A-012: editing and deactivating/reactivating a holiday. Mirrors the API's
// holidayPatchSchema (packages/shared/src/s1.ts) exactly — date/name/type,
// plus a reason the server requires on every PATCH. scope is not patchable
// server-side, so it is not offered here either.
// ---------------------------------------------------------------------------

export const holidayEditSchema = z.object({
  date: dateString('Holiday date must be YYYY-MM-DD'),
  name: z.string().trim().min(1, 'Name is required').max(255),
  type: z.enum(HOLIDAY_TYPES, { errorMap: () => ({ message: 'Pick a holiday type' }) }),
  reason: z.string().trim().min(1, 'Say why the holiday is being changed').max(2000),
});
export type HolidayEditInput = z.infer<typeof holidayEditSchema>;

/** Deactivate/reactivate: only `active` changes, but the API still requires a reason. */
export const holidayStatusChangeSchema = z.object({
  reason: z.string().trim().min(1, 'Say why the holiday is being changed').max(2000),
});
export type HolidayStatusChangeInput = z.infer<typeof holidayStatusChangeSchema>;
