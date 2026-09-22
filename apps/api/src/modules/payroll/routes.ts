import {mutationRoute} from "../../common/mutationRoute.js";
import {encryptPii} from "../../common/crypto.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ATTENDANCE_WEIGHTS,
  P1_PERMISSIONS,
  type PayslipLeave,
  PAYROLL_MAX_PERIOD_DAYS,
  payrollPolicyPatchSchema,
  payrollRunApproveSchema,
  payrollRunCreateSchema,
  payrollRunReopenSchema,
  payrollRunsQuerySchema,
  payslipListQuerySchema,
  payslipMeQuerySchema,
  calculatePayslip,
  decodeCursor,
  encodeCursor,
  resolveEffectiveHolidays,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import {
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";

export interface PayrollRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

/**
 * P1 payroll routes (frozen P1 contract).
 *
 * Money: integer paise internally (see packages/shared/src/p1.ts) — every
 * money field is rounded to 2dp at each derived step. The pay rule itself
 * (Sundays and holidays paid, loss of pay deducted once, joiners and leavers
 * paid for their employed days) lives in calculatePayslip in
 * packages/shared/src/p1.ts; this file only gathers its inputs. It replaced a
 * P1 simplification that counted every calendar day as a working day and took
 * loss of pay out twice. Runs already LOCKED keep the figures they were locked
 * with. OVERLAPPING_RUN fires against ANY existing run in the org, including
 * LOCKED (there is no cancelled state).
 */

// ---------------------------------------------------------------------------
// Small helpers (snake_case shapes, mirroring S1/S2/S3 conventions)
// ---------------------------------------------------------------------------

function dateOnly(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Inclusive calendar days between two YYYY-MM-DD dates (to >= from). */
function inclusiveDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** NUMERIC (string) → integer paise, single conversion boundary. */
function toPaise(v: string | number | null | undefined): number {
  if (v === null || v === undefined) {
    return 0;
  }
  return Math.round(Number(v) * 100);
}

function fromPaise(p: number): number {
  return p / 100;
}

function sendRuleError(
  reply: FastifyReply,
  requestId: string,
  args: { status: number; code: string; message: string },
): FastifyReply {
  return reply.status(args.status).send({
    code: args.code,
    message: args.message,
    field_errors: [],
    request_id: requestId,
    retryable: false,
  });
}

interface RunRow {
  id: string;
  org_id: string;
  period_start: Date | string;
  period_end: Date | string;
  status: string;
  version: number;
  employee_count: number;
  total_gross: string | number;
  total_deductions: string | number;
  total_net: string | number;
  warnings: unknown;
  approved_by: string | null;
  approved_at: Date | string | null;
  approve_note: string | null;
  locked_by: string | null;
  locked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const RUN_COLS = `id, org_id, period_start, period_end, status, version,
  employee_count, total_gross, total_deductions, total_net, warnings,
  approved_by, approved_at, approve_note, locked_by, locked_at,
  created_at, updated_at`;

function warningsOf(row: RunRow): Array<{
  type: string;
  employee_id: string;
  message: string;
}> {
  return Array.isArray(row.warnings)
    ? (row.warnings as Array<{ type: string; employee_id: string; message: string }>)
    : [];
}

/** Bare run + totals + warnings[]. */
function toRunShape(row: RunRow) {
  return {
    id: row.id,
    period_start: dateOnly(row.period_start),
    period_end: dateOnly(row.period_end),
    status: row.status,
    version: Number(row.version),
    employee_count: Number(row.employee_count),
    total_gross: Number(row.total_gross),
    total_deductions: Number(row.total_deductions),
    total_net: Number(row.total_net),
    warnings: warningsOf(row),
    approved_by: row.approved_by,
    approved_at: iso(row.approved_at),
    approve_note: row.approve_note,
    locked_by: row.locked_by,
    locked_at: iso(row.locked_at),
    created_at: iso(row.created_at) as string,
    updated_at: iso(row.updated_at) as string,
  };
}

interface RunCursor {
  created_at: string;
  id: string;
}

interface PayslipCursor {
  emp_no: string;
  id: string;
}

export async function registerPayrollRoutes(
  app: FastifyInstance,
  opts: PayrollRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, P1_PERMISSIONS.PAYROLL_READ);
  const canGenerate = requirePermission(
    authenticate,
    P1_PERMISSIONS.PAYROLL_GENERATE,
  );
  const canApprove = requirePermission(
    authenticate,
    P1_PERMISSIONS.PAYROLL_APPROVE,
  );
  const canLock = requirePermission(authenticate, P1_PERMISSIONS.PAYROLL_LOCK);
  const canConfigure = requirePermission(
    authenticate,
    P1_PERMISSIONS.PAYROLL_CONFIGURE,
  );
  const canPayslipRead = requirePermission(
    authenticate,
    P1_PERMISSIONS.PAYSLIP_READ,
  );

  async function getPolicy(orgId: string, db: Pool = opts.pool): Promise<{
    per_day_divisor: number;
    pf_pct: number;
  }> {
    const res = await db.query(
      "SELECT per_day_divisor, pf_pct FROM payroll_policies WHERE org_id = $1",
      [orgId],
    );
    const row = res.rows[0] as
      | { per_day_divisor: string | number; pf_pct: string | number }
      | undefined;
    if (!row) {
      return { per_day_divisor: 30, pf_pct: 12 };
    }
    return {
      per_day_divisor: Number(row.per_day_divisor),
      pf_pct: Number(row.pf_pct),
    };
  }

  // ------------------------------------------------ GET /payroll/policy
  app.get("/api/v1/payroll/policy", { preHandler: canRead }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    // Self-heal the seeded default row so fresh orgs always have a policy.
    await opts.pool.query(
      `INSERT INTO payroll_policies (org_id, per_day_divisor, pf_pct)
       VALUES ($1, 30, 12) ON CONFLICT (org_id) DO NOTHING`,
      [user.orgId],
    );
    return reply.status(200).send(await getPolicy(user.orgId,opts.pool));
  });

  // ------------------------------------------------ PATCH /payroll/policy
  app.patch(
    "/api/v1/payroll/policy",
    { preHandler: canConfigure },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = payrollPolicyPatchSchema.safeParse(req.body);
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
      const current = await getPolicy(user.orgId,db);
      const next = {
        per_day_divisor: parsed.data.per_day_divisor ?? current.per_day_divisor,
        pf_pct: parsed.data.pf_pct ?? current.pf_pct,
      };
      await db.query(
        `INSERT INTO payroll_policies (org_id, per_day_divisor, pf_pct)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id) DO UPDATE SET
           per_day_divisor = EXCLUDED.per_day_divisor,
           pf_pct = EXCLUDED.pf_pct,
           updated_at = NOW()`,
        [user.orgId, next.per_day_divisor, next.pf_pct],
      );
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "payroll.policy.update",
        entityType: "payroll_policy",
        entityId: null,
        beforeState: current,
        afterState: next,
        requestId: req.requestId,
      });
      return reply.status(200).send(next);
    
});},
  );

  // ------------------------------------------------ POST /payroll/runs
  app.post(
    "/api/v1/payroll/runs",
    { preHandler: canGenerate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      // Idempotency-Key is OPTIONAL here: replay only when a valid key
      // was already applied (same method+path, unexpired).
      if (await replayIfSeen(db, req, reply)) {
        return;
      }
      const parsed = payrollRunCreateSchema.safeParse(req.body);
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
      const { period_start: start, period_end: end } = parsed.data;
      if (start > end) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "DATE_RANGE",
          message: "period_start must be on or before period_end",
        });
      }
      if (inclusiveDays(start, end) > PAYROLL_MAX_PERIOD_DAYS) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "PERIOD_TOO_LONG",
          message: `Payroll period must span at most ${PAYROLL_MAX_PERIOD_DAYS} days`,
        });
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["payroll:"+user.orgId]);
      // Serialize overlap validation and run creation for this organization.
      const overlap = await db.query(
        `SELECT id FROM payroll_runs
          WHERE org_id = $1
            AND period_start <= $3::date AND period_end >= $2::date
          LIMIT 1`,
        [user.orgId, start, end],
      );
      if ((overlap.rowCount ?? 0) > 0) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "OVERLAPPING_RUN",
          message:
            "Payroll period overlaps with an existing run (including locked runs)",
        });
      }
      const ins = await db.query(
        `INSERT INTO payroll_runs (org_id, period_start, period_end, status, created_by)
         VALUES ($1, $2::date, $3::date, 'OPEN', $4::uuid)
         RETURNING ${RUN_COLS}`,
        [user.orgId, start, end, user.id],
      );
      const body = toRunShape(ins.rows[0] as RunRow);
      await writeAudit(db,{orgId:user.orgId,actorId:user.id,action:"payroll.run.create",entityType:"payroll_run",entityId:body.id,afterState:body,requestId:req.requestId});
      await storeIdempotentResponse(db, req, user.id, 201, body);
      return reply.status(201).send(body);
    
});},
  );

  // ------------------------------------------------ GET /payroll/runs
  app.get("/api/v1/payroll/runs", { preHandler: canRead }, async (req, reply) => {
    const parsed = payrollRunsQuerySchema.safeParse(req.query);
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
    const { limit, cursor, status } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (cursor) {
      const decoded = decodeCursor<RunCursor>(cursor);
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
      `SELECT ${RUN_COLS} FROM payroll_runs
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const rows = res.rows as RunRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toRunShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
          : null,
      has_more: hasMore,
    });
  });

  // ------------------------------------------------ GET /payroll/runs/:id
  app.get(
    "/api/v1/payroll/runs/:id",
    { preHandler: canRead },
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
      const res = await opts.pool.query(
        `SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1::uuid AND org_id = $2`,
        [id, user.orgId],
      );
      const row = res.rows[0] as RunRow | undefined;
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Payroll run not found",
        });
      }
      return reply.status(200).send(toRunShape(row));
    },
  );

  // ------------------------------------------------ POST /payroll/runs/:id/calculate
  app.post(
    "/api/v1/payroll/runs/:id/calculate",
    { preHandler: canGenerate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const client = db;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["payroll:"+user.orgId]);
        const curRes = await client.query(
          `SELECT ${RUN_COLS} FROM payroll_runs
            WHERE id = $1::uuid AND org_id = $2 FOR UPDATE`,
          [id, user.orgId],
        );
        const cur = curRes.rows[0] as RunRow | undefined;
        if (!cur) {
          return sendError(reply, req.requestId, {
            status: 404,
            code: "NOT_FOUND",
            message: "Payroll run not found",
          });
        }
        if (cur.status !== "OPEN") {
          return sendRuleError(reply, req.requestId, {
            status: 422,
            code: "RUN_SEALED",
            message: `Run must be in OPEN state to calculate (current: ${cur.status})`,
          });
        }
        const start = dateOnly(cur.period_start);
        const end = dateOnly(cur.period_end);
        await client.query(
          "UPDATE payroll_runs SET status = 'VALIDATING', updated_at = NOW() WHERE id = $1::uuid",
          [id],
        );

        // Completeness rule: zero attendance records org-wide in the
        // period → back to OPEN with NO_ATTENDANCE_DATA.
        const attCount = await client.query(
          `SELECT COUNT(*) AS count FROM attendance_records r
            JOIN employees e ON e.id = r.employee_id
            WHERE e.org_id = $1 AND r.work_date BETWEEN $2::date AND $3::date`,
          [user.orgId, start, end],
        );
        if (Number((attCount.rows[0] as { count: string }).count) === 0) {
          await client.query(
            "UPDATE payroll_runs SET status = 'OPEN', updated_at = NOW() WHERE id = $1::uuid",
            [id],
          );
          return sendRuleError(reply, req.requestId, {
            status: 422,
            code: "NO_ATTENDANCE_DATA",
            message: "No attendance data exists for this period",
          });
        }

        const policyRes = await client.query(
          "SELECT per_day_divisor, pf_pct FROM payroll_policies WHERE org_id = $1",
          [user.orgId],
        );
        const policyRow = policyRes.rows[0] as
          | { per_day_divisor: string | number; pf_pct: string | number }
          | undefined;
        const divisor = policyRow ? Number(policyRow.per_day_divisor) : 30;
        const pfPct = policyRow ? Number(policyRow.pf_pct) : 12;

        interface EmpRow {
          id: string;
          emp_no: string;
          first_name: string;
          last_name: string | null;
          designation: string | null;
          salary_basic: string | number | null;
          date_of_joining: Date | string;
          date_of_exit: Date | string | null;
          site_id: string | null;
          village_id: string | null;
          mandal_id: string | null;
          district_id: string | null;
        }
        // Who is paid is decided by the dates they were employed, not by the
        // status they hold today: someone who left on the 20th worked twenty
        // days of this period and is owed them, even though the record now
        // says EXITED. DRAFT is excluded because a draft record is not yet
        // anyone's employment (see employeeActivateSchema). SUSPENDED stays in:
        // suspension is a flag with no dates, so the attendance register is
        // the only evidence of the days, applied as for anyone else. An EXITED
        // record without an exit date has no window to pay and would otherwise
        // match every future period, so it needs its date first.
        const empRes = await client.query(
          `SELECT id, emp_no, first_name, last_name, designation, salary_basic,
              date_of_joining, date_of_exit, site_id, village_id, mandal_id,
              district_id
            FROM employees
            WHERE org_id = $1
              AND (status IN ('ACTIVE', 'SUSPENDED')
                   OR (status = 'EXITED' AND date_of_exit IS NOT NULL))
              AND date_of_joining <= $3::date
              AND (date_of_exit IS NULL OR date_of_exit >= $2::date)
            ORDER BY emp_no ASC`,
          [user.orgId, start, end],
        );
        const employees = empRes.rows as EmpRow[];

        const empIds = employees.map((e) => e.id);
        const attendanceByEmp = new Map<string, Map<string, number>>();
        const recordsByEmp = new Map<string, number>();
        if (empIds.length > 0) {
          const recRes = await client.query(
            `SELECT employee_id, work_date, status FROM attendance_records
              WHERE employee_id = ANY($1::uuid[])
                AND work_date BETWEEN $2::date AND $3::date`,
            [empIds, start, end],
          );
          for (const r of recRes.rows as Array<{
            employee_id: string;
            work_date: Date | string;
            status: string;
          }>) {
            recordsByEmp.set(
              r.employee_id,
              (recordsByEmp.get(r.employee_id) ?? 0) + 1,
            );
            let byDate = attendanceByEmp.get(r.employee_id);
            if (!byDate) {
              byDate = new Map();
              attendanceByEmp.set(r.employee_id, byDate);
            }
            const date = dateOnly(r.work_date);
            byDate.set(
              date,
              (byDate.get(date) ?? 0) + (ATTENDANCE_WEIGHTS[r.status] ?? 0),
            );
          }
        }

        const leavesByEmp = new Map<string, PayslipLeave[]>();
        if (empIds.length > 0) {
          const leaveRes = await client.query(
            `SELECT r.employee_id, r.from_date, r.to_date, t.is_paid
              FROM leave_requests r
              JOIN leave_types t ON t.id = r.leave_type_id
              WHERE r.employee_id = ANY($1::uuid[])
                AND r.status = 'APPROVED'
                AND r.from_date <= $3::date AND r.to_date >= $2::date`,
            [empIds, start, end],
          );
          for (const l of leaveRes.rows as Array<{
            employee_id: string;
            from_date: Date | string;
            to_date: Date | string;
            is_paid: boolean;
          }>) {
            const list = leavesByEmp.get(l.employee_id) ?? [];
            list.push({
              from: dateOnly(l.from_date),
              to: dateOnly(l.to_date),
              paid: l.is_paid,
            });
            leavesByEmp.set(l.employee_id, list);
          }
        }

        // Every holiday row in the period. Each employee's own calendar is
        // resolved from these by location, exactly as GET /holidays does for
        // them, so the day payroll pays as a holiday is the day the employee
        // was told was one.
        const holidayRes = await client.query(
          `SELECT id, date, name, type, scope_type, scope_id FROM holidays
            WHERE org_id = $1 AND active = true
              AND date BETWEEN $2::date AND $3::date`,
          [user.orgId, start, end],
        );
        const holidayCandidates = (
          holidayRes.rows as Array<{
            id: string;
            date: Date | string;
            name: string;
            type: string;
            scope_type: string | null;
            scope_id: string | null;
          }>
        ).map((h) => ({ ...h, date: dateOnly(h.date) }));

        const warnings: Array<{
          type: string;
          employee_id: string;
          /* The name and number, so a warning reads as a person and not an id. */
          emp_no: string;
          employee_name: string;
          message: string;
        }> = [];
        let totalGrossPaise = 0;
        let totalDedPaise = 0;
        let totalNetPaise = 0;

        // Preserve every previous calculation, including employees removed from this run.
        const prior = await client.query('SELECT * FROM payslips WHERE payroll_run_id=$1 FOR UPDATE',[id]);
        for (const slip of prior.rows) await client.query('INSERT INTO payslip_revisions(payslip_id,version,snapshot_encrypted,archived_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[slip.id,slip.version,encryptPii(JSON.stringify(slip)),user.id]);
        await client.query('UPDATE payslips SET is_current=false WHERE payroll_run_id=$1',[id]);

        for (const emp of employees) {
          const hasSalary =
            emp.salary_basic !== null && emp.salary_basic !== undefined;
          const recordCount = recordsByEmp.get(emp.id) ?? 0;
          const holidays = new Set(
            resolveEffectiveHolidays(holidayCandidates, [
              emp.site_id,
              emp.village_id,
              emp.mandal_id,
              emp.district_id,
            ]).map((h) => h.date),
          );

          const calc = calculatePayslip({
            periodStart: start,
            periodEnd: end,
            dateOfJoining: dateOnly(emp.date_of_joining),
            dateOfExit: emp.date_of_exit ? dateOnly(emp.date_of_exit) : null,
            basicPaise: hasSalary ? toPaise(emp.salary_basic) : null,
            perDayDivisor: divisor,
            pfPct,
            holidays,
            attendance: attendanceByEmp.get(emp.id) ?? new Map(),
            leaves: leavesByEmp.get(emp.id) ?? [],
          });
          const grossPaise = calc.grossPaise;
          const dedPaise = calc.totalDeductionsPaise;
          const netPaise = calc.netPaise;

          // payable_days = present + paid leave + paid days off, and gross is
          // the pay for exactly those days: lop_amount has already been taken
          // out of it. lop_amount is shown so the employee can see what the
          // unpaid days cost; it is not part of total_deductions, because
          // subtracting it again is the double deduction this replaced.
          const earnings = {
            basic: fromPaise(hasSalary ? toPaise(emp.salary_basic) : 0),
            per_day: fromPaise(calc.perDayPaise),
            payable_days: calc.payableDays,
            present_days: calc.presentDays,
            paid_leave_days: calc.paidLeaveDays,
            paid_off_days: calc.paidOffDays,
            lop_leave_days: calc.lopLeaveDays,
          };
          const deductions = {
            lop_days: calc.unpaidDays,
            lop_amount: fromPaise(calc.lopPaise),
            pf: fromPaise(calc.pfPaise),
          };

          await client.query(
            `INSERT INTO payslips
               (org_id, payroll_run_id, employee_id, earnings, deductions,
                gross, total_deductions, net_pay)
             VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)
             ON CONFLICT (payroll_run_id,employee_id) DO UPDATE SET earnings=EXCLUDED.earnings,deductions=EXCLUDED.deductions,gross=EXCLUDED.gross,total_deductions=EXCLUDED.total_deductions,net_pay=EXCLUDED.net_pay,is_current=true,version=payslips.version+1,updated_at=now()`,
            [
              user.orgId,
              id,
              emp.id,
              JSON.stringify(earnings),
              JSON.stringify(deductions),
              fromPaise(grossPaise),
              fromPaise(dedPaise),
              fromPaise(netPaise),
            ],
          );

          totalGrossPaise += grossPaise;
          totalDedPaise += dedPaise;
          totalNetPaise += netPaise;

          if (recordCount === 0) {
            warnings.push({
              type: "NO_RECORDS",
              employee_id: emp.id,
              emp_no: emp.emp_no,
              employee_name: [emp.first_name, emp.last_name].filter(Boolean).join(" "),
              message: `No attendance records for employee ${emp.emp_no} in this period`,
            });
          }
          if (!hasSalary) {
            warnings.push({
              type: "NO_SALARY",
              employee_id: emp.id,
              emp_no: emp.emp_no,
              employee_name: [emp.first_name, emp.last_name].filter(Boolean).join(" "),
              message: `No basic salary set for employee ${emp.emp_no}`,
            });
          }
        }

        const upd = await client.query(
          `UPDATE payroll_runs SET
             status = 'CALCULATED', employee_count = $2,
             total_gross = $3, total_deductions = $4, total_net = $5,
             warnings = $6, version = version + 1, updated_at = NOW()
           WHERE id = $1::uuid
           RETURNING ${RUN_COLS}`,
          [
            id,
            employees.length,
            fromPaise(totalGrossPaise),
            fromPaise(totalDedPaise),
            fromPaise(totalNetPaise),
            JSON.stringify(warnings),
          ],
        );
        await writeAudit(client,{orgId:user.orgId,actorId:user.id,action:"payroll.run.calculate",entityType:"payroll_run",entityId:id,afterState:toRunShape(upd.rows[0] as RunRow),requestId:req.requestId});
        return reply.status(200).send(toRunShape(upd.rows[0] as RunRow));
    
});},
  );

  /** Single-step forward transition with an explicit expected state. */
  async function transition(
    db: Pool,
    runId: string,
    ctx: {
      ip: string;
      headers: Record<string, unknown>;
      requestId: string;
    },
    reply: FastifyReply,
    user: { id: string; orgId: string; impersonator?: { id: string } },
    args: {
      from: string;
      to: string;
      action: string;
      auditAction: string;
      extraSet?: string;
      extraParams?: unknown[];
      note?: string | null;
      reason?: string | null;
    },
  ) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["payroll:"+user.orgId]);
    const upd = await db.query(
      `UPDATE payroll_runs SET
         status = '${args.to}', ${args.extraSet ? `${args.extraSet}, ` : ""}
         version = version + 1, updated_at = NOW()
       WHERE id = $1::uuid AND org_id = $2 AND status = '${args.from}'
       RETURNING ${RUN_COLS}`,
      [runId, user.orgId, ...(args.extraParams ?? [])],
    );
    const row = upd.rows[0] as RunRow | undefined;
    if (!row) {
      const cur = await db.query(
        "SELECT status FROM payroll_runs WHERE id = $1::uuid AND org_id = $2",
        [runId, user.orgId],
      );
      const curRow = cur.rows[0] as { status: string } | undefined;
      if (!curRow) {
        return sendError(reply, ctx.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Payroll run not found",
        });
      }
      return sendRuleError(reply, ctx.requestId, {
        status: 422,
        code: "RUN_SEALED",
        message: `Run must be in ${args.from} state for ${args.action} (current: ${curRow.status})`,
      });
    }
    const body = toRunShape(row);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: ctx.ip,
      actorUserAgent:
        typeof ctx.headers["user-agent"] === "string"
          ? (ctx.headers["user-agent"] as string)
          : null,
      action: args.auditAction,
      entityType: "payroll_run",
      entityId: row.id,
      afterState: body,
      reason: args.reason ?? args.note ?? null,
      requestId: ctx.requestId,
    });
    return reply.status(200).send(body);
  }

  // ------------------------------------------------ POST /payroll/runs/:id/submit-review
  app.post(
    "/api/v1/payroll/runs/:id/submit-review",
    { preHandler: canGenerate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      return transition(
        db,
        id,
        { ip: req.ip, headers: req.headers, requestId: req.requestId },
        reply,
        user,
        {
          from: "CALCULATED",
          to: "REVIEW",
          action: "submit for review",
          auditAction: "payroll.run.submit_review",
        },
      );
    
});},
  );

  // ------------------------------------------------ POST /payroll/runs/:id/approve
  app.post(
    "/api/v1/payroll/runs/:id/approve",
    { preHandler: canApprove },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = payrollRunApproveSchema.safeParse(req.body ?? {});
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
      const note = parsed.data.note?.trim() ? parsed.data.note.trim() : null;
      const { id } = req.params as { id: string };
      return transition(
        db,
        id,
        { ip: req.ip, headers: req.headers, requestId: req.requestId },
        reply,
        user,
        {
          from: "REVIEW",
          to: "APPROVED",
          action: "approve",
          auditAction: "payroll.run.approve",
          extraSet: "approved_by = $3::uuid, approved_at = NOW(), approve_note = $4",
          extraParams: [user.id, note],
          note,
        },
      );
    
});},
  );

  // ------------------------------------------------ POST /payroll/runs/:id/lock
  app.post(
    "/api/v1/payroll/runs/:id/lock",
    { preHandler: canLock },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id: lockId } = req.params as { id: string };
      return transition(
        db,
        lockId,
        { ip: req.ip, headers: req.headers, requestId: req.requestId },
        reply,
        user,
        {
          from: "APPROVED",
          to: "LOCKED",
          action: "lock",
          auditAction: "payroll.run.lock",
          extraSet: "locked_by = $3::uuid, locked_at = NOW()",
          extraParams: [user.id],
        },
      );
    
});},
  );

  // ------------------------------------------------ POST /payroll/runs/:id/reopen
  app.post(
    "/api/v1/payroll/runs/:id/reopen",
    { preHandler: canLock },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = payrollRunReopenSchema.safeParse(req.body ?? {});
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
      const reason = parsed.data.reason?.trim() ? parsed.data.reason.trim() : null;
      if (!reason) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "REASON_REQUIRED",
          message: "A reason is required to reopen a locked run (controlled override)",
        });
      }
      const { id: reopenId } = req.params as { id: string };
      return transition(
        db,
        reopenId,
        { ip: req.ip, headers: req.headers, requestId: req.requestId },
        reply,
        user,
        {
          from: "LOCKED",
          to: parsed.data.recalculate ? "OPEN" : "APPROVED",
          action: "reopen",
          auditAction: "payroll.run.reopen",
          // Fresh lock cycle: clear the previous lock stamp (history stays in audit).
          extraSet: parsed.data.recalculate ? "locked_by = NULL, locked_at = NULL, approved_by = NULL, approved_at = NULL, approve_note = NULL" : "locked_by = NULL, locked_at = NULL",
          reason,
        },
      );
    
});},
  );

  // ------------------------------------------------ GET /payroll/runs/:id/payslips
  app.get(
    "/api/v1/payroll/runs/:id/payslips",
    { preHandler: canRead },
    async (req, reply) => {
      const parsed = payslipListQuerySchema.safeParse(req.query);
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
      const runRes = await opts.pool.query(
        "SELECT id FROM payroll_runs WHERE id = $1::uuid AND org_id = $2",
        [id, user.orgId],
      );
      if ((runRes.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Payroll run not found",
        });
      }
      const { limit, cursor } = parsed.data;
      const values: unknown[] = [id];
      const clauses = ["p.payroll_run_id = $1::uuid", "p.is_current=true"];
      if (cursor) {
        const decoded = decodeCursor<PayslipCursor>(cursor);
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
        values.push(decoded.emp_no, decoded.id);
        clauses.push(
          `(e.emp_no, p.id) > ($${values.length - 1}, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);
      const res = await opts.pool.query(
        `SELECT p.id, p.employee_id, e.emp_no,
            TRIM(BOTH ' ' FROM CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS employee_name,
            p.gross, p.total_deductions, p.net_pay
          FROM payslips p
          JOIN employees e ON e.id = p.employee_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY e.emp_no ASC, p.id ASC LIMIT $${values.length}`,
        values as string[],
      );
      const rows = res.rows as Array<{
        id: string;
        employee_id: string;
        emp_no: string;
        employee_name: string;
        gross: string | number;
        total_deductions: string | number;
        net_pay: string | number;
      }>;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return reply.status(200).send({
        data: page.map((r) => ({
          id: r.id,
          employee_id: r.employee_id,
          emp_no: r.emp_no,
          employee_name: r.employee_name,
          gross: Number(r.gross),
          total_deductions: Number(r.total_deductions),
          net_pay: Number(r.net_pay),
        })),
        next_cursor:
          hasMore && last
            ? encodeCursor({ emp_no: last.emp_no, id: last.id })
            : null,
        has_more: hasMore,
      });
    },
  );

  // ------------------------------------------------ GET /payslips/me
  app.get(
    "/api/v1/payslips/me",
    { preHandler: canPayslipRead },
    async (req, reply) => {
      const parsed = payslipMeQuerySchema.safeParse(req.query);
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
      const linkRes = await opts.pool.query(
        "SELECT employee_id FROM users WHERE id = $1",
        [user.id],
      );
      const linked = (linkRes.rows[0] as { employee_id: string | null } | undefined)
        ?.employee_id;
      if (!linked) {
        return sendRuleError(reply, req.requestId, {
          status: 404,
          code: "NO_EMPLOYEE_LINK",
          message: "No employee linked to this user",
        });
      }
      const { period_start: qStart, period_end: qEnd } = parsed.data;
      const values: unknown[] = [user.orgId, linked];
      const clauses = ["r.org_id = $1", "p.employee_id = $2::uuid", "p.is_current=true"];
      if (qStart) {
        values.push(qStart);
        clauses.push(`r.period_end >= $${values.length}::date`);
      }
      if (qEnd) {
        values.push(qEnd);
        clauses.push(`r.period_start <= $${values.length}::date`);
      }
      // Own latest slip in the window (documented choice for multi-slip windows).
      const res = await opts.pool.query(
        `SELECT p.id, p.earnings, p.deductions, p.gross, p.total_deductions,
            p.net_pay, p.version,
            r.period_start, r.period_end, r.status AS run_status,
            e.emp_no, e.designation,
            TRIM(BOTH ' ' FROM CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS employee_name
          FROM payslips p
          JOIN payroll_runs r ON r.id = p.payroll_run_id
          JOIN employees e ON e.id = p.employee_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY r.period_end DESC, r.period_start DESC, r.created_at DESC
          LIMIT 1`,
        values as string[],
      );
      const row = res.rows[0] as
        | {
            id: string;
            earnings: unknown;
            deductions: unknown;
            gross: string | number;
            total_deductions: string | number;
            net_pay: string | number;
            version: number;
            period_start: Date | string;
            period_end: Date | string;
            run_status: string;
            emp_no: string;
            designation: string | null;
            employee_name: string;
          }
        | undefined;
      if (!row) {
        return sendRuleError(reply, req.requestId, {
          status: 404,
          code: "NO_PAYSLIP",
          message: "No payslip found for this period",
        });
      }
      return reply.status(200).send({
        id: row.id,
        period: { start: dateOnly(row.period_start), end: dateOnly(row.period_end) },
        run_status: row.run_status,
        employee: {
          emp_no: row.emp_no,
          name: row.employee_name,
          designation: row.designation,
        },
        earnings: row.earnings,
        deductions: row.deductions,
        gross: Number(row.gross),
        total_deductions: Number(row.total_deductions),
        net_pay: Number(row.net_pay),
        version: Number(row.version),
      });
    },
  );
}
