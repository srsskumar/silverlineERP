import {scanUpload} from "../../common/fileSafety.js";
import {encodeBlob, readBlob} from "../../common/blobStore.js";
import {mutationRoute} from "../../common/mutationRoute.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ApiError,
  MAX_DOCUMENT_BYTES,
  S1_PERMISSIONS,
  cursorPageQuerySchema,
  decodeCursor,
  documentUploadSchema,
  employeeActivateSchema,
  employeeCreateSchema,
  employeeExitSchema,
  employeePatchSchema,
  employeeReactivateSchema,
  employeeSuspendSchema,
  encodeCursor,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
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
  status: z.enum(["DRAFT", "ACTIVE", "SUSPENDED", "EXITED"]).optional(),
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
  department: string | null;
  date_of_joining: Date | string;
  date_of_exit: Date | string | null;
  exit_reason: string | null;
  reports_to: string | null;
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
    department: row.department,
    date_of_joining: dateOnly(row.date_of_joining),
    date_of_exit: dateOnly(row.date_of_exit),
    exit_reason: row.exit_reason,
    reports_to: row.reports_to,
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


const SELECT_COLS = `id, org_id, emp_no, first_name, last_name, father_name,
  date_of_birth, gender, phone, phone_secondary, email,
  aadhaar_encrypted, pan_encrypted, address,
  district_id, mandal_id, village_id, site_id, designation, department,
  date_of_joining, date_of_exit, exit_reason, reports_to, salary_basic,
  bank_name, bank_account_encrypted, bank_ifsc, phonepe_number,
  education, skills, experience_years, status, version, created_at, updated_at`;

/** Validates unit refs (existence + org + expected type per field). */
async function validateUnitRefs(
  pool: Pool,
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
  pool: Pool,
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
  const canReadDocs = requirePermission(
    authenticate,
    S1_PERMISSIONS.DOCUMENT_READ,
  );
  const canUploadDocs = requirePermission(
    authenticate,
    S1_PERMISSIONS.DOCUMENT_UPLOAD,
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
      values.push(`%${q}%`);
      clauses.push(
        `(emp_no ILIKE $${values.length} OR first_name ILIKE $${values.length} OR last_name ILIKE $${values.length} OR phone ILIKE $${values.length})`,
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
    const pii = canSeePii(req);
    const hasMore = res.rows.length > limit;
    const page = res.rows.slice(0, limit) as EmployeeRow[];
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map((r) => toShape(r, pii)),
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
    let row: EmployeeRow;
    try {
      const ins = await db.query(
        `INSERT INTO employees (
           org_id, emp_no, first_name, last_name, father_name, date_of_birth, gender,
           phone, phone_secondary, email, aadhaar_encrypted, pan_encrypted, address,
           district_id, mandal_id, village_id, site_id, designation, department,
           date_of_joining, reports_to, salary_basic, bank_name,
           bank_account_encrypted, bank_ifsc, phonepe_number,
           education, skills, experience_years, status, created_by, updated_by,
           aadhaar_hash, pan_hash, bank_account_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 $14::uuid,$15::uuid,$16::uuid,$17::uuid,$18,$19,$20,$21::uuid,$22,$23,
                 $24,$25,$26,$27,$28,$29,'DRAFT',$30::uuid,$30::uuid,$31,$32,$33)
         RETURNING ${SELECT_COLS}`,
        [
          user.orgId,
          d.emp_no,
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
          d.designation ?? null,
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
      actorId: user.id,
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
        const parsedRow = employeeCreateSchema.safeParse(raw);
        if (!parsedRow.success) {
          for (const fe of toFieldErrors(parsedRow.error)) {
            rowErrors.push({ field: fe.field, message: fe.message });
          }
        } else {
          const v = parsedRow.data;
          if (seenEmpNos.has(v.emp_no) || existingEmpNos.has(v.emp_no)) {
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
            seenEmpNos.add(v.emp_no);
            seenPhones.add(v.phone);
            existingEmpNos.add(v.emp_no);
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
              const ins = await client.query(
                `INSERT INTO employees (
                   org_id, emp_no, first_name, last_name, father_name, date_of_birth, gender,
                   phone, phone_secondary, email, aadhaar_encrypted, pan_encrypted, address,
                   district_id, mandal_id, village_id, site_id, designation, department,
                   date_of_joining, reports_to, salary_basic, bank_name,
                   bank_account_encrypted, bank_ifsc, phonepe_number,
                   education, skills, experience_years, status, created_by, updated_by,
                   aadhaar_hash, pan_hash, bank_account_hash)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                         $14::uuid,$15::uuid,$16::uuid,$17::uuid,$18,$19,$20,$21::uuid,$22,$23,
                         $24,$25,$26,$27,$28,$29,'DRAFT',$30::uuid,$30::uuid,$31,$32,$33)
                 RETURNING id`,
                [
                  user.orgId,
                  v.emp_no,
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
                  v.designation ?? null,
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
                ],
              );
              const newId = (ins.rows[0] as { id: string }).id;
              await writeAudit(client as unknown as Pool, {
                orgId: user.orgId,
                actorId: user.id,
                actorIp: req.ip,
                actorUserAgent:
                  typeof req.headers["user-agent"] === "string"
                    ? (req.headers["user-agent"] as string)
                    : null,
                action: "employee.import",
                entityType: "employee",
                entityId: newId,
                afterState: redactPiiForAudit({ emp_no: v.emp_no, index }),
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
    return reply.status(200).send(toShape(row, canSeePii(req)));
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
      actorId: user.id,
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
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "employee.exit",
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
   * POST /api/v1/employees/:id/activate — DRAFT → ACTIVE.
   *
   * Creation lands an employee in DRAFT on purpose, so an incomplete record
   * cannot punch, be assigned a fence or enter a payroll run. Without this
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
        actorId: user.id,
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
        actorId: user.id,
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
        actorId: user.id,
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
        actorId: user.id,
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
}
