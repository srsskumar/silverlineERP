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
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { createRateLimiter } from "../../common/rateLimit.js";
import { isInsideFence } from "../../common/geo.js";
import { detectMovementAnomaly } from "@silverline/shared";
import { sendError } from "../../common/httpErrors.js";
import { emitNotification } from "../s5/notify.js";

export interface AttendanceRoutesOptions {
  pool: Pool;
  jwtSecret: string;
  /** S6 punch cap override (default 30/min per authed user, else IP). */
  punchRateLimitMax?: number;
  punchRateLimitWindowMs?: number;
}

const SKEW_MS = SKEW_WINDOW_MIN * 60 * 1000;

// ---------------------------------------------------------------------------
// Row types + shapes (snake_case, mirroring the S1 employee/org conventions)
// ---------------------------------------------------------------------------

interface EmployeeLite {
  id: string;
  status: string;
  village_id: string | null;
  mandal_id: string | null;
  district_id: string | null;
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
  geofence_result: string;
  geofence_id: string | null;
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
  geofence_violation: boolean;
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
    geofence_result: row.geofence_result,
    geofence_id: row.geofence_id,
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
    geofence_violation: row.geofence_violation,
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
    created_at: iso(row.created_at) as string,
    updated_at: iso(row.updated_at) as string,
  };
}

const EVENT_COLS = `id, employee_id, event_type, client_timestamp,
  server_timestamp, lat, lng, gps_accuracy, geofence_result, geofence_id,
  mock_location, device_id, app_version, idempotency_key, device_signals`;

const RECORD_COLS = `id, employee_id, work_date, check_in_event_id,
  check_out_event_id, check_in_at, check_out_at, total_hours, status,
  geofence_violation`;

const EXCEPTION_COLS = `id, employee_id, attendance_record_id, exception_type,
  reason, document_id, source, status, version, submitted_by, reviewed_by,
  reviewed_at, review_note, created_at, updated_at`;

function ifMatchVersion(req: { headers: Record<string, unknown> }): number {
  const raw = req.headers["if-match"];
  const text = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const n = text === undefined || text === "" ? NaN : Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [
        {
          field: "If-Match",
          message: "If-Match header with the current version is required",
          code: "missing_version",
        },
      ],
    });
  }
  return n;
}

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

interface FenceRow {
  id: string;
  geometry_type: string;
  geometry: { lat: number; lng: number; radius_m: number } | { points: Array<[number, number]> };
  tolerance_meters: number | null;
  accuracy_threshold_meters: number | null;
}

/**
 * Resolve the applicable ACTIVE fence: employee village → parent mandal →
 * parent district (walked via org_units), falling back to the employee's
 * direct mandal/district refs when the chain is broken. Null = NO_FENCE.
 */
async function resolveFence(
  pool: Pool,
  orgId: string,
  emp: EmployeeLite,
): Promise<FenceRow | null> {
  const startIds = [emp.village_id, emp.mandal_id, emp.district_id].filter(
    (v): v is string => !!v,
  );
  if (startIds.length === 0) {
    return null;
  }
  const units = await pool.query(
    "SELECT id, type, parent_id FROM org_units WHERE org_id = $1 AND id = ANY($2::uuid[])",
    [orgId, startIds],
  );
  const byId = new Map(
    (units.rows as Array<{ id: string; type: string; parent_id: string | null }>).map(
      (u) => [u.id, u],
    ),
  );
  // Build the village → mandal → district chain, tolerating broken links by
  // falling back to the employee's direct refs.
  const chain: Array<{ type: string; id: string }> = [];
  const push = (type: string, id: string | null) => {
    if (id && !chain.some((c) => c.id === id)) {
      chain.push({ type, id });
    }
  };
  const village = emp.village_id ? byId.get(emp.village_id) : undefined;
  if (emp.village_id && (!village || village.type === "village")) {
    push("village", emp.village_id);
    const mandalId = village?.parent_id ?? emp.mandal_id;
    const mandal = mandalId ? byId.get(mandalId) : undefined;
    if (mandalId && (!mandal || mandal.type === "mandal")) {
      push("mandal", mandalId);
      push("district", mandal?.parent_id ?? emp.district_id);
    } else {
      push("district", emp.district_id);
    }
  } else if (emp.mandal_id) {
    push("mandal", emp.mandal_id);
    const mandal = byId.get(emp.mandal_id);
    push("district", mandal?.parent_id ?? emp.district_id);
  } else {
    push("district", emp.district_id);
  }
  for (const { type, id } of chain) {
    const fence = await pool.query(
      `SELECT id, geometry_type, geometry, tolerance_meters, accuracy_threshold_meters
       FROM geo_fences
       WHERE org_id = $1 AND scope_type = $2 AND scope_id = $3::uuid AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, type, id],
    );
    const row = fence.rows[0] as FenceRow | undefined;
    if (row) {
      return row;
    }
  }
  return null;
}

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
  violation: z.enum(["true", "false"]).optional(),
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

  async function createSystemException(db:Pool, args: {
    employeeId: string;
    recordId: string | null;
    type: "SYSTEM_FLAG" | "OUTSIDE_GEOFENCE";
    reason: string;
  }): Promise<string> {
    const ins = await db.query(
      `INSERT INTO attendance_exceptions
         (employee_id, attendance_record_id, exception_type, reason, source, status, submitted_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'SYSTEM', 'PENDING', NULL)
       RETURNING id`,
      [args.employeeId, args.recordId, args.type, args.reason],
    );
    return (ins.rows[0] as { id: string }).id;
  }

  function review(
    reply: Parameters<typeof sendError>[0],
    code: "TIMESTAMP_SKEW" | "POOR_ACCURACY" | "MOCK_LOCATION" | "OUTSIDE_GEOFENCE" | "DEVICE_SIGNAL",
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

    // 1. Employee must exist in-org and be ACTIVE.
    const empRes = await db.query(
      `SELECT id, status, village_id, mandal_id, district_id FROM employees
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
        message: "Insufficient permissions",
      });
    }

    const settings=(await db.query('SELECT settings FROM organizations WHERE id=$1',[user.orgId])).rows[0]?.settings??{};
    const workDateFor=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone??'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
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
            lat, lng, gps_accuracy, geofence_result, geofence_id,
            mock_location, device_id, app_version, idempotency_key, device_signals)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'NO_FENCE',NULL,$8,$9,$10,$11,$12::jsonb)
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
        ],
      );
      void ins;
      const message = `client_timestamp differs from server time by more than ${SKEW_WINDOW_MIN} minutes; queued for review`;
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: rec?.id ?? null,
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

    // 8. Resolve the applicable fence (village → mandal → district).
    const fence = await resolveFence(db, user.orgId, emp);
    const hasCoords = d.latitude !== undefined && d.longitude !== undefined;
    const inside =
      fence && hasCoords
        ? isInsideFence(
            {
              geometry_type: fence.geometry_type as "circle" | "polygon",
              geometry: fence.geometry as { lat: number; lng: number; radius_m: number } & {
                points: Array<[number, number]>;
              },
              tolerance_meters: fence.tolerance_meters,
            },
            d.latitude as number,
            d.longitude as number,
          )
        : null;
    const geoResult: string = !fence || !hasCoords ? "NO_FENCE" : inside ? "INSIDE" : "OUTSIDE";

    async function storeEvent(result: string): Promise<EventRow> {
      const ins = await db.query(
        `INSERT INTO attendance_events
           (employee_id, event_type, client_timestamp, server_timestamp,
            lat, lng, gps_accuracy, geofence_result, geofence_id,
            mock_location, device_id, app_version, idempotency_key, device_signals)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13,$14::jsonb)
         RETURNING ${EVENT_COLS}`,
        [
          emp!.id,
          d.event_type,
          clientTime.toISOString(),
          serverNow.toISOString(),
          d.latitude ?? null,
          d.longitude ?? null,
          d.gps_accuracy ?? null,
          result,
          fence?.id ?? null,
          d.mock_location ?? false,
          d.device_id ?? null,
          d.app_version ?? null,
          idemKey,
          storedSignals ? JSON.stringify(storedSignals) : null,
        ],
      );
      return ins.rows[0] as EventRow;
    }

    // 9. Poor GPS accuracy → review.
    if (
      d.gps_accuracy !== undefined &&
      fence?.accuracy_threshold_meters !== null &&
      fence?.accuracy_threshold_meters !== undefined &&
      d.gps_accuracy > Number(fence.accuracy_threshold_meters)
    ) {
      const event = await storeEvent(geoResult);
      const message = `gps_accuracy (${d.gps_accuracy}m) exceeds the fence threshold (${fence.accuracy_threshold_meters}m); queued for review`;
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: record?.id ?? null,
        type: "SYSTEM_FLAG",
        reason: message,
      });
      return review(reply, "POOR_ACCURACY", exceptionId, message);
    }

    // 10. Mock locations never auto-accept.
    if (d.mock_location === true) {
      const event = await storeEvent(geoResult);
      void event;
      const message = "Mock location detected; manual review required";
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: record?.id ?? null,
        type: "SYSTEM_FLAG",
        reason: message,
      });
      return review(reply, "MOCK_LOCATION", exceptionId, message);
    }

    // 10b. Emulator or impossible travel → review. Placed after mock_location
    // so the more specific MOCK_LOCATION code still wins when both apply.
    if (suspectedEmulator || serverMovement?.impossible_travel === true) {
      const event = await storeEvent(geoResult);
      void event;
      const message = serverMovement?.impossible_travel
        ? `Punch is ${serverMovement.distance_m}m from the previous one after ` +
          `${Math.round(serverMovement.elapsed_ms / 1000)}s (${serverMovement.implied_speed_mps}m/s); ` +
          "queued for review"
        : "Punch came from a device that appears to be an emulator; queued for review";
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: record?.id ?? null,
        type: "SYSTEM_FLAG",
        reason: message,
      });
      return review(reply, "DEVICE_SIGNAL", exceptionId, message);
    }

    // 11. Outside boundary + tolerance → review.
    if (geoResult === "OUTSIDE") {
      const event = await storeEvent("OUTSIDE");
      void event;
      const message =
        "Punch location is outside the assigned geo-fence (including tolerance); queued for review";
      const exceptionId = await createSystemException(db, {
        employeeId: emp.id,
        recordId: record?.id ?? null,
        type: "OUTSIDE_GEOFENCE",
        reason: message,
      });
      if (record) {
        await db.query(
          "UPDATE attendance_records SET geofence_violation = true, updated_at = NOW() WHERE id = $1::uuid",
          [record.id],
        );
      }
      return review(reply, "OUTSIDE_GEOFENCE", exceptionId, message);
    }

    // 12. Accept.
    const event = await storeEvent(fence && hasCoords ? "INSIDE" : "NO_FENCE");
    let finalRecord: RecordRow;
    let applied = false;
    if (d.event_type === "CHECK_IN") {
      // Concurrency-safe: bursty concurrent check-ins for the same
      // employee+date race past the suppression check; the UNIQUE
      // (employee_id, work_date) arbiter picks exactly one winner.
      // Losers re-read the winner and report ALREADY_APPLIED semantics
      // instead of 500ing on a unique violation (payroll-impacting
      // records stay exactly-one per employee+date).
      const ins = await db.query(
        `INSERT INTO attendance_records
           (employee_id, work_date, check_in_event_id, check_in_at, status, geofence_violation)
         VALUES ($1::uuid, $2::date, $3::uuid, $4, 'PARTIAL', false)
         ON CONFLICT (employee_id, work_date) DO NOTHING
         RETURNING ${RECORD_COLS}`,
        [emp.id, workDate, event.id, serverNow.toISOString()],
      );
      if ((ins.rowCount ?? 0) > 0) {
        finalRecord = ins.rows[0] as RecordRow;
      } else {
        const existing = await db.query(
          `SELECT ${RECORD_COLS} FROM attendance_records
           WHERE employee_id = $1::uuid AND work_date = $2::date`,
          [emp.id, workDate],
        );
        finalRecord = existing.rows[0] as RecordRow;
        applied = true;
      }
    } else {
      const checkInAt = new Date(record!.check_in_at as string | Date).getTime();
      const hours = Number(((serverNow.getTime() - checkInAt) / 3600000).toFixed(2));
      const upd = await db.query(
        `UPDATE attendance_records SET
           check_out_event_id = $2::uuid, check_out_at = $3,
           total_hours = $4, status = 'COMPLETE', updated_at = NOW()
         WHERE id = $1::uuid
         RETURNING ${RECORD_COLS}`,
        [record!.id, event.id, serverNow.toISOString(), hours],
      );
      finalRecord = upd.rows[0] as RecordRow;
    }
    if (applied) {
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
    const { limit, cursor, employee_id, from, to, status, violation } = parsed.data;
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
    if (violation !== undefined) {
      values.push(violation === "true");
      clauses.push(`r.geofence_violation = $${values.length}`);
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
        message: "Insufficient permissions",
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
      const expectedVersion = ifMatchVersion(req);
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
      // P1 payroll lock guard: deciding an exception whose linked record's
      // work_date falls in a LOCKED payroll run period is blocked.
      // Exceptions WITHOUT a record link (date unknown) skip the guard.
      if (cur.attendance_record_id) {
        const recRes = await db.query(
          "SELECT work_date FROM attendance_records WHERE id = $1::uuid",
          [cur.attendance_record_id],
        );
        const recRow = recRes.rows[0] as
          | { work_date: Date | string }
          | undefined;
        if (recRow) {
          const workDate =
            recRow.work_date instanceof Date
              ? recRow.work_date.toISOString().slice(0, 10)
              : String(recRow.work_date).slice(0, 10);
          const locked = await db.query(
            `SELECT id FROM payroll_runs
              WHERE org_id = $1 AND status = 'LOCKED'
                AND period_start <= $2::date AND period_end >= $2::date
              LIMIT 1`,
            [user.orgId, workDate],
          );
          if ((locked.rowCount ?? 0) > 0) {
            return sendError(reply, req.requestId, {
              status: 422,
              code: "PAYROLL_LOCKED",
              message:
                "Attendance exception cannot be decided in a locked payroll period — locked period, contact payroll",
            });
          }
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
      const body = toExceptionShape(row);
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
        actorId: user.id,
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
        message: "Insufficient permissions",
      });
    }
    // Claimed punches ride along in the reason (the S2 exception table has no
    // dedicated columns; a history/regularization table is deferred with fence history).
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
         (employee_id, attendance_record_id, exception_type, reason, source, status, submitted_by)
       VALUES ($1::uuid, NULL, 'REGULARIZATION', $2, 'USER', 'PENDING', $3::uuid)
       RETURNING ${EXCEPTION_COLS}`,
      [d.employee_id, reason, user.id],
    );
    return reply.status(201).send(toExceptionShape(ins.rows[0] as ExceptionRow));
  
});});
}
