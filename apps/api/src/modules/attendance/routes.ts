import {mutationRoute} from "../../common/mutationRoute.js";
import {enforceRecordScope} from "../../common/recordScope.js";
import {employeeRestriction} from "../../common/scopedReads.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  DUP_WINDOW_MIN,
  PERMISSIONS,
  P1_PERMISSIONS,
  S2_PERMISSIONS,
  SKEW_WINDOW_MIN,
  attendanceEventSchema,
  attendanceExceptionCreateSchema,
  attendanceExceptionDecisionSchema,
  attendanceRegularizeSchema,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  isValidIdempotencyKey,
  toFieldErrors,
} from "@silverline/shared";
import { businessDay } from '@silverline/shared';
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { createRateLimiter } from "../../common/rateLimit.js";
import { detectMovementAnomaly } from "@silverline/shared";
import { sendError } from "../../common/httpErrors.js";
import { emitNotification } from "../s5/notify.js";
import { parseIfMatch } from '../../common/ifMatch.js';

export interface AttendanceRoutesOptions {
  pool: Pool;
  jwtSecret: string;
  /** S6 punch cap override (default 30/min per authed user, else IP). */
  punchRateLimitMax?: number;
  punchRateLimitWindowMs?: number;
}

const SKEW_MS = SKEW_WINDOW_MIN * 60 * 1000;

/**
 * How recently a punch must have been made for the survey progress prompt to
 * still be worth putting to the person (§59, phase 2).
 *
 * Fifteen minutes: long enough to ride out a flaky tower and an automatic
 * retry, short enough that anything older is a replay from the offline queue
 * rather than somebody standing there with the app open.
 */
const LIVE_PUNCH_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Row types + shapes (snake_case, mirroring the S1 employee/org conventions)
// ---------------------------------------------------------------------------

interface EmployeeLite {
  id: string;
  status: string;
}

interface EventRow {
  id: string;
  employee_id: string;
  event_type: string;
  client_timestamp: Date | string;
  server_timestamp: Date | string;
  lat: number | null;
  lng: number | null;
  gps_accuracy: number | null;
  mock_location: boolean;
  device_id: string | null;
  app_version: string | null;
  idempotency_key: string | null;
}

interface RecordRow {
  id: string;
  employee_id: string;
  work_date: string | Date;
  check_in_event_id: string | null;
  check_out_event_id: string | null;
  check_in_at: Date | string | null;
  check_out_at: Date | string | null;
  total_hours: string | number | null;
  status: string;
}

interface ExceptionRow {
  id: string;
  employee_id: string;
  attendance_record_id: string | null;
  exception_type: string;
  reason: string;
  document_id: string | null;
  source: string;
  status: string;
  version: number;
  submitted_by: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  review_note: string | null;
  attendance_event_id: string | null;
  work_date: Date | string | null;
  claimed_check_in: Date | string | null;
  claimed_check_out: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toEventShape(row: EventRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    event_type: row.event_type,
    client_timestamp: iso(row.client_timestamp),
    server_timestamp: iso(row.server_timestamp),
    latitude: row.lat === null ? null : Number(row.lat),
    longitude: row.lng === null ? null : Number(row.lng),
    gps_accuracy: row.gps_accuracy === null ? null : Number(row.gps_accuracy),
    mock_location: row.mock_location,
    device_id: row.device_id,
    app_version: row.app_version,
  };
}

function toRecordShape(row: RecordRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    work_date:
      row.work_date instanceof Date
        ? row.work_date.toISOString().slice(0, 10)
        : String(row.work_date).slice(0, 10),
    status: row.status,
    check_in_event_id: row.check_in_event_id,
    check_out_event_id: row.check_out_event_id,
    check_in_at: iso(row.check_in_at),
    check_out_at: iso(row.check_out_at),
    total_hours:
      row.total_hours === null || row.total_hours === undefined
        ? null
        : Number(row.total_hours),
  };
}

function toExceptionShape(row: ExceptionRow) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    attendance_record_id: row.attendance_record_id,
    exception_type: row.exception_type,
    reason: row.reason,
    document_id: row.document_id,
    source: row.source,
    status: row.status,
    version: row.version,
    submitted_by: row.submitted_by,
    reviewed_by: row.reviewed_by,
    reviewed_at: iso(row.reviewed_at),
    review_note: row.review_note,
    attendance_event_id: row.attendance_event_id,
    work_date:
      row.work_date === null || row.work_date === undefined
        ? null
        : row.work_date instanceof Date
          ? row.work_date.toISOString().slice(0, 10)
          : String(row.work_date).slice(0, 10),
    claimed_check_in: iso(row.claimed_check_in),
    claimed_check_out: iso(row.claimed_check_out),
    created_at: iso(row.created_at) as string,
    updated_at: iso(row.updated_at) as string,
  };
}

/*
 * The geo-fence columns (geofence_result, geofence_id, geofence_version on
 * events; geofence_violation on records) are still in the tables so rows
 * from before 2026-09-22 stay readable, but they are neither read nor written
 * here: a punch is no longer judged against a boundary.
 */
const EVENT_COLS = `id, employee_id, event_type, client_timestamp,
  server_timestamp, lat, lng, gps_accuracy, mock_location, device_id,
  app_version, idempotency_key, device_signals`;

const RECORD_COLS = `id, employee_id, work_date, check_in_event_id,
  check_out_event_id, check_in_at, check_out_at, total_hours, status`;

const EXCEPTION_COLS = `id, employee_id, attendance_record_id, exception_type,
  reason, document_id, source, status, version, submitted_by, reviewed_by,
  reviewed_at, review_note, attendance_event_id, work_date, claimed_check_in,
  claimed_check_out, created_at, updated_at`;


function idemKeyOr422(
  req: { headers: Record<string, unknown> },
  reply: Parameters<typeof sendError>[0],
  requestId: string,
): string | null {
  const raw = req.headers["idempotency-key"];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!isValidIdempotencyKey(key)) {
    sendError(reply, requestId, {
      status: 422,
      code: "MISSING_IDEMPOTENCY_KEY",
      message: "Idempotency-Key header is required",
      fieldErrors: [
        { field: "Idempotency-Key", message: "Idempotency-Key header is required" },
      ],
    });
    return null;
  }
  return key;
}

/**
 * The LOCKED payroll run covering a work date, if any (BR-05).
 *
 * Once a run is locked its attendance inputs are frozen: adding a punch or a
 * regularization afterwards would silently change a period that has already
 * been paid out and signed off.
 */
async function lockedPayrollRun(
  db: Pool,
  orgId: string,
  workDate: string,
): Promise<{ id: string; period_start: string; period_end: string } | null> {
  const res = await db.query(
    `SELECT id, period_start, period_end FROM payroll_runs
      WHERE org_id = $1 AND status = 'LOCKED'
        AND period_start <= $2::date AND period_end >= $2::date
      LIMIT 1`,
    [orgId, workDate],
  );
  return (res.rows[0] as { id: string; period_start: string; period_end: string } | undefined) ?? null;
}

/**
 * Decides whether a write into a locked period may proceed.
 *
 * Returns null to allow, or the error to send. An override is only available to
 * a holder of payroll.lock — the same authority that locked the run — and only
 * with a reason, which is then audited.
 */
function payrollLockDecision(
  locked: { id: string } | null,
  user: { permissions: string[] },
  overrideReason: string | undefined,
): { status: number; code: string; message: string; fieldErrors?: Array<{ field: string; message: string }> } | null {
  if (!locked) return null;
  const mayOverride = user.permissions.includes(P1_PERMISSIONS.PAYROLL_LOCK);
  if (mayOverride && overrideReason) return null;
  return {
    status: 422,
    code: "PAYROLL_LOCKED",
    message: mayOverride
      ? "This work date falls in a locked payroll period; supply payroll_override_reason to record the correction"
      : "This work date falls in a locked payroll period — contact payroll",
    fieldErrors: mayOverride
      ? [
          {
            field: "payroll_override_reason",
            message: "A reason is required to write into a locked payroll period",
          },
        ]
      : undefined,
  };
}

/**
 * The organization's zone and settings.
 *
 * The zone lives in two places: the `timezone` column set when the tenant is
 * created, and a `settings.timezone` override an admin can edit. Reading only
 * the override ignored the column entirely, so a tenant outside IST had its
 * work dates computed in IST.
 */
async function orgClock(
  db: Pool,
  orgId: string,
): Promise<{ timeZone: string; settings: Record<string, any> }> {
  const orgRow = (await db.query("SELECT timezone, settings FROM organizations WHERE id=$1", [orgId]))
    .rows[0];
  const settings = orgRow?.settings ?? {};
  return { timeZone: settings.timezone ?? orgRow?.timezone ?? "Asia/Kolkata", settings };
}

/**
 * Put one punch onto its day's attendance record.
 *
 * This is the single place a punch becomes attendance, whether it was
 * accepted as it arrived or held for review and approved later. Keeping one
 * copy matters because payroll reads the record, not the event: an approved
 * punch that took a different path to the table would be paid differently.
 *
 * With no record for the day one is opened. With a record already there:
 *
 *   - `keepExisting` hands it back untouched. A live check-in uses this: the
 *     route has already refused a second check-in, so an existing row here
 *     can only be a concurrent twin of this same punch, and the UNIQUE
 *     (employee_id, work_date) arbiter has picked the winner.
 *   - otherwise the punch is merged. An approved check-in earlier than the
 *     one on file becomes the day's start and a later check-out its end. That
 *     is what makes approval order-free: a reviewer may approve the flagged
 *     check-out before the flagged check-in, or approve a morning punch after
 *     the person punched again and was accepted.
 *
 * Hours and COMPLETE follow from having both ends.
 */
async function applyPunchToDay(
  db: Pool,
  a: {
    employeeId: string;
    workDate: string;
    eventType: "CHECK_IN" | "CHECK_OUT";
    eventId: string | null;
    at: Date;
    keepExisting?: boolean;
  },
): Promise<{ record: RecordRow; created: boolean }> {
  const isIn = a.eventType === "CHECK_IN";
  const at = a.at.toISOString();
  const ins = await db.query(
    `INSERT INTO attendance_records
       (employee_id, work_date, check_in_event_id, check_in_at,
        check_out_event_id, check_out_at, status)
     VALUES ($1::uuid, $2::date, $3::uuid, $4, $5::uuid, $6, 'PARTIAL')
     ON CONFLICT (employee_id, work_date) DO NOTHING
     RETURNING ${RECORD_COLS}`,
    [
      a.employeeId,
      a.workDate,
      isIn ? a.eventId : null,
      isIn ? at : null,
      isIn ? null : a.eventId,
      isIn ? null : at,
    ],
  );
  if ((ins.rowCount ?? 0) > 0) {
    return { record: ins.rows[0] as RecordRow, created: true };
  }
  const cur = (
    await db.query(
      `SELECT ${RECORD_COLS} FROM attendance_records
        WHERE employee_id = $1::uuid AND work_date = $2::date FOR UPDATE`,
      [a.employeeId, a.workDate],
    )
  ).rows[0] as RecordRow;
  if (a.keepExisting) {
    return { record: cur, created: false };
  }
  const ms = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
  let inAt = ms(cur.check_in_at);
  let outAt = ms(cur.check_out_at);
  let inEvent = cur.check_in_event_id;
  let outEvent = cur.check_out_event_id;
  if (isIn && (inAt === null || a.at.getTime() < inAt)) {
    inAt = a.at.getTime();
    inEvent = a.eventId;
  }
  if (!isIn && (outAt === null || a.at.getTime() > outAt)) {
    outAt = a.at.getTime();
    outEvent = a.eventId;
  }
  const both = inAt !== null && outAt !== null;
  const hours = both ? Number(((outAt! - inAt!) / 3600000).toFixed(2)) : null;
  const upd = await db.query(
    `UPDATE attendance_records SET
       check_in_event_id = $2::uuid, check_in_at = $3,
       check_out_event_id = $4::uuid, check_out_at = $5,
       total_hours = $6, status = $7,
       updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING ${RECORD_COLS}`,
    [
      cur.id,
      inEvent,
      inAt === null ? null : new Date(inAt).toISOString(),
      outEvent,
      outAt === null ? null : new Date(outAt).toISOString(),
      hours,
      both ? "COMPLETE" : "PARTIAL",
    ],
  );
  return { record: upd.rows[0] as RecordRow, created: false };
}

/** What approving an exception would put onto the day's attendance. */
interface ExceptionEffect {
  /** work_date of the record the exception was raised against, if any. */
  recordDate: string | null;
  /** The day the punches below land on; null when there is nothing to apply. */
  workDate: string | null;
  punches: Array<{
    eventType: "CHECK_IN" | "CHECK_OUT";
    eventId: string | null;
    at: Date;
  }>;
}

/**
 * Work out what an exception's approval applies, without applying it.
 *
 * A held-back punch applies itself. Its moment is the server's receipt time,
 * except for a punch refused for clock skew: that is almost always an offline
 * punch replayed long after it was made, and the day it belongs to is the day
 * the phone recorded, not the day the signal came back. A client clock that
 * runs *ahead* of the server is a wrong clock rather than a late replay, so
 * the earlier of the two moments is the one taken.
 *
 * A regularization applies the times it claims, on the date it names.
 * Anything else -- a note raised by hand, or a system exception from before
 * exceptions named their punch -- applies nothing, as before.
 */
async function exceptionEffect(db: Pool, orgId: string, x: ExceptionRow): Promise<ExceptionEffect> {
  let recordDate: string | null = null;
  if (x.attendance_record_id) {
    const rec = (
      await db.query("SELECT work_date FROM attendance_records WHERE id = $1::uuid", [
        x.attendance_record_id,
      ])
    ).rows[0] as { work_date: string } | undefined;
    recordDate = rec ? String(rec.work_date).slice(0, 10) : null;
  }
  if (x.attendance_event_id) {
    const ev = (
      await db.query(
        `SELECT id, event_type, client_timestamp, server_timestamp
           FROM attendance_events WHERE id = $1::uuid AND employee_id = $2::uuid`,
        [x.attendance_event_id, x.employee_id],
      )
    ).rows[0] as
      | { id: string; event_type: "CHECK_IN" | "CHECK_OUT"; client_timestamp: Date; server_timestamp: Date }
      | undefined;
    if (ev) {
      const client = new Date(ev.client_timestamp);
      const server = new Date(ev.server_timestamp);
      const skewed = Math.abs(client.getTime() - server.getTime()) > SKEW_MS;
      const at = skewed && client.getTime() < server.getTime() ? client : server;
      const { timeZone } = await orgClock(db, orgId);
      return {
        recordDate,
        workDate: businessDay(at, timeZone),
        punches: [
          {
            eventType: ev.event_type,
            eventId: ev.id,
            at,
          },
        ],
      };
    }
  }
  if (x.exception_type === "REGULARIZATION" && x.work_date) {
    const punches: ExceptionEffect["punches"] = [];
    if (x.claimed_check_in) {
      punches.push({ eventType: "CHECK_IN", eventId: null, at: new Date(x.claimed_check_in) });
    }
    if (x.claimed_check_out) {
      punches.push({ eventType: "CHECK_OUT", eventId: null, at: new Date(x.claimed_check_out) });
    }
    return { recordDate, workDate: String(x.work_date).slice(0, 10), punches };
  }
  return { recordDate, workDate: null, punches: [] };
}

/** Upper bound on markers returned to the map in one request. */
const MAX_MAP_EVENTS = 5000;

const mapEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MAP_EVENTS).default(1000),
  employee_id: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const recordsListQuerySchema = cursorPageQuerySchema.extend({
  employee_id: z.string().uuid().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
    .optional(),
  status: z.enum(["PARTIAL", "COMPLETE"]).optional(),
});

interface RecordCursor {
  work_date: string;
  id: string;
}

export async function registerAttendanceRoutes(
  app: FastifyInstance,
  opts: AttendanceRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, S2_PERMISSIONS.ATTENDANCE_READ);
  const canDecide = requirePermission(
    authenticate,
    S2_PERMISSIONS.ATTENDANCE_DECIDE,
  );
  // S6 punch limiter (fixed window, authed user id else IP; 429 RATE_LIMITED).
  // Runs after authenticate so the key can use the authed user id.
  const punchRateLimit = createRateLimiter({
    max: opts.punchRateLimitMax ?? 30,
    windowMs: opts.punchRateLimitWindowMs ?? 60_000,
    message: "Too many punch attempts, try again later",
  });

  /** Punch scope (frozen): self (linked employee) or attendance.decide. */
  async function assertPunchScope(
    user: { id: string; permissions: string[] },
    employeeId: string,
  ): Promise<boolean> {
    if (user.permissions.includes(S2_PERMISSIONS.ATTENDANCE_DECIDE)) {
      return true;
    }
    const link = await opts.pool.query(
      "SELECT employee_id FROM users WHERE id = $1",
      [user.id],
    );
    const linked = (link.rows[0] as { employee_id: string | null } | undefined)
      ?.employee_id;
    return linked === employeeId;
  }

  /** Exception scope: own linked employee, or any with attendance.read. */
  async function assertExceptionScope(
    user: { id: string; permissions: string[] },
    employeeId: string,
  ): Promise<boolean> {
    if (user.permissions.includes(S2_PERMISSIONS.ATTENDANCE_READ)) {
      return true;
    }
    const link = await opts.pool.query(
      "SELECT employee_id FROM users WHERE id = $1",
      [user.id],
    );
    const linked = (link.rows[0] as { employee_id: string | null } | undefined)
      ?.employee_id;
    return linked === employeeId;
  }

  async function todayRecord(db:Pool, employeeId: string, workDate: string) {
    const res = await db.query(
      `SELECT ${RECORD_COLS} FROM attendance_records WHERE employee_id = $1::uuid AND work_date = $2::date`,
      [employeeId, workDate],
    );
    return res.rows[0] as RecordRow | undefined;
  }

  async function recordForEvent(db:Pool, eventId: string) {
    const res = await db.query(
      `SELECT ${RECORD_COLS} FROM attendance_records
       WHERE check_in_event_id = $1::uuid OR check_out_event_id = $1::uuid`,
      [eventId],
    );
    return res.rows[0] as RecordRow | undefined;
  }

  /**
   * Hold a punch for review.
   *
   * The exception names the event it holds back, so that approving it can
   * put that punch onto the day (§078). Without the link an approval had
   * nothing to apply and the day stayed absent.
   */
  async function createSystemException(db:Pool, args: {
    employeeId: string;
    recordId: string | null;
    eventId: string;
    type: "SYSTEM_FLAG";
    reason: string;
  }): Promise<string> {
    const ins = await db.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, source, status,
          submitted_by, attendance_event_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'SYSTEM', 'PENDING', NULL, $5::uuid)
       RETURNING id`,
      [args.employeeId, args.recordId, args.type, args.reason, args.eventId],
    );
    return (ins.rows[0] as { id: string }).id;
  }

  function review(
    reply: Parameters<typeof sendError>[0],
    code:
      | "TIMESTAMP_SKEW"
      | "MOCK_LOCATION"
      | "DEVICE_SIGNAL"
      | "ON_APPROVED_LEAVE",
    exceptionId: string,
    message: string,
  ) {
    return reply.status(202).send({
      review: "REQUIRES_REVIEW",
      code,
      exception_id: exceptionId,
      message,
    });
  }

  // ------------------------------------------------ POST /attendance/events
  app.post("/api/v1/attendance/events", { preHandler: [authenticate, punchRateLimit] }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = attendanceEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const idemKey = idemKeyOr422(req, reply, req.requestId);
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
    const d = parsed.data;
    await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",['payroll:'+user.orgId]);
    await enforceRecordScope(req,'attendance.punch');

    /*
     * Punching out closes the day, and for field work the day's return is
     * part of closing it (§59, phase 2).
     *
     * The refusal is a prompt, not a rule. It only fires on a live punch --
     * one the person is making right now, with the app in their hand, where
     * being told "file the return first" is something they can act on.
     *
     * A punch that has already happened is never refused. The field has no
     * signal for hours at a stretch, so punches are made into the offline
     * queue and replayed later; the queue marks a rejected op FAILED and
     * gives up on it. Refusing one of those would delete a punch that
     * physically occurred and leave the person shown as still on site --
     * corrupt attendance, which is far worse than a late return. So a
     * replayed punch is accepted and the unfiled return is *recorded* as
     * such, which puts it on the supervisor's list instead of losing it.
     */
    // "Other" with nothing written is the same as no reason at all, and the
    // table refuses it. Say so as a validation failure rather than letting a
    // constraint violation surface as a fault.
    if (d.progress_deferred_reason === 'OTHER'
        && !d.progress_deferred_remarks?.trim()) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'Say what stopped the day\'s return being filed.',
      });
    }

    if (d.event_type === 'CHECK_OUT' && d.survey_village_id && !d.progress_deferred_reason) {
      const workDay = businessDay(new Date(d.client_timestamp));
      const filed = await db.query(
        `SELECT 1 FROM survey_entries
         WHERE survey_village_id = $1::uuid AND entry_date = $2::date`,
        [d.survey_village_id, workDay]);
      if (!filed.rowCount) {
        // Made while offline, or long enough ago that the app can no longer
        // put the question to them. Either way it is history, not a prompt.
        const ageMs = Date.now() - new Date(d.client_timestamp).getTime();
        const alreadyHappened = d.queued_offline === true || ageMs > LIVE_PUNCH_WINDOW_MS;
        if (!alreadyHappened) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: 'DAILY_PROGRESS_REQUIRED',
            message:
              `No progress has been recorded for this village on ${workDay}. `
              + 'File the day\'s return before punching out, or say why it cannot be filed.',
          });
        }
        // Recorded rather than silent: an unfiled return that nobody
        // accounted for is still an unfiled return somebody must chase.
        d.progress_deferred_reason = 'UNFILED_OFFLINE';
        d.progress_deferred_remarks = d.progress_deferred_remarks
          ?? 'Punched out without signal; the day\'s return was never filed.';
      }
    }

    // 1. Employee must exist in-org and be ACTIVE.
    const empRes = await db.query(
      `SELECT id, status FROM employees
       WHERE id = $1::uuid AND org_id = $2 FOR UPDATE`,
      [d.employee_id, user.orgId],
    );
    const emp = empRes.rows[0] as EmployeeLite | undefined;
    if (!emp || emp.status !== "ACTIVE") {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "EMPLOYEE_INACTIVE",
        message: "Employee does not exist or is not ACTIVE",
        fieldErrors: [{ field: "employee_id", message: "Employee is not active" }],
      });
    }

    // Punch scope: self-only unless attendance.decide.
    if (!(await assertPunchScope(user, emp.id))) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `You can only punch for yourself. Recording somebody else's attendance needs the "attendance.decide" permission \u2014 ask your supervisor to record it, or to grant you that permission.`,
      });
    }

    const { timeZone, settings } = await orgClock(db, user.orgId);
    const workDateFor = (date: Date) => businessDay(date, timeZone);
    const clientTime = new Date(d.client_timestamp);
    const serverNow = new Date();

    // 4 (moved before skew/future by design): duplicate Idempotency-Key replays
    // the original outcome without side effects.
    const seen = await db.query(
      `SELECT ${EVENT_COLS} FROM attendance_events
       WHERE idempotency_key = $1 AND employee_id = $2::uuid`,
      [idemKey, emp.id],
    );
    const seenRow = seen.rows[0] as EventRow | undefined;
    if (seenRow) {
      const linkedRecord =
        (await recordForEvent(db, seenRow.id)) ??
        (await todayRecord(db, emp.id, workDateFor(new Date(seenRow.server_timestamp))));
      return reply.status(200).send({
        applied: true,
        event: toEventShape(seenRow),
        record: linkedRecord ? toRecordShape(linkedRecord) : null,
      });
    }

    /*
     * Anti-fraud signals (§9.3).
     *
     * The client sends what it can observe about its own device, but a client
     * can lie about all of it, so the movement half is re-derived here from the
     * employee's own last positioned punch. `client_movement` is kept alongside
     * for comparison — a client claiming "no anomaly" while the server sees one
     * is itself interesting during a review.
     */
    let serverMovement: ReturnType<typeof detectMovementAnomaly> = null;
    if (d.latitude !== undefined && d.longitude !== undefined) {
      const prior = await db.query(
        `SELECT lat, lng, gps_accuracy, client_timestamp
           FROM attendance_events
          WHERE employee_id = $1::uuid AND lat IS NOT NULL AND lng IS NOT NULL
          ORDER BY client_timestamp DESC
          LIMIT 1`,
        [emp.id],
      );
      const previous = prior.rows[0] as
        | { lat: number; lng: number; gps_accuracy: number | null; client_timestamp: Date | string }
        | undefined;
      if (previous) {
        serverMovement = detectMovementAnomaly(
          {
            latitude: Number(previous.lat),
            longitude: Number(previous.lng),
            accuracy: previous.gps_accuracy === null ? null : Number(previous.gps_accuracy),
            timestamp: new Date(previous.client_timestamp).getTime(),
          },
          {
            latitude: d.latitude,
            longitude: d.longitude,
            accuracy: d.gps_accuracy ?? null,
            timestamp: clientTime.getTime(),
          },
        );
      }
    }
    const suspectedEmulator = d.device_signals?.device?.suspected_emulator === true;
    const storedSignals =
      d.device_signals || serverMovement
        ? {
            device: d.device_signals?.device ?? null,
            client_movement: d.device_signals?.movement ?? null,
            server_movement: serverMovement,
            flagged: suspectedEmulator || serverMovement?.impossible_travel === true,
          }
        : null;

    // 2. Skew vs server clock > 15 min → review + SYSTEM exception.
    if (Math.abs(clientTime.getTime() - serverNow.getTime()) > SKEW_MS) {
      const workDate = workDateFor(serverNow);
      const rec = await todayRecord(db, emp.id, workDate);
      const ins = await db.query(
        `INSERT INTO attendance_events
           (employee_id, event_type, client_timestamp, server_timestamp,
            lat, lng, gps_accuracy,
            mock_location, device_id, app_version, idempotency_key, device_signals,
            survey_village_id, progress_deferred_reason, progress_deferred_remarks)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
            $13::uuid,$14,$15)
         RETURNING ${EVENT_COLS}`,
        [
          emp.id,
          d.event_type,
          clientTime.toISOString(),
          serverNow.toISOString(),
          d.latitude ?? null,
          d.longitude ?? null,
          d.gps_accuracy ?? null,
          d.mock_location ?? false,
          d.device_id ?? null,
          d.app_version ?? null,
          idemKey,
          storedSignals ? JSON.stringify(storedSignals) : null,
          d.survey_village_id ?? null,
          d.progress_deferred_reason ?? null,
          d.progress_deferred_remarks ?? null,
        ],
      );
      const message = `client_timestamp differs from server time by more than ${SKEW_WINDOW_MIN} minutes; queued for review`;
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: rec?.id ?? null,
        eventId: (ins.rows[0] as EventRow).id,
        type: "SYSTEM_FLAG",
        reason: message,
      });
      return review(reply, "TIMESTAMP_SKEW", exceptionId, message);
    }

    // 3. Client timestamps in the future are rejected outright.
    if (clientTime.getTime() > serverNow.getTime()) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "FUTURE_PUNCH",
        message: "client_timestamp is in the future",
        fieldErrors: [
          { field: "client_timestamp", message: "client_timestamp cannot be in the future" },
        ],
      });
    }

    // 5. 5-minute suppression window: same (employee, event_type) recently seen.
    const recent = await db.query(
      `SELECT ${EVENT_COLS} FROM attendance_events
       WHERE employee_id = $1::uuid AND event_type = $2
         AND server_timestamp >= NOW() - ($3 || ' minutes')::interval
       ORDER BY server_timestamp DESC LIMIT 1`,
      [emp.id, d.event_type, String(settings.attendance_duplicate_minutes??DUP_WINDOW_MIN)],
    );
    const recentRow = recent.rows[0] as EventRow | undefined;
    if (recentRow) {
      const workDate = workDateFor(serverNow);
      const rec = await todayRecord(db, emp.id, workDate);
      return reply.status(200).send({
        applied: true,
        event: toEventShape(recentRow),
        record: rec ? toRecordShape(rec) : null,
      });
    }

    const workDate = workDateFor(serverNow);

    // 5b. BR-05: a locked payroll period does not accept new attendance.
    //     An authorized correction may still be made, with a recorded reason.
    const locked = await lockedPayrollRun(db, user.orgId, workDate);
    const lockError = payrollLockDecision(locked, user, d.payroll_override_reason);
    if (lockError) {
      return sendError(reply, req.requestId, lockError);
    }

    if (locked && d.payroll_override_reason) {
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "attendance.payroll_lock_override",
        entityType: "payroll_run",
        entityId: locked.id,
        afterState: { employee_id: emp.id, work_date: workDate, event_type: d.event_type },
        reason: d.payroll_override_reason,
        requestId: req.requestId,
      });
    }

    const record = await todayRecord(db, emp.id, workDate);

    // 6. CHECK_OUT needs an open check-in for the same work_date.
    if (d.event_type === "CHECK_OUT") {
      if (!record) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "CHECKOUT_WITHOUT_CHECKIN",
          message: "No open check-in found for today; file a regularization request",
          fieldErrors: [
            { field: "event_type", message: "No open check-in for this work date" },
          ],
        });
      }
      if (record.check_out_event_id) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "RECORD_CLOSED",
          message: "Today's attendance record is already closed (paired)",
          fieldErrors: [
            { field: "event_type", message: "Record already has a paired check-out" },
          ],
        });
      }
    }

    // 7. CHECK_IN while an open check-in exists for the same work_date.
    if (d.event_type === "CHECK_IN" && record) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "DUPLICATE_CHECKIN",
        message:
          "A check-in already exists for today; check out or file a regularization request",
        fieldErrors: [
          { field: "event_type", message: "Duplicate check-in for this work date" },
        ],
      });
    }

    /*
     * 8. Store the punch as it arrived.
     *
     * There is no geo-fence (decision 2026-09-22): a punch with a position
     * and one without are accepted the same way, and the position, when
     * sent, is kept as evidence rather than judged against a boundary.
     */
    async function storeEvent(): Promise<EventRow> {
      const ins = await db.query(
        `INSERT INTO attendance_events
           (employee_id, event_type, client_timestamp, server_timestamp,
            lat, lng, gps_accuracy,
            mock_location, device_id, app_version, idempotency_key, device_signals,
            survey_village_id, progress_deferred_reason, progress_deferred_remarks)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
            $13::uuid,$14,$15)
         RETURNING ${EVENT_COLS}`,
        [
          emp!.id,
          d.event_type,
          clientTime.toISOString(),
          serverNow.toISOString(),
          d.latitude ?? null,
          d.longitude ?? null,
          d.gps_accuracy ?? null,
          d.mock_location ?? false,
          d.device_id ?? null,
          d.app_version ?? null,
          idemKey,
          storedSignals ? JSON.stringify(storedSignals) : null,
          d.survey_village_id ?? null,
          d.progress_deferred_reason ?? null,
          d.progress_deferred_remarks ?? null,
        ],
      );
      return ins.rows[0] as EventRow;
    }

    /**
     * Hold this punch for review: store the event, raise the exception that
     * names it, and answer 202. Approving the exception is what puts the
     * punch onto the day.
     */
    async function holdForReview(
      code: Parameters<typeof review>[1],
      message: string,
    ) {
      const event = await storeEvent();
      const exceptionId = await createSystemException(db, {
        employeeId: emp!.id,
        recordId: record?.id ?? null,
        eventId: event.id,
        type: "SYSTEM_FLAG",
        reason: message,
      });
      return review(reply, code, exceptionId, message);
    }

    /*
     * 8b. A punch on a day of approved leave goes to review.
     *
     * Refusing it would be wrong often enough to matter -- leave gets
     * cancelled in person and the record follows days later, and somebody
     * called in on a leave day did turn up. Accepting it silently was worse:
     * payroll then paid the day twice, once as leave and once as attendance.
     * A reviewer decides which of the two stands.
     */
    const onLeave = await db.query(
      `SELECT from_date, to_date FROM leave_requests
        WHERE employee_id = $1::uuid AND status = 'APPROVED'
          AND from_date <= $2::date AND to_date >= $2::date
        LIMIT 1`,
      [emp.id, workDate],
    );
    if ((onLeave.rowCount ?? 0) > 0) {
      return holdForReview(
        "ON_APPROVED_LEAVE",
        `Punch on ${workDate}, which is covered by approved leave; queued for review. ` +
          "Cancel the leave if the day was worked.",
      );
    }

    // 9. Mock locations never auto-accept.
    if (d.mock_location === true) {
      return holdForReview(
        "MOCK_LOCATION",
        "Mock location detected; manual review required",
      );
    }

    // 9b. Emulator or impossible travel → review. Placed after mock_location
    // so the more specific MOCK_LOCATION code still wins when both apply.
    if (suspectedEmulator || serverMovement?.impossible_travel === true) {
      return holdForReview(
        "DEVICE_SIGNAL",
        serverMovement?.impossible_travel
          ? `Punch is ${serverMovement.distance_m}m from the previous one after ` +
              `${Math.round(serverMovement.elapsed_ms / 1000)}s (${serverMovement.implied_speed_mps}m/s); ` +
              "queued for review"
          : "Punch came from a device that appears to be an emulator; queued for review",
      );
    }

    // 10. Accept.
    const event = await storeEvent();
    // A check-in that finds the day already open lost a race with a
    // concurrent twin of itself (the duplicate check above ran before either
    // committed); it reports the winner as already applied rather than
    // 500ing on the unique (employee_id, work_date) key.
    const { record: finalRecord, created } = await applyPunchToDay(db, {
      employeeId: emp.id,
      workDate,
      eventType: d.event_type,
      eventId: event.id,
      at: serverNow,
      keepExisting: d.event_type === "CHECK_IN",
    });
    if (d.event_type === "CHECK_IN" && !created) {
      return reply.status(200).send({
        applied: true,
        event: toEventShape(event),
        record: toRecordShape(finalRecord),
      });
    }
    return reply.status(201).send({
      event: toEventShape(event),
      record: toRecordShape(finalRecord),
      decision: "ACCEPTED",
    });
  
});});

  // Employees can read their own history without the administrative attendance.read grant.
  app.get('/api/v1/attendance/me',{preHandler:authenticate},async(req,reply)=>{
    const parsed=recordsListQuerySchema.safeParse(req.query);
    if(!parsed.success)throw new ApiError({status:422,code:'VALIDATION_ERROR',message:'Invalid history filters',fieldErrors:toFieldErrors(parsed.error)});
    const q=parsed.data,user=req.authUser!;
    const link=(await opts.pool.query('SELECT employee_id FROM users WHERE id=$1 AND org_id=$2',[user.id,user.orgId])).rows[0];
    if(!link?.employee_id)throw new ApiError({status:404,code:'NO_EMPLOYEE_LINK',message:'No employee linked to this user'});
    const values:unknown[]=[link.employee_id],clauses=['employee_id=$1'];
    if(q.from){values.push(q.from);clauses.push('work_date>=$'+values.length+'::date');}
    if(q.to){values.push(q.to);clauses.push('work_date<=$'+values.length+'::date');}
    if(q.status){values.push(q.status);clauses.push('status=$'+values.length);}
    if(q.cursor){const c=decodeCursor<RecordCursor>(q.cursor);if(!c)throw new ApiError({status:422,code:'VALIDATION_ERROR',message:'Invalid cursor'});values.push(c.work_date,c.id);clauses.push('(work_date,id)<($'+(values.length-1)+'::date,$'+values.length+'::uuid)');}
    values.push(q.limit+1);
    const rows=(await opts.pool.query('SELECT '+RECORD_COLS+' FROM attendance_records WHERE '+clauses.join(' AND ')+' ORDER BY work_date DESC,id DESC LIMIT $'+values.length,values)).rows as RecordRow[];
    const page=rows.slice(0,q.limit).map(toRecordShape),last=page.at(-1),more=rows.length>q.limit;
    return reply.send({data:page,has_more:more,next_cursor:more&&last?encodeCursor({work_date:last.work_date,id:last.id}):null});
  });

  // ------------------------------------------------ GET /attendance/records
  app.get("/api/v1/attendance/records", { preHandler: canRead }, async (req, reply) => {
    const parsed = recordsListQuerySchema.safeParse(req.query);
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
    const { limit, cursor, employee_id, from, to, status } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["e.org_id = $1"];
    clauses.push(await employeeRestriction(opts.pool,user,values,"r.employee_id"));
    if (employee_id) {
      values.push(employee_id);
      clauses.push(`r.employee_id = $${values.length}::uuid`);
    }
    if (from) {
      values.push(from);
      clauses.push(`r.work_date >= $${values.length}::date`);
    }
    if (to) {
      values.push(to);
      clauses.push(`r.work_date <= $${values.length}::date`);
    }
    if (status) {
      values.push(status);
      clauses.push(`r.status = $${values.length}`);
    }
    if (cursor) {
      const decoded = decodeCursor<RecordCursor>(cursor);
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
      values.push(decoded.work_date, decoded.id);
      clauses.push(
        `(r.work_date, r.id) < ($${values.length - 1}::date, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT ${RECORD_COLS.split(",").map((c) => `r.${c.trim()}`).join(", ")}
       FROM attendance_records r
       JOIN employees e ON e.id = r.employee_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.work_date DESC, r.id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const hasMore = res.rows.length > limit;
    const page = res.rows.slice(0, limit) as RecordRow[];
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toRecordShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({
              work_date:
                last.work_date instanceof Date
                  ? last.work_date.toISOString().slice(0, 10)
                  : String(last.work_date).slice(0, 10),
              id: last.id,
            })
          : null,
      has_more: hasMore,
    });
  });

  /*
   * GET /attendance/events/map — positioned punches for the operations map.
   *
   * Separate from the records list because records carry no coordinates: only
   * events do, and a map needs a flat stream of positions rather than one row
   * per employee-day. Returns just what a marker needs (position, outcome,
   * time) so the payload stays small enough to cluster client-side; this is the
   * endpoint to replace with vector tiles if a deployment ever exceeds the
   * MAX_MAP_EVENTS ceiling in practice.
   */
  app.get("/api/v1/attendance/events/map", { preHandler: canRead }, async (req, reply) => {
    const parsed = mapEventsQuerySchema.safeParse(req.query);
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
    const { limit, employee_id, from, to } = parsed.data;
    const values: unknown[] = [user.orgId];
    // Coordinates are the whole point, so unpositioned events are excluded.
    const clauses = ["e.org_id = $1", "ev.lat IS NOT NULL", "ev.lng IS NOT NULL"];
    clauses.push(await employeeRestriction(opts.pool, user, values, "ev.employee_id"));
    if (employee_id) {
      values.push(employee_id);
      clauses.push(`ev.employee_id = $${values.length}::uuid`);
    }
    if (from) {
      values.push(from);
      clauses.push(`ev.client_timestamp >= $${values.length}::timestamptz`);
    }
    if (to) {
      values.push(to);
      clauses.push(`ev.client_timestamp <= $${values.length}::timestamptz`);
    }
    values.push(limit);
    const res = await opts.pool.query(
      `SELECT ev.id, ev.employee_id, ev.event_type, ev.client_timestamp,
              ev.lat, ev.lng,
              ev.mock_location, (ev.device_signals->>'flagged')::boolean AS flagged
         FROM attendance_events ev
         JOIN employees e ON e.id = ev.employee_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY ev.client_timestamp DESC
        LIMIT $${values.length}`,
      values as string[],
    );
    type MapRow = {
      id: string;
      employee_id: string;
      event_type: string;
      client_timestamp: Date | string;
      lat: number;
      lng: number;
      mock_location: boolean;
      flagged: boolean | null;
    };
    return reply.status(200).send({
      data: (res.rows as MapRow[]).map((r) => ({
        id: r.id,
        employee_id: r.employee_id,
        event_type: r.event_type,
        at: iso(r.client_timestamp),
        lat: Number(r.lat),
        lng: Number(r.lng),
        // One field the map can colour by, rather than making the client
        // re-derive precedence from separate flags.
        outcome: r.mock_location || r.flagged === true ? "review" : "ok",
      })),
      // No cursor: the map draws a bounded working set, not a paged list.
      truncated: res.rows.length === limit,
    });
  });

  // ------------------------------------------------ GET /attendance/records/:id
  app.get("/api/v1/attendance/records/:id", { preHandler: canRead }, async (req, reply) => {
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
      `SELECT ${RECORD_COLS.split(",").map((c) => `r.${c.trim()}`).join(", ")}
       FROM attendance_records r
       JOIN employees e ON e.id = r.employee_id
       WHERE r.id = $1::uuid AND e.org_id = $2`,
      [id, user.orgId],
    );
    const row = res.rows[0] as RecordRow | undefined;
    if (!row) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Attendance record not found",
      });
    }
    const events = await opts.pool.query(
      `SELECT ${EVENT_COLS} FROM attendance_events
       WHERE employee_id = $1::uuid
         AND (server_timestamp AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       ORDER BY server_timestamp ASC`,
      [
        row.employee_id,
        row.work_date instanceof Date
          ? row.work_date.toISOString().slice(0, 10)
          : String(row.work_date).slice(0, 10),
      ],
    );
    return reply.status(200).send({
      ...toRecordShape(row),
      events: (events.rows as EventRow[]).map(toEventShape),
    });
  });

  // ------------------------------------------------ POST /attendance/exceptions
  app.post("/api/v1/attendance/exceptions", { preHandler: authenticate }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = attendanceExceptionCreateSchema.safeParse(req.body);
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
    if (d.attendance_record_id) {
      const recRes = await db.query(
        "SELECT id FROM attendance_records WHERE id = $1::uuid AND employee_id = $2::uuid",
        [d.attendance_record_id, d.employee_id],
      );
      if ((recRes.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "attendance_record_id", message: "Record not found for this employee" },
          ],
        });
      }
    }
    if (!(await assertExceptionScope(user, d.employee_id))) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `That attendance record belongs to somebody else. You can raise an exception on your own attendance; anybody else's needs the "attendance.decide" permission.`,
      });
    }
    const ins = await db.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, document_id, source, status, submitted_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'USER', 'PENDING', $6::uuid)
       RETURNING ${EXCEPTION_COLS}`,
      [
        d.employee_id,
        d.attendance_record_id ?? null,
        d.exception_type,
        d.reason,
        d.document_id ?? null,
        user.id,
      ],
    );
    return reply.status(201).send(toExceptionShape(ins.rows[0] as ExceptionRow));
  
});});

  // --------------------------------- PATCH /attendance/exceptions/:id/decision
  app.patch(
    "/api/v1/attendance/exceptions/:id/decision",
    { preHandler: canDecide },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = attendanceExceptionDecisionSchema.safeParse(req.body);
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
      const curRes = await db.query(
        `SELECT ${EXCEPTION_COLS.split(",").map((c) => `x.${c.trim()}`).join(", ")}
         FROM attendance_exceptions x
         JOIN employees e ON e.id = x.employee_id
         WHERE x.id = $1::uuid AND e.org_id = $2`,
        [id, user.orgId],
      );
      const cur = curRes.rows[0] as ExceptionRow | undefined;
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Exception not found",
        });
      }
      // Self-approval guard (PRD §4): the decider cannot decide an
      // exception they submitted, unless they hold users.manage
      // (emergency override — audited below with reason = note).
      if (
        cur.submitted_by &&
        cur.submitted_by === user.id &&
        !user.permissions.includes(PERMISSIONS.USERS_MANAGE)
      ) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "SELF_DECISION",
          message: "You cannot decide an exception you submitted",
        });
      }
      /*
       * Nor an exception on their own attendance (HR-7).
       *
       * Comparing only submitted_by missed the case that matters most: a
       * punch held back by the system has no submitter, so a manager whose
       * own flagged punch was held back could simply approve it. The
       * users.manage override above cannot stand in here -- every HR manager
       * holds it, which would make the rule apply to nobody who can decide.
       * The override is the organization's explicit maker-checker emergency
       * grant, approval.self_approve, and its use is audited with the note.
       */
      const deciderEmployee = (
        await db.query("SELECT employee_id FROM users WHERE id = $1", [user.id])
      ).rows[0]?.employee_id as string | null | undefined;
      if (
        deciderEmployee &&
        deciderEmployee === cur.employee_id &&
        !user.permissions.includes("approval.self_approve")
      ) {
        return sendError(reply, req.requestId, {
          status: 403,
          code: "SELF_DECISION",
          message:
            "You cannot decide an exception on your own attendance; another approver must decide it",
        });
      }

      /*
       * What approving this would change, worked out before anything is
       * written: the payroll lock below needs its date, and a held-back punch
       * or a regularization has a date even when no record exists yet.
       */
      const effect = await exceptionEffect(db, user.orgId, cur);

      // P1 payroll lock guard: deciding an exception whose work date falls in
      // a LOCKED payroll run period is blocked. The date comes from the linked
      // record, else from the held-back punch or the regularization; an
      // exception with none of those (date unknown) skips the guard.
      for (const lockDate of new Set([effect.recordDate, effect.workDate])) {
        if (lockDate && (await lockedPayrollRun(db, user.orgId, lockDate))) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "PAYROLL_LOCKED",
            message:
              "Attendance exception cannot be decided in a locked payroll period — locked period, contact payroll",
          });
        }
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
      // Single transition only: PENDING → APPROVED | REJECTED.
      if (cur.status !== "PENDING") {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "INVALID_TRANSITION",
          message: `Exception has already been decided (${cur.status})`,
          fieldErrors: [
            { field: "status", message: `Cannot decide from status ${cur.status}` },
          ],
        });
      }
      const { decision, note } = parsed.data;
      const next = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      /*
       * Approving a punch onto a day of approved leave would pay that day
       * twice, once as leave and once as attendance. The leave has to go
       * first; rejecting the punch needs no such step.
       */
      if (next === "APPROVED" && effect.punches.length > 0) {
        const leave = await db.query(
          `SELECT id FROM leave_requests
            WHERE employee_id = $1::uuid AND status = 'APPROVED'
              AND from_date <= $2::date AND to_date >= $2::date
            LIMIT 1`,
          [cur.employee_id, effect.workDate],
        );
        if ((leave.rowCount ?? 0) > 0) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "LEAVE_CONFLICT",
            message: `${effect.workDate} is covered by approved leave. Cancel the leave first if the day was worked, or reject this exception.`,
          });
        }
      }
      const upd = await db.query(
        `UPDATE attendance_exceptions SET
           status = $2, reviewed_by = $3::uuid, reviewed_at = NOW(),
           review_note = $4, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND version = $5
         RETURNING ${EXCEPTION_COLS}`,
        [id, next, user.id, note ?? null, expectedVersion],
      );
      const row = upd.rows[0] as ExceptionRow | undefined;
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: "Version mismatch (concurrent update)",
          fieldErrors: [
            { field: "version", message: "Concurrent modification detected" },
          ],
        });
      }
      /*
       * An approval changes attendance, in the same transaction as the
       * decision, exactly as the punch would have had it been accepted when
       * it arrived. Before this an approval changed only the exception's
       * status: the day stayed absent and payroll docked it as loss of pay.
       */
      let applied = row;
      if (next === "APPROVED" && effect.punches.length > 0) {
        let recordId: string | null = null;
        for (const punch of effect.punches) {
          const { record } = await applyPunchToDay(db, {
            employeeId: cur.employee_id,
            workDate: effect.workDate!,
            eventType: punch.eventType,
            eventId: punch.eventId,
            at: punch.at,
          });
          recordId = record.id;
        }
        if (recordId && recordId !== row.attendance_record_id) {
          applied = (
            await db.query(
              `UPDATE attendance_exceptions SET attendance_record_id = $2::uuid
                WHERE id = $1::uuid RETURNING ${EXCEPTION_COLS}`,
              [row.id, recordId],
            )
          ).rows[0] as ExceptionRow;
        }
      }
      const body = toExceptionShape(applied);
      // S5 inbox (best-effort): ATTENDANCE_DECIDED to the exception
      // submitter (skipped for SYSTEM exceptions with no submitter).
      if (row.submitted_by) {
        try {
          const recip = await db.query(
            "SELECT id FROM users WHERE id = $1::uuid AND org_id = $2",
            [row.submitted_by, user.orgId],
          );
          if ((recip.rowCount ?? 0) > 0) {
            await emitNotification(db, {
              orgId: user.orgId,
              recipientId: row.submitted_by,
              type: "ATTENDANCE_DECIDED",
              title: "Attendance exception decided",
              body: `Your attendance exception was ${next.toLowerCase()}`,
              entityType: "attendance_exception",
              entityId: row.id,
            });
          }
        } catch (err) {
          console.error("attendance notification failed", err);
        }
      }
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "attendance.exception.decide",
        entityType: "attendance_exception",
        entityId: row.id,
        beforeState: toExceptionShape(cur),
        afterState: body,
        reason: note ?? null,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  // ------------------------------------------------ POST /attendance/regularize
  app.post("/api/v1/attendance/regularize", { preHandler: authenticate }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = attendanceRegularizeSchema.safeParse(req.body);
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
    if (!(await assertExceptionScope(user, d.employee_id))) {
      return sendError(reply, req.requestId, {
        status: 403,
        code: "FORBIDDEN",
        message:
          `That attendance record belongs to somebody else. You can raise an exception on your own attendance; anybody else's needs the "attendance.decide" permission.`,
      });
    }
    /*
     * A day that has not happened yet has no attendance to correct. A
     * regularization for a future date was accepted and sat in the queue,
     * and approving it would have written a day's presence before the day.
     */
    const { timeZone: regularizeTz } = await orgClock(db, user.orgId);
    if (d.work_date > businessDay(new Date(), regularizeTz)) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [
          { field: "work_date", message: "The work date cannot be in the future" },
        ],
      });
    }
    // BR-05: the same lock applies to a regularization, which is a request to
    // change attendance for a specific work date.
    const lockedRun = await lockedPayrollRun(db, user.orgId, d.work_date);
    const regularizeLockError = payrollLockDecision(
      lockedRun,
      user,
      d.payroll_override_reason,
    );
    if (regularizeLockError) {
      return sendError(reply, req.requestId, regularizeLockError);
    }
    if (lockedRun && d.payroll_override_reason) {
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "attendance.payroll_lock_override",
        entityType: "payroll_run",
        entityId: lockedRun.id,
        afterState: { employee_id: d.employee_id, work_date: d.work_date },
        reason: d.payroll_override_reason,
        requestId: req.requestId,
      });
    }

    // The claim is stored in its own columns (§078) so that approving it can
    // put those times onto the day. The same claim still rides along in the
    // reason, which is what every screen already shows a reviewer.
    const claimed: string[] = [];
    if (d.claimed_check_in) {
      claimed.push(`claimed_check_in: ${d.claimed_check_in}`);
    }
    if (d.claimed_check_out) {
      claimed.push(`claimed_check_out: ${d.claimed_check_out}`);
    }
    const reason =
      claimed.length > 0
        ? `${d.reason} [work_date: ${d.work_date}; ${claimed.join("; ")}]`
        : `${d.reason} [work_date: ${d.work_date}]`;
    const ins = await db.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, source, status, submitted_by,
          work_date, claimed_check_in, claimed_check_out)
       VALUES ($1::uuid, NULL, 'REGULARIZATION', $2, 'USER', 'PENDING', $3::uuid,
          $4::date, $5, $6)
       RETURNING ${EXCEPTION_COLS}`,
      [
        d.employee_id,
        reason,
        user.id,
        d.work_date,
        d.claimed_check_in ? new Date(d.claimed_check_in).toISOString() : null,
        d.claimed_check_out ? new Date(d.claimed_check_out).toISOString() : null,
      ],
    );
    return reply.status(201).send(toExceptionShape(ins.rows[0] as ExceptionRow));
  
});});
}
