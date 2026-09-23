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
  event?: { id: string; latitude: number | null; gps_accuracy: number | null };
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
 * A fresh employee on their own chain, so each test owns its attendance
 * history (impossible-travel compares against the employee's previous punch).
 */
async function freshWorker(): Promise<{ employeeId: string }> {
  const chain = await createChain(w.app, w.admin, `A${uniq().slice(-4)}`);
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: chain.district,
    mandal_id: chain.mandal,
    village_id: chain.village,
    site_id: chain.site,
  });
  return { employeeId };
}

describe("UT-ATT-01 check in as active eligible employee with a position", () => {
  it("creates one event and one workday record, keeping the position as evidence", async () => {
    const { employeeId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 8,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as PunchBody;
    expect(body.decision).toBe("ACCEPTED");
    // There is no fence to pass: the position is stored, not judged, and the
    // response no longer carries a fence verdict at all.
    expect(body.event!.latitude).toBeCloseTo(GEO.atSite.lat, 5);
    expect(body.event!.gps_accuracy).toBe(8);
    expect(body.event).not.toHaveProperty("geofence_result");
    expect(body.event).not.toHaveProperty("geofence_id");

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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    expect(checkIn.statusCode).toBe(201);
    const checkInEventId = (checkIn.json() as PunchBody).event!.id;

    const checkOut = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      "SELECT lat, client_timestamp FROM attendance_events WHERE id = $1",
      [checkInEventId],
    );
    expect(Number(original.rows[0].lat)).toBeCloseTo(GEO.atSite.lat, 5);
  });

  it("accepts a punch with no position exactly as it accepts one with", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const res = await punch({ employee_id: employeeId });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as PunchBody;
    expect(body.decision).toBe("ACCEPTED");
    expect(body.event!.latitude).toBeNull();
    expect(body.record!.status).toBe("PARTIAL");
  });

  it("leaves the retired fence columns at their defaults", async () => {
    // The columns stay for the rows written while fencing existed; a new
    // punch must not look like it was ever judged against a boundary.
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.awayFromSite.lat,
      longitude: GEO.awayFromSite.lng,
    });
    expect(res.statusCode).toBe(201);
    const event = await w.pool.query(
      "SELECT geofence_result, geofence_id, geofence_version FROM attendance_events WHERE id = $1",
      [(res.json() as PunchBody).event!.id],
    );
    expect(event.rows[0]).toEqual({ geofence_result: "NO_FENCE", geofence_id: null, geofence_version: null });
    const record = await w.pool.query(
      "SELECT geofence_violation FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(record.rows[0].geofence_violation).toBe(false);
  });

  it("refuses a punch for an employee who is not ACTIVE", async () => {
    for (const employeeId of [w.suspendedEmployee, w.exitedEmployee]) {
      const res = await punch({ employee_id: employeeId });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe("EMPLOYEE_INACTIVE");
    }
  });
});

describe("a punch held back for review", () => {
  // UT-ATT-02 (outside the fence) and UT-ATT-03 (accuracy above the fence's
  // threshold) are retired with the geo-fence. What they also pinned -- that
  // a held-back punch raises a PENDING system exception somebody with
  // attendance.decide can act on -- still holds for the holds that remain,
  // and is kept here against the mock-location hold.
  it("does not silently accept, and raises a review exception", async () => {
    const { employeeId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 8,
      mock_location: true,
    });
    // 202, not 201: the punch is recorded but not accepted as normal attendance.
    expect(res.statusCode).toBe(202);
    const body = res.json() as PunchBody;
    expect(body.review).toBe("REQUIRES_REVIEW");
    expect(body.code).toBe("MOCK_LOCATION");
    expect(body.exception_id).toBeTruthy();

    // No complete workday record was manufactured from a held punch.
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [employeeId],
    );
    expect(records.rows[0].n).toBe(0);

    const exception = await w.pool.query(
      "SELECT exception_type, status, source FROM attendance_exceptions WHERE id = $1",
      [body.exception_id],
    );
    expect(exception.rows[0].exception_type).toBe("SYSTEM_FLAG");
    expect(exception.rows[0].status).toBe("PENDING");
    expect(exception.rows[0].source).toBe("SYSTEM");
  });

  it("routes the exception to a reviewer who holds attendance.decide", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      mock_location: true,
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

describe("GPS accuracy", () => {
  it("is stored, never judged: a wide accuracy circle is still an accepted punch", async () => {
    // The accuracy threshold belonged to the fence and went with it.
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 5000,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as PunchBody).event!.gps_accuracy).toBe(5000);
  });

  it("still records the position and accuracy on a held-back punch", async () => {
    const { employeeId } = await freshWorker();
    await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      gps_accuracy: 300,
      mock_location: true,
    });
    const event = await w.pool.query(
      `SELECT lat, lng, gps_accuracy FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employeeId],
    );
    expect(Number(event.rows[0].gps_accuracy)).toBe(300);
    expect(Number(event.rows[0].lat)).toBeCloseTo(GEO.atSite.lat, 5);
  });
});

describe("UT-ATT-04 punch with mock-location indicator", () => {
  it("never auto-accepts, and retains the evidence and the reason", async () => {
    const { employeeId } = await freshWorker();

    const res = await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
    expect(Number(event.rows[0].lat)).toBeCloseTo(GEO.atSite.lat, 5);

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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.site.lat,
      longitude: GEO.site.lng,
      gps_accuracy: 5,
      client_timestamp: new Date(Date.now() - 600_000).toISOString(),
    });
    // 150 m in ten minutes — a walk.
    const second = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.site.lat + metresNorth(150),
      longitude: GEO.site.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
      // The hold that is left once the fence is gone.
      mock_location: true,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
          latitude: GEO.atSite.lat,
          longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("DUPLICATE_CHECKIN");
  });

  it("rejects a check-out on an already closed record", async () => {
    const { employeeId } = await freshWorker();
    await punch({
      employee_id: employeeId,
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    await w.pool.query(
      "UPDATE attendance_events SET server_timestamp = NOW() - INTERVAL '30 minutes' WHERE employee_id = $1",
      [employeeId],
    );

    const res = await punch({
      employee_id: employeeId,
      event_type: "CHECK_OUT",
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a client timestamp in the future outright", async () => {
    const { employeeId } = await freshWorker();
    const res = await punch({
      employee_id: employeeId,
      client_timestamp: new Date(Date.now() + 60_000).toISOString(),
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
        latitude: GEO.atSite.lat,
        longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
        latitude: GEO.atSite.lat,
        longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
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
      latitude: GEO.atSite.lat,
      longitude: GEO.atSite.lng,
    });
    expect(res.statusCode).toBe(201);
  });
});
