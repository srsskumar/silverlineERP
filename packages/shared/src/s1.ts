import { z } from "zod";
import type { RoleCode } from "./rbac.js";

/**
 * S1 contracts (Silverline ERP sprint S1): org units, employees, documents,
 * holidays. ADDITIVE module — existing exports in other files are untouched.
 *
 * Permission codes below use dotted names (e.g. `employee.read`); the S0
 * `PERMISSIONS` map is intentionally not modified.
 */

export const S1_PERMISSIONS = {
  ORG_UNITS_READ: "org.units.read",
  ORG_UNITS_MANAGE: "org.units.manage",
  EMPLOYEE_READ: "employee.read",
  EMPLOYEE_CREATE: "employee.create",
  EMPLOYEE_EXIT: "employee.exit",
  EMPLOYEE_REACTIVATE: "employee.reactivate",
  EMPLOYEE_IMPORT: "employee.import",
  EMPLOYEE_PII_READ: "employee.pii.read",
  DOCUMENT_READ: "document.read",
  DOCUMENT_UPLOAD: "document.upload",
  HOLIDAY_READ: "holiday.read",
  HOLIDAY_MANAGE: "holiday.manage",
} as const;

export type S1PermissionCode =
  (typeof S1_PERMISSIONS)[keyof typeof S1_PERMISSIONS];

export const S1_ALL_PERMISSIONS: string[] = Object.values(S1_PERMISSIONS);

const EMPLOYEE_ALL = [
  S1_PERMISSIONS.EMPLOYEE_READ,
  S1_PERMISSIONS.EMPLOYEE_CREATE,
  S1_PERMISSIONS.EMPLOYEE_EXIT,
  S1_PERMISSIONS.EMPLOYEE_REACTIVATE,
  S1_PERMISSIONS.EMPLOYEE_IMPORT,
  S1_PERMISSIONS.EMPLOYEE_PII_READ,
];

/**
 * Additive S1 grants per system role. The seeder unions these with the S0
 * `ROLE_PERMISSIONS` map (which is left unchanged).
 */
export const S1_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S1_ALL_PERMISSIONS],
  ADMIN: [...S1_ALL_PERMISSIONS],
  HR_MANAGER: [
    ...EMPLOYEE_ALL,
    S1_PERMISSIONS.ORG_UNITS_READ,
    S1_PERMISSIONS.HOLIDAY_READ,
    S1_PERMISSIONS.HOLIDAY_MANAGE,
    S1_PERMISSIONS.DOCUMENT_READ,
    S1_PERMISSIONS.DOCUMENT_UPLOAD,
  ],
  PROJECT_MANAGER: [
    S1_PERMISSIONS.EMPLOYEE_READ,
    S1_PERMISSIONS.ORG_UNITS_READ,
    S1_PERMISSIONS.DOCUMENT_READ,
  ],
  TEAM_LEAD: [
    S1_PERMISSIONS.EMPLOYEE_READ,
    S1_PERMISSIONS.ORG_UNITS_READ,
    S1_PERMISSIONS.DOCUMENT_READ,
  ],
  // PRD §4: PAYROLL_OFFICER is payroll-only and INVENTORY_MANAGER has no
  // business perms (no inventory module yet) — neither holds employee codes.
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: [],
  EMPLOYEE: [],
  CLIENT_VIEWER: [],
  AUDITOR: [S1_PERMISSIONS.EMPLOYEE_READ],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[], GOVT_OBSERVER:[],
};

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

/** Calendar date as `YYYY-MM-DD` (stored as Postgres DATE). */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");

export type DateString = z.infer<typeof dateStringSchema>;

/** Phone numbers: optional leading `+`, 7–15 digits. */
export const phoneSchema = z
  .string()
  .regex(/^\+?[0-9]{7,15}$/, "Invalid phone number");

export const orgUnitTypeSchema = z.enum([
  "district",
  // Optional tier between district and mandal. Andhra Pradesh revenue
  // geography is District -> Division -> Mandal -> Village, and the land
  // survey master list (§59) arrives keyed on it. Optional because every
  // mandal already recorded has a district for a parent.
  "division",
  "mandal",
  "village",
  "site",
]);

export type OrgUnitType = z.infer<typeof orgUnitTypeSchema>;

export const orgUnitStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

/** POST /api/v1/org/units */
export const orgUnitCreateSchema = z.object({
  type: orgUnitTypeSchema,
  code: z.string().min(1, "Code is required").max(50),
  name: z.string().min(1, "Name is required").max(255),
  parent_id: z.string().uuid("parent_id must be a UUID").optional(),
});

export type OrgUnitCreateInput = z.infer<typeof orgUnitCreateSchema>;

/** PATCH /api/v1/org/units/:id — status changes go through this schema. */
export const orgUnitPatchSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: orgUnitStatusSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: "Nothing to update",
  });

export type OrgUnitPatchInput = z.infer<typeof orgUnitPatchSchema>;

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/** POST /api/v1/employees — also reused for each bulk-import row. */
export const employeeCreateSchema = z.object({
  /**
   * The employee number.
   *
   * Optional: the server allocates the next one when it is left out, which
   * is what a bulk upload wants. Nobody filling in two hundred rows should be
   * inventing unique identifiers by hand, and the ones they invent collide —
   * two people typing the next number at the same time produce the same
   * number, and one of the two imports fails on a constraint nobody expected.
   *
   * Still accepted when given, because an organisation migrating from another
   * system has numbers already printed on ID cards, and renumbering everybody
   * to suit us is not a migration anybody would agree to.
   */
  emp_no: z.string().min(1).max(50).optional(),
  first_name: z.string().min(1, "first_name is required").max(100),
  last_name: z.string().max(100).optional(),
  father_name: z.string().max(200).optional(),
  date_of_birth: dateStringSchema.optional(),
  gender: z.string().max(20).optional(),
  phone: phoneSchema,
  phone_secondary: phoneSchema.optional(),
  email: z.string().email("Invalid email").max(255).optional(),
  address: z.string().max(2000).optional(),
  district_id: z.string().uuid().optional(),
  mandal_id: z.string().uuid().optional(),
  village_id: z.string().uuid().optional(),
  site_id: z.string().uuid().optional(),
  designation: z.string().max(100).optional(),
  /**
   * The designation chosen from the list, when it came from the list.
   *
   * The label stays alongside it: every report, payslip and export already
   * reads the text, and a record whose title can only be resolved by a join
   * is a record that prints blank wherever the join was forgotten.
   */
  designation_id: z.string().uuid().nullable().optional(),
  department: z.string().max(100).optional(),
  date_of_joining: dateStringSchema,
  reports_to: z.string().uuid().optional(),
  salary_basic: z.number().min(0).optional(),
  bank_name: z.string().max(100).optional(),
  bank_account: z.string().max(100).optional(),
  bank_ifsc: z.string().max(20).optional(),
  phonepe_number: phoneSchema.optional(),
  aadhaar: z.string().max(32).optional(),
  pan: z.string().max(32).optional(),
  education: z.string().max(2000).optional(),
  skills: z.array(z.string().max(100)).max(100).default([]),
  experience_years: z.number().min(0).max(60).optional(),
});

export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

/**
 * PATCH /api/v1/employees/:id. `status` is deliberately absent — status
 * moves only via exit/reactivate (the route rejects a `status` key with 422).
 */
export const employeePatchSchema = employeeCreateSchema.partial();

export type EmployeePatchInput = z.infer<typeof employeePatchSchema>;

/** POST /api/v1/employees/:id/exit */
export const employeeExitSchema = z.object({
  exit_date: dateStringSchema,
  reason: z.string().min(1, "Reason is required").max(2000),
});

export type EmployeeExitInput = z.infer<typeof employeeExitSchema>;

/**
 * POST /api/v1/employees/:id/activate — DRAFT → ACTIVE.
 *
 * Creation deliberately lands an employee in DRAFT so a half-entered record
 * cannot punch, hold a fence or be paid. Activation is the explicit, audited
 * step that puts them on the roster once the record is complete.
 */
export const employeeActivateSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(2000),
});

export type EmployeeActivateInput = z.infer<typeof employeeActivateSchema>;

/** POST /api/v1/employees/:id/suspend — ACTIVE → SUSPENDED. */
export const employeeSuspendSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(2000),
});

export type EmployeeSuspendInput = z.infer<typeof employeeSuspendSchema>;

/** POST /api/v1/employees/:id/reactivate */
export const employeeReactivateSchema = z.object({
  reason: z.string().min(1, "Reason is required").max(2000),
});

export type EmployeeReactivateInput = z.infer<
  typeof employeeReactivateSchema
>;

/** POST /api/v1/employees/bulk-import — synchronous in S1 (max 500 rows). */
export const bulkImportSchema = z.object({
  rows: z
    .array(employeeCreateSchema)
    .min(1, "At least one row is required")
    .max(500, "At most 500 rows per import"),
});

export type BulkImportInput = z.infer<typeof bulkImportSchema>;

export interface BulkImportRowError {
  index: number;
  emp_no?: string;
  errors: Array<{ field: string; message: string }>;
}

export interface BulkImportReport {
  imported: number;
  failed: number;
  errors: BulkImportRowError[];
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** POST /api/v1/employees/:id/documents */
export const documentUploadSchema = z.object({
  doc_type: z.string().min(1, "doc_type is required").max(100),
  file_name: z.string().min(1, "file_name is required").max(255),
  content_base64: z.string().min(1, "content_base64 is required"),
});

export type DocumentUploadInput = z.infer<typeof documentUploadSchema>;

/** Binary allowlist for S1 local uploads (matched on file extension). */
export const ALLOWED_DOCUMENT_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"] as const;

/** S1 local-driver cap: 5 MiB of decoded binary per file. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export const holidayTypeSchema = z.enum([
  "national",
  "regional",
  "local",
  "weekly_off",
  "manual",
]);

export type HolidayType = z.infer<typeof holidayTypeSchema>;

/** POST /api/v1/holidays */
export const holidayCreateSchema = z.object({
  date: dateStringSchema,
  name: z.string().min(1, "Name is required").max(255),
  type: holidayTypeSchema,
  scope_type: z.string().max(50).optional(),
  scope_id: z.string().uuid().optional(),
});

export type HolidayCreateInput = z.infer<typeof holidayCreateSchema>;

// ---------------------------------------------------------------------------
// Holiday precedence (§8.2)
// ---------------------------------------------------------------------------

/** A holiday row as far as precedence is concerned. */
export interface HolidayCandidate {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  name: string;
  type: string;
  /** null for an organization-wide holiday. */
  scope_type: string | null;
  scope_id: string | null;
}

/**
 * Scope precedence, finest first. An explicitly scoped holiday describes the
 * place an employee actually works, so it outranks the organization-wide
 * default; among scopes, the narrowest description of that place wins.
 */
const HOLIDAY_SCOPE_RANK: Record<string, number> = {
  site: 0,
  village: 1,
  mandal: 2,
  division: 3,
  district: 4,
};

/** Organization-wide (unscoped) holidays rank last. */
const ORG_WIDE_RANK = 5;

function holidayRank(holiday: HolidayCandidate): number {
  if (!holiday.scope_type || !holiday.scope_id) return ORG_WIDE_RANK;
  return HOLIDAY_SCOPE_RANK[holiday.scope_type] ?? ORG_WIDE_RANK - 1;
}

/**
 * The single holiday in effect on each date for one employee.
 *
 * An organization can declare a generic national holiday and a district can
 * declare a local one on the same date; both rows are legitimate and both are
 * stored. Payroll and attendance need one answer per date, and picking it by
 * insertion order would make the result depend on data-entry order.
 *
 * `scopeIds` is the employee's own location chain (site, village, mandal,
 * district, in any order). A scoped holiday only applies when its scope is in
 * that chain — a holiday declared for another district is simply not this
 * employee's holiday.
 *
 * Returns one entry per date, keyed by date, sorted by date.
 */
export function resolveEffectiveHolidays(
  holidays: readonly HolidayCandidate[],
  scopeIds: readonly (string | null | undefined)[],
): HolidayCandidate[] {
  const chain = new Set(scopeIds.filter((id): id is string => typeof id === "string"));
  const best = new Map<string, HolidayCandidate>();
  for (const holiday of holidays) {
    const scoped = Boolean(holiday.scope_type && holiday.scope_id);
    // A holiday scoped to somewhere this employee does not work is not theirs.
    if (scoped && !chain.has(holiday.scope_id as string)) continue;
    const current = best.get(holiday.date);
    if (!current || holidayRank(holiday) < holidayRank(current)) {
      best.set(holiday.date, holiday);
    }
  }
  return [...best.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * A spreadsheet row, turned into what employeeCreateSchema expects.
 *
 * Every cell arrives as text, and an empty cell arrives as an empty string.
 * The schema is strict for good reason — it is the same one the API enforces
 * on a single create — so a file that is perfectly correct on the page came
 * back with five errors about types nobody typed:
 *
 *   phone_secondary: Invalid phone number   (the cell was blank)
 *   salary_basic:    Expected number        (the cell said "35000")
 *   skills:          Expected array         (the cell said "Survey;AutoCAD")
 *   experience_years:Expected number        (the cell said "6")
 *   date_of_birth:   Invalid calendar date  (Excel gave its serial number)
 *
 * None of those is the person's mistake, so none of them should be their
 * problem. This converts what a spreadsheet actually produces; anything it
 * cannot convert is left alone and the schema rejects it with a message
 * about the value, which is the case worth reporting.
 */
export function employeeImportRow(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const row = dropBlankCells(raw) as Record<string, unknown>;

  for (const key of ['salary_basic', 'experience_years'] as const) {
    const v = row[key];
    if (typeof v === 'string') {
      // "35,000" and "₹35000" are what people actually type.
      //
      // Stripped of everything but digits, "about forty" becomes the empty
      // string and Number('') is 0 — so a cell nobody could read would have
      // imported as a salary of zero, which is worse than refusing it. The
      // result has to contain a digit to count as a number at all.
      const cleaned = v.replace(/[^0-9.-]/g, '');
      const n = Number(cleaned);
      if (/\d/.test(cleaned) && Number.isFinite(n)) row[key] = n;
    }
  }

  if (typeof row.skills === 'string') {
    row.skills = row.skills.split(/[;,|]/).map(s => s.trim()).filter(Boolean);
  }

  for (const key of ['date_of_birth', 'date_of_joining'] as const) {
    const converted = spreadsheetDate(row[key]);
    if (converted !== undefined) row[key] = converted;
  }

  return row;
}

/**
 * A spreadsheet row with its empty cells removed.
 *
 * An empty cell means "not given", not "given as nothing", and the
 * difference decides whether a row imports. Left in as an empty string it
 * fails every optional field that validates a format — and worse, it passes
 * some: z.coerce.number()('') is 0, so a blank allotment silently becomes an
 * allotment of zero and a blank extent becomes an extent the schema then
 * rejects for not being positive.
 *
 * Every importer needs this, so it lives in one place rather than being
 * learned separately by each.
 */
export function dropBlankCells(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    if (value === null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A date as a spreadsheet gave it, in the form the API wants.
 *
 * Excel stores a date as a day count and hands it over as a number, so a
 * date of birth arrives as 33078. It also has a famous flaw: 1900 is treated
 * as a leap year, which it was not, so every serial after the 59th is one
 * day ahead unless the epoch is offset to match.
 *
 * Text dates are accepted in the two orders people write them here —
 * DD/MM/YYYY and DD-MM-YYYY — because a sheet typed by hand in India uses
 * them and rejecting the row teaches nobody anything. Ambiguous American
 * order is not guessed at: 03/04/2026 is read as the fourth of March, which
 * is what the rest of this system means by it.
 */
export function spreadsheetDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;

  if (typeof value === 'number' && Number.isFinite(value)) {
    /*
     * Day 1 is 1 January 1900, and day 60 is Excel's 29 February 1900 — a
     * date that never existed. Everything from 61 onwards is therefore one
     * day ahead of a straight count, so the epoch shifts by a day at that
     * point. Using one epoch for the whole range puts either the 1900 dates
     * or every date since a day out, and a date of birth a day wrong is the
     * kind of error nobody spots until it matters.
     */
    const epoch = value < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const d = new Date(epoch + value * 86_400_000);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // A serial that arrived as text, which happens when a column is formatted
  // as text after the dates were entered.
  if (/^\d{4,6}$/.test(text)) return spreadsheetDate(Number(text));

  return undefined;
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

/**
 * A job title, chosen from a list rather than typed.
 *
 * Designation was free text, which meant "Site Engineer", "site engineer" and
 * "Sr. Engineer" were three designations as far as any report was concerned,
 * and nobody could answer how many engineers there were. A list fixes that at
 * the point of entry, which is the only point where it can be fixed.
 *
 * Each one can carry a role, because what somebody is called and what they
 * are allowed to do are answered together at the moment they are hired. The
 * role is created empty: an administrator grants it permissions afterwards,
 * deliberately, rather than a job title quietly conferring access.
 */
export const designationCreateSchema = z.object({
  label: z.string().trim().min(1, "Give the designation a name").max(160),
  /**
   * Derived from the label when not given, so nobody has to invent a code.
   */
  code: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_]+$/,
    "A code is capitals, digits and underscores").optional(),
  display_order: z.number().int().min(0).max(9999).optional(),
  /** Create an RBAC role of the same name alongside it, with no permissions. */
  create_role: z.boolean().default(false),
});

export type DesignationCreate = z.infer<typeof designationCreateSchema>;

/** The code a label implies: capitals, with runs of anything else as one `_`. */
export function designationCode(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 64);
}

/**
 * Changing the same thing about several people at once (§note 12).
 *
 * Deliberately a narrow set of fields. What belongs here is what a group
 * genuinely has in common — where they are posted, who they report to, what
 * they are called, which department they sit in — and it is edited in bulk
 * because a crew of thirty moving to a new mandal is one decision, not thirty.
 *
 * What is left out is left out on purpose. Names, phone numbers, Aadhaar, PAN
 * and bank details identify one person and can never be right for a group.
 * Salary is per-person and a bulk change to it is a payroll incident waiting
 * to happen. Status has its own routes — exit, suspend, reactivate — each
 * asking for a reason and writing its own trail, and a bulk status change
 * would walk straight past all of it.
 */
export const employeeBulkUpdateSchema = z.object({
  employee_ids: z.array(z.string().uuid())
    .min(1, 'Choose at least one person')
    .max(500, 'That is more than 500 people at once'),
  changes: z.object({
    designation_id: z.string().uuid().nullable().optional(),
    designation: z.string().max(100).nullable().optional(),
    department: z.string().max(100).nullable().optional(),
    reports_to: z.string().uuid().nullable().optional(),
    district_id: z.string().uuid().nullable().optional(),
    mandal_id: z.string().uuid().nullable().optional(),
    village_id: z.string().uuid().nullable().optional(),
    site_id: z.string().uuid().nullable().optional(),
  }),
  /**
   * Show what would change, and write nothing.
   *
   * A bulk edit is the one screen where somebody discovers they had the wrong
   * filter applied after it has already touched two hundred records.
   */
  dry_run: z.boolean().default(true),
});

export type EmployeeBulkUpdateInput = z.infer<typeof employeeBulkUpdateSchema>;

/** The fields a bulk edit may touch, for a UI that should not guess. */
export const BULK_EDITABLE_FIELDS = [
  'designation_id', 'department', 'reports_to',
  'district_id', 'mandal_id', 'village_id', 'site_id',
] as const;

/**
 * Whether a change would actually change anything.
 *
 * A bulk edit that reports "200 updated" when 180 of them already held the
 * value teaches people to ignore the number.
 */
export function bulkChangeAffects(
  current: Record<string, unknown>, changes: Record<string, unknown>,
): string[] {
  return Object.entries(changes)
    .filter(([field, value]) => value !== undefined
      && String(current[field] ?? '') !== String(value ?? ''))
    .map(([field]) => field);
}
