/**
 * Catalogue: Geofence geometry, assignment and resolution (UT-GEO-01..13).
 *
 * Geometry decisions (01–04) are asserted against the shared `isInsideFence`
 * implementation, which is the single authority the API, the web client and the
 * Android client all evaluate — testing a re-implementation here would prove
 * nothing about what the phone decides.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInsideFence, type FenceShape } from "@silverline/shared";
import {
  GEO,
  buildWorld,
  createActiveEmployee,
  createChain,
  createEmployee,
  createFence,
  idem,
  ifMatch,
  loginAs,
  metresNorth,
  createUser,
  uniq,
  type CatalogueWorld,
} from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

function circle(radiusM: number, toleranceM: number | null = 0): FenceShape {
  return {
    geometry_type: "circle",
    geometry: { ...GEO.circleCentre, radius_m: radiusM },
    tolerance_meters: toleranceM,
  };
}

function polygon(toleranceM: number | null = 0): FenceShape {
  return {
    geometry_type: "polygon",
    geometry: { points: [...GEO.polygon] },
    tolerance_meters: toleranceM,
  };
}

describe("UT-GEO-01 point at centre, boundary and outside a circular fence", () => {
  const fence = circle(GEO.circleRadiusM);

  it("counts the centre as inside", () => {
    expect(isInsideFence(fence, GEO.circleCentre.lat, GEO.circleCentre.lng)).toBe(true);
  });

  it("counts a point just inside the boundary as inside", () => {
    const justInside = GEO.circleCentre.lat + metresNorth(GEO.circleRadiusM - 1);
    expect(isInsideFence(fence, justInside, GEO.circleCentre.lng)).toBe(true);
  });

  it("counts the boundary itself as inside", () => {
    // Exactly on the radius. A worker standing on the painted line is at work.
    expect(
      isInsideFence(fence, GEO.boundaryCircle.lat, GEO.boundaryCircle.lng),
    ).toBe(true);
  });

  it("counts a point beyond the boundary as outside", () => {
    const justOutside = GEO.circleCentre.lat + metresNorth(GEO.circleRadiusM + 5);
    expect(isInsideFence(fence, justOutside, GEO.circleCentre.lng)).toBe(false);
    expect(isInsideFence(fence, GEO.outsideCircle.lat, GEO.outsideCircle.lng)).toBe(false);
  });

  it("is symmetric in every direction, not just north", () => {
    const east = GEO.circleCentre.lng + 100 / (111_320 * Math.cos((17.385 * Math.PI) / 180));
    expect(isInsideFence(fence, GEO.circleCentre.lat, east)).toBe(true);
    const south = GEO.circleCentre.lat - metresNorth(100);
    expect(isInsideFence(fence, south, GEO.circleCentre.lng)).toBe(true);
  });
});

describe("UT-GEO-02 point inside, on edge and outside a polygon", () => {
  const fence = polygon();

  it("decides an interior point as inside", () => {
    expect(isInsideFence(fence, GEO.insidePolygon.lat, GEO.insidePolygon.lng)).toBe(true);
  });

  it("decides a vertex as inside", () => {
    expect(isInsideFence(fence, GEO.edgePolygon.lat, GEO.edgePolygon.lng)).toBe(true);
  });

  it("decides a point on an edge as inside", () => {
    // Midpoint of the southern edge.
    expect(isInsideFence(fence, 17.4, 78.505)).toBe(true);
  });

  it("decides an exterior point as outside", () => {
    expect(isInsideFence(fence, GEO.outsidePolygon.lat, GEO.outsidePolygon.lng)).toBe(false);
  });

  it("is deterministic — the same point always decides the same way", () => {
    const point = { lat: 17.4025, lng: 78.5075 };
    const decisions = Array.from({ length: 20 }, () =>
      isInsideFence(fence, point.lat, point.lng),
    );
    expect(new Set(decisions).size).toBe(1);
  });

  it("treats a degenerate ring of fewer than three points as containing nothing", () => {
    const degenerate: FenceShape = {
      geometry_type: "polygon",
      geometry: { points: [[17.4, 78.5], [17.41, 78.5]] },
      tolerance_meters: 0,
    };
    expect(isInsideFence(degenerate, 17.405, 78.5)).toBe(false);
  });
});

describe("UT-GEO-03 validate malformed circle and polygon geometry", () => {
  async function reject(payload: Record<string, unknown>, field: string) {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Malformed fence",
        scope_type: "site",
        scope_id: w.chainA.site,
        ...payload,
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; field_errors?: Array<{ field: string }> };
    expect(body.code).toBe("VALIDATION_ERROR");
    // The union schema reports the path under the geometry object.
    const fields = (body.field_errors ?? []).map((e) => e.field).join(" ");
    expect(fields).toContain(field);
  }

  it("rejects a latitude outside ±90", async () => {
    await reject(
      { geometry_type: "circle", geometry: { lat: 91, lng: 78.4, radius_m: 100 } },
      "lat",
    );
  });

  it("rejects a longitude outside ±180", async () => {
    await reject(
      { geometry_type: "circle", geometry: { lat: 17.4, lng: 181, radius_m: 100 } },
      "lng",
    );
  });

  it("rejects a non-positive radius", async () => {
    await reject(
      { geometry_type: "circle", geometry: { lat: 17.4, lng: 78.4, radius_m: 0 } },
      "radius_m",
    );
    await reject(
      { geometry_type: "circle", geometry: { lat: 17.4, lng: 78.4, radius_m: -50 } },
      "radius_m",
    );
  });

  it("rejects a polygon with fewer than three points", async () => {
    await reject(
      {
        geometry_type: "polygon",
        geometry: { points: [[17.4, 78.5], [17.41, 78.5]] },
      },
      "points",
    );
  });

  it("rejects a polygon point with an out-of-range coordinate", async () => {
    await reject(
      {
        geometry_type: "polygon",
        geometry: { points: [[17.4, 78.5], [17.41, 78.5], [95, 78.51]] },
      },
      "points",
    );
  });

  it("rejects a scope_type that does not match the referenced unit", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Mistyped scope",
        scope_type: "district",
        scope_id: w.chainA.site,
        geometry_type: "circle",
        geometry: { lat: 17.4, lng: 78.4, radius_m: 100 },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(
      (res.json() as { field_errors: Array<{ field: string }> }).field_errors[0]!.field,
    ).toBe("scope_type");
  });

  it("rejects a scope_id from another organization", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Cross-tenant scope",
        scope_type: "site",
        scope_id: w.other.site,
        geometry_type: "circle",
        geometry: { lat: 17.4, lng: 78.4, radius_m: 100 },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(
      (res.json() as { field_errors: Array<{ field: string }> }).field_errors[0]!.field,
    ).toBe("scope_id");
  });

  it("writes nothing when geometry validation fails", async () => {
    const before = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM geo_fences WHERE org_id = $1",
      [w.orgId],
    );
    await reject(
      { geometry_type: "circle", geometry: { lat: 200, lng: 78.4, radius_m: 100 } },
      "lat",
    );
    const after = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM geo_fences WHERE org_id = $1",
      [w.orgId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("UT-GEO-04 apply tolerance", () => {
  it("extends a circle's accepted area by exactly the tolerance", () => {
    const withTolerance = circle(GEO.circleRadiusM, 50);
    const at240 = GEO.circleCentre.lat + metresNorth(240);
    const at260 = GEO.circleCentre.lat + metresNorth(260);

    // 240 m is outside the 200 m radius but inside radius + 50 m.
    expect(isInsideFence(circle(GEO.circleRadiusM), at240, GEO.circleCentre.lng)).toBe(false);
    expect(isInsideFence(withTolerance, at240, GEO.circleCentre.lng)).toBe(true);
    // 260 m is beyond radius + tolerance.
    expect(isInsideFence(withTolerance, at260, GEO.circleCentre.lng)).toBe(false);
  });

  it("extends a polygon's accepted area by the tolerance around every edge", () => {
    const justOutside = { lat: 17.4 - metresNorth(30), lng: 78.505 };
    expect(isInsideFence(polygon(0), justOutside.lat, justOutside.lng)).toBe(false);
    expect(isInsideFence(polygon(50), justOutside.lat, justOutside.lng)).toBe(true);
    expect(isInsideFence(polygon(10), justOutside.lat, justOutside.lng)).toBe(false);
  });

  it("treats a null tolerance as zero", () => {
    const at210 = GEO.circleCentre.lat + metresNorth(210);
    expect(isInsideFence(circle(GEO.circleRadiusM, null), at210, GEO.circleCentre.lng)).toBe(
      false,
    );
  });

  it("uses the stored tolerance when the server evaluates a punch", async () => {
    // A fence whose tolerance is the only reason the punch lands inside.
    const chain = await createChain(w.app, w.admin, `T${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const fenceId = await createFence(w.app, w.admin, {
      name: "Tolerance fence",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { ...GEO.circleCentre, radius_m: 100 },
      tolerance_meters: 100,
    });

    const at150 = GEO.circleCentre.lat + metresNorth(150);
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: at150,
        longitude: GEO.circleCentre.lng,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { event: { geofence_result: string; geofence_id: string } };
    expect(body.event.geofence_result).toBe("INSIDE");
    expect(body.event.geofence_id).toBe(fenceId);
  });
});

describe("UT-GEO-05 resolve direct employee fence and site fence together", () => {
  it("lets the active direct assignment win over the site fence", async () => {
    // directEmployee sits on chainA's site AND holds a direct assignment to the
    // circle fence. Give chainA's site a *second*, competing fence to make the
    // precedence visible.
    const competing = await createFence(w.app, w.admin, {
      name: "Competing site fence",
      scope_type: "site",
      scope_id: w.chainA.site,
      geometry_type: "circle",
      geometry: { lat: 12.9716, lng: 77.5946, radius_m: 5000 },
    });

    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: w.directEmployee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
    });
    expect([201, 202]).toContain(res.statusCode);

    const event = await w.pool.query(
      `SELECT geofence_id, geofence_result FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [w.directEmployee],
    );
    // The direct assignment is the effective fence, not the competing site one.
    expect(event.rows[0].geofence_id).toBe(w.circleFence);
    expect(event.rows[0].geofence_id).not.toBe(competing);
    expect(event.rows[0].geofence_result).toBe("INSIDE");
  });
});

describe("UT-GEO-06 resolve without direct assignment", () => {
  /**
   * Builds an employee on a fresh chain with a fence at each level, so each
   * level can be switched off in turn and the fallback observed.
   */
  async function levelledChain() {
    const chain = await createChain(w.app, w.admin, `L${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const fences = {
      site: await createFence(w.app, w.admin, {
        name: "site",
        scope_type: "site",
        scope_id: chain.site,
        geometry_type: "circle",
        geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
      }),
      village: await createFence(w.app, w.admin, {
        name: "village",
        scope_type: "village",
        scope_id: chain.village,
        geometry_type: "circle",
        geometry: { lat: 17.2, lng: 78.2, radius_m: 100 },
      }),
      mandal: await createFence(w.app, w.admin, {
        name: "mandal",
        scope_type: "mandal",
        scope_id: chain.mandal,
        geometry_type: "circle",
        geometry: { lat: 17.3, lng: 78.3, radius_m: 100 },
      }),
      district: await createFence(w.app, w.admin, {
        name: "district",
        scope_type: "district",
        scope_id: chain.district,
        geometry_type: "circle",
        geometry: { lat: 17.4, lng: 78.4, radius_m: 100 },
      }),
    };
    return { chain, employee, fences };
  }

  /** Punches with no coordinates, so the answer is purely which fence resolved. */
  async function resolvedFenceFor(employee: string): Promise<string | null> {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
      },
    });
    expect([200, 201, 202]).toContain(res.statusCode);
    const row = await w.pool.query(
      `SELECT geofence_id FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employee],
    );
    return row.rows[0]?.geofence_id ?? null;
  }

  async function deactivate(fenceId: string) {
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/geo-fences/${fenceId}`,
      headers: { ...w.admin, ...(await ifMatch(w, "geo_fences", fenceId)), ...idem() },
      payload: { status: "INACTIVE" },
    });
    expect(res.statusCode).toBe(200);
  }

  it("walks site → village → mandal → district as each level is switched off", async () => {
    const { employee, fences } = await levelledChain();

    // A punch with coordinates would pick whichever fence contains the point;
    // with none, resolution is pure precedence.
    expect(await resolvedFenceFor(employee)).toBe(fences.site);

    // Each punch needs its own work-date slot, so clear the day between probes.
    const clear = async () => {
      await w.pool.query("DELETE FROM attendance_records WHERE employee_id = $1", [employee]);
      await w.pool.query("DELETE FROM attendance_events WHERE employee_id = $1", [employee]);
    };

    await deactivate(fences.site);
    await clear();
    expect(await resolvedFenceFor(employee)).toBe(fences.village);

    await deactivate(fences.village);
    await clear();
    expect(await resolvedFenceFor(employee)).toBe(fences.mandal);

    await deactivate(fences.mandal);
    await clear();
    expect(await resolvedFenceFor(employee)).toBe(fences.district);

    await deactivate(fences.district);
    await clear();
    // Nothing left to resolve: NO_FENCE, not an error.
    expect(await resolvedFenceFor(employee)).toBeNull();
  });

  it("skips a level that simply has no fence", async () => {
    const chain = await createChain(w.app, w.admin, `S${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    // Only a mandal fence exists: site and village are absent, not inactive.
    const mandalFence = await createFence(w.app, w.admin, {
      name: "only mandal",
      scope_type: "mandal",
      scope_id: chain.mandal,
      geometry_type: "circle",
      geometry: { lat: 17.3, lng: 78.3, radius_m: 100 },
    });
    expect(await resolvedFenceFor(employee)).toBe(mandalFence);
  });

  it("evaluates every fence at a level and picks the one containing the punch", async () => {
    // A village holding both a depot and a site office is ordinary; a worker
    // inside the older of the two must not be reported OUTSIDE.
    const chain = await createChain(w.app, w.admin, `M${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const older = await createFence(w.app, w.admin, {
      name: "depot",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { ...GEO.circleCentre, radius_m: 200 },
    });
    await createFence(w.app, w.admin, {
      name: "site office",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { lat: 12.9716, lng: 77.5946, radius_m: 200 },
    });

    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
        latitude: GEO.insideCircle.lat,
        longitude: GEO.insideCircle.lng,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { event: { geofence_id: string; geofence_result: string } };
    expect(body.event.geofence_id).toBe(older);
    expect(body.event.geofence_result).toBe("INSIDE");
  });
});

describe("UT-GEO-07 deactivate direct fence", () => {
  it("falls back to the location hierarchy once the direct fence is inactive", async () => {
    const chain = await createChain(w.app, w.admin, `D${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const siteFence = await createFence(w.app, w.admin, {
      name: "hierarchy fence",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
    });
    // A direct fence on a different chain entirely, so the two are told apart.
    const directFence = await createFence(w.app, w.admin, {
      name: "direct fence",
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.9, lng: 78.9, radius_m: 100 },
      employee_ids: [employee],
    });

    const punch = async () => {
      await w.pool.query("DELETE FROM attendance_records WHERE employee_id = $1", [employee]);
      await w.pool.query("DELETE FROM attendance_events WHERE employee_id = $1", [employee]);
      await w.app.inject({
        method: "POST",
        url: "/api/v1/attendance/events",
        headers: { ...w.admin, ...idem() },
        payload: {
          employee_id: employee,
          event_type: "CHECK_IN",
          client_timestamp: new Date().toISOString(),
        },
      });
      const row = await w.pool.query(
        `SELECT geofence_id FROM attendance_events
          WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
        [employee],
      );
      return row.rows[0]?.geofence_id ?? null;
    };

    expect(await punch()).toBe(directFence);

    // BR-13: deactivating the *fence* retires the direct route too.
    const res = await w.app.inject({
      method: "PATCH",
      url: `/api/v1/geo-fences/${directFence}`,
      headers: {
        ...w.admin,
        ...(await ifMatch(w, "geo_fences", directFence)),
        ...idem(),
      },
      payload: { status: "INACTIVE" },
    });
    expect(res.statusCode).toBe(200);

    expect(await punch()).toBe(siteFence);
  });

  it("ignores an assignment row that has been retired", async () => {
    const chain = await createChain(w.app, w.admin, `R${uniq().slice(-3)}`);
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: chain.district,
      mandal_id: chain.mandal,
      village_id: chain.village,
      site_id: chain.site,
    });
    const siteFence = await createFence(w.app, w.admin, {
      name: "fallback",
      scope_type: "site",
      scope_id: chain.site,
      geometry_type: "circle",
      geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
    });
    const directFence = await createFence(w.app, w.admin, {
      name: "direct",
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.9, lng: 78.9, radius_m: 100 },
      employee_ids: [employee],
    });
    void directFence;

    // Retire the assignment (the fence itself stays ACTIVE for other people).
    await w.pool.query(
      `UPDATE geo_fence_employee_assignments SET status = 'INACTIVE'
        WHERE org_id = $1 AND employee_id = $2`,
      [w.orgId, employee],
    );

    await w.app.inject({
      method: "POST",
      url: "/api/v1/attendance/events",
      headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employee,
        event_type: "CHECK_IN",
        client_timestamp: new Date().toISOString(),
      },
    });
    const row = await w.pool.query(
      `SELECT geofence_id FROM attendance_events
        WHERE employee_id = $1 ORDER BY server_timestamp DESC LIMIT 1`,
      [employee],
    );
    expect(row.rows[0].geofence_id).toBe(siteFence);
  });
});

describe("UT-GEO-08 reassign employee to a second direct fence", () => {
  it("retires the previous assignment and leaves exactly one active", async () => {
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });

    const first = await createFence(w.app, w.admin, {
      name: "first direct",
      scope_type: "site",
      scope_id: w.chainA.site,
      geometry_type: "circle",
      geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
      employee_ids: [employee],
    });
    const second = await createFence(w.app, w.admin, {
      name: "second direct",
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.2, lng: 78.2, radius_m: 100 },
      employee_ids: [employee],
    });

    const rows = await w.pool.query(
      `SELECT geo_fence_id, status FROM geo_fence_employee_assignments
        WHERE org_id = $1 AND employee_id = $2 ORDER BY created_at`,
      [w.orgId, employee],
    );
    const byFence = new Map(rows.rows.map((r) => [r.geo_fence_id, r.status]));
    expect(byFence.get(first)).toBe("INACTIVE");
    expect(byFence.get(second)).toBe("ACTIVE");
    expect(rows.rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
  });

  it("keeps the retired assignment as history rather than deleting it", async () => {
    const employee = await createActiveEmployee(w.app, w.admin, {
      district_id: w.chainA.district,
    });
    await createFence(w.app, w.admin, {
      name: "history A",
      scope_type: "site",
      scope_id: w.chainA.site,
      geometry_type: "circle",
      geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
      employee_ids: [employee],
    });
    await createFence(w.app, w.admin, {
      name: "history B",
      scope_type: "site",
      scope_id: w.chainB.site,
      geometry_type: "circle",
      geometry: { lat: 17.2, lng: 78.2, radius_m: 100 },
      employee_ids: [employee],
    });

    const rows = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM geo_fence_employee_assignments WHERE employee_id = $1",
      [employee],
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

describe("UT-GEO-09 assign inactive, exited or cross-organization employee", () => {
  async function rejectAssignment(employeeId: string) {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Rejected assignment fence",
        scope_type: "site",
        scope_id: w.chainA.site,
        geometry_type: "circle",
        geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
        employee_ids: [employeeId],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { field_errors: Array<{ field: string }> };
    expect(body.field_errors[0]!.field).toBe("employee_ids");
  }

  it("rejects a DRAFT employee", async () => {
    await rejectAssignment(await createEmployee(w.app, w.admin));
  });

  it("rejects a suspended employee", async () => {
    await rejectAssignment(w.suspendedEmployee);
  });

  it("rejects an exited employee", async () => {
    await rejectAssignment(w.exitedEmployee);
  });

  it("rejects an employee from another organization", async () => {
    await rejectAssignment(w.other.employee);
  });

  it("creates no fence at all when one id in the list is invalid", async () => {
    const before = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM geo_fences WHERE org_id = $1",
      [w.orgId],
    );
    const good = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.admin, ...idem() },
      payload: {
        name: "Partial assignment fence",
        scope_type: "site",
        scope_id: w.chainA.site,
        geometry_type: "circle",
        geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
        employee_ids: [good, w.exitedEmployee],
      },
    });
    expect(res.statusCode).toBe(422);
    const after = await w.pool.query(
      "SELECT COUNT(*)::int AS n FROM geo_fences WHERE org_id = $1",
      [w.orgId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("UT-GEO-10 read effective fences as an employee", () => {
  it("returns the direct fence and the employee's own location chain only", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers: w.directUser,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((f) => f.id);

    // directEmployee's own direct fence is present...
    expect(ids).toContain(w.circleFence);
    // ...and chainB's fences, which belong to a different employee, are not.
    expect(ids).not.toContain(w.polygonFence);
    expect(ids).not.toContain(w.villageFence);
  });

  it("returns the whole location chain for an employee with no direct fence", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers: w.siteUser,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        w.polygonFence,
        w.villageFence,
        w.mandalFence,
        w.districtFence,
      ]),
    );
    expect(ids).not.toContain(w.circleFence);
  });

  it("orders the direct fence first, then finest scope to coarsest", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers: w.siteUser,
    });
    const scopes = (res.json() as { data: Array<{ scope_type: string }> }).data.map(
      (f) => f.scope_type,
    );
    const rank: Record<string, number> = { site: 1, village: 2, mandal: 3, district: 4 };
    const ranks = scopes.map((s) => rank[s]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("returns nothing for a user with no linked employee", async () => {
    const username = `cat_nolink_${uniq()}`;
    await createUser(w.pool, w.orgId, { username, roles: ["EMPLOYEE"] });
    const headers = await loginAs(w.app, username);
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toEqual([]);
  });

  it("requires authentication", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences/effective",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("UT-GEO-11 read organization fence list as ordinary employee", () => {
  it("forbids the org-wide list without revealing whether any fence exists", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences",
      headers: w.directUser,
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string; message: string; data?: unknown };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.data).toBeUndefined();
    // The denial must not double as an existence oracle.
    expect(res.body).not.toContain(w.circleFence);
    expect(res.body).not.toContain(w.polygonFence);
  });

  it("forbids creating a fence as an ordinary employee", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/api/v1/geo-fences",
      headers: { ...w.directUser, ...idem() },
      payload: {
        name: "Self-service fence",
        scope_type: "site",
        scope_id: w.chainA.site,
        geometry_type: "circle",
        geometry: { lat: 17.1, lng: 78.1, radius_m: 100 },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the list to a role that holds geo.read", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo-fences",
      headers: w.role.PROJECT_MANAGER,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("UT-GEO-12 normalize geocoder result and invalid provider rows", () => {
  const realFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  /** Replaces the provider with a canned body. */
  function stubProvider(body: unknown, ok = true) {
    globalThis.fetch = (async () =>
      ({
        ok,
        status: ok ? 200 : 503,
        json: async () => body,
      }) as unknown as Response) as typeof fetch;
  }

  it("drops rows whose coordinates are not finite numbers", async () => {
    stubProvider([
      { osm_type: "node", osm_id: 1, lat: "17.385", lon: "78.4867", display_name: "Good", type: "city" },
      { osm_type: "node", osm_id: 2, lat: "not-a-number", lon: "78.5", display_name: "Bad lat" },
      { osm_type: "node", osm_id: 3, lat: "17.4", lon: null, display_name: "Missing lon" },
      { osm_type: "node", osm_id: 4, lat: "Infinity", lon: "78.5", display_name: "Infinite" },
    ]);

    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo/search?q=${encodeURIComponent(`normalize-${uniq()}`)}`,
      headers: w.admin,
    });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Array<{ lat: number; lng: number }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0]!.lat).toBeCloseTo(17.385, 4);
    expect(data[0]!.lng).toBeCloseTo(78.4867, 4);
    for (const row of data) {
      expect(Number.isFinite(row.lat)).toBe(true);
      expect(Number.isFinite(row.lng)).toBe(true);
    }
  });

  it("returns only the normalized shape, never the provider payload", async () => {
    stubProvider([
      {
        osm_type: "node",
        osm_id: 7,
        lat: "17.1",
        lon: "78.1",
        display_name: "Somewhere",
        type: "village",
        licence: "ODbL — provider terms",
        address: { state: "Telangana", country_code: "in" },
        boundingbox: ["1", "2", "3", "4"],
      },
    ]);

    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo/search?q=${encodeURIComponent(`leak-${uniq()}`)}`,
      headers: w.admin,
    });
    const body = res.body;
    expect(body).not.toContain("licence");
    expect(body).not.toContain("boundingbox");
    expect(body).not.toContain("country_code");
    const row = (res.json() as { data: Array<Record<string, unknown>> }).data[0]!;
    expect(Object.keys(row).sort()).toEqual(["display_name", "id", "lat", "lng", "type"]);
  });

  it("reports a provider failure as a stable error, not a 500", async () => {
    stubProvider([], false);
    const res = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo/search?q=${encodeURIComponent(`down-${uniq()}`)}`,
      headers: w.admin,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("GEOCODER_UNAVAILABLE");
  });

  it("validates the query before calling the provider", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }) as typeof fetch;

    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo/search?q=a",
      headers: w.admin,
    });
    expect(res.statusCode).toBe(422);
    expect(called).toBe(false);
  });

  it("requires geo.manage — an ordinary employee cannot search places", async () => {
    const res = await w.app.inject({
      method: "GET",
      url: "/api/v1/geo/search?q=hyderabad",
      headers: w.directUser,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("UT-GEO-13 exercise geocoder rate slot and cache", () => {
  const realFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("serves a repeated query from cache without calling the provider again", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => [
          { osm_type: "node", osm_id: 9, lat: "17.3", lon: "78.3", display_name: "Cached", type: "city" },
        ],
      } as unknown as Response;
    }) as typeof fetch;

    const query = `cache-probe-${uniq()}`;
    const first = await w.app.inject({
      method: "GET",
      url: `/api/v1/geo/search?q=${encodeURIComponent(query)}`,
      headers: w.admin,
    });
    expect(first.statusCode).toBe(200);
    expect(calls).toBe(1);

    // Same query, and the same query in a different case — the cache key is
    // case-insensitive because a place name's capitalisation is not identity.
    for (const variant of [query, query.toUpperCase()]) {
      const again = await w.app.inject({
        method: "GET",
        url: `/api/v1/geo/search?q=${encodeURIComponent(variant)}`,
        headers: w.admin,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
    }
    expect(calls).toBe(1);
  });

  it("serializes uncached provider calls to at most one per second", async () => {
    const callTimes: number[] = [];
    globalThis.fetch = (async () => {
      callTimes.push(Date.now());
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as unknown as Response;
    }) as typeof fetch;

    const prefix = `rate-probe-${uniq()}`;
    // Three distinct queries, issued together, must not burst at the provider:
    // the public geocoder's terms allow one request per second.
    const started = Date.now();
    await Promise.all(
      [1, 2, 3].map((n) =>
        w.app.inject({
          method: "GET",
          url: `/api/v1/geo/search?q=${encodeURIComponent(`${prefix}-${n}`)}`,
          headers: w.admin,
        }),
      ),
    );
    expect(callTimes).toHaveLength(3);

    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]!);
    for (const gap of gaps) {
      // Allow a small scheduling tolerance below the nominal 1000 ms.
      expect(gap).toBeGreaterThanOrEqual(950);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  }, 20_000);
});
