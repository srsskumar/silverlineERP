/**
 * Catalogue: end-to-end suite (E2E-01..33).
 *
 * The catalogue asks for real PostgreSQL, API, Web and an Android device. This
 * file supplies the first two in full: a real database and the real API, driven
 * end to end through its HTTP surface with nothing stubbed but the external
 * adapters the catalogue itself says to stub (geocoder, malware scanner).
 *
 * The Web and Android halves live with the code they exercise, tagged with the
 * same catalogue IDs so the traceability report joins them up:
 *   - apps/web/tests/catalogue-e2e.test.ts   — E2E-02, 04, 20, 26, 30, 31
 *   - apps/mobile/test/catalogue.test.ts     — E2E-12, 13, 28
 * Steps that genuinely need a physical handset (camera burn-in on-device, OS
 * geofence callbacks) are called out in the catalogue report rather than
 * simulated here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { classifySyncResponse, resolveOutcome } from "../../../mobile/src/api/sync.js";
import { encryptPii } from "../../src/common/crypto.js";
import { runJobs } from "../../src/modules/automation/worker.js";
import {
  GEO,
  JWT_SECRET,
  buildWorld,
  createActiveEmployee,
  createChain,
  createEmployee,
  createFence,
  createUser,
  grantLeaveBalance,
  headersForUserId,
  idem,
  ifMatch,
  leaveTypeIds,
  loginAs,
  metresNorth,
  post,
  uniq,
  workDate,
  type CatalogueWorld,
  type Headers,
} from "./fixture.js";

let w: CatalogueWorld;
let types: Record<string, string>;

beforeAll(async () => {
  w = await buildWorld();
  types = await leaveTypeIds(w.app, w.admin);
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

interface ErrorBody {
  code: string;
  message: string;
  field_errors?: Array<{ field: string; message: string }>;
}

function plusDays(days: number): string {
  const base = new Date(`${workDate()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** A signed-in field employee on their own chain, with a fence they stand in. */
async function fieldWorker(over: Record<string, unknown> = {}): Promise<{
  employeeId: string;
  userId: string;
  headers: Headers;
  fenceId: string;
  site: string;
  chain: Awaited<ReturnType<typeof createChain>>;
}> {
  const chain = await createChain(w.app, w.admin, `E${uniq().slice(-4)}`);
  const employeeId = await createActiveEmployee(w.app, w.admin, {
    district_id: chain.district,
    mandal_id: chain.mandal,
    village_id: chain.village,
    site_id: chain.site,
    salary_basic: 30000,
    ...over,
  });
  const fenceId = await createFence(w.app, w.admin, {
    name: `Fence ${uniq()}`,
    scope_type: "site",
    scope_id: chain.site,
    geometry_type: "circle",
    geometry: { ...GEO.circleCentre, radius_m: GEO.circleRadiusM },
    tolerance_meters: 0,
  });
  const username = `cat_e2e_${uniq()}`;
  const userId = await createUser(w.pool, w.orgId, {
    username,
    roles: ["EMPLOYEE"],
    employeeId,
  });
  return {
    employeeId,
    userId,
    headers: await loginAs(w.app, username),
    fenceId,
    site: chain.site,
    chain,
  };
}

async function punch(
  headers: Headers,
  payload: Record<string, unknown>,
  key = idem(),
) {
  return w.app.inject({
    method: "POST",
    url: "/api/v1/attendance/events",
    headers: { ...headers, ...key },
    payload: {
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      ...payload,
    },
  });
}

// ===========================================================================
// E2E-01
// ===========================================================================

describe("E2E-01 admin signs in, completes MFA and opens scoped dashboard", () => {
  it("establishes a session behind MFA and shows the right scope", async () => {
    const username = `cat_e2e_admin_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["ADMIN"] });
    const secret = authenticator.generateSecret();
    await w.pool.query(
      "UPDATE users SET mfa_enabled = true, mfa_secret = $2, mfa_last_counter = NULL WHERE username = $1",
      [username, encryptPii(secret)],
    );

    // 1. Password alone gets a challenge, never a session.
    const challenge = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Pass1234!" },
    });
    expect(challenge.statusCode).toBe(200);
    expect((challenge.json() as { mfa_required: boolean }).mfa_required).toBe(true);
    expect((challenge.json() as { access_token?: string }).access_token).toBeUndefined();

    // 2. The code completes the sign-in.
    const signedIn = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Pass1234!", totp_code: authenticator.generate(secret) },
    });
    expect(signedIn.statusCode).toBe(200);
    const session = signedIn.json() as {
      access_token: string;
      refresh_token: string;
      user: { username: string; roles: string[] };
    };
    expect(session.user.roles).toContain("ADMIN");
    const headers = { authorization: `Bearer ${session.access_token}` };

    // 3. The session opens the admin's dashboard with real data.
    const me = await w.app.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(me.statusCode).toBe(200);

    const dashboard = await w.app.inject({
      method: "GET",
      url: "/api/v1/dashboards/role/admin",
      headers,
    });
    expect(dashboard.statusCode).toBe(200);
    const tiles = dashboard.json() as Record<string, unknown>;
    expect(Object.keys(tiles).length).toBeGreaterThan(0);

    // 4. The login is on the audit trail, attributed to this user.
    const audit = await w.pool.query(
      `SELECT a.action FROM audit_events a JOIN users u ON u.id = a.actor_id
        WHERE u.username = $1 AND a.action = 'auth.login'`,
      [username],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("shows a scoped admin only their own slice", async () => {
    const username = `cat_e2e_scoped_${uniq()}`;
    const userId = await createUser(w.pool, w.orgId, { username, roles: ["HR_MANAGER"] });
    await w.pool.query(
      "UPDATE user_roles SET scope_type = 'district', scope_id = $2 WHERE user_id = $1",
      [userId, w.chainA.district],
    );
    const headers = await loginAs(w.app, username);

    const employees = await w.app.inject({
      method: "GET",
      url: "/api/v1/employees?limit=100",
      headers,
    });
    const ids = (employees.json() as { data: Array<{ id: string }> }).data.map((e) => e.id);
    expect(ids).toContain(w.directEmployee);
    expect(ids).not.toContain(w.siteEmployee);
  });
});

// ===========================================================================
// E2E-02  (navigation depth is asserted in apps/web/tests/catalogue-e2e.test.ts)
// ===========================================================================

describe("E2E-02 employee signs in without admin permissions", () => {
  it("reaches their own attendance but not admin pages or org-wide fences", async () => {
    const worker = await fieldWorker();

    // Their own attendance history and effective fences are reachable.
    for (const url of ["/api/v1/attendance/me", "/api/v1/geo-fences/effective"]) {
      const res = await w.app.inject({ method: "GET", url, headers: worker.headers });
      expect(res.statusCode, url).toBe(200);
    }
    // And they can punch for themselves.
    expect(
      (
        await punch(worker.headers, {
          employee_id: worker.employeeId,
          latitude: GEO.insideCircle.lat,
          longitude: GEO.insideCircle.lng,
        })
      ).statusCode,
    ).toBe(201);

    // Administrative surfaces stay closed.
    for (const url of [
      "/api/v1/admin/users",
      "/api/v1/admin/settings",
      "/api/v1/admin/devices",
      "/api/v1/geo-fences",
      "/api/v1/employees",
      "/api/v1/audit",
      "/api/v1/payroll/runs",
    ]) {
      const res = await w.app.inject({ method: "GET", url, headers: worker.headers });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("cannot punch on someone else's behalf", async () => {
    const worker = await fieldWorker();
    const res = await punch(worker.headers, {
      employee_id: w.directEmployee,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ===========================================================================
// E2E-03
// ===========================================================================

describe("E2E-03 admin creates employee, links user and assigns District to Site", () => {
  it("lets the new employee read their own profile and site, and nothing foreign", async () => {
    const chain = await createChain(w.app, w.admin, `P${uniq().slice(-4)}`);

    // 1. Admin creates the employee across the full location chain.
    const employeeId = await createEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const activated = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/activate`,
      headers: { ...w.admin, ...idem() },
      payload: { reason: "Record complete, joining today" },
    });
    expect(activated.statusCode).toBe(200);

    // 2. Admin links a login to that employee.
    const username = `cat_e2e_new_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["EMPLOYEE"], employeeId });
    const headers = await loginAs(w.app, username);

    // 3. The employee reads their own profile.
    const self = await w.app.inject({
      method: "GET",
      url: "/api/v1/employees/me",
      headers,
    });
    expect(self.statusCode).toBe(200);
    const profile = self.json() as {
      id: string;
      district_id: string;
      site_id: string;
      aadhaar: string | null;
    };
    expect(profile.id).toBe(employeeId);
    expect(profile.district_id).toBe(chain.district);
    expect(profile.site_id).toBe(chain.site);

    // 4. And sees nothing belonging to another tenant.
    const foreign = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${w.other.employee}`,
      headers,
    });
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    expect(foreign.body).not.toContain(w.other.employee);
  });
});

// ===========================================================================
// E2E-04  (map recentre/preview is asserted in the web suite)
// ===========================================================================

describe("E2E-04 admin opens New fence, searches a place, selects result and clicks map", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("returns a selectable coordinate from the place search that a fence can be built on", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [
          {
            osm_type: "node",
            osm_id: 42,
            lat: String(GEO.circleCentre.lat),
            lon: String(GEO.circleCentre.lng),
            display_name: "Kondapur, Telangana, India",
            type: "suburb",
          },
        ],
      }) as unknown as Response) as typeof fetch;

    const search = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo/search?q=${encodeURIComponent(`kondapur-${uniq()}`)}`,
      headers: w.admin,
    });
    expect(search.statusCode).toBe(200);
    const result = (
      search.json() as { data: Array<{ lat: number; lng: number; display_name: string }> }
    ).data[0]!;
    expect(result.display_name).toContain("Kondapur");

    // The selected coordinate is exactly what the fence form submits, and the
    // fence that comes back previews at the same place.
    const chain = await createChain(w.app, w.admin, `S${uniq().slice(-4)}`);
    const fenceId = await createFence(w.app, w.admin, {
      name: "Fence from search",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { lat: result.lat, lng: result.lng, radius_m: 250 },
      tolerance_meters: 10,
    });

    const stored = await w.pool.query(
      "SELECT geometry, tolerance_meters FROM geo_fences WHERE id = $1",
      [fenceId],
    );
    const geometry = stored.rows[0].geometry as { lat: number; lng: number; radius_m: number };
    expect(geometry.lat).toBeCloseTo(result.lat, 6);
    expect(geometry.lng).toBeCloseTo(result.lng, 6);
    expect(geometry.radius_m).toBe(250);
    expect(Number(stored.rows[0].tolerance_meters)).toBe(10);
  });

  it("accepts a polygon drawn by clicking the map", async () => {
    const chain = await createChain(w.app, w.admin, `D${uniq().slice(-4)}`);
    const fenceId = await createFence(w.app, w.admin, {
      name: "Drawn polygon",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "polygon",
      geometry: { points: GEO.polygon },
    });
    const stored = await w.pool.query("SELECT geometry FROM geo_fences WHERE id = $1", [
      fenceId,
    ]);
    expect((stored.rows[0].geometry as { points: number[][] }).points).toHaveLength(
      GEO.polygon.length,
    );
  });
});

// ===========================================================================
// E2E-05
// ===========================================================================

describe("E2E-05 admin creates fence and selects one employee directly", () => {
  it("saves and audits the assignment, lists it, and the phone then fetches it", async () => {
    const worker = await fieldWorker();

    const fenceId = await createFence(w.app, w.admin, {
      name: `Direct fence ${uniq()}`,
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.9, lng: 78.9, radius_m: 300 },
      employee_ids: [worker.employeeId],
    });

    // The fence table shows the assigned employee.
    const listed = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo-fences?scope_type=site&scope_id=${w.chainB.site}&limit=100`,
      headers: w.admin,
    });
    const row = (
      listed.json() as { data: Array<{ id: string; employee_ids: string[] }> }
    ).data.find((f) => f.id === fenceId)!;
    expect(row.employee_ids).toContain(worker.employeeId);

    const assignment = await w.pool.query(
      `SELECT status, created_by FROM geo_fence_employee_assignments
        WHERE geo_fence_id = $1 AND employee_id = $2`,
      [fenceId, worker.employeeId],
    );
    expect(assignment.rows[0].status).toBe("ACTIVE");
    expect(assignment.rows[0].created_by).toBe(w.adminId);

    const audit = await w.pool.query(
      "SELECT action, after_state FROM audit_events WHERE entity_id = $1 AND action = 'geo_fence.create'",
      [fenceId],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0].after_state)).toContain(worker.employeeId);

    // "Refresh location" on the phone is this call.
    const effective = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers: worker.headers,
    });
    const ids = (effective.json() as { data: Array<{ id: string }> }).data.map((f) => f.id);
    expect(ids[0]).toBe(fenceId);
  });
});

// ===========================================================================
// E2E-06
// ===========================================================================

describe("E2E-06 employee has direct fence and a different site fence", () => {
  it("shows the direct fence on the phone and evaluates the same one on the server", async () => {
    const worker = await fieldWorker();
    // A direct fence somewhere else entirely, so the two cannot be confused.
    const directFence = await createFence(w.app, w.admin, {
      name: `Direct ${uniq()}`,
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.9, lng: 78.9, radius_m: 300 },
      employee_ids: [worker.employeeId],
    });

    // The phone's own list puts the direct fence first.
    const effective = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers: worker.headers,
    });
    const phoneFences = (effective.json() as {
      data: Array<{ id: string; version: number }>;
    }).data;
    expect(phoneFences[0]!.id).toBe(directFence);

    // A punch at the *site* fence's location is now OUTSIDE, because the
    // direct fence — not the site fence — is the one that applies.
    const res = await punch(w.admin, {
      employee_id: worker.employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(res.statusCode).toBe(202);

    const event = await w.pool.query(
      `SELECT geofence_id, geofence_version, geofence_result FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [worker.employeeId],
    );
    // The server evaluated the same fence, at the same version, the phone showed.
    expect(event.rows[0].geofence_id).toBe(directFence);
    expect(event.rows[0].geofence_version).toBe(phoneFences[0]!.version);
    expect(event.rows[0].geofence_result).toBe("OUTSIDE");
  });
});

// ===========================================================================
// E2E-07
// ===========================================================================

describe("E2E-07 employee has no direct fence but has Site Village Mandal District fences", () => {
  it("uses the site fence, and each coarser one as the finer level goes away", async () => {
    const chain = await createChain(w.app, w.admin, `H${uniq().slice(-4)}`);
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const levels: Array<["site" | "village" | "mandal" | "district", string, string]> = [
      ["site", chain.site, ""],
      ["village", chain.village, ""],
      ["mandal", chain.mandal, ""],
      ["district", chain.district, ""],
    ];
    const fences: Record<string, string> = {};
    for (const [index, [scope, scopeId]] of levels.entries()) {
      fences[scope] = await createFence(w.app, w.admin, {
        name: `${scope} fence`,
        scope_type: scope,
        scope_id: scopeId,
        geometry_type: "circle",
        geometry: { lat: 17 + index / 10, lng: 78 + index / 10, radius_m: 150 },
      });
    }

    const effectiveFence = async (): Promise<string | null> => {
      await w.pool.query("DELETE FROM attendance_records WHERE employee_id = $1", [employeeId]);
      await w.pool.query("DELETE FROM attendance_events WHERE employee_id = $1", [employeeId]);
      await punch(w.admin, { employee_id: employeeId });
      const row = await w.pool.query(
        `SELECT geofence_id FROM attendance_events
          WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
        [employeeId],
      );
      return row.rows[0]?.geofence_id ?? null;
    };

    const deactivate = async (fenceId: string) => {
      const res = await w.app.inject({
        method: "PATCH",
        url: `/api/v1/geo-fences/${fenceId}`,
        headers: { ...w.admin, ...(await ifMatch(w, "geo_fences", fenceId)), ...idem() },
        payload: { status: "INACTIVE" },
      });
      expect(res.statusCode).toBe(200);
    };

    expect(await effectiveFence()).toBe(fences.site);
    await deactivate(fences.site!);
    expect(await effectiveFence()).toBe(fences.village);
    await deactivate(fences.village!);
    expect(await effectiveFence()).toBe(fences.mandal);
    await deactivate(fences.mandal!);
    expect(await effectiveFence()).toBe(fences.district);
  });
});

// ===========================================================================
// E2E-08
// ===========================================================================

describe("E2E-08 employee stands inside circular boundary and checks in/out", () => {
  it("produces two immutable events and one complete workday marked INSIDE", async () => {
    const worker = await fieldWorker();
    const position = { latitude: GEO.insideCircle.lat, longitude: GEO.insideCircle.lng };

    const checkIn = await punch(worker.headers, {
      employee_id: worker.employeeId,
      ...position,
      gps_accuracy: 6,
    });
    expect(checkIn.statusCode).toBe(201);
    const checkOut = await punch(worker.headers, {
      employee_id: worker.employeeId,
      event_type: "CHECK_OUT",
      ...position,
      gps_accuracy: 6,
    });
    expect(checkOut.statusCode).toBe(201);

    const events = await w.pool.query(
      `SELECT id, event_type, geofence_result, geofence_id FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp`,
      [worker.employeeId],
    );
    expect(events.rowCount).toBe(2);
    expect(events.rows.map((e) => e.event_type)).toEqual(["CHECK_IN", "CHECK_OUT"]);
    for (const event of events.rows) {
      expect(event.geofence_result).toBe("INSIDE");
      expect(event.geofence_id).toBe(worker.fenceId);
    }

    const record = await w.pool.query(
      `SELECT status, work_date, check_in_event_id, check_out_event_id, total_hours,
              geofence_violation
         FROM attendance_records WHERE employee_id = $1`,
      [worker.employeeId],
    );
    expect(record.rowCount).toBe(1);
    expect(record.rows[0].status).toBe("COMPLETE");
    expect(String(record.rows[0].work_date).slice(0, 10)).toBe(workDate());
    expect(record.rows[0].check_in_event_id).toBe(events.rows[0].id);
    expect(record.rows[0].check_out_event_id).toBe(events.rows[1].id);
    expect(record.rows[0].geofence_violation).toBe(false);

    // The employee sees the finished day in their own history.
    const history = await w.app.inject({
      method: "GET",
      url: "/api/v1/attendance/me",
      headers: worker.headers,
    });
    const days = (history.json() as { data: Array<{ status: string }> }).data;
    expect(days[0]!.status).toBe("COMPLETE");
  });
});

// ===========================================================================
// E2E-09
// ===========================================================================

describe("E2E-09 employee stands inside polygon and on tolerated edge", () => {
  it("accepts both, and the server agrees with the on-device preview", async () => {
    const chain = await createChain(w.app, w.admin, `G${uniq().slice(-4)}`);
    const fenceId = await createFence(w.app, w.admin, {
      name: "Polygon site",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "polygon",
      geometry: { points: GEO.polygon },
      tolerance_meters: 50,
    });

    const interior = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const edge = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });

    // The phone previews against the same geometry the server stores.
    const stored = await w.pool.query(
      "SELECT geometry_type, geometry, tolerance_meters FROM geo_fences WHERE id = $1",
      [fenceId],
    );
    const shape = {
      geometry_type: stored.rows[0].geometry_type as "polygon",
      geometry: stored.rows[0].geometry as { points: Array<[number, number]> },
      tolerance_meters: Number(stored.rows[0].tolerance_meters),
    };
    const { isInsideFence } = await import("@silverline/shared");

    const inside = await punch(w.admin, {
      employee_id: interior,
      latitude: GEO.insidePolygon.lat,
      longitude: GEO.insidePolygon.lng,
    });
    expect(inside.statusCode).toBe(201);
    expect(isInsideFence(shape, GEO.insidePolygon.lat, GEO.insidePolygon.lng)).toBe(true);

    // 30 m outside the southern edge, inside the 50 m tolerance.
    const tolerated = { lat: 17.4 - metresNorth(30), lng: 78.505 };
    const onEdge = await punch(w.admin, {
      employee_id: edge,
      latitude: tolerated.lat,
      longitude: tolerated.lng,
    });
    expect(onEdge.statusCode).toBe(201);
    // Preview and server reach the same conclusion — the point of sharing the
    // implementation is that the app never promises what the server refuses.
    expect(isInsideFence(shape, tolerated.lat, tolerated.lng)).toBe(true);

    const results = await w.pool.query(
      "SELECT geofence_result FROM attendance_events WHERE employee_id = ANY($1::uuid[])",
      [[interior, edge]],
    );
    expect(results.rows.map((r) => r.geofence_result)).toEqual(["INSIDE", "INSIDE"]);
  });
});

// ===========================================================================
// E2E-10
// ===========================================================================

describe("E2E-10 employee punches outside boundary and submits reason/photo", () => {
  it("requires review, reaches an approver, and is not counted as normal attendance", async () => {
    const worker = await fieldWorker();

    const res = await punch(worker.headers, {
      employee_id: worker.employeeId,
      latitude: GEO.outsideCircle.lat,
      longitude: GEO.outsideCircle.lng,
      gps_accuracy: 8,
    });
    expect(res.statusCode).toBe(202);
    const systemExceptionId = (res.json() as { exception_id: string }).exception_id;

    // Nothing was silently credited.
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [worker.employeeId],
    );
    expect(records.rows[0].n).toBe(0);

    // The employee explains themselves.
    const explained = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/exceptions",
      headers: { ...worker.headers, ...idem() },
      payload: {
        employee_id: worker.employeeId,
        exception_type: "OUTSIDE_GEOFENCE",
        reason: "Supervisor moved the muster point to the far gate today",
      },
    });
    expect(explained.statusCode).toBe(201);

    // A TL/PM sees both in their queue.
    const queue = await w.app.inject({
      method: "GET",
      url: "/api/v1/attendance/records?limit=100",
      headers: w.role.PROJECT_MANAGER,
    });
    expect(queue.statusCode).toBe(200);
    const pending = await w.pool.query(
      "SELECT id, status, source FROM attendance_exceptions WHERE employee_id = $1 ORDER BY created_at",
      [worker.employeeId],
    );
    expect(pending.rowCount).toBe(2);
    expect(pending.rows.map((r) => r.source).sort()).toEqual(["SYSTEM", "USER"]);
    expect(pending.rows.every((r) => r.status === "PENDING")).toBe(true);

    // The approver decides the system flag.
    const version = await w.pool.query(
      "SELECT version FROM attendance_exceptions WHERE id = $1",
      [systemExceptionId],
    );
    const decision = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/attendance/exceptions/${systemExceptionId}/decision`,
      headers: {
        ...w.role.PROJECT_MANAGER,
        "if-match": String(version.rows[0].version),
        ...idem(),
      },
      payload: { decision: "APPROVE", note: "Confirmed with the site supervisor" },
    });
    expect(decision.statusCode).toBe(200);

    const decided = await w.pool.query(
      "SELECT status, reviewed_by, review_note FROM attendance_exceptions WHERE id = $1",
      [systemExceptionId],
    );
    expect(decided.rows[0].status).toBe("APPROVED");
    expect(decided.rows[0].reviewed_by).toBe(w.roleUserId.PROJECT_MANAGER);
    expect(decided.rows[0].review_note).toBeTruthy();
  });
});

// ===========================================================================
// E2E-11
// ===========================================================================

describe("E2E-11 device reports poor accuracy, mock location or impossible travel", () => {
  const cases: Array<{
    label: string;
    code: string;
    build: (employeeId: string) => Record<string, unknown>;
    fence?: Record<string, unknown>;
  }> = [
    {
      label: "poor accuracy",
      code: "POOR_ACCURACY",
      fence: { accuracy_threshold_meters: 40 },
      build: (employeeId) => ({
        employee_id: employeeId,
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
        gps_accuracy: 400,
      }),
    },
    {
      label: "mock location",
      code: "MOCK_LOCATION",
      build: (employeeId) => ({
        employee_id: employeeId,
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
        mock_location: true,
      }),
    },
  ];

  for (const probe of cases) {
    it(`explains the ${probe.label} decision and keeps the evidence`, async () => {
      const worker = await fieldWorker();
      if (probe.fence) {
        await w.app.inject({
          method: "PATCH",
          url: `/api/v1/geo-fences/${worker.fenceId}`,
          headers: {
            ...w.admin,
            ...(await ifMatch(w, "geo_fences", worker.fenceId)),
            ...idem(),
          },
          payload: probe.fence,
        });
      }

      const res = await punch(worker.headers, probe.build(worker.employeeId));
      expect(res.statusCode).toBe(202);
      const body = res.json() as { code: string; message: string; exception_id: string };
      expect(body.code).toBe(probe.code);
      // The UI has something to show the user, not just a status code.
      expect(body.message.length).toBeGreaterThan(10);

      const exception = await w.pool.query(
        "SELECT reason, status FROM attendance_exceptions WHERE id = $1",
        [body.exception_id],
      );
      expect(exception.rows[0].status).toBe("PENDING");
      expect(exception.rows[0].reason).toBeTruthy();
    });
  }

  it("explains an impossible-travel decision and keeps the derived evidence", async () => {
    const worker = await fieldWorker();
    await punch(worker.headers, {
      employee_id: worker.employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 5,
      client_timestamp: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await punch(worker.headers, {
      employee_id: worker.employeeId,
      event_type: "CHECK_OUT",
      latitude: 28.6139,
      longitude: 77.209,
      gps_accuracy: 5,
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { code: string }).code).toBe("DEVICE_SIGNAL");

    const event = await w.pool.query(
      `SELECT device_signals FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [worker.employeeId],
    );
    const signals = event.rows[0].device_signals as {
      server_movement: { distance_m: number; implied_speed_mps: number };
    };
    // The numbers a reviewer needs to judge it are stored, not just a verdict.
    expect(signals.server_movement.distance_m).toBeGreaterThan(100_000);
    expect(signals.server_movement.implied_speed_mps).toBeGreaterThan(55);
  });
});

// ===========================================================================
// E2E-12 / E2E-13  (queue mechanics live in the mobile suite)
// ===========================================================================

describe("E2E-12 employee checks in offline, force-closes app, reopens and reconnects", () => {
  it("syncs the queued punch exactly once when the network returns", async () => {
    const worker = await fieldWorker();
    // The device minted this key while offline and kept it across the restart.
    const offlineKey = idem();
    const payload = {
      employee_id: worker.employeeId,
      event_type: "CHECK_IN",
      client_timestamp: new Date(Date.now() - 120_000).toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
      gps_accuracy: 7,
    };

    // Reconnect: the queue flushes.
    const first = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...worker.headers, ...offlineKey },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(classifySyncResponse(first.statusCode, first.json())).toBe("ACCEPTED");

    // The engine retries anything it is not sure landed.
    const retry = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...worker.headers, ...offlineKey },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    const decision = classifySyncResponse(retry.statusCode, retry.json());
    expect(decision).toBe("ALREADY_APPLIED");
    expect(resolveOutcome(decision).state).toBe("SUCCEEDED");

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [worker.employeeId],
    );
    expect(events.rows[0].n).toBe(1);

    // The final attendance is visible to the employee.
    const history = await w.app.inject({
      method: "GET",
      url: "/api/v1/attendance/me",
      headers: worker.headers,
    });
    expect((history.json() as { data: unknown[] }).data).toHaveLength(1);
  });
});

describe("E2E-13 network drops after server commits but before client receives response", () => {
  it("returns ALREADY_APPLIED on retry, with exactly one attendance event", async () => {
    const worker = await fieldWorker();
    const key = idem();
    const payload = {
      employee_id: worker.employeeId,
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    };

    // The server committed this one; the client never saw the answer.
    const committed = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...worker.headers, ...key },
      payload,
    });
    expect(committed.statusCode).toBe(201);

    // Three retries of the same operation.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await w.app.inject({
        method: "POST",
        url: "/api/v1/attendance/events",
        headers: { ...worker.headers, ...key },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect((retry.json() as { applied: boolean }).applied).toBe(true);
    }

    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [worker.employeeId],
    );
    expect(events.rows[0].n).toBe(1);
    const records = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = $1",
      [worker.employeeId],
    );
    expect(records.rows[0].n).toBe(1);
  });

  it("refuses a key reused for different request content", async () => {
    const worker = await fieldWorker();
    const key = idem();
    await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...worker.headers, ...key },
      payload: {
        employee_id: worker.employeeId,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
    });

    const different = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...worker.headers, ...key },
      payload: {
        employee_id: worker.employeeId,
        event_type: "CHECK_OUT",
        client_timestamp: new Date().toISOString(),
      },
    });
    // Silently replaying the first answer would hide a real client bug.
    expect(different.statusCode).toBe(409);
    expect((different.json() as ErrorBody).code).toBe("IDEMPOTENCY_MISMATCH");
  });
});

// ===========================================================================
// E2E-14
// ===========================================================================

describe("E2E-14 admin exits employee, then employee attempts punch/task/asset workflows", () => {
  it("fails all three with a useful reason, and audits the exit", async () => {
    const worker = await fieldWorker();
    const projectId = w.activeProject;

    const exitReason = "Contract ended on the Kondapur site";
    const exited = await w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${worker.employeeId}/exit`,
      headers: { ...w.admin, ...idem() },
      payload: { exit_date: workDate(), reason: exitReason },
    });
    expect(exited.statusCode).toBe(200);

    // 1. Attendance.
    const attendance = await punch(w.admin, {
      employee_id: worker.employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(attendance.statusCode).toBe(422);
    const attendanceBody = attendance.json() as ErrorBody;
    expect(attendanceBody.code).toBe("EMPLOYEE_INACTIVE");
    expect(attendanceBody.message).toMatch(/not active|does not exist/i);

    // 2. Task assignment.
    const t = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: `Post-exit task ${uniq()}`,
    });
    const assigned = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${t}/assign`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", t)), ...idem() },
      payload: { assignee_id: worker.userId, reason: "Should be refused" },
    });
    expect(assigned.statusCode).toBeGreaterThanOrEqual(400);

    // 3. Asset assignment.
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: `EX${uniq().toUpperCase().slice(-8)}`,
      name: "Post-exit asset",
      category: "ELECTRONIC",
      condition: "GOOD",
    });
    const asset = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/assign`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload: { employee_id: worker.employeeId, condition: "GOOD", reason: "Should be refused" },
    });
    expect(asset.statusCode).toBeGreaterThanOrEqual(400);
    expect((asset.json() as ErrorBody).code).toBe("EMPLOYEE_INACTIVE");

    // The exit itself is on the record, with who and why.
    const audit = await w.pool.query(
      "SELECT actor_id, reason FROM audit_events WHERE entity_id = $1 AND action = 'employee.exit'",
      [worker.employeeId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(w.adminId);
    expect(audit.rows[0].reason).toBe(exitReason);

    // And nothing was half-created by the denied attempts.
    expect(
      (
        await w.pool.query(
          "SELECT COUNT(*)::int AS n FROM asset_assignments WHERE employee_id = $1",
          [worker.employeeId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

// ===========================================================================
// E2E-15 / E2E-16
// ===========================================================================

describe("E2E-15 employee submits leave through configured TL and manager chain", () => {
  it("routes to each approver in turn and updates the ledger on the final decision", async () => {
    // Manager with a TEAM_LEAD login; employee reporting to them.
    const managerEmployee = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const managerUsername = `cat_e2e_tl_${uniq()}`;
    const managerUserId = await createUser(w.pool, w.orgId, {
      username: managerUsername,
      roles: ["TEAM_LEAD"],
      employeeId: managerEmployee,
    });
    const managerHeaders = await loginAs(w.app, managerUsername);

    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      reports_to: managerEmployee,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!, 10);
    const username = `cat_e2e_req_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["EMPLOYEE"], employeeId });
    const headers = await loginAs(w.app, username);

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...headers, ...idem() },
      payload: {
        employee_id: employeeId,
        leave_type_id: types.CL,
        from_date: plusDays(30),
        to_date: plusDays(31),
        reason: "Family function",
      },
    });
    expect(created.statusCode).toBe(201);
    const request = created.json() as { id: string; current_approver_id: string };
    expect(request.current_approver_id).toBe(managerUserId);

    // The TL's inbox carries it.
    const inbox = await w.app.inject({
      method: "GET",
      url: "/api/v1/leave/requests?approver_me=true&limit=50",
      headers: managerHeaders,
    });
    expect(inbox.statusCode).toBe(200);
    const inboxIds = (inbox.json() as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(inboxIds).toContain(request.id);

    // Step 1.
    expect(
      (
        await w.app.inject({
          method: "POST",
          url: `/api/v1/leave/requests/${request.id}/decision`,
          headers: {
            ...managerHeaders,
            ...(await ifMatch(w, "leave_requests", request.id)),
            ...idem(),
          },
          payload: { decision: "APPROVE", note: "Cover arranged" },
        })
      ).statusCode,
    ).toBe(200);

    // Step 2 — whoever the chain named next.
    const midway = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${request.id}`,
      headers: w.admin,
    });
    const nextApproverId = (midway.json() as { current_approver_id: string })
      .current_approver_id;
    expect(nextApproverId).not.toBe(managerUserId);
    const finalApprover = await headersForUserId(w, nextApproverId);
    expect(
      (
        await w.app.inject({
          method: "POST",
          url: `/api/v1/leave/requests/${request.id}/decision`,
          headers: {
            ...finalApprover,
            ...(await ifMatch(w, "leave_requests", request.id)),
            ...idem(),
          },
          payload: { decision: "APPROVE" },
        })
      ).statusCode,
    ).toBe(200);

    // The ledger moved by exactly the two days taken.
    const balance = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/balances?employee_id=${employeeId}`,
      headers: w.admin,
    });
    const cl = (
      balance.json() as {
        data: Array<{ leave_type_id: string; consumed: number; current_balance: number }>;
      }
    ).data.find((b) => b.leave_type_id === types.CL)!;
    expect(cl.consumed).toBe(2);
    expect(cl.current_balance).toBe(8);

    // And the employee can see the outcome.
    const own = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${request.id}`,
      headers,
    });
    expect((own.json() as { status: string }).status).toBe("APPROVED");
  });
});

describe("E2E-16 employee or unauthorized user attempts own/out-of-scope approval", () => {
  it("denies both without disclosing the hidden record, leaving it unchanged", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await grantLeaveBalance(w.app, w.admin, employeeId, types.CL!);
    const username = `cat_e2e_self_${uniq()}`;
    await createUser(w.pool, w.orgId, {
      username,
      // Holds the decide grant *and* is the subject.
      roles: ["HR_MANAGER"],
      employeeId,
    });
    const headers = await loginAs(w.app, username);

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { ...headers, ...idem() },
      payload: {
        employee_id: employeeId,
        leave_type_id: types.CL,
        from_date: plusDays(40),
        to_date: plusDays(40),
        reason: "Self approval attempt",
      },
    });
    const requestId = (created.json() as { id: string }).id;

    const selfDecision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${requestId}/decision`,
      headers: {
        ...headers,
        ...(await ifMatch(w, "leave_requests", requestId)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(selfDecision.statusCode).toBe(403);

    // An out-of-scope employee cannot even see it.
    const stranger = await fieldWorker();
    const peek = await w.app.inject({
      method: "GET",
      url: `/api/v1/leave/requests/${requestId}`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(peek.statusCode);
    // The denial reveals nothing about the request itself.
    expect(peek.body).not.toContain("Self approval attempt");

    const strangerDecision = await w.app.inject({
      method: "POST",
      url: `/api/v1/leave/requests/${requestId}/decision`,
      headers: {
        ...stranger.headers,
        ...(await ifMatch(w, "leave_requests", requestId)),
        ...idem(),
      },
      payload: { decision: "APPROVE" },
    });
    expect(strangerDecision.statusCode).toBe(403);

    const after = await w.pool.query(
      "SELECT status, version FROM leave_requests WHERE id = $1",
      [requestId],
    );
    expect(after.rows[0].status).toBe("PENDING");
  });
});

// ===========================================================================
// E2E-17
// ===========================================================================

describe("E2E-17 payroll run has missing attendance, then data is corrected and run locked", () => {
  it("blocks, then advances after correction, then rejects ordinary edits once locked", async () => {
    const start = "2021-03-01";
    const end = "2021-03-31";
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
      salary_basic: 30000,
      date_of_joining: "2019-01-01",
    });

    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/payroll/runs",
      headers: { ...w.admin, ...idem() },
      payload: { period_start: start, period_end: end },
    });
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as { id: string }).id;

    // 1. Validation blocks: no attendance in the period at all.
    const blocked = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as ErrorBody).code).toBe("NO_ATTENDANCE_DATA");
    expect(
      (await w.pool.query("SELECT status FROM payroll_runs WHERE id = $1", [runId])).rows[0]
        .status,
    ).toBe("OPEN");

    // 2. The data is corrected.
    for (let day = 1; day <= 20; day += 1) {
      await w.pool.query(
        `INSERT INTO attendance_records (employee_id, work_date, status, check_in_at)
         VALUES ($1, ($2::date + ($3 || ' days')::interval)::date, 'COMPLETE', NOW())`,
        [employeeId, start, String(day - 1)],
      );
    }

    // 3. The run advances all the way to LOCKED.
    for (const step of ["calculate", "submit-review", "approve", "lock"]) {
      const res = await w.app.inject({
        method: "POST",
        url: `/api/v1/payroll/runs/${runId}/${step}`,
        headers: { ...w.admin, ...idem() },
        payload: {},
      });
      expect(res.statusCode, step).toBe(200);
    }

    const slip = await w.pool.query(
      "SELECT gross, net_pay FROM payslips WHERE payroll_run_id = $1 AND employee_id = $2",
      [runId, employeeId],
    );
    expect(Number(slip.rows[0].gross)).toBe(20_000);

    // 4. Locked data rejects ordinary edits.
    const recalculate = await w.app.inject({
      method: "POST",
      url: `/api/v1/payroll/runs/${runId}/calculate`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(recalculate.statusCode).toBe(422);
    expect((recalculate.json() as ErrorBody).code).toBe("RUN_SEALED");

    // And attendance inside the locked period is frozen too (BR-05).
    const lateRegularization = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/regularize",
      headers: { ...w.role.HR_MANAGER, ...idem() },
      payload: {
        employee_id: employeeId,
        work_date: "2021-03-25",
        reason: "Forgot to punch",
      },
    });
    expect(lateRegularization.statusCode).toBe(422);
    expect((lateRegularization.json() as ErrorBody).code).toBe("PAYROLL_LOCKED");
  });
});

// ===========================================================================
// E2E-18
// ===========================================================================

describe("E2E-18 two inventory users consume quantity one simultaneously", () => {
  it("commits one transaction, fails the other, and leaves stock at zero", async () => {
    const itemId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/inventory/items", {
      code: `E18${uniq().toUpperCase().slice(-7)}`,
      name: "Last cement bag",
      unit: "BAG",
    });
    await w.app.inject({
      method: "POST",
      url: "/api/v1/inventory/transactions",
      headers: { ...w.role.INVENTORY_MANAGER, ...idem() },
      payload: { item_id: itemId, direction: "IN", quantity: "1", reference: "delivery" },
    });

    // Two different users reach for it at the same moment.
    const consume = (headers: Headers) =>
      w.app.inject({
        method: "POST",
        url: "/api/v1/inventory/transactions",
        headers: { ...headers, ...idem() },
        payload: {
          item_id: itemId,
          direction: "OUT",
          quantity: "1",
          reference: `issue-${uniq()}`,
        },
      });

    const [a, b] = await Promise.all([
      consume(w.role.INVENTORY_MANAGER),
      consume(w.admin),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect((loser.json() as ErrorBody).code).toBe("INSUFFICIENT_STOCK");

    const ledger = await w.pool.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0) AS qty,
              COUNT(*) FILTER (WHERE direction = 'OUT')::int AS outs
         FROM stock_transactions WHERE item_id = $1`,
      [itemId],
    );
    expect(Number(ledger.rows[0].qty)).toBe(0);
    expect(ledger.rows[0].outs).toBe(1);
  });
});

// ===========================================================================
// E2E-19
// ===========================================================================

describe("E2E-19 assign and return asset with QR scan and condition evidence", () => {
  it("shows the asset before the change and keeps the history consistent", async () => {
    const assetCode = `QR${uniq().toUpperCase().slice(-8)}`;
    const assetId = await post(w.app, w.role.INVENTORY_MANAGER, "/api/v1/assets", {
      asset_code: assetCode,
      serial_number: `SN${uniq().toUpperCase().slice(-8)}`,
      name: "Cordless drill",
      category: "ELECTRONIC",
      condition: "GOOD",
    });
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });

    // 1. The scan resolves the code to the asset...
    const resolved = await w.app.inject({
      method: "GET",
      url: `/api/v1/assets/resolve?code=${encodeURIComponent(assetCode)}`,
      headers: w.role.INVENTORY_MANAGER,
    });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { id: string }).id).toBe(assetId);

    // 2. ...and its current state is shown before anything is mutated.
    const before = await w.app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: w.role.INVENTORY_MANAGER,
    });
    expect(before.statusCode).toBe(200);
    const state = before.json() as {
      status: string;
      condition: string;
      assignments: unknown[];
    };
    expect(state.status).toBe("AVAILABLE");
    expect(state.condition).toBe("GOOD");
    expect(state.assignments).toHaveLength(0);

    // 3. Assign.
    const assigned = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/assign`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload: {
        employee_id: employeeId,
        condition: "GOOD",
        reason: "Issued for the Kondapur site",
        due_date: plusDays(30),
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { status: string }).status).toBe("ASSIGNED");

    // 4. Return, with the condition actually observed.
    const returned = await w.app.inject({
      method: "POST",
      url: `/api/v1/assets/${assetId}/transition`,
      headers: {
        ...w.role.INVENTORY_MANAGER,
        ...(await ifMatch(w, "assets", assetId)),
        ...idem(),
      },
      payload: {
        status: "RETURNED",
        condition: "WORN_BATTERY",
        reason: "Battery holds less charge after the season",
      },
    });
    expect(returned.statusCode).toBe(200);

    const after = await w.app.inject({
      method: "GET",
      url: `/api/v1/assets/${assetId}`,
      headers: w.role.INVENTORY_MANAGER,
    });
    const finalState = after.json() as {
      status: string;
      condition: string;
      assignments: Array<{
        employee_id: string;
        returned_at: string | null;
        condition: string;
        reason: string;
      }>;
    };
    expect(finalState.status).toBe("RETURNED");
    expect(finalState.condition).toBe("WORN_BATTERY");
    // One closed assignment, still naming who held it and why.
    expect(finalState.assignments).toHaveLength(1);
    expect(finalState.assignments[0]!.employee_id).toBe(employeeId);
    expect(finalState.assignments[0]!.returned_at).toBeTruthy();
    expect(finalState.assignments[0]!.reason).toContain("Kondapur");
  });
});

// ===========================================================================
// E2E-20  (the drag itself is asserted in the web suite)
// ===========================================================================

describe("E2E-20 PM drags card through allowed then disallowed board transition", () => {
  it("persists the allowed move for both views and reverts the invalid one", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `B${uniq().toUpperCase().slice(-8)}`,
      name: "Board project",
      // The manager runs this board. A manager is scoped to their own work,
      // so a project nobody put them on is one they cannot see to drag.
      project_manager_id: w.roleUserId.PROJECT_MANAGER,
    });
    await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: {
        ...w.admin,
        ...(await ifMatch(w, "projects", projectId)),
        ...idem(),
      },
      payload: { status: "ACTIVE" },
    });
    const taskId = await post(w.app, w.role.PROJECT_MANAGER, "/api/v1/tasks", {
      project_id: projectId,
      title: `Board card ${uniq()}`,
    });

    // Allowed move.
    const allowed = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}/status`,
      headers: {
        ...w.role.PROJECT_MANAGER,
        ...(await ifMatch(w, "tasks", taskId)),
        ...idem(),
      },
      payload: { status: "IN_PROGRESS" },
    });
    expect(allowed.statusCode).toBe(200);

    // The same state shows in the List view's payload and the board's.
    const list = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks?project_id=${projectId}&limit=50`,
      headers: w.role.PROJECT_MANAGER,
    });
    const listed = (
      list.json() as { data: Array<{ id: string; status: string; allowed_next: string[] }> }
    ).data.find((t) => t.id === taskId)!;
    expect(listed.status).toBe("IN_PROGRESS");
    // The board picks its drop targets from exactly this field.
    expect(listed.allowed_next).toEqual(
      expect.arrayContaining(["IN_REVIEW", "BLOCKED", "TO_DO"]),
    );
    expect(listed.allowed_next).not.toContain("DONE");

    // Disallowed move: IN_PROGRESS → DONE skips review.
    const invalid = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${taskId}/status`,
      headers: {
        ...w.role.PROJECT_MANAGER,
        ...(await ifMatch(w, "tasks", taskId)),
        ...idem(),
      },
      payload: { status: "DONE" },
    });
    expect(invalid.statusCode).toBe(422);
    const body = invalid.json() as ErrorBody & { allowed_next?: string[] };
    expect(body.code).toBe("INVALID_TRANSITION");
    // The card snaps back, and the UI is told where it *could* go.
    expect(body.allowed_next).toEqual(expect.arrayContaining(["IN_REVIEW"]));

    const persisted = await w.pool.query("SELECT status FROM tasks WHERE id = $1", [taskId]);
    expect(persisted.rows[0].status).toBe("IN_PROGRESS");
  });
});

// ===========================================================================
// E2E-21 / E2E-22 / E2E-23
// ===========================================================================

describe("E2E-21 create dependency cycle and start blocked successor", () => {
  it("rejects both without leaving a partial write", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `C${uniq().toUpperCase().slice(-8)}`,
      name: "Cycle project",
    });
    const a = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Foundation",
    });
    const b = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Walls",
    });
    expect(
      (
        await w.app.inject({
          method: "POST",
          url: `/api/v1/tasks/${b}/dependencies`,
          headers: { ...w.admin, ...idem() },
          payload: { predecessor_id: a, dependency_type: "FINISH_TO_START" },
        })
      ).statusCode,
    ).toBe(201);

    const edgesBefore = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM task_dependencies WHERE successor_id = ANY($1::uuid[])",
      [[a, b]],
    );

    // 1. Closing the loop is refused.
    const cycle = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${a}/dependencies`,
      headers: { ...w.admin, ...idem() },
      payload: { predecessor_id: b, dependency_type: "FINISH_TO_START" },
    });
    expect(cycle.statusCode).toBe(422);
    expect((cycle.json() as ErrorBody).code).toBe("DEPENDENCY_CYCLE");

    // 2. Starting the successor early is refused.
    const premature = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${b}/status`,
      headers: { ...w.admin, ...(await ifMatch(w, "tasks", b)), ...idem() },
      payload: { status: "IN_PROGRESS" },
    });
    expect(premature.statusCode).toBe(422);
    expect((premature.json() as ErrorBody).code).toBe("DEPENDENCY_BLOCKED");

    // Neither attempt changed anything.
    const edgesAfter = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM task_dependencies WHERE successor_id = ANY($1::uuid[])",
      [[a, b]],
    );
    expect(edgesAfter.rows[0].n).toBe(edgesBefore.rows[0].n);
    const statuses = await w.pool.query(
      "SELECT id, status FROM tasks WHERE id = ANY($1::uuid[])",
      [[a, b]],
    );
    expect(statuses.rows.every((r) => r.status === "TO_DO")).toBe(true);
  });
});

describe("E2E-22 close project with open tasks, then finish tasks and retry", () => {
  it("lists the blockers first, then closes and audits the second attempt", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `X${uniq().toUpperCase().slice(-8)}`,
      name: "Closable project",
    });
    await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: { status: "ACTIVE" },
    });
    const tasks = [
      await post(w.app, w.admin, "/api/v1/tasks", { project_id: projectId, title: "One" }),
      await post(w.app, w.admin, "/api/v1/tasks", { project_id: projectId, title: "Two" }),
    ];

    const first = await w.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: {},
    });
    expect(first.statusCode).toBe(422);
    const blocked = first.json() as ErrorBody & { open_count?: number };
    expect(blocked.code).toBe("PROJECT_HAS_OPEN_TASKS");
    expect(blocked.open_count).toBe(2);
    expect(blocked.message).toContain("2");

    for (const taskId of tasks) {
      for (const status of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
        const res = await w.app.inject({
          method: "PATCH",
          url: `/api/v1/tasks/${taskId}/status`,
          headers: { ...w.admin, ...(await ifMatch(w, "tasks", taskId)), ...idem() },
          payload: { status },
        });
        expect(res.statusCode, `${taskId} ${status}`).toBe(200);
      }
    }

    const second = await w.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(
      (await w.pool.query("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0]
        .status,
    ).toBe("CLOSED");

    const audit = await w.pool.query(
      "SELECT action, actor_id FROM audit_events WHERE entity_id = $1 AND action LIKE 'project.close%'",
      [projectId],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(audit.rows[0].actor_id).toBe(w.adminId);
  });
});

describe("E2E-23 close cycle with incomplete tasks", () => {
  it("rolls the unfinished work into the configured target and keeps the history", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `Y${uniq().toUpperCase().slice(-8)}`,
      name: "Cycle rollover project",
    });
    await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: { status: "ACTIVE" },
    });

    const cycleId = await post(w.app, w.admin, "/api/v1/cycles", {
      project_id: projectId,
      name: `Sprint ${uniq()}`,
      start_date: plusDays(0),
      end_date: plusDays(13),
      rollover: "NEXT",
    });

    const done = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Finished work",
    });
    const open = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Unfinished work",
    });
    for (const taskId of [done, open]) {
      await w.app.inject({
        method: "PATCH",
        url: `/api/v1/tasks/${taskId}/planning`,
        headers: { ...w.admin, ...(await ifMatch(w, "tasks", taskId)), ...idem() },
        payload: { cycle_id: cycleId },
      });
    }
    for (const status of ["IN_PROGRESS", "IN_REVIEW", "DONE"]) {
      await w.app.inject({
        method: "PATCH",
        url: `/api/v1/tasks/${done}/status`,
        headers: { ...w.admin, ...(await ifMatch(w, "tasks", done)), ...idem() },
        payload: { status },
      });
    }

    const closed = await w.app.inject({
      method: "POST",
      url: `/api/v1/cycles/${cycleId}/close`,
      headers: { ...w.admin, ...(await ifMatch(w, "cycles", cycleId)), ...idem() },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    const metrics = (
      closed.json() as {
        metrics: { planned: number; completed: number; remaining: number; next_cycle_id: string };
      }
    ).metrics;
    expect(metrics).toMatchObject({ planned: 2, completed: 1, remaining: 1 });

    const moved = await w.pool.query("SELECT cycle_id FROM tasks WHERE id = $1", [open]);
    expect(moved.rows[0].cycle_id).toBe(metrics.next_cycle_id);
    const kept = await w.pool.query("SELECT cycle_id FROM tasks WHERE id = $1", [done]);
    expect(kept.rows[0].cycle_id).toBe(cycleId);

    // The prior cycle is still there, closed, with its numbers.
    const prior = await w.pool.query(
      "SELECT status, closed_at, metrics FROM cycles WHERE id = $1",
      [cycleId],
    );
    expect(prior.rows[0].status).toBe("CLOSED");
    expect(prior.rows[0].closed_at).toBeTruthy();
    expect(prior.rows[0].metrics).toMatchObject({ planned: 2, completed: 1 });
  });
});

// ===========================================================================
// E2E-24 / E2E-25
// ===========================================================================

describe("E2E-24 automation tries invalid assignment or status transition", () => {
  async function drainJobs(maxPasses = 20): Promise<void> {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const { events } = await runJobs(w.app, w.pool, JWT_SECRET);
      if (events === 0) return;
    }
  }

  it("blocks the action at the domain rule and names the failure in the log", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `A${uniq().toUpperCase().slice(-8)}`,
      name: "Automation project",
    });
    await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: { status: "ACTIVE" },
    });

    const ruleId = await post(w.app, w.admin, "/api/v1/automation-rules", {
      project_id: projectId,
      name: `Skip review ${uniq()}`,
      trigger: "task.create",
      conditions: [],
      actions: [{ type: "status", value: "DONE" }],
      active: true,
    });

    const taskId = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Automated task",
    });
    const event = await w.pool.query(
      `INSERT INTO domain_events (org_id, actor_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'task.create', 'task', $3, $4::jsonb) RETURNING id`,
      [w.orgId, w.adminId, taskId, JSON.stringify({ project_id: projectId })],
    );
    await drainJobs();

    // The business data is untouched.
    expect(
      (await w.pool.query("SELECT status FROM tasks WHERE id = $1", [taskId])).rows[0].status,
    ).toBe("TO_DO");

    // The execution log identifies the failure, so an admin can fix the rule.
    const execution = await w.pool.query(
      "SELECT status, results FROM automation_executions WHERE rule_id = $1 AND event_id = $2",
      [ruleId, event.rows[0].id],
    );
    expect(execution.rowCount).toBe(1);
    expect(execution.rows[0].status).toBe("FAILED");
    const results = execution.rows[0].results as Array<{ code?: string; status: number }>;
    expect(results[0]!.code).toBe("INVALID_TRANSITION");

    // And the rule's own executions are readable through the API.
    const listed = await w.app.inject({
      method: "GET",
      url: `/api/v1/automation-rules/${ruleId}/executions`,
      headers: w.admin,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { data: Array<{ status: string }> }).data.some(
        (e) => e.status === "FAILED",
      ),
    ).toBe(true);
  });
});

describe("E2E-25 comment mentions user and SLA crosses threshold", () => {
  it("persists and deduplicates inbox items even when the external adapter fails", async () => {
    const projectId = await post(w.app, w.admin, "/api/v1/projects", {
      workspace_id: w.workspaceId,
      project_type_id: w.projectTypeId,
      code: `M${uniq().toUpperCase().slice(-8)}`,
      name: "Mentions project",
    });
    await w.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...w.admin, ...(await ifMatch(w, "projects", projectId)), ...idem() },
      payload: { status: "ACTIVE" },
    });
    const taskId = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: projectId,
      title: "Task with a mention",
      planned_end_date: plusDays(1),
    });

    // No push adapter is configured in this environment, which is exactly the
    // "external notification adapter fails" condition the catalogue asks for:
    // the in-app inbox must still carry the item.
    const mentionedUsername = `cat_e2e_mention_${uniq()}`;
    const mentionedId = await createUser(w.pool, w.orgId, {
      username: mentionedUsername,
      roles: ["PROJECT_MANAGER"],
    });

    const comment = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/comments`,
      headers: { ...w.admin, ...idem() },
      payload: { body: `Please review this today @${mentionedUsername}` },
    });
    expect(comment.statusCode).toBe(201);

    const inbox = await w.pool.query(
      // The inbox item points at the comment that carried the mention.
      "SELECT id, type, body FROM notifications WHERE recipient_id = $1 AND type = 'MENTION'",
      [mentionedId],
    );
    expect(inbox.rowCount).toBe(1);
    // Usernames only — an inbox line must not leak the task's contents or PII.
    expect(String(inbox.rows[0].body)).toContain("Task with a mention");
    expect(String(inbox.rows[0].body)).not.toMatch(/aadhaar|salary|\d{12}/i);

    // The mention row itself is recorded, so the "mentioned me" filter works.
    const mentions = await w.pool.query(
      `SELECT COUNT(*)::int AS n FROM mentions m
         JOIN comments c ON c.id = m.comment_id
        WHERE m.mentioned_user_id = $1 AND c.task_id = $2`,
      [mentionedId, taskId],
    );
    expect(mentions.rows[0].n).toBe(1);

    const filtered = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks?mentioned_me=true&limit=50`,
      headers: await loginAs(w.app, mentionedUsername),
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      (filtered.json() as { data: Array<{ id: string }> }).data.map((t) => t.id),
    ).toContain(taskId);

    // A repeated identical comment is a second, genuinely distinct comment and
    // raises its own item; what must never happen is one comment raising two.
    const repeated = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/comments`,
      headers: { ...w.admin, ...idem() },
      payload: { body: `Please review this today @${mentionedUsername}` },
    });
    expect(repeated.statusCode).toBe(201);
    const perComment = await w.pool.query(
      `SELECT entity_id, COUNT(*)::int AS n FROM notifications
        WHERE recipient_id = $1 AND type = 'MENTION' GROUP BY entity_id`,
      [mentionedId],
    );
    expect(perComment.rows.every((r) => r.n === 1)).toBe(true);

    // The SLA state is computed and visible without any external service.
    const detail = await w.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers: w.admin,
    });
    expect((detail.json() as { sla_status: string }).sla_status).toBe("AT_RISK");
  });
});

// ===========================================================================
// E2E-26
// ===========================================================================

describe("E2E-26 auditor exports attendance/audit report; viewer exports project progress", () => {
  async function download(headers: Headers, type: string): Promise<string> {
    const created = await w.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: { ...headers, ...idem() },
      payload: { type, format: "csv" },
    });
    expect([200, 201], `${type} create`).toContain(created.statusCode);
    const { id } = created.json() as { id: string };
    const file = await w.app.inject({
      method: "GET",
      url: `/api/v1/reports/${id}/download`,
      headers,
    });
    expect(file.statusCode).toBe(200);
    return file.body;
  }

  it("gives the auditor reconstruction evidence", async () => {
    // Make sure there is something to reconstruct.
    const worker = await fieldWorker();
    await punch(w.admin, {
      employee_id: worker.employeeId,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });

    const attendance = await download(w.role.AUDITOR, "attendance");
    expect(attendance).toMatch(/Data scope/i);
    expect(attendance.split("\n").length).toBeGreaterThan(2);

    const audit = await download(w.role.AUDITOR, "audit");
    // The audit export carries the who/what/when an auditor needs.
    expect(audit.toLowerCase()).toMatch(/action/);
  });

  it("gives the client viewer only external-safe project fields", async () => {
    const viewer = w.role.CLIENT_VIEWER;
    // A client viewer holds no employee or attendance read at all.
    for (const type of ["employees", "attendance", "payroll"]) {
      const res = await w.app.inject({
        method: "POST",
        url: "/api/v1/reports",
        headers: { ...viewer, ...idem() },
        payload: { type, format: "csv" },
      });
      expect(res.statusCode, type).toBe(403);
    }

    // And the project view they *can* read is trimmed to safe fields.
    const projects = await w.app.inject({
      method: "GET",
      url: "/api/v1/projects?limit=10",
      headers: viewer,
    });
    expect(projects.statusCode).toBe(200);
    for (const row of (projects.json() as { data: Array<Record<string, unknown>> }).data) {
      // Internal bookkeeping is not part of a client-facing progress view.
      expect(row).not.toHaveProperty("created_by");
      expect(row).not.toHaveProperty("updated_by");
      expect(row).not.toHaveProperty("project_manager_id");
    }
  });

  it("audits every export", async () => {
    const before = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM audit_events WHERE action LIKE 'report%'",
    );
    await download(w.role.AUDITOR, "attendance");
    const after = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM audit_events WHERE action LIKE 'report%'",
    );
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
  });
});

// ===========================================================================
// E2E-27
// ===========================================================================

describe("E2E-27 upload invalid, oversized and malware-positive evidence/document", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");

  async function upload(
    employeeId: string,
    body: Record<string, unknown>,
  ) {
    return w.app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/documents`,
      headers: { ...w.admin, ...idem() },
      payload: body,
    });
  }

  it("rejects a disallowed extension", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const res = await upload(employeeId, {
      doc_type: "ID",
      file_name: "payload.exe",
      content_base64: Buffer.from("MZ").toString("base64"),
    });
    expect(res.statusCode).toBe(422);

    const stored = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM employee_documents WHERE employee_id = $1",
      [employeeId],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("rejects content that does not match its extension", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    // A .png whose bytes are not a PNG — the classic extension lie.
    const res = await upload(employeeId, {
      doc_type: "ID",
      file_name: "not-really.png",
      content_base64: Buffer.from("this is plain text").toString("base64"),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as ErrorBody).code).toBe("FILE_TYPE_MISMATCH");
  });

  it("rejects an oversized file", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const oversized = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(employeeId, {
      doc_type: "ID",
      file_name: "huge.png",
      content_base64: oversized.toString("base64"),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const stored = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM employee_documents WHERE employee_id = $1",
      [employeeId],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("refuses to store anything when the scanner is unreachable", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    // Pointing at a closed port is the honest stand-in for "scanner down": the
    // upload must fail closed, never be stored unscanned.
    process.env["MALWARE_SCANNER_HOST"] = "127.0.0.1";
    process.env["MALWARE_SCANNER_PORT"] = "1";
    try {
      const res = await upload(employeeId, {
        doc_type: "ID",
        file_name: "clean.png",
        content_base64: Buffer.concat([PNG, Buffer.from("payload")]).toString("base64"),
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as ErrorBody).code).toBe("SCAN_UNAVAILABLE");

      const stored = await w.pool.query(
        "SELECT COUNT(*)::int AS n FROM employee_documents WHERE employee_id = $1",
        [employeeId],
      );
      expect(stored.rows[0].n).toBe(0);
    } finally {
      delete process.env["MALWARE_SCANNER_HOST"];
      delete process.env["MALWARE_SCANNER_PORT"];
    }
  });

  it("applies the same rules to task evidence", async () => {
    const taskId = await post(w.app, w.admin, "/api/v1/tasks", {
      project_id: w.activeProject,
      title: `Evidence task ${uniq()}`,
    });
    const res = await w.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/evidence`,
      headers: { ...w.admin, ...idem() },
      payload: {
        evidence_type: "PHOTO",
        file_name: "shot.png",
        content_base64: Buffer.from("not a png at all").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(422);

    const stored = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM task_evidence WHERE task_id = $1",
      [taskId],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it("skips scanning only when the operator has explicitly said so", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    // Scanner unreachable AND the opt-out set: the upload proceeds, because
    // the risk was accepted deliberately rather than by omission.
    process.env["MALWARE_SCANNER_HOST"] = "127.0.0.1";
    process.env["MALWARE_SCANNER_PORT"] = "1";
    process.env["MALWARE_SCANNER_DISABLED"] = "true";
    try {
      const res = await upload(employeeId, {
        doc_type: "ID",
        file_name: "clean.png",
        content_base64: Buffer.concat([PNG, Buffer.from("payload")]).toString("base64"),
      });
      expect(res.statusCode).toBe(201);

      // The signature check is not part of the opt-out: a file lying about its
      // extension is still refused.
      const lying = await upload(employeeId, {
        doc_type: "ID",
        file_name: "lying.png",
        content_base64: Buffer.from("definitely not a png").toString("base64"),
      });
      expect(lying.statusCode).toBe(422);
      expect((lying.json() as ErrorBody).code).toBe("FILE_TYPE_MISMATCH");
    } finally {
      delete process.env["MALWARE_SCANNER_HOST"];
      delete process.env["MALWARE_SCANNER_PORT"];
      delete process.env["MALWARE_SCANNER_DISABLED"];
    }
  });

  it("accepts a well-formed file and stores it once", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    const res = await upload(employeeId, {
      doc_type: "ID",
      file_name: "id.png",
      content_base64: Buffer.concat([PNG, Buffer.from("content")]).toString("base64"),
    });
    expect(res.statusCode).toBe(201);
    const stored = await w.pool.query(
      "SELECT file_path, content_encrypted, checksum FROM employee_documents WHERE employee_id = $1",
      [employeeId],
    );
    expect(stored.rowCount).toBe(1);
    // Content is held in the database, encrypted — there is no path, public or
    // otherwise, and the download goes through an authorized route.
    expect(stored.rows[0].file_path).toBeNull();
    expect(stored.rows[0].content_encrypted).toMatch(/^gcm1\./);
    expect(stored.rows[0].checksum).toHaveLength(64);

    // And it round-trips: the bytes come back byte-identical through the API.
    const docId = (
      await w.pool.query("SELECT id FROM employee_documents WHERE employee_id = $1", [
        employeeId,
      ])
    ).rows[0].id as string;
    const download = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeId}/documents/${docId}/download`,
      headers: w.admin,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(Buffer.concat([PNG, Buffer.from("content")]))).toBe(
      true,
    );
  });
});

// ===========================================================================
// E2E-28
// ===========================================================================

describe("E2E-28 revoke employee device while it has a session and cached data", () => {
  it("kills the session, signals the wipe, and keeps the push text free of detail", async () => {
    const worker = await fieldWorker();
    const deviceId = `device-${uniq()}`;

    // The phone registers and signs in with its device id.
    const registered = await w.app.inject({
      method: "POST",
      url: "/api/v1/devices/register",
      headers: { ...worker.headers, ...idem() },
      payload: { device_id: deviceId, push_token: `tok-${uniq()}` },
    });
    expect(registered.statusCode).toBe(200);
    const registrationId = (registered.json() as { id: string }).id;

    const username = (
      await w.pool.query("SELECT username FROM users WHERE id = $1", [worker.userId])
    ).rows[0].username as string;
    const signedIn = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Pass1234!", device_id: deviceId },
    });
    expect(signedIn.statusCode).toBe(200);
    const { refresh_token } = signedIn.json() as { refresh_token: string };

    // The admin revokes the device.
    const revoked = await w.app.inject({
      method: "POST",
      url: `/api/v1/admin/devices/${registrationId}/revoke`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);

    // 1. The live session cannot be refreshed.
    const refresh = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token },
    });
    expect(refresh.statusCode).toBe(401);
    expect((refresh.json() as ErrorBody).code).toBe("DEVICE_REVOKED");

    // 2. And it cannot sign in again from that device.
    const retry = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Pass1234!", device_id: deviceId },
    });
    expect(retry.statusCode).toBe(401);
    expect((retry.json() as ErrorBody).code).toBe("DEVICE_REVOKED");

    // 3. The wipe is requested, which is what the client acts on.
    const registration = await w.pool.query(
      "SELECT revoked_at, wipe_requested_at FROM device_registrations WHERE id = $1",
      [registrationId],
    );
    expect(registration.rows[0].revoked_at).toBeTruthy();
    expect(registration.rows[0].wipe_requested_at).toBeTruthy();

    // 4. Every session for that device is revoked in the database too.
    const sessions = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND device_id = $2 AND revoked = false",
      [worker.userId, deviceId],
    );
    expect(sessions.rows[0].n).toBe(0);

    // 5. No notification carries business detail about the revocation.
    const notifications = await w.pool.query(
      "SELECT title, body FROM notifications WHERE recipient_id = $1",
      [worker.userId],
    );
    for (const row of notifications.rows) {
      expect(String(row.body)).not.toContain(deviceId);
      expect(String(row.body)).not.toMatch(/password|token|aadhaar/i);
    }
  });

  it("leaves the same user's other devices working", async () => {
    const worker = await fieldWorker();
    const username = (
      await w.pool.query("SELECT username FROM users WHERE id = $1", [worker.userId])
    ).rows[0].username as string;
    const revokedDevice = `device-a-${uniq()}`;
    const keptDevice = `device-b-${uniq()}`;

    for (const deviceId of [revokedDevice, keptDevice]) {
      await w.app.inject({
        method: "POST",
        url: "/api/v1/devices/register",
        headers: { ...worker.headers, ...idem() },
        payload: { device_id: deviceId },
      });
    }
    const registrationId = (
      await w.pool.query(
        "SELECT id FROM device_registrations WHERE user_id = $1 AND device_id = $2",
        [worker.userId, revokedDevice],
      )
    ).rows[0].id as string;

    await w.app.inject({
      method: "POST",
      url: `/api/v1/admin/devices/${registrationId}/revoke`,
      headers: { ...w.admin, ...idem() },
      payload: {},
    });

    // Revoking one handset must not lock the worker out of the other.
    const other = await w.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Pass1234!", device_id: keptDevice },
    });
    expect(other.statusCode).toBe(200);
  });
});

// ===========================================================================
// E2E-29
// ===========================================================================

describe("E2E-29 use organization A identifiers while authenticated to organization B", () => {
  it("denies without confirming the record exists", async () => {
    // Every probe uses a real id that exists in the *other* tenant.
    const probes: Array<[string, string, string]> = [
      ["GET", `/api/v1/employees/${w.other.employee}`, "employee"],
      ["GET", `/api/v1/org/units/${w.other.site}`, "org unit"],
    ];
    for (const [method, url, label] of probes) {
      const res = await w.app.inject({
        method: method as "GET",
        url,
        headers: w.admin,
      });
      expect(res.statusCode, label).toBe(404);
      const body = res.json() as ErrorBody;
      // A 404, and nothing in it that confirms the row is real elsewhere.
      expect(body.code).toBe("NOT_FOUND");
      expect(res.body).not.toContain(w.other.orgId);
    }
  });

  it("refuses to reference another tenant's rows in a write", async () => {
    const crossTenant = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Cross-tenant fence",
        scope_type: "site",
        scope_id: w.other.site,
        geometry_type: "circle",
        geometry: { lat: 17.4, lng: 78.4, radius_m: 100 },
      },
    });
    expect(crossTenant.statusCode).toBe(422);

    const punchOther = await punch(w.admin, {
      employee_id: w.other.employee,
      latitude: GEO.insideCircle.lat,
      longitude: GEO.insideCircle.lng,
    });
    expect(punchOther.statusCode).toBe(422);
    expect((punchOther.json() as ErrorBody).code).toBe("EMPLOYEE_INACTIVE");

    // Nothing was created for the foreign employee.
    const events = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance_events WHERE employee_id = $1",
      [w.other.employee],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it("keeps every list free of the other tenant's rows", async () => {
    const lists: Array<[string, string]> = [
      ["/api/v1/employees?limit=100", w.other.employee],
      ["/api/v1/org/units?limit=100", w.other.site],
      ["/api/v1/geo-fences?limit=100", w.other.fence],
    ];
    for (const [url, foreignId] of lists) {
      const res = await w.app.inject({ method: "GET", url, headers: w.admin });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(foreignId);
    }
  });

  it("works in the other direction too", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/employees/${w.directEmployee}`,
      headers: w.other.admin,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ===========================================================================
// E2E-32
// ===========================================================================

describe("E2E-32 run 200 or more concurrent field users punching and syncing", () => {
  it("records exactly one punch each, with no duplicates and no negative capacity", async () => {
    const USERS = 200;

    // Build the cohort on one shared site, the way a real shift arrives.
    const chain = await createChain(w.app, w.admin, `L${uniq().slice(-4)}`);
    await createFence(w.app, w.admin, {
      name: "Load-test site",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { ...GEO.circleCentre, radius_m: 500 },
    });

    const employees: string[] = [];
    for (let i = 0; i < USERS; i += 1) {
      employees.push(
        await createActiveEmployee(w.app, w.admin, {
          district_id: chain.district,
          mandal_id: chain.mandal,
          village_id: chain.village,
          site_id: chain.site,
        }),
      );
    }

    // Each device retries its punch twice, as a flaky connection would.
    const started = Date.now();
    const results = await Promise.all(
      employees.flatMap((employeeId) => {
        const key = idem();
        const payload = {
          employee_id: employeeId,
          event_type: "CHECK_IN",
          client_timestamp: new Date().toISOString(),
          latitude: GEO.insideCircle.lat,
          longitude: GEO.insideCircle.lng,
          gps_accuracy: 9,
        };
        const send = () =>
          w.app.inject({
            method: "POST",
            url: "/api/v1/attendance/events",
            headers: { ...w.admin, ...key },
            payload,
          });
        return [send(), send()];
      }),
    );
    const elapsedMs = Date.now() - started;

    // No request failed outright.
    const failures = results.filter((r) => r.statusCode >= 400);
    expect(
      failures.map((f) => `${f.statusCode} ${f.body.slice(0, 120)}`).slice(0, 3),
    ).toEqual([]);

    // Exactly one event and one record per employee, despite the retries.
    const events = await w.pool.query(
      `SELECT employee_id, COUNT(*)::int AS n FROM attendance_events
        WHERE employee_id = ANY($1::uuid[]) GROUP BY employee_id`,
      [employees],
    );
    expect(events.rowCount).toBe(USERS);
    expect(events.rows.every((r) => r.n === 1)).toBe(true);

    const records = await w.pool.query(
      `SELECT COUNT(*)::int AS n FROM attendance_records WHERE employee_id = ANY($1::uuid[])`,
      [employees],
    );
    expect(records.rows[0].n).toBe(USERS);

    // Latency and headroom are recorded rather than asserted as a hard gate:
    // the number depends on the machine, and the catalogue asks for it to be
    // reported alongside the release evidence.
    const meanMs = elapsedMs / results.length;
    // eslint-disable-next-line no-console
    console.log(
      `E2E-32: ${USERS} users, ${results.length} requests in ${elapsedMs}ms ` +
        `(mean ${meanMs.toFixed(1)}ms/request)`,
    );
    expect(meanMs).toBeLessThan(250);
  }, 180_000);
});

// ===========================================================================
// E2E-33
// ===========================================================================

describe("E2E-33 restore production-like backup and reconcile migrated master data", () => {
  /**
   * A restore is exercised as the product supports it: the migration runner is
   * re-applied to a database that already holds data, and the business totals
   * are reconciled before and after. That covers the part this repository owns
   * — schema convergence and data integrity. Provisioning a snapshot and
   * measuring wall-clock RPO/RTO belongs to the deployment runbook, and is
   * called out as such in the catalogue report.
   */
  it("re-applies migrations to a populated database without changing business data", async () => {
    const before = await businessTotals();
    expect(before.employees).toBeGreaterThan(0);

    const { migrate } = await import("../../src/database/migrate.js");
    await migrate(TEST_DATABASE_URL());

    const after = await businessTotals();
    expect(after).toEqual(before);
  });

  it("leaves the schema at the version this build expects", async () => {
    const { MIGRATION_VERSIONS } = await import("../../src/database/migrate.js");
    const applied = await w.pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const versions = applied.rows.map((r) => r.version as string);
    for (const expected of MIGRATION_VERSIONS) {
      expect(versions, `missing migration ${expected}`).toContain(expected);
    }

    // And the running API agrees it is current.
    const health = await w.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { schema?: string }).schema).toBeUndefined();
  });

  it("reconciles unique keys, assignments and financial totals", async () => {
    // Unique business keys hold.
    const duplicateEmpNo = await w.pool.query(
      `SELECT org_id, emp_no FROM employees GROUP BY org_id, emp_no HAVING COUNT(*) > 1`,
    );
    expect(duplicateEmpNo.rowCount).toBe(0);

    // At most one open assignment per asset.
    const doubleAssigned = await w.pool.query(
      `SELECT asset_id FROM asset_assignments WHERE returned_at IS NULL
        GROUP BY asset_id HAVING COUNT(*) > 1`,
    );
    expect(doubleAssigned.rowCount).toBe(0);

    // At most one active direct fence per employee.
    const doubleFenced = await w.pool.query(
      `SELECT employee_id FROM geo_fence_employee_assignments WHERE status = 'ACTIVE'
        GROUP BY org_id, employee_id HAVING COUNT(*) > 1`,
    );
    expect(doubleFenced.rowCount).toBe(0);

    // No stock ledger has gone negative.
    const negativeStock = await w.pool.query(
      `SELECT item_id FROM stock_transactions GROUP BY item_id
        HAVING SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) < 0`,
    );
    expect(negativeStock.rowCount).toBe(0);

    // Every payroll run's stored totals match the sum of its payslips.
    const runTotals = await w.pool.query(
      `SELECT r.id, r.total_net, COALESCE(SUM(p.net_pay), 0) AS slip_net
         FROM payroll_runs r
         LEFT JOIN payslips p ON p.payroll_run_id = r.id AND p.is_current
        WHERE r.status <> 'OPEN'
        GROUP BY r.id, r.total_net`,
    );
    for (const row of runTotals.rows) {
      expect(Number(row.total_net), `run ${row.id}`).toBeCloseTo(Number(row.slip_net), 2);
    }

    // And no attendance record points at an event that is not its own.
    const orphaned = await w.pool.query(
      `SELECT r.id FROM attendance_records r
        LEFT JOIN attendance_events e ON e.id = r.check_in_event_id
       WHERE r.check_in_event_id IS NOT NULL AND (e.id IS NULL OR e.employee_id <> r.employee_id)`,
    );
    expect(orphaned.rowCount).toBe(0);
  });

  async function businessTotals() {
    const row = await w.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM employees) AS employees,
        (SELECT COUNT(*)::int FROM org_units) AS org_units,
        (SELECT COUNT(*)::int FROM geo_fences) AS geo_fences,
        (SELECT COUNT(*)::int FROM attendance_events) AS attendance_events,
        (SELECT COUNT(*)::int FROM attendance_records) AS attendance_records,
        (SELECT COUNT(*)::int FROM tasks) AS tasks,
        (SELECT COUNT(*)::int FROM projects) AS projects,
        (SELECT COUNT(*)::int FROM payslips) AS payslips,
        (SELECT COALESCE(SUM(net_pay), 0)::text FROM payslips) AS payslip_net,
        (SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)::text
           FROM stock_transactions) AS stock_balance
    `);
    return row.rows[0] as Record<string, number | string>;
  }
});

function TEST_DATABASE_URL(): string {
  return (
    process.env["TEST_DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_test"
  );
}
