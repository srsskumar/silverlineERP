import { z } from "zod";

export const fieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * Standard API error envelope: { code, message, field_errors, request_id, retryable }
 * (ARCHITECTURE.md §5.1, DEV_PLAN.md §1).
 */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  field_errors: z.array(fieldErrorSchema).default([]),
  request_id: z.string(),
  retryable: z.boolean(),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorSchema>;

export interface ApiErrorOptions {
  status: number;
  code: string;
  message: string;
  fieldErrors?: FieldError[];
  retryable?: boolean;
}

/** Typed server-side error that maps 1:1 onto the envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldError[];
  readonly retryable: boolean;

  constructor(opts: ApiErrorOptions) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.fieldErrors = opts.fieldErrors ?? [];
    this.retryable = opts.retryable ?? (opts.status === 429 || opts.status >= 500);
  }

  toEnvelope(requestId: string): ApiErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      field_errors: this.fieldErrors,
      request_id: requestId,
      retryable: this.retryable,
    };
  }
}

/**
 * A field name as a person would say it.
 *
 * Column names leak out of the schema and into the form: "survey_village_id"
 * and "date_of_joining" are what the table calls them, not what the label
 * above the box says. Anything not listed falls back to the underscores
 * removed and the trailing _id dropped, which handles most of them.
 */
const FIELD_LABELS: Record<string, string> = {
  survey_village_id: "Village",
  survey_project_id: "Programme",
  to_project_id: "Destination programme",
  village_ids: "Villages",
  employee_ids: "People",
  asset_ids: "Equipment",
  asset_id: "Equipment",
  employee_id: "Employee",
  designation_id: "Designation",
  reports_to: "Reports to",
  entry_date: "Date",
  date_of_joining: "Date of joining",
  date_of_birth: "Date of birth",
  emp_no: "Employee number",
  phone_secondary: "Secondary phone",
  salary_basic: "Basic salary",
  total_extent_ac: "Total extent (acres)",
  mandal_id: "Mandal",
  district_id: "District",
  village_id: "Village",
  site_id: "Site",
  stage_code: "Stage",
  measure_code: "Measure",
  teams_deployed: "Teams deployed",
  allocated_on: "Allocated on",
  released_on: "Released on",
  bank_ifsc: "IFSC code",
  gstin: "GSTIN",
  pan: "PAN",
  aadhaar: "Aadhaar",
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  // "values.GOVT_LAND_EXTENT_AC" -> the measure, which is the part that means
  // something; "rows.3.phone" -> "Phone on row 4", counting the way people do.
  const parts = field.split(".");
  if (parts.length > 1) {
    const rowAt = parts.findIndex(p => /^\d+$/.test(p));
    const leaf = fieldLabel(parts[parts.length - 1]);
    if (rowAt >= 0) return `${leaf} on row ${Number(parts[rowAt]) + 1}`;
    return leaf;
  }
  // An ALL-CAPS token is a code people read as a code — a measure, a stage,
  // a status. Spacing it out makes it less recognisable, not more.
  if (/^[A-Z0-9_]+$/.test(field)) return field;
  const words = field.replace(/_id$/, "").replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

/**
 * Zod's own words, replaced with words for the person who typed it.
 *
 * "Invalid uuid", "Expected number, received string" and "Required" describe
 * the schema rather than the mistake. They are accurate and they are useless
 * to somebody looking at a form, which is who reads them.
 *
 * Only the generic messages are rewritten. A message written deliberately in
 * a schema — "A quantity cannot be negative" — already says the right thing
 * and is left exactly as it is.
 */
/**
 * Whether this message is Zod's own wording rather than somebody's.
 *
 * The distinction is the whole point: Zod's defaults describe the schema and
 * are worth replacing; a message written into a schema on purpose — "A
 * quantity cannot be negative" — already says the domain thing, and
 * rewriting it into a generic sentence would throw that away.
 */
function isZodDefault(message: string): boolean {
  return /^(Required|Invalid|Expected |Number must |String must |Array must |Date must |Unrecognized keys)/
    .test(message);
}

function humanise(issue: z.ZodIssue, label: string): string {
  const said = issue.message;
  if (!isZodDefault(said)) return said;
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined" || issue.received === "null") {
        return `${label} is required`;
      }
      if (issue.expected === "number") return `${label} must be a number`;
      if (issue.expected === "array") return `${label} must be a list`;
      if (issue.expected === "boolean") return `${label} must be yes or no`;
      return `${label} is not in the right format`;
    case "invalid_string":
      if (said === "Invalid uuid") return `${label} is not a valid reference`;
      if (said === "Invalid email") return "That is not a valid email address";
      if (said === "Invalid url") return "That is not a valid web address";
      return said;
    case "too_small":
      if (issue.type === "string" && Number(issue.minimum) <= 1) {
        return `${label} cannot be empty`;
      }
      if (issue.type === "array") {
        return `Choose at least ${issue.minimum} ${Number(issue.minimum) === 1 ? "item" : "items"}`;
      }
      if (issue.type === "number") return `${label} must be at least ${issue.minimum}`;
      return said;
    case "too_big":
      if (issue.type === "string") {
        return `${label} is too long — keep it to ${issue.maximum} characters`;
      }
      if (issue.type === "array") return `That is more than ${issue.maximum} at a time`;
      if (issue.type === "number") return `${label} must be ${issue.maximum} or less`;
      return said;
    case "invalid_enum_value":
      return `${label} must be one of: ${(issue.options ?? []).join(", ")}`;
    case "unrecognized_keys":
      return `Not a field this accepts: ${(issue.keys ?? []).join(", ")}`;
    default:
      return said;
  }
}

export function toFieldErrors(err: z.ZodError): FieldError[] {
  return err.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return {
      field,
      message: humanise(issue, fieldLabel(field)),
      code: issue.code,
    };
  });
}

/**
 * The headline above a list of field problems.
 *
 * "Validation failed" is what the server calls it and tells the reader
 * nothing they can act on. With one problem, say the problem; with several,
 * say how many there are so they know to look past the first.
 */
export function validationSummary(fieldErrors: FieldError[]): string {
  if (fieldErrors.length === 0) return "Check the details and try again";
  if (fieldErrors.length === 1) return fieldErrors[0].message;
  return `${fieldErrors.length} things need fixing before this can be saved`;
}
