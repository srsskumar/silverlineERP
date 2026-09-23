import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/createApp.js";
import { migrate } from "../src/database/migrate.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  seedDatabase,
} from "../src/database/seed.js";
import { FUTURE_TOLERANCE_MIN, toUtm } from "@silverline/shared";
import { geoidHeight } from "../src/common/geoid.js";

process.env["UPLOADS_DIR"] = join(tmpdir(), `sl-s2-test-${process.pid}`);

const TEST_DB = testDatabaseUrl();
const JWT_SECRET = "test-secret-change-me";

let app: FastifyInstance;
let pool: Pool;
let orgId = "";
let seq = 0;
let keySeq = 0;

const CENTER = { lat: 12.9716, lng: 77.5946 };
const FAR = { lat: 13.5, lng: 78.5 };

function nextKey(): string {
  keySeq += 1;
  return `s2key-${Date.now()}-${process.pid}-${keySeq}`;
}

async function truncateAll(): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
}

async function createUser(opts: {
  username: string;
  password: string;
  roles?: string[];
}): Promise<string> {
  const hash = await bcrypt.hash(opts.password, 4);
  const res = await pool.query(
    `INSERT INTO users (org_id, username, password_hash, auth_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [orgId, opts.username, hash],
  );
  const id = (res.rows[0] as { id: string }).id;
  for (const code of opts.roles ?? []) {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [code]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      id,
      (role.rows[0] as { id: string }).id,
    ]);
  }
  return id;
}

async function headersFor(username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}

async function adminHeaders() {
  return headersFor(ADMIN_USERNAME, ADMIN_PASSWORD);
}

async function roleHeaders(role: string) {
  const u = `s2_${role.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await createUser({ username: u, password: "Pass1234!", roles: [role] });
  return headersFor(u, "Pass1234!");
}

function empPayload(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    emp_no: `S2E${String(seq).padStart(4, "0")}`,
    first_name: "S2",
    last_name: "User",
    phone: `+9180000${String(10000 + seq)}`,
    date_of_joining: "2024-01-15",
    ...over,
  };
}

async function createUnit(headers: Record<string, string>, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/org/units", headers, payload: body });
}

async function unitChain(headers: Record<string, string>, tag: string) {
  seq += 1;
  const d = await createUnit(headers, { type: "district", code: `SD${tag}${seq}`, name: "D" });
  const district = (d.json() as { id: string }).id;
  const m = await createUnit(headers, {
    type: "mandal",
    code: `SM${tag}${seq}`,
    name: "M",
    parent_id: district,
  });
  const mandal = (m.json() as { id: string }).id;
  const v = await createUnit(headers, {
    type: "village",
    code: `SV${tag}${seq}`,
    name: "V",
    parent_id: mandal,
  });
  const village = (v.json() as { id: string }).id;
  const s = await createUnit(headers, {
    type: "site",
    code: `SS${tag}${seq}`,
    name: "S",
    parent_id: village,
  });
  const site = (s.json() as { id: string }).id;
  return { district, mandal, village, site };
}

async function activeEmployee(headers: Record<string, string>, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers,
    payload: empPayload(over),
  });
  expect(res.statusCode).toBe(201);
  const emp = res.json() as { id: string };
  const exit = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${emp.id}/exit`,
    headers,
    payload: { exit_date: "2024-06-01", reason: "s2-helper" },
  });
  expect(exit.statusCode).toBe(200);
  const re = await app.inject({
    method: "POST",
    url: `/api/v1/employees/${emp.id}/reactivate`,
    headers,
    payload: { reason: "s2-helper" },
  });
  expect(re.statusCode).toBe(200);
  return (re.json() as { id: string }).id;
}

async function punch(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  key?: string,
) {
  const h: Record<string, string> = { ...headers };
  if (key !== undefined) {
    h["Idempotency-Key"] = key;
  }
  return app.inject({ method: "POST", url: "/api/v1/attendance/events", headers: h, payload: body });
}

function checkinBody(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employee_id: employeeId,
    event_type: "CHECK_IN",
    client_timestamp: new Date().toISOString(),
    latitude: CENTER.lat,
    longitude: CENTER.lng,
    gps_accuracy: 10,
    ...over,
  };
}

beforeAll(async () => {
  await migrate(TEST_DB);
  pool = new Pool({ connectionString: TEST_DB });
  app = await buildApp({
    databaseUrl: TEST_DB,
    jwtSecret: JWT_SECRET,
    loginRateLimitMax: 1000,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll();
  const seed = await seedDatabase(pool, { bcryptRounds: 4 });
  orgId = seed.orgId;
  seq = 0;
});

// ---------------------------------------------------------- fence routes

describe("geo-fence routes", () => {
  // Silverline has no geo-fencing (decision 2026-09-22). The routes are gone,
  // not merely closed: an administrator gets the same 404 as anybody else.
  it("no longer exist, for anybody", async () => {
    const h = await adminHeaders();
    for (const url of ["/api/v1/geo-fences", "/api/v1/geo-fences/effective"]) {
      const res = await app.inject({ method: "GET", url, headers: h });
      expect(res.statusCode, url).toBe(404);
    }
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...h, "Idempotency-Key": nextKey() },
      payload: { name: "Gate", geometry_type: "circle", geometry: { lat: 1, lng: 1, radius_m: 10 } },
    });
    expect(post.statusCode).toBe(404);
  });

  it("no longer seed the fence permissions", async () => {
    const codes = await pool.query(
      "SELECT code FROM permissions WHERE code IN ('geo.read', 'geo.manage')",
    );
    expect(codes.rowCount).toBe(0);
    const grants = await pool.query(
      "SELECT 1 FROM role_permissions WHERE permission_code IN ('geo.read', 'geo.manage')",
    );
    expect(grants.rowCount).toBe(0);
  });

  it("keep the place search for the people who read the register", async () => {
    // Kept for the place names attendance is about to attach to punches. The
    // fence permissions went with the fences, so the register's read grant
    // is what opens it; an EMPLOYEE, who reads nobody's register, is refused.
    const employee = await roleHeaders("EMPLOYEE");
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/geo/search?q=hyderabad",
      headers: employee,
    });
    expect(denied.statusCode).toBe(403);
    const h = await adminHeaders();
    const tooShort = await app.inject({ method: "GET", url: "/api/v1/geo/search?q=a", headers: h });
    expect(tooShort.statusCode).toBe(422);
  });
});

// ------------------------------------------------------------------ punches

describe("attendance punches", () => {
  it("accepts a positioned check-in (201 ACCEPTED + PARTIAL record)", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "F");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(h, checkinBody(empId), nextKey());
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      decision: string;
      event: { id: string; latitude: number; gps_accuracy: number };
      record: { status: string; work_date: string };
    };
    expect(body.decision).toBe("ACCEPTED");
    expect(body.event.latitude).toBeCloseTo(CENTER.lat, 5);
    expect(body.event.gps_accuracy).toBe(10);
    expect(body.event).not.toHaveProperty("geofence_result");
    expect(body.record.status).toBe("PARTIAL");
  });

  it("records the punch request's IP and user agent (migration 088)", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "F2");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...h, "Idempotency-Key": nextKey(), "user-agent": "sl-test-agent/1.0" },
      payload: checkinBody(empId),
      remoteAddress: "198.51.100.23",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { event: { id: string; ip_address: string | null } };
    // Surfaced on the response the same way place_name and the UTM fields are.
    expect(body.event.ip_address).toBe("198.51.100.23");
    const stored = await pool.query(
      "SELECT ip_address, user_agent FROM attendance_events WHERE id = $1::uuid",
      [body.event.id],
    );
    expect(stored.rows[0].ip_address).toBe("198.51.100.23");
    expect(stored.rows[0].user_agent).toBe("sl-test-agent/1.0");
  });

  it("accepts a check-in with no position the same way", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "G");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const body = checkinBody(empId) as Record<string, unknown>;
    delete body.latitude;
    delete body.longitude;
    delete body.gps_accuracy;
    const res = await punch(h, body, nextKey());
    expect(res.statusCode).toBe(201);
    const json = res.json() as { decision: string; event: { latitude: number | null } };
    expect(json.decision).toBe("ACCEPTED");
    expect(json.event.latitude).toBeNull();
  });

  it("accepts a punch from anywhere: there is no boundary to be outside of", async () => {
    // Before 2026-09-22 this position, 550 km from the village, was a 202
    // OUTSIDE_GEOFENCE with a pending exception. Now it is an ordinary punch
    // whose position is kept as evidence; the retired columns stay default.
    const h = await adminHeaders();
    const ids = await unitChain(h, "I");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(
      h,
      checkinBody(empId, { latitude: FAR.lat, longitude: FAR.lng }),
      nextKey(),
    );
    expect(res.statusCode).toBe(201);
    const stored = await pool.query(
      `SELECT lat, geofence_result, geofence_id, geofence_version FROM attendance_events
        WHERE employee_id = $1::uuid`,
      [empId],
    );
    const row = stored.rows[0] as {
      lat: string; geofence_result: string; geofence_id: string | null; geofence_version: number | null;
    };
    expect(Number(row.lat)).toBeCloseTo(FAR.lat, 5);
    expect(row.geofence_result).toBe("NO_FENCE");
    expect(row.geofence_id).toBeNull();
    expect(row.geofence_version).toBeNull();
    const exceptions = await pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_exceptions WHERE employee_id = $1::uuid",
      [empId],
    );
    expect((exceptions.rows[0] as { n: number }).n).toBe(0);
  });

  it("flags an emulator device for review (202 DEVICE_SIGNAL)", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "EMU");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(
      h,
      checkinBody(empId, {
        device_signals: {
          device: { is_physical_device: false, suspected_emulator: true, model_name: "sdk_gphone64_arm64" },
          review_suggested: true,
        },
      }),
      nextKey(),
    );
    expect(res.statusCode).toBe(202);
    const body = res.json() as { review: string; code: string; exception_id: string };
    expect(body.review).toBe("REQUIRES_REVIEW");
    expect(body.code).toBe("DEVICE_SIGNAL");
    const stored = await pool.query(
      "SELECT device_signals FROM attendance_events WHERE employee_id = $1::uuid",
      [empId],
    );
    const signals = stored.rows[0] as { device_signals: { flagged: boolean } };
    expect(signals.device_signals.flagged).toBe(true);
  });

  it("derives impossible travel from its own history, not the client's claim", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "TRV");
    const empId = await activeEmployee(h, { village_id: ids.village });

    // First punch establishes the reference position, backdated 30s so the
    // second one is still in the past (future timestamps are rejected as 422).
    const first = await punch(
      h,
      checkinBody(empId, { client_timestamp: new Date(Date.now() - 30_000).toISOString() }),
      nextKey(),
    );
    expect(first.statusCode).toBe(201);

    // Second punch ~550 km away 30s later. The client claims everything is
    // fine; the server must reach its own conclusion from the stored history.
    const res = await punch(
      h,
      checkinBody(empId, {
        event_type: "CHECK_OUT",
        latitude: FAR.lat,
        longitude: FAR.lng,
        device_signals: { movement: { impossible_travel: false }, review_suggested: false },
      }),
      nextKey(),
    );
    expect(res.statusCode).toBe(202);
    const body = res.json() as { code: string };
    expect(body.code).toBe("DEVICE_SIGNAL");

    const stored = await pool.query(
      `SELECT device_signals FROM attendance_events
        WHERE employee_id = $1::uuid AND event_type = 'CHECK_OUT'`,
      [empId],
    );
    const row = stored.rows[0] as {
      device_signals: {
        flagged: boolean;
        server_movement: { impossible_travel: boolean };
        client_movement: { impossible_travel: boolean };
      };
    };
    expect(row.device_signals.server_movement.impossible_travel).toBe(true);
    // The client's contradicting claim is retained for the reviewer.
    expect(row.device_signals.client_movement.impossible_travel).toBe(false);
    expect(row.device_signals.flagged).toBe(true);
  });

  it("accepts a clean punch from a physical device without flagging", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "OK");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(
      h,
      checkinBody(empId, {
        device_signals: {
          device: { is_physical_device: true, suspected_emulator: false, model_name: "Pixel 7a" },
          movement: null,
          review_suggested: false,
        },
      }),
      nextKey(),
    );
    expect(res.statusCode).toBe(201);
    const stored = await pool.query(
      "SELECT device_signals FROM attendance_events WHERE employee_id = $1::uuid",
      [empId],
    );
    const row = stored.rows[0] as { device_signals: { flagged: boolean } };
    expect(row.device_signals.flagged).toBe(false);
  });

  it("serves positioned punches to the operations map with an outcome", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "MAP");
    const clean = await activeEmployee(h, { village_id: ids.village });
    const mocked = await activeEmployee(h, { village_id: ids.village });

    expect((await punch(h, checkinBody(clean), nextKey())).statusCode).toBe(201);
    expect(
      (await punch(h, checkinBody(mocked, { mock_location: true }), nextKey())).statusCode,
    ).toBe(202);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/attendance/events/map",
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: Array<{ id: string; lat: number; lng: number; outcome: string; geofence_result?: string }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.data.length).toBe(2);
    // Every marker carries usable coordinates.
    for (const row of body.data) {
      expect(typeof row.lat).toBe("number");
      expect(typeof row.lng).toBe("number");
    }
    const outcomes = body.data.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["ok", "review"]);
    // The fence verdict is gone from the marker, not merely blank.
    for (const row of body.data) {
      expect(row).not.toHaveProperty("geofence_result");
    }
  });

  it("omits punches with no coordinates from the map", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "NOGPS");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const body = checkinBody(empId) as Record<string, unknown>;
    delete body.latitude;
    delete body.longitude;
    delete body.gps_accuracy;
    expect((await punch(h, body, nextKey())).statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attendance/events/map?employee_id=${empId}`,
      headers: h,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toEqual([]);
  });

  it("rejects a map page size above the ceiling", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/attendance/events/map?limit=99999",
      headers: h,
    });
    expect(res.statusCode).toBe(422);
  });

  it("stores poor accuracy as evidence rather than holding the punch", async () => {
    // The accuracy threshold belonged to the fence and went with it.
    const h = await adminHeaders();
    const ids = await unitChain(h, "J");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(h, checkinBody(empId, { gps_accuracy: 500 }), nextKey());
    expect(res.statusCode).toBe(201);
    expect((res.json() as { event: { gps_accuracy: number } }).event.gps_accuracy).toBe(500);
  });

  it("reviews mock locations (202 MOCK_LOCATION, never auto-accepts)", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "K");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const res = await punch(h, checkinBody(empId, { mock_location: true }), nextKey());
    expect(res.statusCode).toBe(202);
    expect((res.json() as { code: string }).code).toBe("MOCK_LOCATION");
  });

  it("reviews 30-minute skew (202 TIMESTAMP_SKEW + SYSTEM_FLAG)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const skewed = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const res = await punch(h, checkinBody(empId, { client_timestamp: skewed }), nextKey());
    expect(res.statusCode).toBe(202);
    const body = res.json() as { code: string; exception_id: string };
    expect(body.code).toBe("TIMESTAMP_SKEW");
    const db = await pool.query(
      "SELECT exception_type, source FROM attendance_exceptions WHERE id = $1::uuid",
      [body.exception_id],
    );
    expect((db.rows[0] as { exception_type: string }).exception_type).toBe("SYSTEM_FLAG");
    expect((db.rows[0] as { source: string }).source).toBe("SYSTEM");
  });

  it("UT-ATT-11 rejects future punches (422 FUTURE_PUNCH) and says how far ahead the clock is", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const future = new Date(Date.now() + (FUTURE_TOLERANCE_MIN + 5) * 60 * 1000).toISOString();
    const res = await punch(h, checkinBody(empId, { client_timestamp: future }), nextKey());
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("FUTURE_PUNCH");
    // The fix is on the device, so the message says what is wrong with it.
    expect(body.message).toMatch(/ahead of the server by 10 minutes/);
    expect(body.message).toMatch(/date and time/);
  });

  it("UT-ATT-11 accepts a punch from a clock a few minutes fast, keeping the client time as sent", async () => {
    /*
     * A supervisor's browser was three minutes ahead and every on-behalf
     * punch was refused as "in the future". server_timestamp is what the
     * day is built from, so a small forward skew costs nothing to allow.
     */
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const fast = new Date(Date.now() + 3 * 60 * 1000);
    const res = await punch(h, checkinBody(empId, { client_timestamp: fast.toISOString() }), nextKey());
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { event: { client_timestamp: string; server_timestamp: string } };
    expect(new Date(body.event.client_timestamp).getTime()).toBe(fast.getTime());
    expect(new Date(body.event.server_timestamp).getTime()).toBeLessThan(fast.getTime());
  });

  it("lets the organization tighten the forward tolerance", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    await pool.query(
      `UPDATE organizations SET settings = settings || '{"attendance_future_tolerance_minutes": 1}'::jsonb WHERE id = $1`,
      [orgId],
    );
    try {
      const fast = new Date(Date.now() + 3 * 60 * 1000).toISOString();
      const res = await punch(h, checkinBody(empId, { client_timestamp: fast }), nextKey());
      expect(res.statusCode).toBe(422);
      const body = res.json() as { code: string; message: string };
      expect(body.code).toBe("FUTURE_PUNCH");
      expect(body.message).toMatch(/up to 1 is allowed/);
    } finally {
      await pool.query(
        `UPDATE organizations SET settings = settings - 'attendance_future_tolerance_minutes' WHERE id = $1`,
        [orgId],
      );
    }
  });

  it("UT-ATT-12 stores UTM on WGS-1984 and the EGM96 height beside a positioned punch", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const res = await punch(h, checkinBody(empId, { altitude: 920.5, altitude_accuracy: 12 }), nextKey());
    expect(res.statusCode, res.body).toBe(201);
    const ev = (res.json() as { event: Record<string, unknown> }).event;
    // Bengaluru is zone 43 North; the metres agree with the shared projection.
    const expected = toUtm(CENTER.lat, CENTER.lng)!;
    expect(ev.utm_zone).toBe(43);
    expect(ev.utm_hemisphere).toBe("N");
    expect(ev.utm_easting).toBeCloseTo(expected.easting, 2);
    expect(ev.utm_northing).toBeCloseTo(expected.northing, 2);
    expect(ev.altitude).toBe(920.5);
    expect(ev.altitude_accuracy).toBe(12);
    // Orthometric: the phone's ellipsoidal altitude less the geoid undulation.
    expect(ev.height_egm96).toBeCloseTo(920.5 - geoidHeight(CENTER.lat, CENTER.lng)!, 1);
    // The place is named later, by the worker.
    expect(ev.place_name).toBeNull();
    expect(ev.place_status).toBe("resolving");
    const stored = await pool.query(
      "SELECT utm_zone, utm_easting, height_egm96, place_resolved_at FROM attendance_events WHERE id = $1::uuid",
      [ev.id],
    );
    expect(stored.rows[0].utm_zone).toBe(43);
    expect(Number(stored.rows[0].utm_easting)).toBeCloseTo(expected.easting, 2);
    expect(stored.rows[0].place_resolved_at).toBeNull();
  });

  it("UT-ATT-12 stores no UTM, height or place for a punch without a position", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const res = await punch(h, checkinBody(empId, {
      latitude: undefined, longitude: undefined, gps_accuracy: undefined, altitude: 500,
    }), nextKey());
    expect(res.statusCode, res.body).toBe(201);
    const ev = (res.json() as { event: Record<string, unknown> }).event;
    expect(ev.utm_zone).toBeNull();
    expect(ev.utm_easting).toBeNull();
    expect(ev.height_egm96).toBeNull();
    expect(ev.place_status).toBe("none");
  });

  it("requires Idempotency-Key (422 MISSING_IDEMPOTENCY_KEY)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const res = await punch(h, checkinBody(empId));
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("replays a duplicate Idempotency-Key (200 applied, same event)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const key = nextKey();
    const original=checkinBody(empId);
    const first = await punch(h, original, key);
    expect(first.statusCode).toBe(201);
    const firstEvent = (first.json() as { event: { id: string } }).event.id;
    const second = await punch(h, original, key);
    expect(second.statusCode).toBe(200);
    const body = second.json() as { applied: boolean; event: { id: string } };
    expect(body.applied).toBe(true);
    expect(body.event.id).toBe(firstEvent);
    const count = await pool.query("SELECT COUNT(*)::int AS n FROM attendance_events");
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("suppresses a same-minute re-punch (200 applied, no new record)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const first = await punch(h, checkinBody(empId), nextKey());
    expect(first.statusCode).toBe(201);
    const firstEvent = (first.json() as { event: { id: string } }).event.id;
    const second = await punch(h, checkinBody(empId), nextKey());
    expect(second.statusCode).toBe(200);
    const body = second.json() as { applied: boolean; event: { id: string } };
    expect(body.applied).toBe(true);
    expect(body.event.id).toBe(firstEvent);
    const events = await pool.query("SELECT COUNT(*)::int AS n FROM attendance_events");
    expect((events.rows[0] as { n: number }).n).toBe(1);
    const records = await pool.query("SELECT COUNT(*)::int AS n FROM attendance_records");
    expect((records.rows[0] as { n: number }).n).toBe(1);
  });

  it("survives a concurrent check-in burst with exactly one record (no 500s)", async () => {
    const h = await adminHeaders();
    const ids = await unitChain(h, "CB");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => punch(h, checkinBody(empId), nextKey())),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.every((c) => c === 200 || c === 201)).toBe(true);
    expect(results.filter((r) => r.statusCode === 201).length).toBeGreaterThanOrEqual(1);
    const recCount = await pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1::uuid",
      [empId],
    );
    expect((recCount.rows[0] as { n: number }).n).toBe(1);
  });

  it("record insert arbiter is idempotent (ON CONFLICT DO NOTHING + reselect)", async () => {
    // Deterministic guard for the concurrent-burst path: a second insert for
    // the same employee+date must affect 0 rows (never 500) and the reselect
    // must return the winning row.
    const h = await adminHeaders();
    const ids = await unitChain(h, "CA");
    const empId = await activeEmployee(h, { village_id: ids.village });
    const first = await punch(h, checkinBody(empId), nextKey());
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { record: { id: string }; event: { id: string } };
    const recId = firstBody.record.id;
    const wdRes = await pool.query("SELECT work_date::text AS wd FROM attendance_records WHERE id = $1::uuid", [recId]);
    const workDate = (wdRes.rows[0] as { wd: string }).wd;
    const again = await pool.query(
      `INSERT INTO attendance_records
         (employee_id, work_date, check_in_event_id, check_in_at, status)
       VALUES ($1::uuid, $3::date, $2::uuid, NOW(), 'PARTIAL')
       ON CONFLICT (employee_id, work_date) DO NOTHING
       RETURNING id`,
      [empId, firstBody.event.id, workDate],
    );
    expect(again.rowCount ?? -1).toBe(0);
    const existing = await pool.query(
      "SELECT id FROM attendance_records WHERE employee_id = $1::uuid AND work_date = $2::date",
      [empId, workDate],
    );
    expect((existing.rows[0] as { id: string }).id).toBe(recId);
  });

  it("pairs checkout to the open record with total_hours", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const inRes = await punch(h, checkinBody(empId), nextKey());
    expect(inRes.statusCode).toBe(201);
    const recordId = (inRes.json() as { record: { id: string } }).record.id;
    await pool.query(
      "UPDATE attendance_records SET check_in_at = NOW() - INTERVAL '2 hours' WHERE id = $1::uuid",
      [recordId],
    );
    const outRes = await punch(
      h,
      {
        employee_id: empId,
        event_type: "CHECK_OUT",
        client_timestamp: new Date().toISOString(),
        latitude: CENTER.lat,
        longitude: CENTER.lng,
      },
      nextKey(),
    );
    expect(outRes.statusCode).toBe(201);
    const body = outRes.json() as {
      decision: string;
      record: { status: string; total_hours: number; check_out_at: string };
    };
    expect(body.decision).toBe("ACCEPTED");
    expect(body.record.status).toBe("COMPLETE");
    expect(body.record.check_out_at).toBeTruthy();
    expect(body.record.total_hours).toBeGreaterThanOrEqual(1.99);
    expect(body.record.total_hours).toBeLessThanOrEqual(2.01);
  });

  it("rejects checkout without check-in (422 CHECKOUT_WITHOUT_CHECKIN)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const res = await punch(
      h,
      {
        employee_id: empId,
        event_type: "CHECK_OUT",
        client_timestamp: new Date().toISOString(),
      },
      nextKey(),
    );
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe("CHECKOUT_WITHOUT_CHECKIN");
    expect(body.message).toMatch(/regularization/i);
  });

  it("rejects a double check-in (422 DUPLICATE_CHECKIN)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const first = await punch(h, checkinBody(empId), nextKey());
    expect(first.statusCode).toBe(201);
    // Bypass the 5-minute suppression window to reach the duplicate rule.
    await pool.query("UPDATE attendance_events SET server_timestamp = NOW() - INTERVAL '10 minutes'");
    const second = await punch(h, checkinBody(empId), nextKey());
    expect(second.statusCode).toBe(422);
    expect((second.json() as { code: string }).code).toBe("DUPLICATE_CHECKIN");
  });

  it("rejects a second checkout after pairing (422 RECORD_CLOSED)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    await punch(h, checkinBody(empId), nextKey());
    const out1 = await punch(
      h,
      {
        employee_id: empId,
        event_type: "CHECK_OUT",
        client_timestamp: new Date().toISOString(),
      },
      nextKey(),
    );
    expect(out1.statusCode).toBe(201);
    await pool.query("UPDATE attendance_events SET server_timestamp = NOW() - INTERVAL '10 minutes'");
    const out2 = await punch(
      h,
      {
        employee_id: empId,
        event_type: "CHECK_OUT",
        client_timestamp: new Date().toISOString(),
      },
      nextKey(),
    );
    expect(out2.statusCode).toBe(422);
    expect((out2.json() as { code: string }).code).toBe("RECORD_CLOSED");
  });

  it("rejects punches for exited employees (422 EMPLOYEE_INACTIVE)", async () => {
    const h = await adminHeaders();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: h,
      payload: empPayload(),
    });
    const empId = (res.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/v1/employees/${empId}/exit`,
      headers: h,
      payload: { exit_date: "2024-06-01", reason: "left" },
    });
    const punchRes = await punch(h, checkinBody(empId), nextKey());
    expect(punchRes.statusCode).toBe(422);
    expect((punchRes.json() as { code: string }).code).toBe("EMPLOYEE_INACTIVE");
  });

  it("enforces punch scope: self-only unless attendance.decide", async () => {
    const h = await adminHeaders();
    const empA = await activeEmployee(h);
    const empB = await activeEmployee(h);
    const uname = `puncher_${Date.now()}`;
    const uid = await createUser({ username: uname, password: "Pass1234!", roles: ["EMPLOYEE"] });
    await pool.query("UPDATE users SET employee_id = $1::uuid WHERE id = $2::uuid", [empA, uid]);
    const mine = await headersFor(uname, "Pass1234!");
    const own = await punch(mine, checkinBody(empA), nextKey());
    expect(own.statusCode).toBe(201);
    const other = await punch(mine, checkinBody(empB), nextKey());
    expect(other.statusCode).toBe(403);
    // HR_MANAGER holds attendance.decide → may punch anyone.
    const hr = await roleHeaders("HR_MANAGER");
    const hrPunch = await punch(hr, checkinBody(empB), nextKey());
    expect(hrPunch.statusCode).toBe(201);
  });

  it("requires auth on punch (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { "Idempotency-Key": nextKey() },
      payload: {
        employee_id: "00000000-0000-0000-0000-000000000000",
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ------------------------------------------------- records / exceptions

describe("attendance records + exceptions", () => {
  it("lists records with envelope + filters", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const inRes = await punch(h, checkinBody(empId), nextKey());
    expect(inRes.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/attendance/records?employee_id=${empId}`,
      headers: h,
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as {
      data: Array<{
        id: string;
        employee_id: string;
        work_date: string;
        status: string;
        check_in_at: string;
        check_out_at: string | null;
        total_hours: number | null;
      }>;
      next_cursor: unknown;
      has_more: boolean;
    };
    expect(page.data.length).toBe(1);
    expect(page.data[0]?.status).toBe("PARTIAL");
    expect(page.data[0]).not.toHaveProperty("geofence_violation");
    const byStatus = await app.inject({
      method: "GET",
      url: `/api/v1/attendance/records?status=COMPLETE`,
      headers: h,
    });
    expect((byStatus.json() as { data: unknown[] }).data.length).toBe(0);
  });

  it("gates records listing (401 anon, 403 without attendance.read)", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/attendance/records" });
    expect(anon.statusCode).toBe(401);
    const viewer = await roleHeaders("CLIENT_VIEWER");
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/attendance/records",
      headers: viewer,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("returns record detail with events[]", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const inRes = await punch(h, checkinBody(empId), nextKey());
    const recordId = (inRes.json() as { record: { id: string } }).record.id;
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/attendance/records/${recordId}`,
      headers: h,
    });
    expect(got.statusCode).toBe(200);
    const body = got.json() as { id: string; events: Array<{ id: string }> };
    expect(body.id).toBe(recordId);
    expect(body.events.length).toBe(1);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/attendance/records/00000000-0000-0000-0000-000000000000",
      headers: h,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("decides exceptions: approve, single transition, version conflict, audit", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/exceptions",
      headers: h,
      payload: { employee_id: empId, exception_type: "MISSED_PUNCH", reason: "forgot" },
    });
    expect(created.statusCode).toBe(201);
    const exc = created.json() as { id: string; status: string; version: number };
    expect(exc.status).toBe("PENDING");
    expect(exc.version).toBe(1);

    const approved = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "APPROVE", note: "verified with lead" },
    });
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { status: string }).status).toBe("APPROVED");
    expect((approved.json() as { version: number }).version).toBe(2);

    // Single transition: deciding again → 422 even with the fresh version.
    const again = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...h, "If-Match": "2" },
      payload: { decision: "REJECT" },
    });
    expect(again.statusCode).toBe(422);

    // Stale version → 409.
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${exc.id}/decision`,
      headers: { ...h, "If-Match": "1" },
      payload: { decision: "REJECT" },
    });
    expect(stale.statusCode).toBe(409);

    const audit = await pool.query(
      "SELECT reason, action FROM audit_events WHERE action = 'attendance.exception.decide' AND entity_id = $1::uuid",
      [exc.id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0] as { reason: string }).reason).toBe("verified with lead");
  });

  it("creates a REGULARIZATION via /regularize", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: h,
      payload: {
        employee_id: empId,
        work_date: "2026-09-01",
        claimed_check_in: "2026-09-01T04:30:00.000Z",
        claimed_check_out: "2026-09-01T12:30:00.000Z",
        reason: "biometric offline",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { exception_type: string; status: string; reason: string };
    expect(body.exception_type).toBe("REGULARIZATION");
    expect(body.status).toBe("PENDING");
    expect(body.reason).toContain("biometric offline");
  });

  it("refuses a regularization for a day that has not happened (422)", async () => {
    // Approving one would have recorded presence for a day nobody has worked.
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: h,
      payload: { employee_id: empId, work_date: future, reason: "planned" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; field_errors: Array<{ field: string; message: string }> };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.field_errors[0]?.field).toBe("work_date");
    expect(body.field_errors[0]?.message).toMatch(/future/i);
  });

  it("denies exception decisions without attendance.decide (403 EMPLOYEE, 401 anon)", async () => {
    const h = await adminHeaders();
    const empId = await activeEmployee(h);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attendance/exceptions",
      headers: h,
      payload: { employee_id: empId, exception_type: "LATE_CHECKIN", reason: "traffic" },
    });
    const excId = (created.json() as { id: string }).id;
    const emp = await roleHeaders("EMPLOYEE");
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${excId}/decision`,
      headers: { ...emp, "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(denied.statusCode).toBe(403);
    const anon = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${excId}/decision`,
      headers: { "If-Match": "1" },
      payload: { decision: "APPROVE" },
    });
    expect(anon.statusCode).toBe(401);
  });
});
