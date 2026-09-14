/**
 * Catalogue: Attendance decisions (UT-ATT-01..09).
 *
 * UT-ATT-10 (evidence watermark) is device-side and lives in
 * apps/mobile/test/catalogue.test.ts, where the burn-in helpers actually run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SKEW_WINDOW_MIN } from "@silverline/shared";
import {
  GEO,
  buildWorld,
  createActiveEmployee,
  createChain,
  createFence,
  idem,
  metresNorth,
  monthEnd,
  monthStart,
  uniq,
  workDate,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

interface PunchBody {
  event?: {
    id: string;
    geofence_result: string;
    geofence_id: string | null;
    geofence_version: number | null;
  };
  record?: { id: string; status: string; work_date: string };
  decision?: string;
  applied?: boolean;
  review?: string;
  code?: string;
  exception_id?: string;
  message?: string;
}

async function punch(
  payload: Record<string, unknown>,
  headers: Headers = w.admin,
  extraHeaders: Headers = {},
) {
  return w.app.inject({
    method: "POST",
    url: "/api/v1/attendance/events",
    headers: { ...headers, ...idem(), ...extraHeaders },
    payload: {
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      ...payload,
    },
  });
}

/**
 * A fresh employee on their own chain with a circular site fence, so each test
 * owns its attendance history (impossible-travel compares against the
 * employee's previous punch).
 */
async function freshWorker(
  fence: Record<string, unknown> = {},
): Promise<{ employeeId: string; fenceId: string }> {
  const chain = await createChain(w.app, w.admin, `A${uniq().slice(-4)}`);
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: chain.district,
    mandal_id: chain.mandal,
    village_id: chain.village,
    site_id: chain.site,
  });
  const fenceId = await createFence(w.app, w.admin, {
    name: "Worker fence",
    scope_type: "site",
    scope_id: chain.site,
    geometry_type: "circle",
    geometry: { ...GEO.circleCentre, radius_m: GEO.circleRadiusM },
    tolerance_meters: 0,
    ...fence,
  });
  return { employeeId, fenceId };
}

describe("UT-ATT-01 check in as active eligible employee inside fence", () => {
  it("creates one event and one workday record with INSIDE and the effective fence", async () => {
    const { employeeId, fenceId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 8,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as PunchBody;
    expect(body.decision).toBe("ACCEPTED");
    expect(body.event!.geofence_result).toBe("INSIDE");
    expect(body.event!.geofence_id).toBe(fenceId);

    // The fence *version* is pinned too, so a later edit to the fence cannot
    // change what this punch is understood to have meant.
    const fenceVersion = await w.pool.query("SELECT version FROM geo_fences WHERE id = $1", [
      fenceId,
    ]);
    expect(body.event!.geofence_version).toBe(fenceVersion.rows[0].version);

    expect(body.record!.status).toBe("PARTIAL");
    expect(body.record!.work_date).toBe(workDate());

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(1);
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(records.rows[0].n).toBe(1);
  });

  it("completes the workday on check-out and leaves the events immutable", async () => {
    const { employeeId } = await freshWorker();
    const checkIn = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(checkIn.statusCode).toBe(201);
    const checkInEventId = (checkIn.json() as PunchBody).event!.id;

    const checkOut = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(checkOut.statusCode).toBe(201);
    const body = checkOut.json() as PunchBody;
    expect(body.record!.status).toBe("COMPLETE");

    const record = await w.pool.query(
      "SELECT check_in_event_id, check_out_event_id, total_hours FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(record.rows[0].check_in_event_id).toBe(checkInEventId);
    expect(record.rows[0].check_out_event_id).toBe(body.event!.id);
    expect(Number(record.rows[0].total_hours)).toBeGreaterThanOrEqual(0);

    // The check-in event itself is untouched by the check-out.
    const original = await w.pool.query(
      "SELECT geofence_result, client_timestamp FROM attendance_events WHERE id = $1",
      [checkInEventId],
    );
    expect(original.rows[0].geofence_result).toBe("INSIDE");
  });

  it("records NO_FENCE rather than failing when no fence applies", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as PunchBody;
    expect(body.event!.geofence_result).toBe("NO_FENCE");
    expect(body.event!.geofence_id).toBeNull();
    expect(body.event!.geofence_version).toBeNull();
  });

  it("refuses a punch for an employee who is not ACTIVE", async () => {
    for (const employeeId of [w.suspendedEmployee, w.exitedEmployee]) {
      const res = await punch({ employee_id: employeeId });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe("EMPLOYEE_INACTIVE");
    }
  });
});

describe("UT-ATT-02 check in outside effective fence", () => {
  it("does not silently accept, and raises a review exception", async () => {
    const { employeeId, fenceId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.outsideCircle.lat,
      longitude: GEO.outsideCircle.lng,
      gps_accuracy: 8,
    });
    // 202, not 201: the punch is recorded but not accepted as normal attendance.
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.review).toBe("REQUIRES_REVIEW");
    expect(body.code).toBe("OUTSIDE_GEOFENCE");
    expect(body.exception_id).toBeTruthy();

    const event = await w.pool.query(
      `SELECT geofence_result, geofence_id FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    expect(event.rows[0].geofence_result).toBe("OUTSIDE");
    expect(event.rows[0].geofence_id).toBe(fenceId);

    // No complete workday record was manufactured from a rejected punch.
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(records.rows[0].n).toBe(0);

    const exception = await w.pool.query(
      "SELECT exception_type, status, source FROM attendance_exceptions WHERE id = $1",
      [body.exception_id],
    );
    expect(exception.rows[0].exception_type).toBe("OUTSIDE_GEOFENCE");
    expect(exception.rows[0].status).toBe("PENDING");
    expect(exception.rows[0].source).toBe("SYSTEM");
  });

  it("routes the exception to a reviewer who holds attendance.decide", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.outsideCircle.lat,
      longitude: GEO.outsideCircle.lng,
    });
    const exceptionId = (res.json() as PunchBody).exception_id!;

    // A TEAM_LEAD holds attendance.decide and can act on it; the exception is
    // not stranded with no one able to resolve it.
    const version = await w.pool.query(
      "SELECT version FROM attendance_exceptions WHERE id = $1",
      [exceptionId],
    );
    const decision = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exceptionId}/decision`,
      headers: {
        ...w.role.HR_MANAGER,
        "if-match": String(version.rows[0].version),
        ...idem(),
      },
      payload: { decision: "APPROVE", note: "Verified with the site supervisor" },
    });
    expect(decision.statusCode).toBe(200);
    const after = await w.pool.query(
      "SELECT status, reviewed_by FROM attendance_exceptions WHERE id = $1",
      [exceptionId],
    );
    expect(after.rows[0].status).toBe("APPROVED");
    expect(after.rows[0].reviewed_by).toBe(w.roleUserId.HR_MANAGER);
  });
});

describe("UT-ATT-03 punch with accuracy above threshold", () => {
  it("routes to review with a stable code when accuracy exceeds the fence threshold", async () => {
    const { employeeId } = await freshWorker({ accuracy_threshold_meters: 50 });

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 120,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.code).toBe("POOR_ACCURACY");
    // The message names both numbers so the field user can act on it.
    expect(body.message).toContain("120");
    expect(body.message).toContain("50");

    const exception = await w.pool.query(
      "SELECT exception_type, reason FROM attendance_exceptions WHERE id = $1",
      [body.exception_id],
    );
    expect(exception.rows[0].exception_type).toBe("SYSTEM_FLAG");
    expect(exception.rows[0].reason).toContain("accuracy");
  });

  it("accepts a punch whose accuracy is within the threshold", async () => {
    const { employeeId } = await freshWorker({ accuracy_threshold_meters: 50 });
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 20,
    });
    expect(res.statusCode).toBe(201);
  });

  it("applies no accuracy rule when the fence configures no threshold", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 5000,
    });
    // A fence with no configured threshold must not invent one.
    expect(res.statusCode).toBe(201);
  });

  it("still records the position and accuracy on a reviewed punch", async () => {
    const { employeeId } = await freshWorker({ accuracy_threshold_meters: 25 });
    await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 300,
    });
    const event = await w.pool.query(
      `SELECT lat, lng, gps_accuracy FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    expect(Number(event.rows[0].gps_accuracy)).toBe(300);
    expect(Number(event.rows[0].lat)).toBeCloseTo(GEO.insideCircle.lat, 5);
  });
});

describe("UT-ATT-04 punch with mock-location indicator", () => {
  it("never auto-accepts, and retains the evidence and the reason", async () => {
    const { employeeId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      mock_location: true,
    });
    // Inside the fence, good accuracy — and still not accepted, because the
    // position itself cannot be trusted.
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.code).toBe("MOCK_LOCATION");

    const event = await w.pool.query(
      `SELECT mock_location, lat, lng FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    expect(event.rows[0].mock_location).toBe(true);
    expect(Number(event.rows[0].lat)).toBeCloseTo(GEO.insideCircle.lat, 5);

    const exception = await w.pool.query(
      "SELECT reason FROM attendance_exceptions WHERE id = $1",
      [body.exception_id],
    );
    expect(exception.rows[0].reason).toMatch(/mock location/i);
  });

  it("wins over the more general device-signal code when both apply", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      mock_location: true,
      device_signals: { device: { suspected_emulator: true } },
    });
    expect(res.statusCode).toBe(202);
    // The most specific explanation is the useful one for a reviewer.
    expect((res.json() as PunchBody).code).toBe("MOCK_LOCATION");
  });

  it("flags a suspected emulator even without a mock-location flag", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      device_signals: {
        device: { suspected_emulator: true, model_name: "sdk_gphone64_arm64" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as PunchBody).code).toBe("DEVICE_SIGNAL");

    const event = await w.pool.query(
      `SELECT device_signals FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    expect(event.rows[0].device_signals.flagged).toBe(true);
  });
});

describe("UT-ATT-05 detect impossible travel", () => {
  it("creates a review signal without rejecting the punch outright", async () => {
    const { employeeId } = await freshWorker();

    // First punch establishes a position.
    const first = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 5,
      client_timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(first.statusCode).toBe(201);

    // Second punch a minute later, 900 km away. Nothing on the ground moves
    // that fast.
    const second = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: 28.6139,
      longitude: 77.209,
      gps_accuracy: 5,
      client_timestamp: new Date().toISOString(),
    });
    expect(second.statusCode).toBe(202);
    const body = second.json() as PunchBody;
    expect(body.code).toBe("DEVICE_SIGNAL");

    // The event is kept, with the derived evidence — this is a signal for a
    // human, not an autonomous accusation.
    const event = await w.pool.query(
      `SELECT device_signals, lat, lng FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    const signals = event.rows[0].device_signals as {
      server_movement: { impossible_travel: boolean; implied_speed_mps: number };
      flagged: boolean;
    };
    expect(signals.server_movement.impossible_travel).toBe(true);
    expect(signals.server_movement.implied_speed_mps).toBeGreaterThan(55);
    expect(signals.flagged).toBe(true);

    const exception = await w.pool.query(
      "SELECT status, reason FROM attendance_exceptions WHERE id = $1",
      [body.exception_id],
    );
    // PENDING, not REJECTED: a person decides.
    expect(exception.rows[0].status).toBe("PENDING");
    expect(exception.rows[0].reason).toMatch(/m\/s|queued for review/i);
  });

  it("derives the anomaly on the server rather than trusting the client's claim", async () => {
    const { employeeId } = await freshWorker();
    await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 5,
      client_timestamp: new Date(Date.now() - 60_000).toISOString(),
    });

    // The client insists everything is fine. The server checks for itself.
    const second = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: 28.6139,
      longitude: 77.209,
      gps_accuracy: 5,
      device_signals: { movement: { impossible_travel: false }, review_suggested: false },
    });
    expect(second.statusCode).toBe(202);

    const event = await w.pool.query(
      `SELECT device_signals FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    const signals = event.rows[0].device_signals as {
      client_movement: { impossible_travel: boolean };
      server_movement: { impossible_travel: boolean };
    };
    // Both are retained: a client claiming "fine" while the server disagrees is
    // itself worth seeing during a review.
    expect(signals.client_movement.impossible_travel).toBe(false);
    expect(signals.server_movement.impossible_travel).toBe(true);
  });

  it("does not flag ordinary movement", async () => {
    const { employeeId } = await freshWorker();
    await punch({
      employee_id: employeeId,
      latitude: GEO.circleCentre.lat,
      longitude: GEO.circleCentre.lng,
      gps_accuracy: 5,
      client_timestamp: new Date(Date.now() - 600_000).toISOString(),
    });
    // 150 m in ten minutes — a walk.
    const second = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.circleCentre.lat + metresNorth(150),
      longitude: GEO.circleCentre.lng,
      gps_accuracy: 5,
    });
    expect(second.statusCode).toBe(201);
  });
});

describe("UT-ATT-06 retry identical punch and retry same Idempotency-Key", () => {
  it("replays the original outcome for a repeated Idempotency-Key", async () => {
    const { employeeId } = await freshWorker();
    const key = idem();
    const payload = {
      employee_id: employeeId,
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    };

    const first = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstEventId = (first.json() as PunchBody).event!.id;

    // The network dropped the response; the client retries with the same key.
    const retry = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...key },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    const body = retry.json() as PunchBody;
    // `applied: true` at 200 is the ALREADY_APPLIED signal the mobile client
    // maps onto its SYNCED terminal state.
    expect(body.applied).toBe(true);
    expect(body.event!.id).toBe(firstEventId);

    // Exactly one event and one payroll-bearing record.
    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(1);
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(records.rows[0].n).toBe(1);
  });

  it("suppresses an identical punch repeated with a different key", async () => {
    const { employeeId } = await freshWorker();
    const payload = {
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    };
    const first = await punch(payload);
    expect(first.statusCode).toBe(201);

    // A double-tap with a fresh key falls inside the suppression window rather
    // than creating a second event.
    const second = await punch(payload);
    expect(second.statusCode).toBe(200);
    expect((second.json() as PunchBody).applied).toBe(true);

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it("rejects a punch with no Idempotency-Key at all", async () => {
    const { employeeId } = await freshWorker();
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: w.admin,
      payload: {
        employee_id: employeeId,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("replays a reviewed outcome too, without raising a second exception", async () => {
    const { employeeId } = await freshWorker();
    const key = idem();
    const payload = {
      employee_id: employeeId,
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      latitude: GEO.outsideCircle.lat,
      longitude: GEO.outsideCircle.lng,
    };
    const first = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...key },
      payload,
    });
    expect(first.statusCode).toBe(202);

    const retry = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...key },
      payload,
    });
    // A review outcome replays as the same 202, not as an "applied" 200: the
    // punch still needs a human, and telling the client it was accepted would
    // make the app hide a pending exception.
    expect(retry.statusCode).toBe(202);
    expect((retry.json() as PunchBody).exception_id).toBe(
      (first.json() as PunchBody).exception_id,
    );

    // The replay is still side-effect free — one exception, one event.
    const exceptions = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_exceptions WHERE employee_id = $1",
      [employeeId],
    );
    expect(exceptions.rows[0].n).toBe(1);
    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(1);
  });
});

describe("UT-ATT-07 check out without check in and duplicate check in", () => {
  it("rejects a check-out with no open check-in", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("CHECKOUT_WITHOUT_CHECKIN");

    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(records.rows[0].n).toBe(0);
  });

  it("rejects a second check-in for the same work date", async () => {
    const { employeeId } = await freshWorker();
    expect(
      (
        await punch({
          employee_id: employeeId,
          latitude: GEO.insideCircle.lat,
          longitude: GEO.insideCircle.lng,
        })
      ).statusCode,
    ).toBe(201);

    // Step outside the suppression window by clearing the recent event's
    // server timestamp, so this exercises the duplicate rule rather than the
    // replay one.
    await w.pool.query(
      "UPDATE attendance_events SET server_timestamp = NOW() - INTERVAL '30 minutes' WHERE employee_id = $1",
      [employeeId],
    );

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("DUPLICATE_CHECKIN");
  });

  it("rejects a check-out on an already closed record", async () => {
    const { employeeId } = await freshWorker();
    await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    await w.pool.query(
      "UPDATE attendance_events SET server_timestamp = NOW() - INTERVAL '30 minutes' WHERE employee_id = $1",
      [employeeId],
    );

    const res = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("RECORD_CLOSED");
  });

  it("leaves attendance state valid after every rejection", async () => {
    const { employeeId } = await freshWorker();
    await punch({ employee_id: employeeId, event_type: "CHECK_OUT" });
    await punch({ employee_id: employeeId, event_type: "CHECK_OUT" });

    const records = await w.pool.query(
      "SELECT status, check_in_event_id, check_out_event_id FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    // Nothing half-built: a rejected check-out leaves no record behind.
    expect(records.rowCount).toBe(0);
  });
});

describe("UT-ATT-08 punch with client clock beyond skew window", () => {
  it("routes to review and keeps both timestamps", async () => {
    const { employeeId } = await freshWorker();
    const skewMs = (SKEW_WINDOW_MIN + 5) * 60 * 1000;
    const clientTime = new Date(Date.now() - skewMs);

    const res = await punch({
      employee_id: employeeId,
      client_timestamp: clientTime.toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.code).toBe("TIMESTAMP_SKEW");
    expect(body.message).toContain(String(SKEW_WINDOW_MIN));

    const event = await w.pool.query(
      `SELECT client_timestamp, server_timestamp FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    // Both are retained, so a reviewer can see exactly how far the device's
    // clock had drifted.
    expect(new Date(event.rows[0].client_timestamp).getTime()).toBeCloseTo(
      clientTime.getTime(),
      -3,
    );
    const gap =
      new Date(event.rows[0].server_timestamp).getTime() -
      new Date(event.rows[0].client_timestamp).getTime();
    expect(gap).toBeGreaterThan(SKEW_WINDOW_MIN * 60 * 1000);
  });

  it("accepts a punch inside the skew window", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      client_timestamp: new Date(Date.now() - 60_000).toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a client timestamp in the future outright", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      client_timestamp: new Date(Date.now() + 60_000).toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    // Not a review: a punch cannot have happened yet.
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("FUTURE_PUNCH");
  });
});

describe("UT-ATT-09 punch after payroll lock", () => {
  /** Locks a run covering today, so today's punches fall inside a locked period. */
  async function lockCurrentPeriod(): Promise<string> {
    const runId = (
      await w.pool.query(
        `INSERT INTO payroll_runs (org_id, period_start, period_end, status, created_by)
         VALUES ($1, $2::date, $3::date, 'LOCKED', $4) RETURNING id`,
        [w.orgId, monthStart(), monthEnd(), w.adminId],
      )
    ).rows[0].id as string;
    return runId;
  }

  let lockedRunId: string;

  beforeEach(async () => {
    await w.pool.query("DELETE FROM payroll_runs WHERE org_id = $1 AND status = 'LOCKED'", [
      w.orgId,
    ]);
    lockedRunId = await lockCurrentPeriod();
  });

  afterAll(async () => {
    await w.pool.query("DELETE FROM payroll_runs WHERE org_id = $1 AND status = 'LOCKED'", [
      w.orgId,
    ]);
  });

  it("rejects an ordinary punch into a locked period", async () => {
    const { employeeId } = await freshWorker();
    // HR_MANAGER can punch on an employee's behalf but holds no payroll.lock.
    const res = await punch(
      {
        employee_id: employeeId,
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
      w.role.HR_MANAGER,
    );
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("PAYROLL_LOCKED");
    expect(body.message).toMatch(/contact payroll/i);

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("tells a payroll-authorized caller that a reason is required", async () => {
    const { employeeId } = await freshWorker();
    // The seeded admin holds payroll.lock, so the override is available — but
    // only once it carries a reason worth auditing.
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; field_errors?: Array<{ field: string }> };
    expect(body.code).toBe("PAYROLL_LOCKED");
    expect(body.field_errors?.[0]?.field).toBe("payroll_override_reason");
  });

  it("refuses an override from a caller without payroll.lock, reason or not", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch(
      {
        employee_id: employeeId,
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
        payroll_override_reason: "I would like to bypass this",
      },
      w.role.HR_MANAGER,
    );
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("PAYROLL_LOCKED");
    // Supplying a reason does not confer the authority to use one.
    expect(body.message).toMatch(/contact payroll/i);

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [employeeId],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("allows an authorized override that carries a reason, and audits it", async () => {
    const { employeeId } = await freshWorker();
    const reason = "Missed punch corrected after payroll sign-off, approved by the site manager";

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      payroll_override_reason: reason,
    });
    expect(res.statusCode).toBe(201);

    const audit = await w.pool.query(
      `SELECT actor_id, reason FROM audit_events
        WHERE action = 'attendance.payroll_lock_override' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [lockedRunId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(w.adminId);
    expect(audit.rows[0].reason).toBe(reason);
  });

  it("applies the same rule to a regularization request", async () => {
    const { employeeId } = await freshWorker();
    const blocked = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: { ...w.role.HR_MANAGER, ...idem() },
      payload: {
        employee_id: employeeId,
        work_date: workDate(),
        reason: "Forgot to punch in",
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { code: string }).code).toBe("PAYROLL_LOCKED");

    const allowed = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employeeId,
        work_date: workDate(),
        reason: "Forgot to punch in",
        payroll_override_reason: "Correcting a verified omission after lock",
      },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("leaves punches outside the locked period alone", async () => {
    // A run locked over a period that does not contain today must not block
    // today's attendance.
    await w.pool.query("DELETE FROM payroll_runs WHERE id = $1", [lockedRunId]);
    await w.pool.query(
      `INSERT INTO payroll_runs (org_id, period_start, period_end, status, created_by)
       VALUES ($1, '2020-01-01'::date, '2020-01-31'::date, 'LOCKED', $2)`,
      [w.orgId, w.adminId],
    );

    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(201);
  });
});
