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
  leaveRequestCreateSchema,
  toFieldErrors,
  type ApprovalChainStep,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission,scopesForPermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import { emitNotification } from "../s5/notify.js";
import { parseIfMatch } from '../../common/ifMatch.js';

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

/** Inclusive calendar days between two YYYY-MM-DD dates (to >= from). */
function inclusiveDays(from: string, to: string): number {
  const ms =
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
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
}

const REQUEST_COLS = `id, org_id, employee_id, leave_type_id, from_date,
  to_date, total_days, reason, status, approval_chain, current_approver_id,
  version, created_at, updated_at`;

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

  async function findRequest(
    orgId: string,
    id: string,
  ): Promise<RequestRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${REQUEST_COLS} FROM leave_requests WHERE id = $1::uuid AND org_id = $2`,
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
            message: "Insufficient permissions",
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
      actorId: user.id,
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
          message: "Insufficient permissions",
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
    const totalDays = inclusiveDays(d.from_date, d.to_date);
    const periodYear = Number(d.from_date.slice(0, 4));

    // Rule 3: balance check for paid types that require a balance.
    if (type.requires_balance) {
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
      if (totalDays > available) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "INSUFFICIENT_BALANCE",
          message: `Insufficient leave balance (available: ${available}, requested: ${totalDays})`,
          fieldErrors: [
            {
              field: "to_date",
              message: `Requested ${totalDays} days but only ${available} available`,
            },
          ],
          extra: { available },
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
    const body = toRequestShape(row);
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
      actorId: user.id,
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
        message: "Insufficient permissions",
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
      `SELECT ${REQUEST_COLS.split(",").map((c) => `r.${c.trim()}`).join(", ")}
       FROM leave_requests r
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
          message: "Insufficient permissions",
        });
      }
      if(row.employee_id!==own){user.scopes=await scopesForPermission(req,user.permissions.includes(LEAVE_READ)?LEAVE_READ:LEAVE_DECIDE);await employeeAccess(opts.pool,req,row.employee_id);}
      return reply.status(200).send(toRequestDetail(row));
    },
  );

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
      let failure: { status: number; code: string; message: string } | null = null;
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
          const upd = await client.query(
            `UPDATE leave_requests SET
               status = $2, approval_chain = $3, current_approver_id = $4::uuid,
               updated_at = NOW(), version = version + 1
             WHERE id = $1::uuid AND version = $5
             RETURNING ${REQUEST_COLS}`,
            [id, nextStatus, JSON.stringify(chain), nextApprover, expectedVersion],
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
            // (LOP skips the debit). Same transaction as the approval.
            const type = await client.query(
              "SELECT is_paid, requires_balance FROM leave_types WHERE id = $1::uuid",
              [cur.leave_type_id],
            );
            const t = type.rows[0] as
              | { is_paid: boolean; requires_balance: boolean }
              | undefined;
            if (t?.requires_balance) {
              const year = Number(dateOnly(cur.from_date).slice(0, 4));
              const debited = await client.query(
                `UPDATE leave_balances SET consumed = consumed + $4, updated_at = NOW()
                 WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND period_year = $3`,
                [cur.employee_id, cur.leave_type_id, year, cur.total_days],
              );
              if ((debited.rowCount ?? 0) === 0) {
                await client.query(
                  `INSERT INTO leave_balances
                     (employee_id, leave_type_id, period_year, consumed)
                   VALUES ($1::uuid, $2::uuid, $3, $4)
                   ON CONFLICT (employee_id, leave_type_id, period_year)
                   DO UPDATE SET consumed = leave_balances.consumed + EXCLUDED.consumed,
                                 updated_at = NOW()`,
                  [cur.employee_id, cur.leave_type_id, year, cur.total_days],
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
        return sendError(reply, req.requestId, {
          status: f.status,
          code: f.code,
          message: f.message,
        });
      }
      const body = toRequestDetail(finalRow);
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
        actorId: user.id,
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
          message: "Insufficient permissions",
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
      const body = toRequestDetail(row);
      const cancelReason = parsed.data.reason?.trim()
        ? parsed.data.reason.trim()
        : null;
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
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
