import {employeeAccess} from '../../common/domain.js';
import {mutationRoute} from "../../common/mutationRoute.js";
import {employeeRestriction} from "../../common/scopedReads.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  S3_PERMISSIONS,
  assembleApprovalChain,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  leaveBalanceUpsertSchema,
  leaveCancelSchema,
  leaveDecisionSchema,
  leaveOpenYearSchema,
  leaveRequestCreateSchema,
  resolveEffectiveHolidays,
  toFieldErrors,
  type ApprovalChainStep,
  type HolidayCandidate,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission,scopesForPermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import { emitNotification } from "../s5/notify.js";
import { parseIfMatch } from '../../common/ifMatch.js';
import { orgTodaySql } from "../../common/orgTime.js";

export interface LeaveRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const LEAVE_REQUEST = S3_PERMISSIONS.LEAVE_REQUEST;
const LEAVE_READ = S3_PERMISSIONS.LEAVE_READ;
const LEAVE_DECIDE = S3_PERMISSIONS.LEAVE_DECIDE;
const LEAVE_ADMIN = S3_PERMISSIONS.LEAVE_ADMIN;

// ---------------------------------------------------------------------------
// IST date helpers (period defaults + past-date rule use Asia/Kolkata)
// ---------------------------------------------------------------------------

function istDayString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function todayIst(): string {
  return istDayString(new Date());
}

function currentIstYear(): number {
  return Number(istDayString(new Date()).slice(0, 4));
}

/**
 * The organisation's current calendar year, in its own timezone (fix round
 * 1, item 5) -- `organizations.timezone` (default Asia/Kolkata), the same
 * source D-006/D-013 read via `orgTodaySql`, not the fixed IST used
 * elsewhere in this file for the per-request backdating rule.
 */
async function currentOrgYear(db: Pick<Pool, "query">, orgId: string): Promise<number> {
  const res = await db.query(
    `SELECT EXTRACT(YEAR FROM ${orgTodaySql("$1")})::int AS year`,
    [orgId],
  );
  return Number((res.rows[0] as { year: number }).year);
}

/** Inclusive calendar days between two YYYY-MM-DD dates (to >= from). */
function inclusiveDays(from: string, to: string): number {
  const ms =
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function isSundayDate(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}

/**
 * The days of a leave, per leave year (D-011), skipping any date in
 * `skipDates`.
 *
 * A balance belongs to a calendar year. Leave from 30 Dec to 2 Jan is two
 * days of one year's balance and two of the next; charging all four to the
 * first year (as the balance check and the debit both did) overdrew it and
 * never touched the second.
 *
 * `skipDates` is the sandwich rule (D-012, owner decision 2026-09-24): for a
 * PAID leave type, a Sunday or an effective holiday inside the range is
 * already a paid day off and is not deducted a second time. Callers pass an
 * empty set for unpaid (LOP) leave, which keeps counting every calendar day
 * exactly as before.
 */
function daysByYear(
  from: string,
  to: string,
  skipDates: ReadonlySet<string> = new Set(),
): Array<{ year: number; days: number }> {
  const out: Array<{ year: number; days: number }> = [];
  const first = Number(from.slice(0, 4)), last = Number(to.slice(0, 4));
  for (let y = first; y <= last; y++) {
    const start = y === first ? from : `${y}-01-01`;
    const end = y === last ? to : `${y}-12-31`;
    if (skipDates.size === 0) {
      out.push({ year: y, days: inclusiveDays(start, end) });
      continue;
    }
    let days = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!skipDates.has(d)) days += 1;
    }
    out.push({ year: y, days });
  }
  return out;
}

const uuidCheck = z.string().uuid();

function isUuid(value: unknown): value is string {
  return uuidCheck.safeParse(value).success;
}

function dateOnly(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}


/**
 * POST /leave/requests requires a UUID Idempotency-Key (stricter than the
 * S1/S2 free-form key guard). Missing/invalid → 422 MISSING_IDEMPOTENCY_KEY.
 */
function idemUuidOr422(
  req: { headers: Record<string, unknown> },
  reply: FastifyReply,
  requestId: string,
): string | null {
  const raw = req.headers["idempotency-key"];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!key || !isUuid(key)) {
    sendError(reply, requestId, {
      status: 422,
      code: "MISSING_IDEMPOTENCY_KEY",
      message: "Idempotency-Key header with a valid UUID is required",
      fieldErrors: [
        {
          field: "Idempotency-Key",
          message: "Idempotency-Key header with a valid UUID is required",
        },
      ],
    });
    return null;
  }
  return key;
}

/** Error envelope plus a machine-readable rule detail (top-level extras). */
function sendRuleError(
  reply: FastifyReply,
  requestId: string,
  args: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Array<{ field: string; message: string }>;
    extra?: Record<string, unknown>;
  },
): FastifyReply {
  return reply.status(args.status).send({
    code: args.code,
    message: args.message,
    field_errors: args.fieldErrors ?? [],
    request_id: requestId,
    retryable: false,
    ...(args.extra ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Row types + shapes (snake_case, mirroring S1/S2 conventions)
// ---------------------------------------------------------------------------

interface LeaveTypeRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  is_paid: boolean;
  annual_entitlement: string | number;
  requires_balance: boolean;
  active: boolean;
}

function toTypeShape(row: LeaveTypeRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    is_paid: row.is_paid,
    annual_entitlement: Number(row.annual_entitlement),
    requires_balance: row.requires_balance,
  };
}

interface BalanceRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  leave_code: string;
  period_year: number;
  opening_balance: string | number;
  credits: string | number;
  consumed: string | number;
  adjustments: string | number;
  current_balance: string | number;
}

const BALANCE_COLS = `b.id, b.employee_id, b.leave_type_id, t.code AS leave_code,
  b.period_year, b.opening_balance, b.credits, b.consumed, b.adjustments,
  (b.opening_balance + b.credits - b.consumed + b.adjustments) AS current_balance`;

function toBalanceShape(row: BalanceRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    leave_type_id: row.leave_type_id,
    leave_code: row.leave_code,
    period_year: Number(row.period_year),
    opening_balance: Number(row.opening_balance),
    credits: Number(row.credits),
    consumed: Number(row.consumed),
    adjustments: Number(row.adjustments),
    current_balance: Number(row.current_balance),
  };
}

interface RequestRow {
  id: string;
  org_id: string;
  employee_id: string;
  leave_type_id: string;
  from_date: Date | string;
  to_date: Date | string;
  total_days: number;
  reason: string | null;
  status: string;
  approval_chain: unknown;
  current_approver_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  /**
   * The per-year split actually debited at final approval (fix round 1,
   * item 3): `[{year, days}]`, a year with 0 days never listed. Empty
   * (`[]`) until approved -- nothing has been debited yet.
   */
  debited_days: unknown;
  /** From the employee record, when the query joined it. */
  employee_name?: string | null;
  employee_emp_no?: string | null;
}

const REQUEST_COLS = `id, org_id, employee_id, leave_type_id, from_date,
  to_date, total_days, reason, status, approval_chain, current_approver_id,
  version, created_at, updated_at, debited_days`;

/*
 * The request with the employee's name beside it.
 *
 * A leave request carries only the employee id, and every screen that
 * listed requests printed that id where the person reviewing them wanted a
 * name. One join here is cheaper than a directory fetch per page on every
 * client, and it survives the employee later leaving: the name is read from
 * the record, not from the directory of who can still sign in.
 */
const REQUEST_COLS_R = REQUEST_COLS.split(",").map((c) => `r.${c.trim()}`).join(", ");
const EMPLOYEE_NAME_COLS = `trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name,
  e.emp_no AS employee_emp_no`;
const EMPLOYEE_JOIN = `LEFT JOIN employees e ON e.id = r.employee_id AND e.org_id = r.org_id`;

/** Add the employee's name to a row that came back from an INSERT or UPDATE. */
async function nameEmployee<T extends RequestRow>(
  db: Pick<Pool, "query">,
  row: T,
): Promise<T> {
  const res = await db.query(
    `SELECT trim(concat_ws(' ', first_name, last_name)) AS employee_name, emp_no AS employee_emp_no
     FROM employees WHERE id = $1::uuid AND org_id = $2`,
    [row.employee_id, row.org_id],
  );
  const named = res.rows[0] as { employee_name: string; employee_emp_no: string } | undefined;
  return { ...row, employee_name: named?.employee_name ?? null, employee_emp_no: named?.employee_emp_no ?? null };
}

function chainOf(row: RequestRow): ApprovalChainStep[] {
  return Array.isArray(row.approval_chain)
    ? (row.approval_chain as ApprovalChainStep[])
    : [];
}

/** Bare request shape (POST create / list items). */
function toRequestShape(row: RequestRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    leave_type_id: row.leave_type_id,
    from_date: dateOnly(row.from_date),
    to_date: dateOnly(row.to_date),
    total_days: Number(row.total_days),
    status: row.status,
    current_approver_id: row.current_approver_id,
    version: row.version,
    debited_days: row.debited_days ?? [],
    employee_name: row.employee_name ?? null,
    employee_emp_no: row.employee_emp_no ?? null,
  };
}

/** Detail shape: bare + reason, approval_chain, timestamps. */
function toRequestDetail(row: RequestRow) {
  return {
    ...toRequestShape(row),
    reason: row.reason,
    approval_chain: chainOf(row),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const listQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  mine: z.coerce.string().optional(),
  approver_me: z.coerce.string().optional(),
  employee_id: z.string().uuid().optional(),
});

const balancesQuerySchema = z.object({
  employee_id: z.string().uuid().optional(),
  period_year: z.coerce.number().int().min(2000).max(2100).optional(),
});

interface RequestCursor {
  created_at: string;
  id: string;
}

function isTrueFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export async function registerLeaveRoutes(
  app: FastifyInstance,
  opts: LeaveRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRequest = requirePermission(authenticate, LEAVE_REQUEST);
  const canAdmin = requirePermission(authenticate, LEAVE_ADMIN);

  async function linkedEmployeeId(userId: string): Promise<string | null> {
    const res = await opts.pool.query(
      "SELECT employee_id FROM users WHERE id = $1",
      [userId],
    );
    const row = res.rows[0] as { employee_id: string | null } | undefined;
    return row?.employee_id ?? null;
  }

  async function findType(
    orgId: string,
    id: string,
  ): Promise<LeaveTypeRow | undefined> {
    const res = await opts.pool.query(
      "SELECT * FROM leave_types WHERE id = $1::uuid AND org_id = $2",
      [id, orgId],
    );
    return res.rows[0] as LeaveTypeRow | undefined;
  }

  /**
   * The dates inside [from, to] that a PAID leave request does not debit
   * (D-012, sandwich rule, owner decision 2026-09-24): every Sunday, plus
   * this employee's own effective holiday calendar for the range -- the same
   * scope-precedence resolution payroll uses (`resolveEffectiveHolidays`),
   * restricted to active holiday rows. Called only for `is_paid` types; an
   * unpaid (LOP) request keeps charging every calendar day, so callers pass
   * an empty set instead of calling this at all.
   */
  async function sandwichSkipDates(
    db: Pick<Pool, "query">,
    orgId: string,
    employeeId: string,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const skip = new Set<string>();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (isSundayDate(d)) skip.add(d);
    }
    const empRes = await db.query(
      "SELECT site_id, village_id, mandal_id, district_id FROM employees WHERE id = $1::uuid AND org_id = $2",
      [employeeId, orgId],
    );
    const emp = empRes.rows[0] as
      | { site_id: string | null; village_id: string | null; mandal_id: string | null; district_id: string | null }
      | undefined;
    const holRes = await db.query(
      `SELECT id, date::text AS date, name, type, scope_type, scope_id FROM holidays
       WHERE org_id = $1 AND active = true AND date BETWEEN $2::date AND $3::date`,
      [orgId, from, to],
    );
    const candidates = holRes.rows as HolidayCandidate[];
    const effective = resolveEffectiveHolidays(candidates, [
      emp?.site_id, emp?.village_id, emp?.mandal_id, emp?.district_id,
    ]);
    for (const h of effective) skip.add(h.date);
    return skip;
  }

  async function findRequest(
    orgId: string,
    id: string,
  ): Promise<RequestRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${REQUEST_COLS_R}, ${EMPLOYEE_NAME_COLS} FROM leave_requests r ${EMPLOYEE_JOIN} WHERE r.id = $1::uuid AND r.org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as RequestRow | undefined;
  }

  /** Step-1 candidate: linked user of the requester's `reports_to` manager. */
  async function step1Approver(
    orgId: string,
    requesterEmployeeId: string,
  ): Promise<string | null> {
    const mgr = await opts.pool.query(
      "SELECT reports_to FROM employees WHERE id = $1::uuid AND org_id = $2",
      [requesterEmployeeId, orgId],
    );
    const reportsTo = (mgr.rows[0] as { reports_to: string | null } | undefined)
      ?.reports_to;
    if (!reportsTo) {
      return null;
    }
    const linked = await opts.pool.query(
      `SELECT u.id FROM users u
       WHERE u.employee_id = $1::uuid AND u.org_id = $2 AND u.auth_status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           WHERE ur.user_id = u.id AND rp.permission_code = $3
         )
       LIMIT 1`,
      [reportsTo, orgId, LEAVE_DECIDE],
    );
    return ((linked.rows[0] as { id: string } | undefined)?.id ?? null);
  }

  /** Step-2 candidate: first HR_MANAGER/ADMIN/SUPER_ADMIN user by created_at. */
  async function step2Approver(orgId: string): Promise<string | null> {
    const res = await opts.pool.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.org_id = $1 AND u.auth_status = 'ACTIVE'
         AND r.code IN ('HR_MANAGER', 'ADMIN', 'SUPER_ADMIN')
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT 1`,
      [orgId],
    );
    return ((res.rows[0] as { id: string } | undefined)?.id ?? null);
  }

  // ------------------------------------------------ GET /leave/types
  app.get("/api/v1/leave/types", { preHandler: authenticate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const res = await opts.pool.query(
      "SELECT * FROM leave_types WHERE org_id = $1 ORDER BY code ASC",
      [user.orgId],
    );
    return reply
      .status(200)
      .send({ data: (res.rows as LeaveTypeRow[]).map(toTypeShape) });
  });

  // ------------------------------------------------ GET /leave/balances
  app.get(
    "/api/v1/leave/balances",
    { preHandler: authenticate },
    async (req, reply) => {
      const parsed = balancesQuerySchema.safeParse(req.query);
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
      const year = parsed.data.period_year ?? currentIstYear();
      let targetEmployee: string | null;
      if (parsed.data.employee_id) {
        const empRes = await opts.pool.query(
          "SELECT id FROM employees WHERE id = $1::uuid AND org_id = $2",
          [parsed.data.employee_id, user.orgId],
        );
        if ((empRes.rowCount ?? 0) === 0) {
          return sendError(reply, req.requestId, {
            status: 404,
            code: "NOT_FOUND",
            message: "Employee not found",
          });
        }
        const own = await linkedEmployeeId(user.id);
        if (parsed.data.employee_id !== own && !user.permissions.includes(LEAVE_READ)) {
          return sendError(reply, req.requestId, {
            status: 403,
            code: "FORBIDDEN",
            message:
              `That is somebody else's leave. You can see your own; anybody else's needs the "leave.read" permission.`,
          });
        }
        targetEmployee = parsed.data.employee_id;
      } else {
        targetEmployee = await linkedEmployeeId(user.id);
        if (!targetEmployee) {
          return reply.status(200).send({ data: [] });
        }
      }
      const res = await opts.pool.query(
        `SELECT ${BALANCE_COLS} FROM leave_balances b
         JOIN leave_types t ON t.id = b.leave_type_id
         JOIN employees e ON e.id = b.employee_id
         WHERE b.employee_id = $1::uuid AND b.period_year = $2 AND e.org_id = $3
         ORDER BY t.code ASC`,
        [targetEmployee, year, user.orgId],
      );
      return reply
        .status(200)
        .send({ data: (res.rows as BalanceRow[]).map(toBalanceShape) });
    },
  );

  // ------------------------------------------------ POST /leave/balances
  app.post("/api/v1/leave/balances", { preHandler: canAdmin }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = leaveBalanceUpsertSchema.safeParse(req.body);
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
    const empRes = await db.query(
      "SELECT id FROM employees WHERE id = $1::uuid AND org_id = $2",
      [d.employee_id, user.orgId],
    );
    if ((empRes.rowCount ?? 0) === 0) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Employee not found",
      });
    }
    const type = await findType(user.orgId, d.leave_type_id);
    if (!type) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Leave type not found",
      });
    }
    const ins = await db.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, period_year, opening_balance)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       ON CONFLICT (employee_id, leave_type_id, period_year) DO NOTHING
       RETURNING id`,
      [d.employee_id, d.leave_type_id, d.period_year, d.opening_balance],
    );
    const created = (ins.rowCount ?? 0) > 0;
    if (!created) {
      await db.query(
        `UPDATE leave_balances SET opening_balance = $4, updated_at = NOW()
         WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3`,
        [d.employee_id, d.leave_type_id, d.period_year, d.opening_balance],
      );
    }
    const row = (
      await db.query(
        `SELECT ${BALANCE_COLS} FROM leave_balances b
         JOIN leave_types t ON t.id = b.leave_type_id
         WHERE b.employee_id = $1::uuid AND b.leave_type_id = $2::uuid AND b.period_year = $3`,
        [d.employee_id, d.leave_type_id, d.period_year],
      )
    ).rows[0] as BalanceRow;
    const body = toBalanceShape(row);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: "leave.balance.upsert",
      entityType: "leave_balance",
      entityId: row.id,
      afterState: body,
      requestId: req.requestId,
    });
    return reply.status(created ? 201 : 200).send(body);

});});

  // ------------------------------------------------ POST /leave-balances/open-year
  //
  // R5-008: bulk-opens next year's leave balances so a request that crosses
  // into a not-yet-opened year does not 422 for lack of a row. Owner
  // decision (2026-09-24): carry-forward is out of scope -- every row opens
  // at the leave type's plain annual_entitlement, with nothing brought over
  // from the year before. Unused balance simply lapses; there is no
  // carry-forward or expiry rule to apply, because the leave-type schema
  // does not define one. If the owner later wants unused CL/SL/EL to roll
  // into the new year, that needs its own explicit field and its own change
  // -- this endpoint must not silently start carrying balances forward.
  const openYearQuerySchema = z.object({ dry_run: z.string().optional() });

  app.post(
    "/api/v1/leave-balances/open-year",
    { preHandler: canAdmin },
    async (req, reply) => {
      return mutationRoute(opts.pool, req, reply, async (db, reply) => {
        const parsedQuery = openYearQuerySchema.safeParse(req.query);
        if (!parsedQuery.success) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            fieldErrors: toFieldErrors(parsedQuery.error),
          });
        }
        const dryRun = isTrueFlag(parsedQuery.data.dry_run);
        const parsed = leaveOpenYearSchema.safeParse(req.body ?? {});
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
        // Fix round 1, item 5: the org's own timezone, not the fixed IST
        // this file otherwise uses for the backdating rule.
        const thisYear = await currentOrgYear(db, user.orgId);
        // Fix round 1, item 5: `year` is optional -- default to next year
        // (the common case) rather than making every caller compute it.
        const targetYear = d.year ?? thisYear + 1;
        if (targetYear !== thisYear && targetYear !== thisYear + 1) {
          return sendRuleError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: `year must be the current (${thisYear}) or next (${thisYear + 1}) year`,
            fieldErrors: [
              { field: "year", message: `must be ${thisYear} or ${thisYear + 1}` },
            ],
          });
        }

        const values: unknown[] = [user.orgId, targetYear];
        let empFilter = "";
        if (d.employee_ids?.length) {
          values.push(d.employee_ids);
          empFilter = ` AND e.id = ANY($${values.length}::uuid[])`;
        }
        let typeFilter = "";
        if (d.leave_type_ids?.length) {
          values.push(d.leave_type_ids);
          typeFilter = ` AND t.id = ANY($${values.length}::uuid[])`;
        }

        // Every (active employee) x (balance-requiring leave type) pair in
        // scope, left-joined to that year's row if one exists -- computed
        // once so dry-run and the real write agree on the same counts.
        const pairsRes = await db.query(
          `SELECT e.id AS employee_id, t.id AS leave_type_id, t.annual_entitlement,
                  b.id AS balance_id, b.opening_balance, b.credits, b.consumed, b.adjustments
           FROM employees e
           CROSS JOIN leave_types t
           LEFT JOIN leave_balances b
             ON b.employee_id = e.id AND b.leave_type_id = t.id AND b.period_year = $2
           WHERE e.org_id = $1 AND e.status = 'ACTIVE'
             AND t.org_id = $1 AND t.active = true AND t.requires_balance = true
             ${empFilter}${typeFilter}`,
          values,
        );
        type Pair = {
          employee_id: string;
          leave_type_id: string;
          annual_entitlement: string | number;
          balance_id: string | null;
          opening_balance: string | number | null;
          credits: string | number | null;
          consumed: string | number | null;
          adjustments: string | number | null;
        };
        const rows = pairsRes.rows as Pair[];

        /*
         * Fix round 1, item 1: filing self-heals a `leave_balances` row for
         * any year a request touches, even a year the sandwich rule leaves
         * it 0 days in -- an empty row indistinguishable, to a plain
         * existence check, from one this action already opened. Left
         * alone, that employee starts the year with nothing.
         *
         * "Empty and never actually opened" = every ledger term at 0 AND no
         * `leave.balance.upsert` audit entry for that row -- an admin who
         * deliberately set the opening balance to 0 gets the same all-zero
         * row, and that one must not be silently overwritten. The audit
         * trail is the only way to tell the two apart.
         */
        const isEmptyRow = (r: Pair): boolean =>
          r.balance_id !== null &&
          Number(r.opening_balance) === 0 &&
          Number(r.credits) === 0 &&
          Number(r.consumed) === 0 &&
          Number(r.adjustments) === 0;

        const toCreate = rows.filter((r) => r.balance_id === null);
        const emptyRows = rows.filter(isEmptyRow);
        let manuallyTouched = new Set<string>();
        if (emptyRows.length) {
          const auditRes = await db.query(
            `SELECT DISTINCT entity_id FROM audit_events
             WHERE entity_type = 'leave_balance' AND action = 'leave.balance.upsert'
               AND entity_id = ANY($1::uuid[])`,
            [emptyRows.map((r) => r.balance_id as string)],
          );
          manuallyTouched = new Set(
            (auditRes.rows as Array<{ entity_id: string }>).map((r) => r.entity_id),
          );
        }
        const toFill = emptyRows.filter((r) => !manuallyTouched.has(r.balance_id as string));
        const toFillIds = new Set(toFill.map((r) => r.balance_id));
        const toSkip = rows.filter((r) => r.balance_id !== null && !toFillIds.has(r.balance_id));

        if (dryRun) {
          return reply.status(200).send({
            data: {
              year: targetYear,
              created: toCreate.length,
              filled: toFill.length,
              skipped: toSkip.length,
              total: rows.length,
              dry_run: true,
            },
          });
        }

        let created = 0;
        for (const r of toCreate) {
          const ins = await db.query(
            `INSERT INTO leave_balances (employee_id, leave_type_id, period_year, opening_balance)
             VALUES ($1::uuid, $2::uuid, $3, $4)
             ON CONFLICT (employee_id, leave_type_id, period_year) DO NOTHING
             RETURNING id`,
            [r.employee_id, r.leave_type_id, targetYear, r.annual_entitlement],
          );
          if ((ins.rowCount ?? 0) > 0) created += 1;
        }
        let filled = 0;
        for (const r of toFill) {
          // Re-checked in the WHERE, not just the SELECT above: still empty
          // right now, under this same transaction.
          const upd = await db.query(
            `UPDATE leave_balances SET opening_balance = $2, updated_at = NOW()
             WHERE id = $1::uuid AND opening_balance = 0 AND credits = 0
               AND consumed = 0 AND adjustments = 0`,
            [r.balance_id, r.annual_entitlement],
          );
          if ((upd.rowCount ?? 0) > 0) {
            filled += 1;
            await writeAudit(db, {
              orgId: user.orgId,
              actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
              actorIp: req.ip,
              actorUserAgent:
                typeof req.headers["user-agent"] === "string"
                  ? (req.headers["user-agent"] as string)
                  : null,
              action: "leave.balance.open_year_fill",
              entityType: "leave_balance",
              entityId: r.balance_id,
              afterState: { opening_balance: Number(r.annual_entitlement), year: targetYear },
              requestId: req.requestId,
            });
          }
        }
        const skipped = rows.length - created - filled;
        const body = { year: targetYear, created, filled, skipped, total: rows.length, dry_run: false };
        await writeAudit(db, {
          orgId: user.orgId,
          actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
          actorIp: req.ip,
          actorUserAgent:
            typeof req.headers["user-agent"] === "string"
              ? (req.headers["user-agent"] as string)
              : null,
          action: "leave.balance.open_year",
          entityType: "leave_balance",
          entityId: null,
          afterState: body,
          requestId: req.requestId,
        });
        return reply.status(200).send({ data: body });
      });
    },
  );

  // ------------------------------------------------ GET /leave/preview
  //
  // Fix round 1, item 2: the web/mobile "N days" preview shown before
  // filing used to be a client-side calendar-day count, which is wrong for
  // paid leave under the sandwich rule (D-012) -- a request could show
  // "4 days" and file for 3, or 0. This returns exactly what filing would
  // charge, using filing's own day-counting function (`daysByYear` +
  // `sandwichSkipDates`) so the two can never disagree, for the employee's
  // own effective holiday scope.
  const leavePreviewQuerySchema = z.object({
    leave_type_id: z.string().uuid("leave_type_id must be a UUID"),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from_date must be YYYY-MM-DD"),
    to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to_date must be YYYY-MM-DD"),
    employee_id: z.string().uuid().optional(),
  });

  app.get("/api/v1/leave/preview", { preHandler: canRequest }, async (req, reply) => {
    const parsed = leavePreviewQuerySchema.safeParse(req.query);
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
    const q = parsed.data;
    if (q.to_date < q.from_date) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "DATE_RANGE",
        message: "to_date must be on or after from_date",
        fieldErrors: [{ field: "to_date", message: "to_date must be on or after from_date" }],
      });
    }
    const own = await linkedEmployeeId(user.id);
    let employeeId: string;
    if (q.employee_id && q.employee_id !== own) {
      if (!user.permissions.includes(LEAVE_ADMIN)) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message:
            `Previewing somebody else's leave needs the "leave.admin" permission. Leave employee_id out to preview your own.`,
        });
      }
      employeeId = q.employee_id;
    } else if (own) {
      employeeId = own;
    } else {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "No employee record is linked to this account",
      });
    }
    const type = await findType(user.orgId, q.leave_type_id);
    if (!type) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Leave type not found",
      });
    }
    const skipDates = type.is_paid
      ? await sandwichSkipDates(opts.pool, user.orgId, employeeId, q.from_date, q.to_date)
      : new Set<string>();
    const years = daysByYear(q.from_date, q.to_date, skipDates);
    const totalDays = years.reduce((sum, y) => sum + y.days, 0);
    return reply.status(200).send({
      data: {
        leave_type_id: type.id,
        is_paid: type.is_paid,
        from_date: q.from_date,
        to_date: q.to_date,
        total_days: totalDays,
        years: years.map((y) => ({ year: y.year, days: y.days })),
      },
    });
  });

  // ------------------------------------------------ POST /leave/requests
  app.post("/api/v1/leave/requests", { preHandler: canRequest }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const idemKey = idemUuidOr422(req, reply, req.requestId);
    if (!idemKey) {
      return;
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const path = req.url.split("?")[0] ?? "/api/v1/leave/requests";

    // Duplicate key → 200 replay of the original request (no side effects).
    const seen = await db.query(
      `SELECT response_body FROM idempotency_keys
       WHERE key = $1 AND method = 'POST' AND path = $2 AND user_id=$3`,
      [idemKey, path, user.id],
    );
    const seenRow = seen.rows[0] as { response_body: unknown } | undefined;
    if (seenRow) {
      return reply.status(200).send({ applied: true, request: seenRow.response_body });
    }

    const parsed = leaveRequestCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const d = parsed.data;

    // Resolve the employee: own linked employee, unless leave.admin files
    // for someone else via the additive employee_id field.
    const ownEmployee = await linkedEmployeeId(user.id);
    let employeeId: string;
    if (d.employee_id && d.employee_id !== ownEmployee) {
      if (!user.permissions.includes(LEAVE_ADMIN)) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message:
            `Filing leave for somebody else needs the "leave.admin" permission, which is held by HR. Leave employee_id out to file your own.`,
        });
      }
      const other = await db.query(
        "SELECT id FROM employees WHERE id = $1::uuid AND org_id = $2",
        [d.employee_id, user.orgId],
      );
      if ((other.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      employeeId = d.employee_id;
    } else if (ownEmployee) {
      employeeId = d.employee_id ?? ownEmployee;
      const check = await db.query(
        "SELECT id FROM employees WHERE id = $1::uuid AND org_id = $2",
        [employeeId, user.orgId],
      );
      if ((check.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
    } else {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "No employee linked to this user",
      });
    }

    /*
     * Leave is taken from employment, so the person has to be employed. A
     * request filed on behalf of somebody who had left was answered with
     * "insufficient balance", which sent HR to top up a balance for a person
     * who no longer had one to keep.
     *
     * Locked (D-002): the overlap and balance rules below read, then insert.
     * Two requests for the same days filed at the same moment each saw the
     * other as not there yet, and both stood. Holding the employee row makes
     * the second wait, then find the first. NO KEY UPDATE, not UPDATE: it
     * still serialises two filings, but does not block the attendance and
     * other rows whose foreign keys point at this employee.
     */
    const employment = (
      await db.query("SELECT status FROM employees WHERE id = $1::uuid AND org_id = $2 FOR NO KEY UPDATE", [employeeId, user.orgId])
    ).rows[0] as { status: string } | undefined;
    if (employment && employment.status !== "ACTIVE") {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "EMPLOYEE_INACTIVE",
        message: `Leave cannot be filed for an employee whose status is ${employment.status}`,
        fieldErrors: [{ field: "employee_id", message: `Employee is ${employment.status}, not ACTIVE` }],
      });
    }

    // Rule 1: from <= to.
    if (d.from_date > d.to_date) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "DATE_RANGE",
        message: "from_date must be on or before to_date",
        fieldErrors: [
          { field: "to_date", message: "to_date must be on or after from_date" },
        ],
      });
    }

    // Rule 2: past from_date requires a reason.
    const reason = d.reason?.trim() ? d.reason.trim() : null;
    if (d.from_date < todayIst() && !reason) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "REASON_REQUIRED",
        message: "A reason is required when backdating leave",
        fieldErrors: [
          { field: "reason", message: "Reason is required for past dates" },
        ],
      });
    }

    const type = await findType(user.orgId, d.leave_type_id);
    if (!type) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Leave type not found",
      });
    }
    // D-012 sandwich rule: a paid request does not debit its Sundays/effective
    // holidays; an unpaid (LOP) one keeps charging every calendar day.
    const skipDates = type.is_paid
      ? await sandwichSkipDates(db, user.orgId, employeeId, d.from_date, d.to_date)
      : new Set<string>();
    // Rule 3: balance check for paid types that require a balance, once per
    // leave year the request touches, for that year's days only (D-011).
    const years = daysByYear(d.from_date, d.to_date, skipDates);
    const totalDays = years.reduce((sum, y) => sum + y.days, 0);
    // Fix round 1, item 4: a paid range that the sandwich rule reduces to
    // zero days (every day in it a Sunday or a holiday) is refused outright,
    // rather than filed as a 0-day PENDING request nobody asked for.
    if (type.is_paid && totalDays === 0) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "ALL_DAYS_EXCLUDED",
        message:
          "Every day in this range is a Sunday or a holiday; there is nothing to charge",
      });
    }
    if (type.requires_balance) for (const { year: periodYear, days } of years) {
      // Fix round 1, item 1: a year this request touches for zero days (the
      // sandwich rule ate all of it) gets no balance check and, critically,
      // no self-healed row -- an empty `leave_balances` row for a year the
      // employee was never actually charged in is indistinguishable from one
      // open-year already opened, and open-year would then skip it forever.
      if (days === 0) continue;
      const inYear = years.length > 1 ? ` in ${periodYear}` : "";
      await db.query(
        `INSERT INTO leave_balances (employee_id, leave_type_id, period_year)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (employee_id, leave_type_id, period_year) DO NOTHING`,
        [employeeId, type.id, periodYear],
      );
      const balRes = await db.query(
        `SELECT (opening_balance + credits - consumed + adjustments) AS available
         FROM leave_balances
         WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3`,
        [employeeId, type.id, periodYear],
      );
      const available = Number(
        (balRes.rows[0] as { available: string | number }).available,
      );
      if (days > available) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "INSUFFICIENT_BALANCE",
          message: `Insufficient leave balance${inYear} (available: ${available}, requested: ${days})`,
          fieldErrors: [
            {
              field: "to_date",
              message: `Requested ${days} days${inYear} but only ${available} available`,
            },
          ],
          extra: { available, period_year: periodYear },
        });
      }
    }

    // Rule 4: no overlap with own PENDING/APPROVED requests.
    const overlap = await db.query(
      `SELECT id FROM leave_requests
       WHERE employee_id = $1::uuid
         AND status IN ('PENDING', 'APPROVED')
         AND from_date <= $2::date AND to_date >= $3::date
       ORDER BY created_at ASC, id ASC`,
      [employeeId, d.to_date, d.from_date],
    );
    if ((overlap.rowCount ?? 0) > 0) {
      const ids = (overlap.rows as Array<{ id: string }>).map((r) => r.id);
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "LEAVE_OVERLAP",
        message: "Leave dates overlap with an existing pending or approved request",
        fieldErrors: [
          { field: "from_date", message: "Overlaps with an existing leave request" },
        ],
        extra: { conflicting_request_ids: ids },
      });
    }

    // Rule 5: no overlap with own attendance records (regularize first).
    const att = await db.query(
      `SELECT work_date FROM attendance_records
       WHERE employee_id = $1::uuid AND work_date BETWEEN $2::date AND $3::date
       ORDER BY work_date ASC`,
      [employeeId, d.from_date, d.to_date],
    );
    if ((att.rowCount ?? 0) > 0) {
      const dates = (att.rows as Array<{ work_date: Date | string }>).map((r) =>
        dateOnly(r.work_date),
      );
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "ATTENDANCE_CONFLICT",
        message:
          "Leave dates conflict with attendance records; regularize attendance first",
        fieldErrors: [
          { field: "from_date", message: "Conflicts with recorded attendance" },
        ],
        extra: { conflicting_dates: dates },
      });
    }

    // Approval chain: TL/manager step, then HR/admin step.
    // Self-approval is about the requesting EMPLOYEE, not the acting user:
    // resolve the employee's own login (null when they have none) so the
    // skip only fires on true self-approval — on-behalf filing by an
    // HR/admin fallback approver must not resolve to NO_APPROVER.
    const requesterLink = await db.query(
      `SELECT id FROM users WHERE employee_id = $1::uuid AND org_id = $2 LIMIT 1`,
      [employeeId, user.orgId],
    );
    const requesterUserId =
      (requesterLink.rows[0] as { id: string } | undefined)?.id ?? null;
    const chain = assembleApprovalChain({
      requesterUserId,
      step1UserId: await step1Approver(user.orgId, employeeId),
      step2UserId: await step2Approver(user.orgId),
    });
    if (!chain) {
      return sendRuleError(reply, req.requestId, {
        status: 422,
        code: "NO_APPROVER",
        message: "No approver found for this leave request",
      });
    }
    const currentApprover = chain[0]?.approver_user_id ?? null;

    const ins = await db.query(
      `INSERT INTO leave_requests
         (org_id, employee_id, leave_type_id, from_date, to_date, total_days,
          reason, status, approval_chain, current_approver_id)
       VALUES ($1, $2, $3::uuid, $4::date, $5::date, $6, $7, 'PENDING', $8, $9::uuid)
       RETURNING ${REQUEST_COLS}`,
      [
        user.orgId,
        employeeId,
        type.id,
        d.from_date,
        d.to_date,
        totalDays,
        reason,
        JSON.stringify(chain),
        currentApprover,
      ],
    );
    const row = ins.rows[0] as RequestRow;
    const body = toRequestShape(await nameEmployee(db, row));
    try {
      await db.query(
        `INSERT INTO idempotency_keys (key, user_id, method, path, status_code, response_body)
         VALUES ($1, $2::uuid, 'POST', $3, 201, $4)
         ON CONFLICT (user_id,key) DO NOTHING`,
        [idemKey, user.id, path, JSON.stringify(body)],
      );
    } catch (err) {
      throw err;
    }
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: "leave.request.create",
      entityType: "leave_request",
      entityId: row.id,
      afterState: body,
      requestId: req.requestId,
      idempotencyKey: idemKey,
    });
    return reply.status(201).send(body);
  
});});

  // ------------------------------------------------ GET /leave/requests
  app.get("/api/v1/leave/requests", { preHandler: authenticate }, async (req, reply) => {
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
    user.scopes=await scopesForPermission(req,user.permissions.includes(LEAVE_READ)?LEAVE_READ:LEAVE_REQUEST);
    const q = parsed.data;
    if (q.employee_id && !user.permissions.includes(LEAVE_READ)) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `Filtering by another employee needs the "leave.read" permission. Leave the employee filter empty to see your own leave.`,
      });
    }
    const own = await linkedEmployeeId(user.id);
    const values: unknown[] = [user.orgId];
    const clauses = ["r.org_id = $1"];
    clauses.push(await employeeRestriction(opts.pool,user,values,"r.employee_id"));

    if (q.employee_id) {
      values.push(q.employee_id);
      clauses.push(`r.employee_id = $${values.length}::uuid`);
    } else if (isTrueFlag(q.mine)) {
      if (!own) {
        return reply
          .status(200)
          .send({ data: [], next_cursor: null, has_more: false });
      }
      values.push(own);
      clauses.push(`r.employee_id = $${values.length}::uuid`);
    } else if (!isTrueFlag(q.approver_me)) {
      // Default scope: own + (approver queue when the caller can decide).
      if (user.permissions.includes(LEAVE_DECIDE)) {
        if (own) {
          values.push(own, user.id);
          clauses.push(
            `(r.employee_id = $${values.length - 1}::uuid OR r.current_approver_id = $${values.length}::uuid)`,
          );
        } else {
          values.push(user.id);
          clauses.push(`r.current_approver_id = $${values.length}::uuid`);
        }
      } else if (own) {
        values.push(own);
        clauses.push(`r.employee_id = $${values.length}::uuid`);
      } else {
        return reply
          .status(200)
          .send({ data: [], next_cursor: null, has_more: false });
      }
    }
    if (isTrueFlag(q.approver_me)) {
      values.push(user.id);
      clauses.push(`r.current_approver_id = $${values.length}::uuid`);
    }
    if (q.status) {
      values.push(q.status);
      clauses.push(`r.status = $${values.length}`);
    }
    if (q.cursor) {
      const decoded = decodeCursor<RequestCursor>(q.cursor);
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
        `(r.created_at, r.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(q.limit + 1);
    const res = await opts.pool.query(
      `SELECT ${REQUEST_COLS_R}, ${EMPLOYEE_NAME_COLS}
       FROM leave_requests r ${EMPLOYEE_JOIN}
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const rows = res.rows as RequestRow[];
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toRequestShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
          : null,
      has_more: hasMore,
    });
  });

  // ------------------------------------------------ GET /leave/requests/:id
  app.get(
    "/api/v1/leave/requests/:id",
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
      const { id } = req.params as { id: string };
      const row = await findRequest(user.orgId, id);
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Leave request not found",
        });
      }
      const own = await linkedEmployeeId(user.id);
      const canSee =
        row.employee_id === own ||
        user.permissions.includes(LEAVE_READ) ||
        user.permissions.includes(LEAVE_DECIDE);
      if (!canSee) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message:
            "That leave request is not yours and you are not its approver, so you cannot see it.",
        });
      }
      if(row.employee_id!==own){user.scopes=await scopesForPermission(req,user.permissions.includes(LEAVE_READ)?LEAVE_READ:LEAVE_DECIDE);await employeeAccess(opts.pool,req,row.employee_id);}
      return reply.status(200).send(toRequestDetail(row));
    },
  );

  /**
   * Why an approval cannot go through now, or null when it can.
   *
   * Both checks were made only when the request was filed, and a request can
   * sit pending for weeks while the facts move under it:
   *
   *   - Attendance. The person may have worked one of the days after all. A
   *     day that is both attended and on approved leave is paid twice, so
   *     the conflict is refused here exactly as it is at filing, naming the
   *     dates so the approver knows what to regularize.
   *   - Balance. Two pending requests can each fit the balance on their own
   *     and overdraw it together. The balance row is locked for the rest of
   *     the transaction, so two approvals racing for the last days queue
   *     behind each other instead of both reading the same figure. Checked
   *     on the step that debits, which is the last one.
   */
  async function approvalBlocker(
    client: import("pg").PoolClient,
    cur: RequestRow,
  ): Promise<{ status: number; code: string; message: string; extra?: Record<string, unknown> } | null> {
    const from = dateOnly(cur.from_date);
    const to = dateOnly(cur.to_date);
    const att = await client.query(
      `SELECT work_date FROM attendance_records
        WHERE employee_id = $1::uuid AND work_date BETWEEN $2::date AND $3::date
        ORDER BY work_date ASC`,
      [cur.employee_id, from, to],
    );
    if ((att.rowCount ?? 0) > 0) {
      const dates = (att.rows as Array<{ work_date: Date | string }>).map((r) => dateOnly(r.work_date));
      return {
        status: 422,
        code: "ATTENDANCE_CONFLICT",
        message: `Attendance is already recorded on ${dates.join(", ")}; regularize attendance or change the leave dates before approving`,
        extra: { conflicting_dates: dates },
      };
    }
    const chain = chainOf(cur);
    const lastStep = chain.filter((s) => s.status === "PENDING").length <= 1;
    if (!lastStep) return null;
    const type = (
      await client.query("SELECT is_paid, requires_balance FROM leave_types WHERE id = $1::uuid", [
        cur.leave_type_id,
      ])
    ).rows[0] as { is_paid: boolean; requires_balance: boolean } | undefined;
    if (!type?.requires_balance) return null;
    // D-012 sandwich rule, same as at filing.
    const skipDates = type.is_paid
      ? await sandwichSkipDates(client, cur.org_id, cur.employee_id, from, to)
      : new Set<string>();
    // Each leave year the request touches is checked for its own days (D-011).
    for (const { year, days } of daysByYear(from, to, skipDates)) {
      // Fix round 1, item 1: nothing to check, and no row to touch, for a
      // year this request costs zero days in (holidays may have moved
      // between filing and this approval -- recomputed fresh above).
      if (days === 0) continue;
      const bal = await client.query(
        `SELECT (opening_balance + credits - consumed + adjustments) AS available
           FROM leave_balances
          WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3
          FOR UPDATE`,
        [cur.employee_id, cur.leave_type_id, year],
      );
      const available = Number((bal.rows[0] as { available: string | number } | undefined)?.available ?? 0);
      if (days > available) {
        return {
          status: 422,
          code: "INSUFFICIENT_BALANCE",
          message: `Insufficient ${year} leave balance to approve (available: ${available}, requested: ${days}). Another request has used the balance since this one was filed.`,
          extra: { available, period_year: year },
        };
      }
    }
    return null;
  }

  // ------------------------------------------------ POST /leave/requests/:id/decision
  app.post(
    "/api/v1/leave/requests/:id/decision",
    { preHandler: authenticate },
    async (req, reply) => {
      const parsed = leaveDecisionSchema.safeParse(req.body);
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
      user.scopes=await scopesForPermission(req,LEAVE_DECIDE);
      if(!user.permissions.includes(LEAVE_DECIDE))return sendError(reply,req.requestId,{status:403,code:'FORBIDDEN',message:'Insufficient permissions'});
      const expectedVersion = parseIfMatch(req);
      const { id } = req.params as { id: string };
      const scopedRequest=await findRequest(user.orgId,id);if(scopedRequest)await employeeAccess(opts.pool,req,scopedRequest.employee_id);
      const { decision, note } = parsed.data;
      const trimmedNote = note?.trim() ? note.trim() : null;

      const client = await opts.pool.connect();
      let finalRow: RequestRow | undefined;
      let failure: {
        status: number;
        code: string;
        message: string;
        extra?: Record<string, unknown>;
      } | null = null;
      try {
        await client.query("BEGIN");
        const curRes = await client.query(
          `SELECT ${REQUEST_COLS} FROM leave_requests WHERE id = $1::uuid AND org_id = $2 FOR UPDATE`,
          [id, user.orgId],
        );
        const cur = curRes.rows[0] as RequestRow | undefined;
        if (!cur) {
          failure = { status: 404, code: "NOT_FOUND", message: "Leave request not found" };
        } else if (cur.status !== "PENDING") {
          failure = {
            status: 422,
            code: "REQUEST_CLOSED",
            message: `Leave request has already been ${cur.status.toLowerCase()}`,
          };
        } else if (cur.current_approver_id !== user.id) {
          failure = {
            status: 403,
            code: "NOT_APPROVER",
            message: "Only the current approver can decide this request",
          };
        } else if (cur.version !== expectedVersion) {
          failure = {
            status: 409,
            code: "VERSION_CONFLICT",
            message: `Version mismatch (current version: ${cur.version})`,
          };
        } else if (decision === "REJECT" && !trimmedNote) {
          failure = {
            status: 422,
            code: "NOTE_REQUIRED",
            message: "A note is required when rejecting a leave request",
          };
        } else if (decision === "APPROVE" && (failure = await approvalBlocker(client, cur))) {
          // Refused before anything is written; the reason is in `failure`.
        } else {
          const chain = chainOf(cur);
          const nowIso = new Date().toISOString();
          const idx = chain.findIndex(
            (s) => s.approver_user_id === user.id && s.status === "PENDING",
          );
          const target = idx >= 0 ? idx : chain.findIndex((s) => s.status === "PENDING");
          if (target >= 0 && chain[target]) {
            chain[target] = {
              step: chain[target].step,
              approver_user_id: chain[target].approver_user_id,
              status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
              decided_at: nowIso,
              note: trimmedNote,
            };
          }
          let nextStatus = "PENDING";
          let nextApprover: string | null = cur.current_approver_id;
          if (decision === "REJECT") {
            nextStatus = "REJECTED";
          } else {
            const pending = chain.find((s) => s.status === "PENDING");
            if (pending) {
              nextApprover = pending.approver_user_id;
            } else {
              nextStatus = "APPROVED";
              nextApprover = null;
            }
          }

          /*
           * Fix round 1, item 3: total_days is one source of truth, not two
           * that can drift. It was computed at filing under whatever
           * holidays existed that day; final approval can happen weeks
           * later, after a holiday was added or withdrawn in between, so
           * the debit approvalBlocker just re-validated against (and is
           * about to post below) can differ from the total_days stored at
           * filing. On the step that finally approves, recompute the split
           * fresh -- same as approvalBlocker just did -- and persist it as
           * total_days/debited_days on the request itself, in the same
           * UPDATE as the status change. Every reader (list, detail, web,
           * mobile) then shows the figure that was actually charged.
           */
          let newTotalDays: number = cur.total_days;
          let newDebitedDays: Array<{ year: number; days: number }> =
            Array.isArray(cur.debited_days) ? (cur.debited_days as Array<{ year: number; days: number }>) : [];
          let debitYears: Array<{ year: number; days: number }> = [];
          let typeForDebit: { is_paid: boolean; requires_balance: boolean } | undefined;
          if (nextStatus === "APPROVED") {
            const type = await client.query(
              "SELECT is_paid, requires_balance FROM leave_types WHERE id = $1::uuid",
              [cur.leave_type_id],
            );
            typeForDebit = type.rows[0] as
              | { is_paid: boolean; requires_balance: boolean }
              | undefined;
            const from = dateOnly(cur.from_date), to = dateOnly(cur.to_date);
            const skipDates = typeForDebit?.is_paid
              ? await sandwichSkipDates(client, cur.org_id, cur.employee_id, from, to)
              : new Set<string>();
            debitYears = daysByYear(from, to, skipDates);
            newTotalDays = debitYears.reduce((sum, y) => sum + y.days, 0);
            // debited_days reflects what actually posts to a balance below;
            // a type that doesn't track one debits nothing to record.
            newDebitedDays = typeForDebit?.requires_balance
              ? debitYears.filter((y) => y.days > 0).map((y) => ({ year: y.year, days: y.days }))
              : [];
          }

          const upd = await client.query(
            `UPDATE leave_requests SET
               status = $2, approval_chain = $3, current_approver_id = $4::uuid,
               total_days = $6, debited_days = $7::jsonb,
               updated_at = NOW(), version = version + 1
             WHERE id = $1::uuid AND version = $5
             RETURNING ${REQUEST_COLS}`,
            [id, nextStatus, JSON.stringify(chain), nextApprover, expectedVersion, newTotalDays, JSON.stringify(newDebitedDays)],
          );
          finalRow = upd.rows[0] as RequestRow | undefined;
          if (!finalRow) {
            failure = {
              status: 409,
              code: "VERSION_CONFLICT",
              message: "Version mismatch (concurrent update)",
            };
          } else if (nextStatus === "APPROVED") {
            // Atomic ledger debit for paid types that track a balance
            // (LOP skips the debit). Same transaction as the approval, and
            // the same `debitYears` split just persisted above -- one
            // computation, not two that could disagree with each other.
            if (typeForDebit?.requires_balance) {
              for (const { year, days } of debitYears) {
                // Fix round 1, item 1: no row, no debit, for a year this
                // request costs zero days in.
                if (days === 0) continue;
                await client.query(
                  `INSERT INTO leave_balances
                     (employee_id, leave_type_id, period_year, consumed)
                   VALUES ($1::uuid, $2::uuid, $3, $4)
                   ON CONFLICT (employee_id, leave_type_id, period_year)
                   DO UPDATE SET consumed = leave_balances.consumed + EXCLUDED.consumed,
                                 updated_at = NOW()`,
                  [cur.employee_id, cur.leave_type_id, year, days],
                );
              }
            }
          }
        }
        if (failure) {
          await client.query("ROLLBACK");
        } else {
          await client.query("COMMIT");
        }
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
        client.release();
        throw err;
      }
      client.release();

      if (failure || !finalRow) {
        const f = failure ?? {
          status: 500,
          code: "INTERNAL_ERROR",
          message: "Decision failed",
        };
        if ("extra" in f && f.extra) {
          return sendRuleError(reply, req.requestId, {
            status: f.status,
            code: f.code,
            message: f.message,
            extra: f.extra,
          });
        }
        return sendError(reply, req.requestId, {
          status: f.status,
          code: f.code,
          message: f.message,
        });
      }
      const body = toRequestDetail(await nameEmployee(opts.pool, finalRow));
      // S5 inbox (best-effort, after commit): LEAVE_DECIDED to the
      // requester's linked user, on final decisions only. Dates + outcome
      // only — never PII.
      if (finalRow.status === "APPROVED" || finalRow.status === "REJECTED") {
        try {
          const linkRes = await opts.pool.query(
            `SELECT id FROM users WHERE employee_id = $1::uuid AND org_id = $2 LIMIT 1`,
            [finalRow.employee_id, user.orgId],
          );
          const requester = linkRes.rows[0] as { id: string } | undefined;
          if (requester) {
            const outcome =
              finalRow.status === "APPROVED" ? "approved" : "rejected";
            await emitNotification(opts.pool, {
              orgId: user.orgId,
              recipientId: requester.id,
              type: "LEAVE_DECIDED",
              title: "Leave request decided",
              body: `Your leave request ${dateOnly(finalRow.from_date)} to ${dateOnly(finalRow.to_date)} was ${outcome}`,
              entityType: "leave_request",
              entityId: finalRow.id,
            });
          }
        } catch (err) {
          console.error("leave notification failed", err);
        }
      }
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "leave.request.decide",
        entityType: "leave_request",
        entityId: finalRow.id,
        afterState: body,
        reason: trimmedNote,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    },
  );

  // ------------------------------------------------ POST /leave/requests/:id/cancel
  app.post(
    "/api/v1/leave/requests/:id/cancel",
    { preHandler: authenticate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = leaveCancelSchema.safeParse(req.body ?? {});
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
      const cur = await findRequest(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Leave request not found",
        });
      }
      const own = await linkedEmployeeId(user.id);
      const isOwner = own !== null && cur.employee_id === own;
      if(!isOwner&&user.permissions.includes(LEAVE_ADMIN)){user.scopes=await scopesForPermission(req,LEAVE_ADMIN);await employeeAccess(opts.pool,req,cur.employee_id);}
      if (!isOwner && !user.permissions.includes(LEAVE_ADMIN)) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "FORBIDDEN",
          message:
            `That leave request belongs to somebody else. Cancelling it needs the "leave.admin" permission, which is held by HR.`,
        });
      }
      if (cur.status !== "PENDING") {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "REQUEST_CLOSED",
          message:
            "Only PENDING requests can be cancelled (approved requests use the correction flow)",
        });
      }
      const upd = await db.query(
        `UPDATE leave_requests SET status = 'CANCELLED', updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2 AND status = 'PENDING'
         RETURNING ${REQUEST_COLS}`,
        [id, user.orgId],
      );
      const row = upd.rows[0] as RequestRow | undefined;
      if (!row) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "REQUEST_CLOSED",
          message: "Leave request is no longer cancellable",
        });
      }
      const body = toRequestDetail(await nameEmployee(db, row));
      const cancelReason = parsed.data.reason?.trim()
        ? parsed.data.reason.trim()
        : null;
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "leave.request.cancel",
        entityType: "leave_request",
        entityId: row.id,
        afterState: body,
        reason: cancelReason,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );
}
