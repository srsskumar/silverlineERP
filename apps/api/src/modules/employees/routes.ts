import {scanUpload} from "../../common/fileSafety.js";
import { likeContains } from "../../common/like.js";
import {encodeBlob, readBlob} from "../../common/blobStore.js";
import {mutationRoute} from "../../common/mutationRoute.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ApiError,
  MAX_DOCUMENT_BYTES,
  EMPLOYEE_STATUSES,
  S1_PERMISSIONS,
  cursorPageQuerySchema,
  decodeCursor,
  documentUploadSchema,
  employeeActivateSchema,
  employeeCreateSchema,
  employeeImportRow,
  employeeExitSchema,
  employeePatchSchema,
  employeeReactivateSchema,
  employeeSuspendSchema,
  designationCreateSchema,
  designationCode,
  employeeBulkUpdateSchema,
  bulkChangeAffects,
  assignmentsSchema,
  plannedRoleRows,
  describeAccess,
  encodeCursor,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requireAllPermissions, requirePermission } from "../../common/auth.js";
import { mutate } from "../../common/domain.js";
import { resolveScopes, employeeScopeClause } from "../../common/scopes.js";
import { writeAudit } from "../../common/audit.js";
import {
  decryptPii,
  encryptPii,
  maskLast4,
  piiIndex,
  redactPiiForAudit,
} from "../../common/crypto.js";
import { sendError } from "../../common/httpErrors.js";
import {
  idempotencyKeyOf,
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";
import { parseIfMatch } from '../../common/ifMatch.js';

export interface EmployeeRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const PII_READ = S1_PERMISSIONS.EMPLOYEE_PII_READ;

const listQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  district_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
});

interface PageCursor {
  created_at: string;
  id: string;
}

interface EmployeeRow {
  id: string;
  org_id: string;
  emp_no: string;
  first_name: string;
  last_name: string | null;
  father_name: string | null;
  date_of_birth: Date | string | null;
  gender: string | null;
  phone: string;
  phone_secondary: string | null;
  email: string | null;
  aadhaar_encrypted: string | null;
  pan_encrypted: string | null;
  address: string | null;
  district_id: string | null;
  mandal_id: string | null;
  village_id: string | null;
  site_id: string | null;
  designation: string | null;
  designation_id?: string | null;
  department: string | null;
  date_of_joining: Date | string;
  date_of_exit: Date | string | null;
  exit_reason: string | null;
  reports_to: string | null;
  reports_to_name?: string | null;
  reports_to_emp_no?: string | null;
  salary_basic: string | number | null;
  bank_name: string | null;
  bank_account_encrypted: string | null;
  bank_ifsc: string | null;
  phonepe_number: string | null;
  education: string | null;
  skills: unknown;
  experience_years: string | number | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function dateOnly(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function safeDecrypt(blob: string | null): string | null {
  if (!blob) {
    return null;
  }
  return decryptPii(blob);
}

/** Masked employee shape: full PII only with `employee.pii.read`. */
function toShape(row: EmployeeRow, canSeePii: boolean) {
  const aadhaar = safeDecrypt(row.aadhaar_encrypted);
  const pan = safeDecrypt(row.pan_encrypted);
  const bankAccount = safeDecrypt(row.bank_account_encrypted);
  return {
    id: row.id,
    emp_no: row.emp_no,
    first_name: row.first_name,
    last_name: row.last_name,
    father_name: row.father_name,
    date_of_birth: dateOnly(row.date_of_birth),
    gender: row.gender,
    phone: row.phone,
    phone_secondary: row.phone_secondary,
    email: row.email,
    address: row.address,
    district_id: row.district_id,
    mandal_id: row.mandal_id,
    village_id: row.village_id,
    site_id: row.site_id,
    designation: row.designation,
    designation_id: row.designation_id ?? null,
    department: row.department,
    date_of_joining: dateOnly(row.date_of_joining),
    date_of_exit: dateOnly(row.date_of_exit),
    exit_reason: row.exit_reason,
    reports_to: row.reports_to,
    // The manager by name, so a directory column reads as a person rather
    // than an identifier nobody can resolve by eye.
    reports_to_name: row.reports_to_name ?? null,
    reports_to_emp_no: row.reports_to_emp_no ?? null,
    salary_basic:
      row.salary_basic === null || row.salary_basic === undefined
        ? null
        : canSeePii
          ? Number(row.salary_basic)
          : null,
    bank_name: row.bank_name,
    bank_account: canSeePii ? bankAccount : null,
    bank_ifsc: row.bank_ifsc,
    phonepe_number: canSeePii ? row.phonepe_number : null,
    aadhaar: canSeePii ? aadhaar : null,
    pan: canSeePii ? pan : null,
    aadhaar_last4: maskLast4(aadhaar),
    pan_last4: maskLast4(pan),
    bank_account_last4: maskLast4(bankAccount),
    phonepe_number_last4: maskLast4(row.phonepe_number),
    education: row.education,
    skills: Array.isArray(row.skills) ? row.skills : [],
    experience_years:
      row.experience_years === null || row.experience_years === undefined
        ? null
        : Number(row.experience_years),
    status: row.status,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/**
 * Maps a Postgres unique-violation to the field the user actually typed.
 *
 * §7 asks for "its own stable field error" per duplicate. Collapsing every
 * violation onto emp_no told an operator to change the one field that was
 * fine — the offending value was the Aadhaar, the PhonePe number or the bank
 * account.
 */
const DUPLICATE_FIELDS: Array<[fragment: string, field: string, message: string]> = [
  ["uk_employees_aadhaar", "aadhaar", "Aadhaar already exists in this org"],
  ["uk_employees_pan", "pan", "PAN already exists in this org"],
  ["uk_employees_bank_account", "bank_account", "Bank account already exists in this org"],
  ["uk_employees_phonepe", "phonepe_number", "PhonePe number already exists in this org"],
  ["uk_emp_phone", "phone", "Phone already exists in this org"],
  ["uk_emp_no", "emp_no", "emp_no already exists in this org"],
];

function duplicateFieldError(error: unknown): { field: string; message: string } {
  const constraint = (error as { constraint?: string }).constraint ?? "";
  for (const [fragment, field, message] of DUPLICATE_FIELDS) {
    if (constraint.includes(fragment)) return { field, message };
  }
  // phonepe must be tested before the generic phone check, hence the ordered
  // list above; anything unrecognised still names a field rather than nothing.
  if (constraint.includes("phone")) {
    return { field: "phone", message: "Phone already exists in this org" };
  }
  return { field: "emp_no", message: "emp_no already exists in this org" };
}


/**
 * The next employee number for an organisation.
 *
 * Reads the highest number already issued and adds one, keeping whatever
 * prefix the organisation already uses so a new number looks like the old
 * ones. Taken under a lock on the organisation row, because two imports
 * running at once would otherwise read the same maximum and allocate the
 * same number — and the loser fails on a unique constraint halfway through
 * a two hundred row file.
 *
 * Falls back to EMP0001 for an organisation with nobody in it yet.
 */
async function nextEmpNo(
  db: import('pg').Pool | import('pg').PoolClient, orgId: string,
): Promise<string> {
  await db.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  const row = (await db.query(
    `SELECT emp_no FROM employees
      WHERE org_id = $1 AND emp_no ~ '^[A-Za-z]*[0-9]+$'
      ORDER BY length(regexp_replace(emp_no, '^[A-Za-z]*', '')) DESC,
               regexp_replace(emp_no, '^[A-Za-z]*', '') DESC
      LIMIT 1`, [orgId])).rows[0] as { emp_no: string } | undefined;

  if (!row) return 'EMP0001';
  const prefix = /^[A-Za-z]*/.exec(row.emp_no)?.[0] ?? 'EMP';
  const digits = row.emp_no.slice(prefix.length);
  const next = String(Number(digits) + 1).padStart(digits.length, '0');
  return `${prefix}${next}`;
}

const SELECT_COLS = `id, org_id, emp_no, first_name, last_name, father_name,
  date_of_birth, gender, phone, phone_secondary, email,
  aadhaar_encrypted, pan_encrypted, address,
  district_id, mandal_id, village_id, site_id, designation, designation_id, department,
  date_of_joining, date_of_exit, exit_reason, reports_to, salary_basic,
  bank_name, bank_account_encrypted, bank_ifsc, phonepe_number,
  education, skills, experience_years, status, version, created_at, updated_at,
  /*
   * Who they report to, by name.
   *
   * reports_to is an identifier, and an identifier in a directory column
   * answers nobody's question — the whole point of the field is to see the
   * reporting line at a glance rather than open two records to compare them.
   */
  (SELECT COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), m.emp_no)
     FROM employees m WHERE m.id = employees.reports_to) AS reports_to_name,
  (SELECT m.emp_no FROM employees m WHERE m.id = employees.reports_to) AS reports_to_emp_no`;

/**
 * The designation a write means, as both an id and a label.
 *
 * Three things can arrive: an id from the dropdown, a label from a
 * spreadsheet, or neither. An id wins and supplies the label; a label is
 * matched against the list so an import lands on the same designation the
 * form would have chosen; anything unmatched is kept as the text it is,
 * because refusing an import over a job title nobody has added yet helps
 * nobody.
 */
async function resolveDesignation(
  db: Pool | PoolClient, orgId: string,
  input: { designation?: string | null; designation_id?: string | null },
): Promise<{ id: string | null; label: string | null }> {
  if (input.designation_id) {
    const row = (await db.query(
      "SELECT id, label FROM designations WHERE id = $1 AND org_id = $2",
      [input.designation_id, orgId])).rows[0];
    if (!row) {
      throw new ApiError({
        status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
        fieldErrors: [{ field: "designation_id",
          message: "That designation is not on the list", code: "not_found" }],
      });
    }
    return { id: String(row.id), label: String(row.label) };
  }
  const text = input.designation?.trim();
  if (!text) return { id: null, label: null };
  const match = (await db.query(
    `SELECT id, label FROM designations
      WHERE org_id = $1 AND active AND (lower(label) = lower($2) OR code = $3)
      LIMIT 1`,
    [orgId, text, designationCode(text)])).rows[0];
  return match
    ? { id: String(match.id), label: String(match.label) }
    : { id: null, label: text };
}

/** Validates unit refs (existence + org + expected type per field). */
async function validateUnitRefs(
  pool: Pool | PoolClient,
  orgId: string,
  refs: { district_id?: string; mandal_id?: string; village_id?: string; site_id?: string },
): Promise<Array<{ field: string; message: string }>> {
  const problems: Array<{ field: string; message: string }> = [];
  const checks: Array<[string, string | undefined, string]> = [
    ["district_id", refs.district_id, "district"],
    ["mandal_id", refs.mandal_id, "mandal"],
    ["village_id", refs.village_id, "village"],
    ["site_id", refs.site_id, "site"],
  ];
  for (const [field, id, expectedType] of checks) {
    if (!id) {
      continue;
    }
    const res = await pool.query(
      "SELECT id, type FROM org_units WHERE id = $1::uuid AND org_id = $2",
      [id, orgId],
    );
    const row = res.rows[0] as { id: string; type: string } | undefined;
    if (!row) {
      problems.push({ field, message: "Referenced unit not found" });
    } else if (row.type !== expectedType) {
      problems.push({
        field,
        message: `${field} must reference a ${expectedType} unit, got ${row.type}`,
      });
    }
  }
  return problems;
}

/**
 * Validates `reports_to`: must exist in-org and be ACTIVE, and must not
 * create a reporting cycle (walk the chain up; `selfId` is forbidden).
 */
async function validateReportsTo(
  pool: Pool | PoolClient,
  orgId: string,
  reportsTo: string | undefined,
  selfId: string | null,
): Promise<Array<{ field: string; message: string }>> {
  if (!reportsTo) {
    return [];
  }
  if (selfId && reportsTo === selfId) {
    return [{ field: "reports_to", message: "An employee cannot report to themselves" }];
  }
  const target = await pool.query(
    "SELECT id, status, reports_to FROM employees WHERE id = $1::uuid AND org_id = $2",
    [reportsTo, orgId],
  );
  const head = target.rows[0] as
    | { id: string; status: string; reports_to: string | null }
    | undefined;
  if (!head) {
    return [{ field: "reports_to", message: "Reporting manager not found" }];
  }
  if (head.status !== "ACTIVE") {
    return [{ field: "reports_to", message: "Reporting manager must be ACTIVE" }];
  }
  // Walk the chain: a cycle exists if we reach selfId again.
  const seen = new Set<string>([head.id]);
  let cursor: string | null = head.reports_to;
  for (let steps = 0; steps < 1000 && cursor; steps += 1) {
    if (selfId && cursor === selfId) {
      return [{ field: "reports_to", message: "Reporting line must not create a cycle" }];
    }
    if (seen.has(cursor)) {
      break;
    }
    seen.add(cursor);
    const nxt = await pool.query(
      "SELECT id, reports_to FROM employees WHERE id = $1::uuid AND org_id = $2",
      [cursor, orgId],
    );
    const nrow = nxt.rows[0] as
      | { id: string; reports_to: string | null }
      | undefined;
    cursor = nrow?.reports_to ?? null;
  }
  return [];
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function uploadsDir(): string {
  return process.env["UPLOADS_DIR"] ?? join(process.cwd(), "uploads");
}

function decodeBase64Strict(input: string): Buffer {
  const compact = input.replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [{ field: "content_base64", message: "Invalid base64 content" }],
    });
  }
  const buf = Buffer.from(compact, "base64");
  if (buf.length === 0 || buf.toString("base64") !== compact) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [{ field: "content_base64", message: "Invalid base64 content" }],
    });
  }
  return buf;
}

export async function registerEmployeeRoutes(
  app: FastifyInstance,
  opts: EmployeeRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, S1_PERMISSIONS.EMPLOYEE_READ);
  const canCreate = requirePermission(
    authenticate,
    S1_PERMISSIONS.EMPLOYEE_CREATE,
  );
  const canExit = requirePermission(authenticate, S1_PERMISSIONS.EMPLOYEE_EXIT);
  const canReactivate = requirePermission(
    authenticate,
    S1_PERMISSIONS.EMPLOYEE_REACTIVATE,
  );
  const canImport = requirePermission(
    authenticate,
    S1_PERMISSIONS.EMPLOYEE_IMPORT,
  );
  /*
   * Somebody's personal file needs the right to read the person, not only
   * the right to read documents.
   *
   * document.read was later reused for the company document register and
   * handed to inventory managers, payroll officers and bid managers, none
   * of whom may open the directory -- so an inventory manager could list
   * and download another employee's identity documents while
   * GET /employees/:id refused them. employee.read is checked second, so
   * its scope is what the record check runs under: a team lead sees only
   * their own team's files. Uploading is held to the same standard: you do
   * not put papers into a file you may not open.
   */
  const canReadDocs = requireAllPermissions(
    authenticate,
    [S1_PERMISSIONS.DOCUMENT_READ, S1_PERMISSIONS.EMPLOYEE_READ],
  );
  const canUploadDocs = requireAllPermissions(
    authenticate,
    [S1_PERMISSIONS.DOCUMENT_UPLOAD, S1_PERMISSIONS.EMPLOYEE_READ],
  );

  const metaOf = (req: {
    ip: string;
    headers: Record<string, unknown>;
    requestId: string;
  }) => ({
    ip: req.ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
    requestId: req.requestId,
  });

  const canSeePii = (req: {
    authUser?: { permissions: string[] };
  }): boolean => req.authUser?.permissions.includes(PII_READ) === true;

  async function findInOrg(
    orgId: string,
    id: string,
  ): Promise<EmployeeRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${SELECT_COLS} FROM employees WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as EmployeeRow | undefined;
  }

  // GET /api/v1/employees — masked list
  app.get("/api/v1/employees", { preHandler: canRead }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { limit, cursor, status, district_id, q } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    // PRD §4.1 scope enforcement: null-scope assignments see everything;
    // district|mandal|village|team|project assignments union-restrict rows.
    const scopes = resolveScopes(user.scopes ?? []);
    if (!scopes.global) {
      clauses.push(
        await employeeScopeClause(opts.pool, user.orgId, scopes, values),
      );
    }
    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (district_id) {
      values.push(district_id);
      clauses.push(`district_id = $${values.length}::uuid`);
    }
    if (q) {
      values.push(likeContains(q));
      clauses.push(
        `(emp_no ILIKE $${values.length} ESCAPE '!' OR first_name ILIKE $${values.length} ESCAPE '!' OR last_name ILIKE $${values.length} ESCAPE '!' OR phone ILIKE $${values.length} ESCAPE '!')`,
      );
    }
    if (cursor) {
      const decoded = decodeCursor<PageCursor>(cursor);
      if (!decoded) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
          ],
        });
      }
      values.push(decoded.created_at, decoded.id);
      clauses.push(
        `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT ${SELECT_COLS} FROM employees WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    /*
     * The list is always masked (HR-15), whoever is asking.
     *
     * It used to return every Aadhaar, PAN and bank account on the page to a
     * holder of employee.pii.read -- a whole directory of identity numbers in
     * one response, cached by the browser, with no record that anybody had
     * looked. The directory needs the last four to tell people apart; the
     * full number is on the person's own record, where reading it is audited.
     */
    const hasMore = res.rows.length > limit;
    const page = res.rows.slice(0, limit) as EmployeeRow[];
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map((r) => toShape(r, false)),
      next_cursor:
        hasMore && last
          ? encodeCursor({
              created_at: iso(last.created_at),
              id: last.id,
            })
          : null,
      has_more: hasMore,
    });
  });

  // POST /api/v1/employees
  app.post("/api/v1/employees", { preHandler: canCreate }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (await replayIfSeen(db, req, reply)) {
      return;
    }
    const parsed = employeeCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const d = parsed.data;
    const fieldErrors = [
      ...(await validateUnitRefs(db, user.orgId, d)),
      ...(await validateReportsTo(db, user.orgId, d.reports_to, null)),
    ];
    if (fieldErrors.length > 0) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors,
      });
    }
    // Allocated when the caller leaves it out, so the form need not ask for
    // a unique identifier the server can work out for itself.
    const singleEmpNo = d.emp_no ?? await nextEmpNo(db, user.orgId);
    const designation = await resolveDesignation(db, user.orgId, d);
    let row: EmployeeRow;
    try {
      const ins = await db.query(
        `INSERT INTO employees (
           org_id, emp_no, first_name, last_name, father_name, date_of_birth, gender,
           phone, phone_secondary, email, aadhaar_encrypted, pan_encrypted, address,
           district_id, mandal_id, village_id, site_id, designation, designation_id,
           department,
           date_of_joining, reports_to, salary_basic, bank_name,
           bank_account_encrypted, bank_ifsc, phonepe_number,
           education, skills, experience_years, status, created_by, updated_by,
           aadhaar_hash, pan_hash, bank_account_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 $14::uuid,$15::uuid,$16::uuid,$17::uuid,$18,$34::uuid,$19,$20,$21::uuid,$22,$23,
                 $24,$25,$26,$27,$28,$29,'DRAFT',$30::uuid,$30::uuid,$31,$32,$33)
         RETURNING ${SELECT_COLS}`,
        [
          user.orgId,
          singleEmpNo,
          d.first_name,
          d.last_name ?? null,
          d.father_name ?? null,
          d.date_of_birth ?? null,
          d.gender ?? null,
          d.phone,
          d.phone_secondary ?? null,
          d.email ?? null,
          d.aadhaar ? encryptPii(d.aadhaar) : null,
          d.pan ? encryptPii(d.pan) : null,
          d.address ?? null,
          d.district_id ?? null,
          d.mandal_id ?? null,
          d.village_id ?? null,
          d.site_id ?? null,
          designation.label,
          d.department ?? null,
          d.date_of_joining,
          d.reports_to ?? null,
          d.salary_basic ?? null,
          d.bank_name ?? null,
          d.bank_account ? encryptPii(d.bank_account) : null,
          d.bank_ifsc ?? null,
          d.phonepe_number ?? null,
          d.education ?? null,
          JSON.stringify(d.skills ?? []),
          d.experience_years ?? null,
          user.id,
          piiIndex(d.aadhaar),
          piiIndex(d.pan),
          piiIndex(d.bank_account),
          designation.id,
        ],
      );
      row = ins.rows[0] as EmployeeRow;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        const duplicate = duplicateFieldError(err);
        return sendError(reply, req.requestId, {
          status: 409,
          code: "CONFLICT",
          message: `Another employee in this organization already uses this ${duplicate.field}`,
          fieldErrors: [duplicate],
        });
      }
      throw err;
    }
    const body = toShape(row, canSeePii(req));
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "employee.create",
      entityType: "employee",
      entityId: row.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(db, req, user.id, 201, body);
    return reply.status(201).send(body);
  
});});

  // POST /api/v1/employees/bulk-import (static route before :id)
  app.post(
    "/api/v1/employees/bulk-import",
    { preHandler: canImport },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const envelope = z
        .object({ rows: z.array(z.unknown()).min(1).max(500),dry_run:z.boolean().default(false) })
        .safeParse(req.body);
      if (!envelope.success) {
        const issue = envelope.error.issues[0];
        if (issue?.path[0] === "rows" && issue.code === "too_big") {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            fieldErrors: [{ field: "rows", message: "At most 500 rows per import" }],
          });
        }
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(envelope.error),
        });
      }
      // Rows are validated individually below so one bad row never fails
      // the batch (shape contract: employeeCreateSchema per row).
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const rawRows = envelope.data.rows as unknown[];
      const errors: Array<{
        index: number;
        emp_no?: string;
        errors: Array<{ field: string; message: string }>;
      }> = [];

      const empNos = rawRows
        .map((r) => (r as { emp_no?: unknown }).emp_no)
        .filter((v): v is string => typeof v === "string" && v !== "");
      const phones = rawRows
        .map((r) => (r as { phone?: unknown }).phone)
        .filter((v): v is string => typeof v === "string" && v !== "");
      const existingEmpNos = new Set<string>();
      const existingPhones = new Set<string>();
      if (empNos.length > 0) {
        const r = await opts.pool.query(
          "SELECT emp_no FROM employees WHERE org_id = $1 AND emp_no = ANY($2)",
          [user.orgId, empNos],
        );
        for (const row of r.rows as Array<{ emp_no: string }>) {
          existingEmpNos.add(row.emp_no);
        }
      }
      if (phones.length > 0) {
        const r = await opts.pool.query(
          "SELECT phone FROM employees WHERE org_id = $1 AND phone = ANY($2)",
          [user.orgId, phones],
        );
        for (const row of r.rows as Array<{ phone: string }>) {
          existingPhones.add(row.phone);
        }
      }

      const seenEmpNos = new Set<string>();
      const seenPhones = new Set<string>();
      const valid: Array<{ index: number; data: z.infer<typeof employeeCreateSchema> }> = [];

      for (let index = 0; index < rawRows.length; index += 1) {
        const raw = rawRows[index] as Record<string, unknown>;
        const rowErrors: Array<{ field: string; message: string }> = [];
        // What a spreadsheet produces, turned into what the schema expects:
        // blank cells dropped, numbers read out of text, a skills cell split,
        // and Excel's date serials converted. None of those is the person's
        // mistake, so none of them should be their problem.
        /*
         * reports_to, as a spreadsheet can express it.
         *
         * The field is an identifier, and nobody types a UUID into a
         * spreadsheet — so the column takes the manager's employee number
         * and it is resolved here. A number that matches nobody is reported
         * on the row rather than dropped, because a silently missing
         * reporting line looks exactly like one that was never given.
         */
        const prepared = employeeImportRow(raw) as Record<string, unknown>;
        const managerRef = prepared.reports_to;
        if (typeof managerRef === 'string'
            && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(managerRef)) {
          const manager = (await opts.pool.query(
            "SELECT id FROM employees WHERE org_id = $1 AND emp_no = $2",
            [user.orgId, managerRef])).rows[0];
          // Reported through the same accumulator as every other row fault,
          // so it appears in the results beside them rather than as a
          // separate kind of failure.
          if (manager) prepared.reports_to = String(manager.id);
          else rowErrors.push({
            field: 'reports_to', message: `No employee has the number ${managerRef}`,
          });
        }
        const parsedRow = rowErrors.length > 0
          ? null
          : employeeCreateSchema.safeParse(prepared);
        if (parsedRow && !parsedRow.success) {
          for (const fe of toFieldErrors(parsedRow.error)) {
            rowErrors.push({ field: fe.field, message: fe.message });
          }
        } else if (parsedRow) {
          const v = parsedRow.data;
          // Only a number somebody supplied can clash. A blank one is
          // allocated by the server later, from a sequence nothing else
          // is reading.
          if (v.emp_no && (seenEmpNos.has(v.emp_no) || existingEmpNos.has(v.emp_no))) {
            rowErrors.push({ field: "emp_no", message: "emp_no already exists in this org" });
          }
          if (seenPhones.has(v.phone) || existingPhones.has(v.phone)) {
            rowErrors.push({ field: "phone", message: "Phone already exists in this org" });
          }
          rowErrors.push(...(await validateUnitRefs(opts.pool, user.orgId, v)));
          rowErrors.push(
            ...(await validateReportsTo(opts.pool, user.orgId, v.reports_to, null)),
          );
          if (rowErrors.length === 0) {
            valid.push({ index, data: v });
            if (v.emp_no) seenEmpNos.add(v.emp_no);
            seenPhones.add(v.phone);
            if (v.emp_no) existingEmpNos.add(v.emp_no);
            existingPhones.add(v.phone);
          }
        }
        if (rowErrors.length > 0) {
          const entry: {
            index: number;
            emp_no?: string;
            errors: Array<{ field: string; message: string }>;
          } = { index, errors: rowErrors };
          if (typeof raw.emp_no === "string" && raw.emp_no !== "") {
            entry.emp_no = raw.emp_no;
          }
          errors.push(entry);
        }
      }

      // Insert valid rows individually inside one transaction.
      let imported = 0;
      const importedRows:Array<{index:number;id:string}>=[];
      await db.query('SAVEPOINT import_preview');
      if (valid.length > 0) {
        const client = db;
        try {

          for (const { index, data: v } of valid) {
            try {
              await client.query('SAVEPOINT import_row');
              // Allocated here rather than in the sheet: nobody filling in
              // two hundred rows should be inventing unique identifiers, and
              // the ones people invent collide.
              const empNo = v.emp_no ?? await nextEmpNo(client, user.orgId);
              // A sheet carries the title as text; the list is what turns it
              // into the same designation the form would have picked.
              const rowDesignation = await resolveDesignation(client, user.orgId, v);
              const ins = await client.query(
                `INSERT INTO employees (
                   org_id, emp_no, first_name, last_name, father_name, date_of_birth, gender,
                   phone, phone_secondary, email, aadhaar_encrypted, pan_encrypted, address,
                   district_id, mandal_id, village_id, site_id, designation, designation_id,
                   department,
                   date_of_joining, reports_to, salary_basic, bank_name,
                   bank_account_encrypted, bank_ifsc, phonepe_number,
                   education, skills, experience_years, status, created_by, updated_by,
                   aadhaar_hash, pan_hash, bank_account_hash)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                         $14::uuid,$15::uuid,$16::uuid,$17::uuid,$18,$34::uuid,$19,$20,$21::uuid,$22,$23,
                         $24,$25,$26,$27,$28,$29,'DRAFT',$30::uuid,$30::uuid,$31,$32,$33)
                 RETURNING id`,
                [
                  user.orgId,
                  empNo,
                  v.first_name,
                  v.last_name ?? null,
                  v.father_name ?? null,
                  v.date_of_birth ?? null,
                  v.gender ?? null,
                  v.phone,
                  v.phone_secondary ?? null,
                  v.email ?? null,
                  v.aadhaar ? encryptPii(v.aadhaar) : null,
                  v.pan ? encryptPii(v.pan) : null,
                  v.address ?? null,
                  v.district_id ?? null,
                  v.mandal_id ?? null,
                  v.village_id ?? null,
                  v.site_id ?? null,
                  rowDesignation.label,
                  v.department ?? null,
                  v.date_of_joining,
                  v.reports_to ?? null,
                  v.salary_basic ?? null,
                  v.bank_name ?? null,
                  v.bank_account ? encryptPii(v.bank_account) : null,
                  v.bank_ifsc ?? null,
                  v.phonepe_number ?? null,
                  v.education ?? null,
                  JSON.stringify(v.skills ?? []),
                  v.experience_years ?? null,
                  user.id,
                  piiIndex(v.aadhaar),
                  piiIndex(v.pan),
                  piiIndex(v.bank_account),
                  rowDesignation.id,
                ],
              );
              const newId = (ins.rows[0] as { id: string }).id;
              await writeAudit(client as unknown as Pool, {
                orgId: user.orgId,
                actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
                actorIp: req.ip,
                actorUserAgent:
                  typeof req.headers["user-agent"] === "string"
                    ? (req.headers["user-agent"] as string)
                    : null,
                action: "employee.import",
                entityType: "employee",
                entityId: newId,
                afterState: redactPiiForAudit({ emp_no: empNo, index }),
                reason: "bulk import",
                requestId: req.requestId,
              });
              await client.query('RELEASE SAVEPOINT import_row');
              importedRows.push({index,id:newId});
              imported += 1;
            } catch (error) {
              await client.query('ROLLBACK TO SAVEPOINT import_row');
              await client.query('RELEASE SAVEPOINT import_row');
              if(!['23505','23503','23514'].includes(String((error as {code?:string}).code)))throw error;
              const entry: {
                index: number;
                emp_no?: string;
                errors: Array<{ field: string; message: string }>;
              } = {
                index,
                // Name the field that actually collided so the operator can fix
                // the right cell in their spreadsheet.
                errors: [
                  String((error as { code?: string }).code) === "23505"
                    ? duplicateFieldError(error)
                    : { field: "emp_no", message: "Row conflicts with an existing employee" },
                ],
              };
              if (v.emp_no) {
                entry.emp_no = v.emp_no;
              }
              errors.push(entry);
            }
          }

        } catch {
          try {
            await client.query("ROLLBACK");
          } catch {
            // ignore rollback failure
          }
          throw new ApiError({
            status: 500,
            code: "INTERNAL_ERROR",
            message: "Bulk import failed",
          });
        }
      }
      if(envelope.data.dry_run)await db.query('ROLLBACK TO SAVEPOINT import_preview');
      await db.query('RELEASE SAVEPOINT import_preview');
      await writeAudit(db,{orgId:user.orgId,actorId:user.id,action:envelope.data.dry_run?'employee.import.preview':'employee.import.batch',entityType:'employee_import',requestId:req.requestId,afterState:{accepted:imported,rejected:errors.length,dry_run:envelope.data.dry_run}});
      errors.sort((a, b) => a.index - b.index);
      return reply.status(200).send({
        dry_run:envelope.data.dry_run,
        validated:imported,
        rows:rawRows.map((_,index)=>{const error=errors.find(e=>e.index===index),row=importedRows.find(r=>r.index===index);return {index,status:error?(error.errors.some(e=>/exist|duplicate|conflict/i.test(e.message))?'DUPLICATE':'REJECTED'):envelope.data.dry_run?'VALIDATED':'IMPORTED',...(row&&!envelope.data.dry_run?{id:row.id}:{}),errors:error?.errors??[]};}),
        imported:envelope.data.dry_run?0:imported,
        failed: errors.length,
        errors,
      });
});},
  );

  // GET /api/v1/employees/me — any authenticated caller
  app.get(
    "/api/v1/employees/me",
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const link = await opts.pool.query(
        "SELECT employee_id FROM users WHERE id = $1",
        [user.id],
      );
      const employeeId = (link.rows[0] as { employee_id: string | null } | undefined)
        ?.employee_id;
      if (!employeeId) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "No employee linked to this user",
        });
      }
      const row = await findInOrg(user.orgId, employeeId);
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "No employee linked to this user",
        });
      }
      return reply.status(200).send(toShape(row, canSeePii(req)));
    },
  );

  // GET /api/v1/employees/:id
  app.get("/api/v1/employees/:id", { preHandler: canRead }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    const row = await findInOrg(user.orgId, id);
    if (!row) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Employee not found",
      });
    }
    const pii = canSeePii(req);
    const body = toShape(row, pii);
    /*
     * Reading somebody's full identity and bank numbers is itself an event
     * worth recording: who looked, at whose, and when. Only a response that
     * actually carried an unmasked value is logged, and the audit row names
     * the fields, never their contents.
     */
    const revealed = pii
      ? (["aadhaar", "pan", "bank_account", "phonepe_number", "salary_basic"] as const).filter(
          (field) => body[field] !== null && body[field] !== undefined,
        )
      : [];
    if (revealed.length > 0) {
      const meta = metaOf(req);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.pii.read",
        entityType: "employee",
        entityId: row.id,
        afterState: { fields: revealed },
        requestId: req.requestId,
      });
    }
    return reply.status(200).send(body);
  });

  // PATCH /api/v1/employees/:id — holders of employee.create (HR/Admin).
  // Status is immutable here (422); use exit/reactivate.
  app.patch("/api/v1/employees/:id", { preHandler: canCreate }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (req.body !== null && typeof req.body === "object" && "status" in req.body) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Status cannot be patched directly; use exit/reactivate",
        fieldErrors: [
          { field: "status", message: "Use exit/reactivate to change status" },
        ],
      });
    }
    const parsed = employeePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const expectedVersion = parseIfMatch(req);
    const { id } = req.params as { id: string };
    const cur = await findInOrg(user.orgId, id);
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Employee not found",
      });
    }
    if (cur.version !== expectedVersion) {
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${cur.version})`,
        fieldErrors: [
          {
            field: "version",
            message: `Expected version ${expectedVersion} but current is ${cur.version}`,
            code: "VERSION_MISMATCH",
          },
        ],
      });
    }
    const d = parsed.data;
    const fieldErrors = [
      ...(await validateUnitRefs(db, user.orgId, d)),
      ...(await validateReportsTo(db, user.orgId, d.reports_to, id)),
    ];
    if (d.emp_no && d.emp_no !== cur.emp_no) {
      const dup = await db.query(
        "SELECT id FROM employees WHERE org_id = $1 AND emp_no = $2 AND id <> $3::uuid LIMIT 1",
        [user.orgId, d.emp_no, id],
      );
      if ((dup.rowCount ?? 0) > 0) {
        fieldErrors.push({ field: "emp_no", message: "emp_no already exists in this org" });
      }
    }
    if (d.phone && d.phone !== cur.phone) {
      const dup = await db.query(
        "SELECT id FROM employees WHERE org_id = $1 AND phone = $2 AND id <> $3::uuid LIMIT 1",
        [user.orgId, d.phone, id],
      );
      if ((dup.rowCount ?? 0) > 0) {
        fieldErrors.push({ field: "phone", message: "Phone already exists in this org" });
      }
    }
    if (fieldErrors.length > 0) {
      const conflict = fieldErrors.some(
        (f) => f.field === "emp_no" || f.field === "phone",
      );
      return sendError(reply, req.requestId, {
        status: conflict ? 409 : 422,
        code: conflict ? "CONFLICT" : "VALIDATION_ERROR",
        message: conflict
          ? "Employee with this emp_no or phone already exists"
          : "Validation failed",
        fieldErrors,
      });
    }
    // COALESCE leaves it alone when nothing was sent, so an edit that does
    // not mention the designation does not clear it.
    const patchDesignation = await resolveDesignation(db, user.orgId, d);
    const upd = await db.query(
      `UPDATE employees SET
         emp_no = COALESCE($3, emp_no),
         first_name = COALESCE($4, first_name),
         last_name = COALESCE($5, last_name),
         father_name = COALESCE($6, father_name),
         date_of_birth = COALESCE($7, date_of_birth),
         gender = COALESCE($8, gender),
         phone = COALESCE($9, phone),
         phone_secondary = COALESCE($10, phone_secondary),
         email = COALESCE($11, email),
         aadhaar_encrypted = COALESCE($12, aadhaar_encrypted),
         pan_encrypted = COALESCE($13, pan_encrypted),
         address = COALESCE($14, address),
         district_id = COALESCE($15::uuid, district_id),
         mandal_id = COALESCE($16::uuid, mandal_id),
         village_id = COALESCE($17::uuid, village_id),
         site_id = COALESCE($18::uuid, site_id),
         designation = COALESCE($19, designation),
         designation_id = COALESCE($36::uuid, designation_id),
         department = COALESCE($20, department),
         date_of_joining = COALESCE($21, date_of_joining),
         reports_to = COALESCE($22::uuid, reports_to),
         salary_basic = COALESCE($23, salary_basic),
         bank_name = COALESCE($24, bank_name),
         bank_account_encrypted = COALESCE($25, bank_account_encrypted),
         bank_ifsc = COALESCE($26, bank_ifsc),
         phonepe_number = COALESCE($27, phonepe_number),
         education = COALESCE($28, education),
         skills = COALESCE($29, skills),
         experience_years = COALESCE($30, experience_years),
         aadhaar_hash = CASE WHEN $12 IS NULL THEN aadhaar_hash ELSE $33 END,
         pan_hash = CASE WHEN $13 IS NULL THEN pan_hash ELSE $34 END,
         bank_account_hash = CASE WHEN $25 IS NULL THEN bank_account_hash ELSE $35 END,
         updated_by = $31::uuid, updated_at = NOW(), version = version + 1
       WHERE id = $1::uuid AND org_id = $2 AND version = $32
       RETURNING ${SELECT_COLS}`,
      [
        id,
        user.orgId,
        d.emp_no ?? null,
        d.first_name ?? null,
        d.last_name ?? null,
        d.father_name ?? null,
        d.date_of_birth ?? null,
        d.gender ?? null,
        d.phone ?? null,
        d.phone_secondary ?? null,
        d.email ?? null,
        d.aadhaar !== undefined ? encryptPii(d.aadhaar) : null,
        d.pan !== undefined ? encryptPii(d.pan) : null,
        d.address ?? null,
        d.district_id ?? null,
        d.mandal_id ?? null,
        d.village_id ?? null,
        d.site_id ?? null,
        d.designation ?? null,
        d.department ?? null,
        d.date_of_joining ?? null,
        d.reports_to ?? null,
        d.salary_basic ?? null,
        d.bank_name ?? null,
        d.bank_account !== undefined ? encryptPii(d.bank_account) : null,
        d.bank_ifsc ?? null,
        d.phonepe_number ?? null,
        d.education ?? null,
        d.skills !== undefined ? JSON.stringify(d.skills) : null,
        d.experience_years ?? null,
        user.id,
        expectedVersion,
        d.aadhaar !== undefined ? piiIndex(d.aadhaar) : null,
        d.pan !== undefined ? piiIndex(d.pan) : null,
        d.bank_account !== undefined ? piiIndex(d.bank_account) : null,
        patchDesignation.id,
      ],
    );
    const row = upd.rows[0] as EmployeeRow | undefined;
    if (!row) {
      const latest = await findInOrg(user.orgId, id);
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
        fieldErrors: [
          {
            field: "version",
            message: `Expected version ${expectedVersion} but current is ${latest?.version ?? "unknown"}`,
            code: "VERSION_MISMATCH",
          },
        ],
      });
    }
    const body = toShape(row, canSeePii(req));
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "employee.update",
      entityType: "employee",
      entityId: row.id,
      beforeState: redactPiiForAudit(toShape(cur, false)),
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});

  // POST /api/v1/employees/:id/exit
  app.post(
    "/api/v1/employees/:id/exit",
    { preHandler: canExit },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = employeeExitSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findInOrg(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      // Cannot exit your own linked employee record.
      const link = await db.query(
        "SELECT id FROM users WHERE id = $1 AND employee_id = $2::uuid",
        [user.id, id],
      );
      if ((link.rowCount ?? 0) > 0) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message: "You cannot exit your own linked employee record",
        });
      }
      if (cur.status === "EXITED") {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Employee is already exited",
          fieldErrors: [{ field: "status", message: "Employee is already EXITED" }],
        });
      }
      const { exit_date, reason } = parsed.data;
      const doj = dateOnly(cur.date_of_joining);
      if (doj && exit_date < doj) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "exit_date", message: "exit_date cannot be before date_of_joining" },
          ],
        });
      }
      const upd = await db.query(
        `UPDATE employees SET status = 'EXITED', date_of_exit = $3,
           exit_reason = $4, exit_approved_by = $5::uuid,
           status_changed_at = NOW(), updated_by = $5::uuid,
           updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${SELECT_COLS}`,
        [id, user.orgId, exit_date, reason, user.id],
      );
      const row = upd.rows[0] as EmployeeRow;
      const body = toShape(row, canSeePii(req));
      const meta = metaOf(req);

      /*
       * Offboarding, in the same transaction as the exit (HR-14).
       *
       * Marking the employee EXITED used to be the whole of it. Their login
       * kept working, their pending leave sat in an approver's inbox, and
       * tasks stayed on a person who would never pick them up. Each of these
       * is done here or not at all: an exit that half-happened is worse than
       * one that was refused. (Tasks are flagged, not moved; see below.)
       *
       * Logins are disabled rather than deleted -- the account is the actor
       * on years of audit rows -- and every session is revoked, since a
       * token already issued would otherwise outlive the decision.
       */
      const disabled = (
        await db.query(
          `UPDATE users SET auth_status = 'DISABLED', updated_at = NOW()
            WHERE employee_id = $1::uuid AND org_id = $2 AND auth_status <> 'DISABLED'
            RETURNING id`,
          [id, user.orgId],
        )
      ).rows.map((r: { id: string }) => r.id);
      const accountIds = (
        await db.query("SELECT id FROM users WHERE employee_id = $1::uuid AND org_id = $2", [
          id,
          user.orgId,
        ])
      ).rows.map((r: { id: string }) => r.id);
      if (disabled.length > 0) {
        // The same rule the user admin screen enforces: an organization is
        // never left without an active administrator to undo a mistake.
        const admins = await db.query(
          `SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
             JOIN role_permissions rp ON rp.role_id = ur.role_id
            WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE'
              AND ur.scope_type IS NULL AND ur.scope_id IS NULL
              AND rp.permission_code IN ('users.manage', 'admin.configure')
            GROUP BY u.id HAVING count(DISTINCT rp.permission_code) = 2
            LIMIT 1`,
          [user.orgId],
        );
        if ((admins.rowCount ?? 0) === 0) {
          return sendError(reply, req.requestId, {
            status: 409,
            code: "LAST_ADMIN",
            message:
              "This employee's login is the organization's last active administrator. Give another account administrator rights before recording the exit.",
          });
        }
        await db.query(
          "UPDATE sessions SET revoked = true, revoked_at = now() WHERE user_id = ANY($1::uuid[]) AND revoked = false",
          [disabled],
        );
      }
      // Pending leave is withdrawn: nobody is left to take it, and an
      // approver acting on it later would debit a closed balance.
      const cancelledLeave = (
        await db.query(
          `UPDATE leave_requests SET status = 'CANCELLED', updated_at = NOW(), version = version + 1
            WHERE employee_id = $1::uuid AND org_id = $2 AND status = 'PENDING'
            RETURNING id`,
          [id, user.orgId],
        )
      ).rows.map((r: { id: string }) => r.id);
      /*
       * Open tasks stay on the person, and each is flagged on its own audit
       * trail. The catalogue is explicit (UT-WORK-06): work held by a
       * departing employee is neither silently reassigned nor deleted -- it
       * stays visible and attributable so a project manager can decide who
       * takes it, and the assign route already refuses new work for them.
       * Forcing BLOCKED instead would break projects whose workflow has no
       * such status or no edge into it. Whether exit should unassign is a
       * product decision, not one to make here.
       */
      const openTasks =
        accountIds.length === 0
          ? []
          : ((
              await db.query(
                `SELECT id, project_id, assignee_id FROM tasks
                  WHERE org_id = $1 AND assignee_id = ANY($2::uuid[])
                    AND status NOT IN ('DONE', 'CANCELLED')`,
                [user.orgId, accountIds],
              )
            ).rows as Array<{ id: string; project_id: string; assignee_id: string }>);
      for (const task of openTasks) {
        await writeAudit(db, {
          orgId: user.orgId,
          actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
          actorIp: meta.ip,
          actorUserAgent: meta.userAgent,
          action: "task.assignee_exited",
          entityType: "task",
          entityId: task.id,
          afterState: {
            assignee_id: task.assignee_id,
            project_id: task.project_id,
            exited_employee_id: id,
            needs_reassignment: true,
          },
          reason: `Assignee exited: ${reason}`,
          requestId: req.requestId,
        });
      }

      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.exit",
        entityType: "employee",
        entityId: row.id,
        beforeState: redactPiiForAudit(toShape(cur, false)),
        afterState: {
          ...(redactPiiForAudit(body) as Record<string, unknown>),
          offboarding: {
            disabled_user_ids: disabled,
            cancelled_leave_request_ids: cancelledLeave,
            open_task_ids_needing_reassignment: openTasks.map((t) => t.id),
          },
        },
        reason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  /**
   * POST /api/v1/employees/:id/activate — DRAFT → ACTIVE.
   *
   * Creation lands an employee in DRAFT on purpose, so an incomplete record
   * cannot punch or enter a payroll run. Without this
   * transition that draft was terminal: nothing in the product could put a
   * newly created employee on the roster. Authorized by employee.reactivate,
   * which is already the grant for "put this person on the active roster".
   */
  app.post(
    "/api/v1/employees/:id/activate",
    { preHandler: canReactivate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = employeeActivateSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findInOrg(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      // Only the draft edge belongs here. An EXITED or SUSPENDED employee goes
      // back through reactivate, which is the audited re-entry path.
      if (cur.status !== "DRAFT") {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Only DRAFT employees can be activated",
          fieldErrors: [
            {
              field: "status",
              message:
                cur.status === "ACTIVE"
                  ? "Employee is already ACTIVE"
                  : `Cannot activate from status ${cur.status}; use reactivate`,
            },
          ],
        });
      }
      const { reason } = parsed.data;
      const upd = await db.query(
        `UPDATE employees SET status = 'ACTIVE', status_changed_at = NOW(),
           updated_by = $3::uuid, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${SELECT_COLS}`,
        [id, user.orgId, user.id],
      );
      const row = upd.rows[0] as EmployeeRow;
      const body = toShape(row, canSeePii(req));
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.activate",
        entityType: "employee",
        entityId: row.id,
        beforeState: redactPiiForAudit(toShape(cur, false)),
        afterState: redactPiiForAudit(body),
        reason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);

});},
  );

  /**
   * POST /api/v1/employees/:id/suspend — ACTIVE → SUSPENDED.
   *
   * The counterpart to reactivate. Suspension is a reversible pause (BR-01
   * eligibility stops immediately, history is preserved) as distinct from exit,
   * so it carries the same authority as exit rather than a new permission code.
   */
  app.post(
    "/api/v1/employees/:id/suspend",
    { preHandler: canExit },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = employeeSuspendSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findInOrg(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      // Same self-protection as exit: an actor must not be able to lock
      // themselves out of their own record.
      const link = await db.query(
        "SELECT id FROM users WHERE id = $1 AND employee_id = $2::uuid",
        [user.id, id],
      );
      if ((link.rowCount ?? 0) > 0) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message: "You cannot suspend your own linked employee record",
        });
      }
      if (cur.status !== "ACTIVE") {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Only ACTIVE employees can be suspended",
          fieldErrors: [
            { field: "status", message: `Cannot suspend from status ${cur.status}` },
          ],
        });
      }
      const { reason } = parsed.data;
      const upd = await db.query(
        `UPDATE employees SET status = 'SUSPENDED', status_changed_at = NOW(),
           updated_by = $3::uuid, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${SELECT_COLS}`,
        [id, user.orgId, user.id],
      );
      const row = upd.rows[0] as EmployeeRow;
      const body = toShape(row, canSeePii(req));
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.suspend",
        entityType: "employee",
        entityId: row.id,
        beforeState: redactPiiForAudit(toShape(cur, false)),
        afterState: redactPiiForAudit(body),
        reason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);

});},
  );

  // POST /api/v1/employees/:id/reactivate
  app.post(
    "/api/v1/employees/:id/reactivate",
    { preHandler: canReactivate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = employeeReactivateSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findInOrg(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      if (cur.status !== "EXITED" && cur.status !== "SUSPENDED") {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Only EXITED or SUSPENDED employees can be reactivated",
          fieldErrors: [
            { field: "status", message: `Cannot reactivate from status ${cur.status}` },
          ],
        });
      }
      const { reason } = parsed.data;
      const upd = await db.query(
        `UPDATE employees SET status = 'ACTIVE', date_of_exit = NULL,
           exit_reason = NULL, status_changed_at = NOW(),
           updated_by = $3::uuid, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${SELECT_COLS}`,
        [id, user.orgId, user.id],
      );
      const row = upd.rows[0] as EmployeeRow;
      const body = toShape(row, canSeePii(req));
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.reactivate",
        entityType: "employee",
        entityId: row.id,
        beforeState: redactPiiForAudit(toShape(cur, false)),
        afterState: redactPiiForAudit(body),
        reason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  app.get('/api/v1/employees/:id/documents/:documentId/download',{preHandler:canReadDocs},async(req,reply)=>{
    const {id,documentId}=req.params as {id:string;documentId:string},user=req.authUser!;
    const row=(await opts.pool.query('SELECT * FROM employee_documents WHERE id=$1 AND employee_id=$2 AND org_id=$3',[documentId,id,user.orgId])).rows[0];
    if(!row)throw new ApiError({status:404,code:'NOT_FOUND',message:'Document not found'});
    const binary=await readBlob(row);
    if(!binary)throw new ApiError({status:404,code:'NOT_FOUND',message:'Document content is no longer available'});
    await writeAudit(opts.pool,{orgId:user.orgId,actorId:user.id,action:'document.download',entityType:'employee_document',entityId:documentId,requestId:req.requestId});
    return reply.header('Content-Type',row.mime_type).header('X-Content-Type-Options','nosniff').header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(row.file_name)).send(binary);
  });

  // GET /api/v1/employees/:id/documents
  app.get(
    "/api/v1/employees/:id/documents",
    { preHandler: canReadDocs },
    async (req, reply) => {
      const parsed = cursorPageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const emp = await findInOrg(user.orgId, id);
      if (!emp) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      const { limit, cursor } = parsed.data;
      const values: unknown[] = [user.orgId, id];
      const clauses = ["org_id = $1", "employee_id = $2::uuid"];
      if (cursor) {
        const decoded = decodeCursor<PageCursor>(cursor);
        if (!decoded) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            fieldErrors: [
              { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
            ],
          });
        }
        values.push(decoded.created_at, decoded.id);
        clauses.push(
          `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);
      const res = await opts.pool.query(
        `SELECT id, doc_type, file_name, file_size, checksum, created_at
         FROM employee_documents WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values as string[],
      );
      const hasMore = res.rows.length > limit;
      const page = res.rows.slice(0, limit) as Array<{
        id: string;
        doc_type: string;
        file_name: string;
        file_size: number;
        checksum: string;
        created_at: Date;
      }>;
      const last = page[page.length - 1];
      return reply.status(200).send({
        data: page.map((r) => ({
          id: r.id,
          doc_type: r.doc_type,
          file_name: r.file_name,
          file_size: r.file_size,
          checksum: r.checksum,
          created_at:
            r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        })),
        next_cursor:
          hasMore && last
            ? encodeCursor({
                created_at:
                  last.created_at instanceof Date
                    ? last.created_at.toISOString()
                    : last.created_at,
                id: last.id,
              })
            : null,
        has_more: hasMore,
      });
    },
  );

  // POST /api/v1/employees/:id/documents
  app.post(
    "/api/v1/employees/:id/documents",
    { preHandler: canUploadDocs },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = documentUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const emp = await findInOrg(user.orgId, id);
      if (!emp) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      const { doc_type, file_name, content_base64 } = parsed.data;
      const ext = file_name.split(".").pop()?.toLowerCase() ?? "";
      if (
        !file_name.includes(".") ||
        !(ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)
      ) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            {
              field: "file_name",
              message: `Only ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ")} files are allowed`,
            },
          ],
        });
      }
      const binary = decodeBase64Strict(content_base64);
      if (binary.length > MAX_DOCUMENT_BYTES) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "File exceeds the 5MB limit",
          fieldErrors: [
            { field: "content_base64", message: "File exceeds the 5MB limit" },
          ],
        });
      }
      await scanUpload(binary,ext,app.appConfig.nodeEnv==='production');
      const checksum = createHash("sha256").update(binary).digest("hex");
      const docIdRes = await db.query("SELECT gen_random_uuid() AS id");
      const docId = (docIdRes.rows[0] as { id: string }).id;
      const ins = await db.query(
        `INSERT INTO employee_documents
           (id, org_id, employee_id, doc_type, file_name, content_encrypted, file_size, mime_type, checksum, created_by)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid)
         RETURNING id, doc_type, file_name, file_size, checksum, created_at`,
        [
          docId,
          user.orgId,
          id,
          doc_type,
          file_name,
          encodeBlob(binary),
          binary.length,
          MIME_BY_EXT[ext] ?? "application/octet-stream",
          checksum,
          user.id,
        ],
      );
      const row = ins.rows[0] as {
        id: string;
        doc_type: string;
        file_name: string;
        file_size: number;
        checksum: string;
        created_at: Date;
      };
      const body = {
        id: row.id,
        doc_type: row.doc_type,
        file_name: row.file_name,
        file_size: row.file_size,
        checksum: row.checksum,
        created_at:
          row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      };
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "document.upload",
        entityType: "employee_document",
        entityId: row.id,
        afterState: body,
        requestId: req.requestId,
      });
      return reply.status(201).send(body);
    
});},
  );

  /* ------------------------------------------------------- designations */

  /**
   * The list of job titles, for the dropdown that replaced the free-text box.
   *
   * Open to anybody who can read the directory: choosing a designation is
   * part of reading an employee record, and a dropdown whose options need a
   * separate permission is a dropdown that renders empty for half the people
   * who have to use it.
   */
  app.get("/api/v1/designations", { preHandler: canRead }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401, code: "UNAUTHENTICATED", message: "Sign in first",
      });
    }
    const rows = (await opts.pool.query(
      `SELECT d.id, d.code, d.label, d.display_order, d.active, d.role_id,
              r.name AS role_name,
              (SELECT count(*)::int FROM employees e
                WHERE e.designation_id = d.id AND e.status <> 'EXITED') AS employee_count
         FROM designations d
         LEFT JOIN roles r ON r.id = d.role_id
        WHERE d.org_id = $1 AND d.active
        ORDER BY d.display_order, d.label`,
      [user.orgId],
    )).rows;
    return reply.send({ data: rows });
  });

  /**
   * A new job title, and optionally the role that goes with it.
   *
   * The role is created with no permissions at all. A job title that granted
   * access by existing would make hiring an access-control decision taken by
   * whoever fills in the form, which is exactly backwards — an administrator
   * grants the role its permissions afterwards, on purpose.
   */
  app.post("/api/v1/designations", { preHandler: canCreate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401, code: "UNAUTHENTICATED", message: "Sign in first",
      });
    }
    const parsed = designationCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const input = parsed.data;
    const code = input.code ?? designationCode(input.label);
    if (!code) {
      return sendError(reply, req.requestId, {
        status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
        fieldErrors: [{ field: "label", message: "Use at least one letter or digit", code: "invalid" }],
      });
    }

    const client = await opts.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (await client.query(
        "SELECT * FROM designations WHERE org_id = $1 AND code = $2", [user.orgId, code],
      )).rows[0];
      if (existing) {
        await client.query("ROLLBACK");
        // Somebody adding a designation that is already there means the same
        // thing as picking it: return it rather than making them go and look.
        return reply.status(200).send({ data: existing });
      }

      let roleId: string | null = null;
      if (input.create_role) {
        const roleCode = `${user.orgId.slice(0, 8)}_${code}`;
        const found = (await client.query(
          "SELECT id FROM roles WHERE code = $1", [roleCode])).rows[0];
        roleId = found
          ? String(found.id)
          : String((await client.query(
              `INSERT INTO roles(org_id, code, name, is_system_role, description)
               VALUES($1, $2, $3, false, $4) RETURNING id`,
              [user.orgId, roleCode, input.label,
               `Created alongside the ${input.label} designation. Grant it permissions before assigning it.`],
            )).rows[0].id);
      }

      const row = (await client.query(
        `INSERT INTO designations(org_id, code, label, role_id, display_order, created_by)
         VALUES($1, $2, $3, $4, COALESCE($5, 100), $6) RETURNING *`,
        [user.orgId, code, input.label, roleId, input.display_order ?? null, user.id],
      )).rows[0];
      await client.query("COMMIT");
      await writeAudit(opts.pool, {
        orgId: user.orgId, actorId: user.id, impersonatorId: user.impersonator?.id ?? null, action: "designation.create",
        entityType: "designation", entityId: String(row.id), afterState: row,
      });
      return reply.status(201).send({ data: row });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  /* ------------------------------------------------- bulk edit (§note 12) */

  /**
   * Change the same thing about several people at once.
   *
   * A crew of thirty moving to a new mandal is one decision, not thirty, and
   * doing it one record at a time is how twenty-eight get moved and two are
   * forgotten until somebody's attendance stops matching their site.
   *
   * Dry run by default. A bulk edit is the one screen where somebody
   * discovers they had the wrong filter applied after it has already touched
   * two hundred records, so it shows the work before it does it.
   */
  app.patch("/api/v1/employees/bulk", { preHandler: canCreate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401, code: "UNAUTHENTICATED", message: "Sign in first",
      });
    }
    const parsed = employeeBulkUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const input = parsed.data;
    const changes = Object.fromEntries(
      Object.entries(input.changes).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>;
    if (Object.keys(changes).length === 0) {
      return sendError(reply, req.requestId, {
        status: 422, code: "NOTHING_TO_CHANGE",
        message: "Choose at least one field to change. Nothing was sent to apply.",
      });
    }

    const client = await opts.pool.connect();
    try {
      await client.query("BEGIN");

      const rows = (await client.query(
        `SELECT ${SELECT_COLS} FROM employees
          WHERE org_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
        [user.orgId, input.employee_ids],
      )).rows as EmployeeRow[];

      const found = new Set(rows.map((r) => String(r.id)));
      const missing = input.employee_ids.filter((id) => !found.has(id));

      /*
       * Validated once, against the change rather than per row.
       *
       * The reporting line is the exception: a cycle depends on which record
       * is being moved, so it has to be asked for each of them.
       */
      const fieldErrors = await validateUnitRefs(client, user.orgId, changes);
      if (changes.designation_id) {
        const d = (await client.query(
          "SELECT id FROM designations WHERE id = $1 AND org_id = $2",
          [changes.designation_id, user.orgId])).rows[0];
        if (!d) {
          fieldErrors.push({ field: "designation_id",
            message: "That designation is not on the list" });
        }
      }
      if (fieldErrors.length > 0) {
        await client.query("ROLLBACK");
        return sendError(reply, req.requestId, {
          status: 422, code: "VALIDATION_ERROR", message: "Validation failed", fieldErrors,
        });
      }

      const resolved = await resolveDesignation(client, user.orgId, changes);
      if (resolved.id || resolved.label) {
        changes.designation_id = resolved.id;
        changes.designation = resolved.label;
      }

      const planned: Array<{ id: string; emp_no: string; fields: string[] }> = [];
      const refused: Array<{ id: string; emp_no: string; reason: string }> = [];

      for (const row of rows) {
        const cycle = changes.reports_to === undefined
          ? []
          : await validateReportsTo(
              client, user.orgId,
              (changes.reports_to as string | null) ?? undefined, String(row.id));
        if (cycle.length > 0) {
          refused.push({ id: String(row.id), emp_no: String(row.emp_no),
            reason: cycle[0].message });
          continue;
        }
        const fields = bulkChangeAffects(
          row as unknown as Record<string, unknown>, changes);
        if (fields.length === 0) continue;
        planned.push({ id: String(row.id), emp_no: String(row.emp_no), fields });
      }

      if (input.dry_run) {
        await client.query("ROLLBACK");
        return reply.send({
          data: {
            dry_run: true,
            would_change: planned.length,
            unchanged: rows.length - planned.length - refused.length,
            not_found: missing,
            refused,
            changes,
            sample: planned.slice(0, 20),
          },
        });
      }

      const sets = Object.keys(changes).map((f, i) => `${f} = $${i + 3}`).join(", ");
      const values = Object.values(changes);
      for (const p of planned) {
        await client.query(
          `UPDATE employees SET ${sets}, updated_by = $2, updated_at = NOW(),
             version = version + 1
           WHERE id = $1 AND org_id = $${values.length + 3}`,
          [p.id, user.id, ...values, user.orgId],
        );
      }
      await client.query("COMMIT");

      const meta = metaOf(req);
      for (const p of planned) {
        await writeAudit(opts.pool, {
          orgId: user.orgId, actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
          actorIp: meta.ip, actorUserAgent: meta.userAgent,
          action: "employee.bulk_update", entityType: "employee", entityId: p.id,
          afterState: changes, requestId: req.requestId,
          reason: `Bulk edit of ${input.employee_ids.length} record(s)`,
        });
      }

      return reply.send({
        data: {
          dry_run: false,
          updated: planned.length,
          unchanged: rows.length - planned.length - refused.length,
          not_found: missing,
          refused,
        },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  /* =============================================================== §076
   * What work this person is on, and therefore what data they see.
   *
   * The role decides the screens; this decides the data. Nothing here
   * grants or removes a permission -- an employee who is put on three
   * programmes still sees only the employee's screens, and sees them for
   * those three programmes.
   *
   * Both mechanisms already existed. Survey programmes scope themselves
   * through survey_project_employees, which seventy people rely on.
   * Ordinary projects scope through user_roles, which worked and which
   * nobody had ever used, because setting one meant pasting a UUID into a
   * box marked "Scope record ID".
   */

  async function employeeOr404(db: Pool | PoolClient, orgId: string, id: string) {
    const row = await db.query(
      `SELECT e.id, e.org_id,
              COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no) AS name,
              u.id AS user_id, u.username
         FROM employees e
         LEFT JOIN users u ON u.employee_id = e.id
        WHERE e.id = $1 AND e.org_id = $2`,
      [id, orgId],
    );
    if (!row.rowCount) {
      throw new ApiError({ status: 404, code: 'NOT_FOUND', message: 'No such employee' });
    }
    return row.rows[0] as {
      id: string; name: string; user_id: string | null; username: string | null;
    };
  }

  app.get(
    '/api/v1/employees/:id/assignments',
    { preHandler: requirePermission(authenticate, 'users.read') },
    async (req) => {
      const user = req.authUser!;
      const id = (req.params as { id: string }).id;
      const employee = await employeeOr404(opts.pool, user.orgId, id);

      const roleRows = employee.user_id
        ? (await opts.pool.query(
            `SELECT ur.role_id, ur.scope_type, ur.scope_id, r.code
               FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = $1`, [employee.user_id])).rows
        : [];
      const projectIds = [...new Set(
        roleRows.filter((r) => r.scope_type === 'project' && r.scope_id).map((r) => r.scope_id as string),
      )];
      /*
       * Unscoped means the whole organisation -- that is what resolveScopes
       * makes of it -- so the screen has to say so rather than showing an
       * empty list that looks like "nothing".
       */
      const access = roleRows.some((r) => !r.scope_type) || roleRows.length === 0
        ? 'ORGANISATION' : 'ASSIGNED';

      /*
       * Programme enrolment hangs off the employee, not the login, so
       * somebody with no account can still be on a programme -- and often
       * is: a chainman files nothing and is on the crew all the same.
       */
      const programmes = (await opts.pool.query(
            `SELECT pe.survey_project_id, pe.project_role, pe.assigned_on,
                    sp.code, sp.name, sp.status
               FROM survey_project_employees pe
               JOIN survey_projects sp ON sp.id = pe.survey_project_id
              WHERE pe.employee_id = $1 AND pe.org_id = $2 AND pe.released_on IS NULL
              ORDER BY sp.name`, [id, user.orgId])).rows;

      const [projectChoices, programmeChoices, otherScopes] = await Promise.all([
        opts.pool.query(
          `SELECT id, code, name, status FROM projects
            WHERE org_id = $1 AND status <> 'CANCELLED' ORDER BY name LIMIT 500`, [user.orgId]),
        opts.pool.query(
          `SELECT id, code, name, status FROM survey_projects
            WHERE org_id = $1 AND status <> 'CLOSED' ORDER BY name LIMIT 500`, [user.orgId]),
        opts.pool.query(
          `SELECT DISTINCT ur.scope_type, COALESCE(ou.name, e.emp_no) AS label
             FROM user_roles ur
             LEFT JOIN org_units ou ON ou.id = ur.scope_id
             LEFT JOIN employees e ON e.id = ur.scope_id
            WHERE ur.user_id = $1 AND ur.scope_type IS NOT NULL AND ur.scope_type <> 'project'`,
          [employee.user_id ?? null]),
      ]);

      return {
        data: {
          employee: { id: employee.id, name: employee.name },
          /*
           * A project scope is carried on the user account, so an employee
           * with no login cannot have one. Said plainly here rather than
           * letting the screen offer a control that would do nothing.
           */
          user: employee.user_id
            ? { id: employee.user_id, username: employee.username }
            : null,
          roles: [...new Set(roleRows.map((r) => r.code as string))],
          project_access: access,
          project_ids: projectIds,
          programmes: programmes.map((p) => ({
            ...p, assigned_on: p.assigned_on ? String(p.assigned_on).slice(0, 10) : null,
          })),
          /* Limits set elsewhere, so the screen can say it is not the whole story. */
          other_scopes: otherScopes.rows,
          choices: {
            projects: projectChoices.rows,
            programmes: programmeChoices.rows,
          },
          summary: describeAccess(access as 'ORGANISATION' | 'ASSIGNED',
            projectIds.length, programmes.length),
        },
      };
    },
  );

  app.put(
    '/api/v1/employees/:id/assignments',
    { preHandler: requirePermission(authenticate, 'users.manage') },
    async (req) => {
      const user = req.authUser!;
      const id = (req.params as { id: string }).id;
      const parsed = assignmentsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError({
          status: 422, code: 'VALIDATION_ERROR', message: 'Validation failed',
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const input = parsed.data;

      return mutate(opts.pool, req, 'employee.assignments', 'employee', async (db) => {
        const employee = await employeeOr404(db, user.orgId, id);

        /*
         * Changing your own data scope is how an administrator locks
         * themselves out of the screen they would need to undo it. Refused:
         * somebody else can do it, and the refusal costs nothing.
         */
        if (employee.user_id === user.id) {
          throw new ApiError({
            status: 409, code: 'SELF_SCOPE',
            message: 'Ask another administrator to change your own access',
          });
        }

        /* ------------------------------------------- survey programmes */
        {
          const current = (await db.query(
            `SELECT survey_project_id, project_role FROM survey_project_employees
              WHERE employee_id = $1 AND org_id = $2 AND released_on IS NULL`,
            [id, user.orgId])).rows as Array<{ survey_project_id: string; project_role: string }>;
          const wanted = new Map(input.programmes.map((p) => [p.survey_project_id, p.project_role]));
          const changing =
            current.length !== wanted.size
            || current.some((c) => wanted.get(c.survey_project_id) !== c.project_role);
          if (changing && !user.permissions.includes('survey.assign')) {
            throw new ApiError({
              status: 403, code: 'FORBIDDEN',
              message: 'Changing survey programme assignments needs the survey.assign permission',
            });
          }
          for (const p of input.programmes) {
            const found = await db.query(
              'SELECT 1 FROM survey_projects WHERE id = $1 AND org_id = $2',
              [p.survey_project_id, user.orgId]);
            if (!found.rowCount) {
              throw new ApiError({
                status: 422, code: 'INVALID_SCOPE', message: 'No such survey programme',
              });
            }
            await db.query(
              `INSERT INTO survey_project_employees(org_id, survey_project_id, employee_id,
                 project_role, assigned_on, created_by)
               VALUES($1,$2,$3,$4,CURRENT_DATE,$5)
               ON CONFLICT (survey_project_id, employee_id)
               DO UPDATE SET project_role = EXCLUDED.project_role, released_on = NULL`,
              [user.orgId, p.survey_project_id, id, p.project_role, user.id]);
          }
          /*
           * Released, not deleted. Somebody worked those days and the
           * entries point at the enrolment; removing the row would orphan
           * the history of who was on the programme when.
           */
          const keep = input.programmes.map((p) => p.survey_project_id);
          await db.query(
            `UPDATE survey_project_employees SET released_on = CURRENT_DATE
              WHERE employee_id = $1 AND org_id = $2 AND released_on IS NULL
                AND NOT (survey_project_id = ANY($3::uuid[]))`,
            [id, user.orgId, keep]);
        }

        /* ------------------------------------------- ordinary projects */
        if (!employee.user_id) {
          if (input.project_access === 'ASSIGNED') {
            throw new ApiError({
              status: 409, code: 'NO_ACCOUNT',
              message: 'This employee has no login, so there is no project access to limit',
            });
          }
        } else {
          const existing = (await db.query(
            'SELECT role_id, scope_type, scope_id FROM user_roles WHERE user_id = $1',
            [employee.user_id])).rows as Array<{ role_id: string; scope_type: string | null; scope_id: string | null }>;

          for (const projectId of input.project_ids) {
            const found = await db.query(
              'SELECT 1 FROM projects WHERE id = $1 AND org_id = $2', [projectId, user.orgId]);
            if (!found.rowCount) {
              throw new ApiError({
                status: 422, code: 'INVALID_SCOPE', message: 'No such project',
              });
            }
          }

          const planned = plannedRoleRows(existing, input.project_access, input.project_ids);
          await db.query('DELETE FROM user_roles WHERE user_id = $1', [employee.user_id]);
          for (const row of planned) {
            await db.query(
              `INSERT INTO user_roles(user_id, role_id, scope_type, scope_id)
               VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [employee.user_id, row.role_id, row.scope_type, row.scope_id]);
          }
          /*
           * What a session may see is decided when its token is minted, so
           * a narrowed scope would not bite until the token lapsed. Sign
           * them out: the change is only worth making if it applies now.
           */
          await db.query(
            'UPDATE sessions SET revoked = true, revoked_at = now() WHERE user_id = $1 AND revoked = false',
            [employee.user_id]);
        }

        return {
          id,
          project_access: input.project_access,
          project_ids: input.project_ids,
          programmes: input.programmes,
          summary: describeAccess(input.project_access,
            input.project_ids.length, input.programmes.length),
        };
      });
    },
  );
}
