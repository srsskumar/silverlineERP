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
  emp_no: z.string().min(1, "emp_no is required").max(50),
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
  designation: z.string().max(100).optional(),
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
