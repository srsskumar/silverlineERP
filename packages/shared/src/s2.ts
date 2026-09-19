import { z } from "zod";
import type { RoleCode } from "./rbac.js";

/**
 * S2 contracts (Silverline ERP sprint S2): geo-fences + attendance.
 * ADDITIVE module — existing exports in other files are untouched.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const S2_PERMISSIONS = {
  GEO_READ: "geo.read",
  GEO_MANAGE: "geo.manage",
  ATTENDANCE_PUNCH: "attendance.punch",
  ATTENDANCE_READ: "attendance.read",
  ATTENDANCE_DECIDE: "attendance.decide",
} as const;

export type S2PermissionCode =
  (typeof S2_PERMISSIONS)[keyof typeof S2_PERMISSIONS];

export const S2_ALL_PERMISSIONS: string[] = Object.values(S2_PERMISSIONS);

/**
 * Additive S2 grants per system role. The seeder unions these with the
 * S0 (`ROLE_PERMISSIONS`) + S1 (`S1_ROLE_GRANTS`) maps (left unchanged).
 */
export const S2_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S2_ALL_PERMISSIONS],
  ADMIN: [...S2_ALL_PERMISSIONS],
  HR_MANAGER: [...S2_ALL_PERMISSIONS],
  PROJECT_MANAGER: [
    S2_PERMISSIONS.ATTENDANCE_READ,
    S2_PERMISSIONS.ATTENDANCE_DECIDE,
    S2_PERMISSIONS.ATTENDANCE_PUNCH,
    S2_PERMISSIONS.GEO_READ,
  ],
  TEAM_LEAD: [
    S2_PERMISSIONS.ATTENDANCE_READ,
    S2_PERMISSIONS.ATTENDANCE_DECIDE,
    S2_PERMISSIONS.ATTENDANCE_PUNCH,
    S2_PERMISSIONS.GEO_READ,
  ],
  PAYROLL_OFFICER: [],
  INVENTORY_MANAGER: [],
  EMPLOYEE: [S2_PERMISSIONS.ATTENDANCE_PUNCH],
  CLIENT_VIEWER: [],
  AUDITOR: [S2_PERMISSIONS.ATTENDANCE_READ],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[], GOVT_OBSERVER:[],
};

// ---------------------------------------------------------------------------
// Attendance pipeline tuning constants
// ---------------------------------------------------------------------------

/** Same (employee, event_type) punch inside this window is a no-op replay. */
export const DUP_WINDOW_MIN = 5;

/** |client_timestamp - server_now| beyond this forces REQUIRES_REVIEW. */
export const SKEW_WINDOW_MIN = 15;

// ---------------------------------------------------------------------------
// Geo-fences
// ---------------------------------------------------------------------------

export const geoScopeTypeSchema = z.enum([
  "district",
  "mandal",
  "village",
  "site",
]);

export type GeoScopeType = z.infer<typeof geoScopeTypeSchema>;

export const geoGeometryTypeSchema = z.enum(["circle", "polygon"]);

export type GeoGeometryType = z.infer<typeof geoGeometryTypeSchema>;

export const geoFenceStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

export type GeoFenceStatus = z.infer<typeof geoFenceStatusSchema>;

const latSchema = z
  .number({ invalid_type_error: "latitude must be a number" })
  .min(-90, "latitude must be >= -90")
  .max(90, "latitude must be <= 90");

const lngSchema = z
  .number({ invalid_type_error: "longitude must be a number" })
  .min(-180, "longitude must be <= 180")
  .max(180, "longitude must be <= 180");

export const circleGeometrySchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  radius_m: z.number().positive("radius_m must be positive").max(100000),
});

export type CircleGeometry = z.infer<typeof circleGeometrySchema>;

export const polygonGeometrySchema = z.object({
  points: z
    .array(z.tuple([latSchema, lngSchema]))
    .min(3, "polygon needs at least 3 points")
    .max(1000),
});

export type PolygonGeometry = z.infer<typeof polygonGeometrySchema>;

const fenceBase = {
  name: z.string().min(1, "Name is required").max(255),
  scope_type: geoScopeTypeSchema,
  scope_id: z.string().uuid("scope_id must be a UUID"),
  employee_ids: z.array(z.string().uuid("employee_id must be a UUID")).max(500).default([]),
  tolerance_meters: z.number().min(0).max(100000).default(0),
  accuracy_threshold_meters: z.number().positive().max(100000).optional(),
};

/** POST /api/v1/geo-fences (discriminated by geometry_type). */
export const geoFenceCreateSchema = z.union([
  z.object({
    ...fenceBase,
    geometry_type: z.literal("circle"),
    geometry: circleGeometrySchema,
  }),
  z.object({
    ...fenceBase,
    geometry_type: z.literal("polygon"),
    geometry: polygonGeometrySchema,
  }),
]);

export type GeoFenceCreateInput = z.infer<typeof geoFenceCreateSchema>;

/** PATCH /api/v1/geo-fences/:id — geometry is immutable in S2. */
export const geoFencePatchSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    tolerance_meters: z.number().min(0).max(100000).optional(),
    accuracy_threshold_meters: z.number().positive().max(100000).optional(),
    status: geoFenceStatusSchema.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.tolerance_meters !== undefined ||
      v.accuracy_threshold_meters !== undefined ||
      v.status !== undefined,
    { message: "Nothing to update" },
  );

export type GeoFencePatchInput = z.infer<typeof geoFencePatchSchema>;

// ---------------------------------------------------------------------------
// Attendance events / records / exceptions
// ---------------------------------------------------------------------------

export const attendanceEventTypeSchema = z.enum(["CHECK_IN", "CHECK_OUT"]);

export type AttendanceEventType = z.infer<typeof attendanceEventTypeSchema>;

export const geofenceResultSchema = z.enum(["INSIDE", "OUTSIDE", "NO_FENCE"]);

export type GeofenceResult = z.infer<typeof geofenceResultSchema>;

/** Punch decision union (202 review carries a machine-readable code). */
export const attendanceDecisionSchema = z.enum(["ACCEPTED", "REQUIRES_REVIEW"]);

export type AttendanceDecision = z.infer<typeof attendanceDecisionSchema>;

export const attendanceReviewCodeSchema = z.enum([
  "TIMESTAMP_SKEW",
  "POOR_ACCURACY",
  "MOCK_LOCATION",
  "OUTSIDE_GEOFENCE",
]);

export type AttendanceReviewCode = z.infer<typeof attendanceReviewCodeSchema>;

/** POST /api/v1/attendance/events */
/**
 * Device-reported anti-fraud signals. Kept permissive: an older or newer client
 * must never have a punch rejected over a telemetry field, so unknown keys are
 * simply dropped and every member is optional.
 */
export const deviceSignalsSchema = z.object({
  device: z
    .object({
      is_physical_device: z.boolean().optional(),
      device_type: z.string().max(50).nullable().optional(),
      os_name: z.string().max(50).nullable().optional(),
      os_version: z.string().max(50).nullable().optional(),
      manufacturer: z.string().max(100).nullable().optional(),
      model_name: z.string().max(100).nullable().optional(),
      os_build_id: z.string().max(200).nullable().optional(),
      suspected_emulator: z.boolean().optional(),
    })
    .optional(),
  movement: z
    .object({
      distance_m: z.number().optional(),
      elapsed_ms: z.number().optional(),
      implied_speed_mps: z.number().optional(),
      impossible_travel: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  review_suggested: z.boolean().optional(),
});

export type DeviceSignals = z.infer<typeof deviceSignalsSchema>;

export const attendanceEventSchema = z
  .object({
    employee_id: z.string().uuid("employee_id must be a UUID"),
    event_type: attendanceEventTypeSchema,
    client_timestamp: z
      .string()
      .min(1, "client_timestamp is required")
      .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid ISO timestamp"),
    latitude: latSchema.optional(),
    longitude: lngSchema.optional(),
    gps_accuracy: z.number().min(0).max(100000).optional(),
    mock_location: z.boolean().default(false),
    device_id: z.string().max(255).optional(),
    app_version: z.string().max(50).optional(),
    // Advisory anti-fraud signals from the device (requirements §9.3). Passed
    // through and stored; the server re-derives movement from its own history
    // rather than trusting the client's copy. Loose by design — platforms keep
    // adding fields, and a strict shape would reject punches from a newer app.
    device_signals: deviceSignalsSchema.optional(),
    /**
     * The village this punch is for (§59).
     *
     * Optional: an office day and a training day have no village, and every
     * punch recorded before this existed has none either.
     */
    survey_village_id: z.string().uuid().optional(),
    /**
     * Why the day's return is not being filed at punch-out.
     *
     * The specification asks that punching out require the daily progress
     * submission. Requiring it absolutely would strand a crew member with a
     * dead battery: they could not punch out, attendance would show them
     * still on site, and corrupt attendance is worse than a late return. So
     * the punch is refused until they either file the return or say why they
     * cannot, and the omission is recorded.
     */
    progress_deferred_reason: z.string().max(32).optional(),
    progress_deferred_remarks: z.string().max(2000).optional(),
    /**
     * Set by the app when this punch was made into the offline queue and is
     * being replayed now.
     *
     * A replayed punch is never refused for a missing return. The punch
     * already happened in the physical world; the queue gives up on a
     * rejected op, so refusing one would delete a real punch and leave the
     * person shown as still on site. The unfiled return is recorded instead.
     *
     * Not a security boundary -- a client that lies about this only skips a
     * prompt, and the unfiled return still appears on the supervisor's list.
     */
    queued_offline: z.boolean().optional(),
    /**
     * Reason for writing attendance into a LOCKED payroll period (BR-05).
     *
     * Ignored unless the caller also holds payroll.lock. Present so an
     * authorized correction can be made without reopening the whole run, and so
     * the audit trail records *why* the lock was overridden.
     */
    payroll_override_reason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    (v) =>
      (v.latitude === undefined && v.longitude === undefined) ||
      (v.latitude !== undefined && v.longitude !== undefined),
    {
      message: "latitude and longitude must be provided together",
      path: ["latitude"],
    },
  );

export type AttendanceEventInput = z.infer<typeof attendanceEventSchema>;

export const attendanceExceptionTypeSchema = z.enum([
  "MISSED_PUNCH",
  "LATE_CHECKIN",
  "EARLY_CHECKOUT",
  "OUTSIDE_GEOFENCE",
  "REGULARIZATION",
  "SYSTEM_FLAG",
]);

export type AttendanceExceptionType = z.infer<
  typeof attendanceExceptionTypeSchema
>;

export const attendanceExceptionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export type AttendanceExceptionStatus = z.infer<
  typeof attendanceExceptionStatusSchema
>;

/** POST /api/v1/attendance/exceptions */
export const attendanceExceptionCreateSchema = z.object({
  employee_id: z.string().uuid("employee_id must be a UUID"),
  attendance_record_id: z.string().uuid().optional(),
  exception_type: attendanceExceptionTypeSchema,
  reason: z.string().min(1, "Reason is required").max(2000),
  document_id: z.string().uuid().optional(),
});

export type AttendanceExceptionCreateInput = z.infer<
  typeof attendanceExceptionCreateSchema
>;

/** PATCH /api/v1/attendance/exceptions/:id/decision */
export const attendanceExceptionDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(2000).optional(),
});

export type AttendanceExceptionDecisionInput = z.infer<
  typeof attendanceExceptionDecisionSchema
>;

/** POST /api/v1/attendance/regularize (thin wrapper over REGULARIZATION). */
export const attendanceRegularizeSchema = z.object({
  employee_id: z.string().uuid("employee_id must be a UUID"),
  work_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "Invalid calendar date"),
  claimed_check_in: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid ISO timestamp")
    .optional(),
  claimed_check_out: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid ISO timestamp")
    .optional(),
  reason: z.string().min(1, "Reason is required").max(2000),
  /** See attendanceEventSchema.payroll_override_reason (BR-05). */
  payroll_override_reason: z.string().trim().min(1).max(2000).optional(),
});

export type AttendanceRegularizeInput = z.infer<
  typeof attendanceRegularizeSchema
>;

export const attendanceRecordStatusSchema = z.enum(["PARTIAL", "COMPLETE"]);

export type AttendanceRecordStatus = z.infer<
  typeof attendanceRecordStatusSchema
>;
