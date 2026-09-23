/**
 * Naming the place a punch was made from (owner request, 2026-09-23).
 *
 * The punch stores its coordinates at once; the worker asks the geocoder
 * afterwards, oldest first, a bounded batch per pass, and gives up on a
 * punch the provider keeps failing on rather than blocking the queue.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toUtm } from "@silverline/shared";
import {
  clearReverseCache,
  placeNameFromAddress,
  reverseCacheKey,
  reverseGeocode,
} from "../src/modules/geo/routes.js";
import { PLACE_BATCH, PLACE_MAX_ATTEMPTS, runPlaceNames } from "../src/modules/jobs/placeNames.js";
import { runJobs } from "../src/modules/automation/worker.js";
import {
  JWT_SECRET,
  buildWorld,
  createActiveEmployee,
  idem,
  type CatalogueWorld,
} from "./catalogue/fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

const KONDAPUR = { lat: 17.4617, lng: 78.3594 };

async function positionedPunch(lat = KONDAPUR.lat, lng = KONDAPUR.lng, serverAt?: Date): Promise<string> {
  const employeeId = await createActiveEmployee(w.app, w.admin);
  const res = await w.app.inject({
    method: "POST",
    url: "/api/v1/attendance/events",
    headers: { ...w.admin, ...idem() },
    payload: {
      employee_id: employeeId,
      event_type: "CHECK_IN",
      client_timestamp: new Date().toISOString(),
      latitude: lat,
      longitude: lng,
      gps_accuracy: 9,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { event: { id: string } }).event.id;
  if (serverAt) {
    await w.pool.query("UPDATE attendance_events SET server_timestamp = $2 WHERE id = $1::uuid", [id, serverAt.toISOString()]);
  }
  return id;
}

async function eventRow(id: string) {
  return (await w.pool.query(
    "SELECT place_name, place_detail, place_resolved_at, place_attempts FROM attendance_events WHERE id = $1::uuid",
    [id],
  )).rows[0] as { place_name: string | null; place_detail: Record<string, unknown> | null; place_resolved_at: Date | null; place_attempts: number };
}

/** Leaves nothing for the job to pick up, so each test starts with its own punches. */
async function clearPending(): Promise<void> {
  await w.pool.query("UPDATE attendance_events SET place_resolved_at = NOW() WHERE place_resolved_at IS NULL");
}

describe("placeNameFromAddress", () => {
  it("says the settlement, the district and the state, once each", () => {
    expect(placeNameFromAddress({
      road: "Gachibowli Road", suburb: "Kondapur", city: "Hyderabad", state_district: "Ranga Reddy",
      state: "Telangana", country: "India", postcode: "500084",
    })).toBe("Kondapur, Hyderabad, Telangana");
    // A village in a district that is not a city.
    expect(placeNameFromAddress({ village: "Kolluru", state_district: "Nellore", state: "Andhra Pradesh", country: "India" }))
      .toBe("Kolluru, Nellore, Andhra Pradesh");
    // A city that is its own district is not repeated.
    expect(placeNameFromAddress({ city: "Mumbai", state_district: "Mumbai", state: "Maharashtra" })).toBe("Mumbai, Maharashtra");
  });

  it("falls back to the country, and to nothing", () => {
    expect(placeNameFromAddress({ country: "India" })).toBe("India");
    expect(placeNameFromAddress({})).toBeNull();
    expect(placeNameFromAddress(null)).toBeNull();
  });
});

describe("UT-GEO-14 worker names positioned punches", () => {
  beforeEach(clearPending);

  it("names the oldest first, keeps the address whole, and marks the punch resolved", async () => {
    const older = await positionedPunch(KONDAPUR.lat, KONDAPUR.lng, new Date(Date.now() - 3_600_000));
    const newer = await positionedPunch(17.385, 78.4867);
    const asked: Array<[number, number]> = [];
    const result = await runPlaceNames(w.pool, async (lat, lng) => {
      asked.push([lat, lng]);
      return {
        place_name: lat > 17.4 ? "Kondapur, Hyderabad, Telangana" : "Charminar, Hyderabad, Telangana",
        place_detail: { suburb: lat > 17.4 ? "Kondapur" : "Charminar", city: "Hyderabad", state: "Telangana" },
      };
    });
    expect(result).toEqual({ named: 2, empty: 0, failed: 0, abandoned: 0 });
    expect(asked[0]![0]).toBeCloseTo(KONDAPUR.lat, 4);
    expect(asked[1]![0]).toBeCloseTo(17.385, 4);

    const a = await eventRow(older);
    expect(a.place_name).toBe("Kondapur, Hyderabad, Telangana");
    expect(a.place_detail).toMatchObject({ suburb: "Kondapur", state: "Telangana" });
    expect(a.place_resolved_at).not.toBeNull();
    expect((await eventRow(newer)).place_name).toBe("Charminar, Hyderabad, Telangana");

    // And the register now says where the day started.
    const rec = await w.app.inject({ method: "GET", url: "/api/v1/attendance/records?limit=50", headers: w.admin });
    const rows = (rec.json() as { data: Array<{ check_in_place_name: string | null; check_in_place_status: string }> }).data;
    expect(rows.some((r) => r.check_in_place_name === "Kondapur, Hyderabad, Telangana" && r.check_in_place_status === "named")).toBe(true);
  });

  it("counts a provider failure, and gives up after the last allowed attempt", async () => {
    const id = await positionedPunch();
    const failing = async () => { throw new Error("Geocoder returned 503"); };
    for (let attempt = 1; attempt < PLACE_MAX_ATTEMPTS; attempt += 1) {
      const r = await runPlaceNames(w.pool, failing);
      expect(r.failed).toBe(1);
      expect(r.abandoned).toBe(0);
      const row = await eventRow(id);
      expect(row.place_attempts).toBe(attempt);
      expect(row.place_resolved_at).toBeNull();
    }
    const last = await runPlaceNames(w.pool, failing);
    expect(last).toMatchObject({ failed: 1, abandoned: 1 });
    const row = await eventRow(id);
    expect(row.place_attempts).toBe(PLACE_MAX_ATTEMPTS);
    // Resolved with no name: nothing will ask again, and the screen says "unnamed", not "resolving".
    expect(row.place_resolved_at).not.toBeNull();
    expect(row.place_name).toBeNull();
    const again = await runPlaceNames(w.pool, async () => { throw new Error("should not be asked"); });
    expect(again.failed).toBe(0);
  });

  it("is final at once when the provider answers that there is nothing there", async () => {
    const id = await positionedPunch(-40, -30); // open Atlantic
    const r = await runPlaceNames(w.pool, async () => ({ place_name: null, place_detail: null }));
    expect(r).toMatchObject({ named: 0, empty: 1 });
    const row = await eventRow(id);
    expect(row.place_resolved_at).not.toBeNull();
    expect(row.place_name).toBeNull();
  });

  it("takes a bounded batch per pass, and never a punch without a position", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const bare = await w.app.inject({
      method: "POST", url: "/api/v1/attendance/events", headers: { ...w.admin, ...idem() },
      payload: { employee_id: employeeId, event_type: "CHECK_IN", client_timestamp: new Date().toISOString() },
    });
    expect(bare.statusCode).toBe(201);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await positionedPunch(17.3 + i * 0.01, 78.4));
    let asked = 0;
    const r = await runPlaceNames(w.pool, async () => { asked += 1; return { place_name: "Somewhere, Telangana", place_detail: {} }; });
    expect(asked).toBe(3);
    expect(r.named).toBe(3);
    expect(PLACE_BATCH).toBeGreaterThanOrEqual(3);
    const unpositioned = await w.pool.query(
      "SELECT place_resolved_at, place_attempts FROM attendance_events WHERE id = $1::uuid",
      [(bare.json() as { event: { id: string } }).event.id],
    );
    expect(unpositioned.rows[0].place_resolved_at).toBeNull();
    expect(unpositioned.rows[0].place_attempts).toBe(0);
  });

  it("is switched off by GEOCODING_REVERSE=off, so a worker pass never reaches the provider", async () => {
    // vitest sets this off for every suite; the pass must leave the punch untouched.
    expect(process.env["GEOCODING_REVERSE"]).toBe("off");
    const id = await positionedPunch();
    await runJobs(w.app, w.pool, JWT_SECRET);
    const row = await eventRow(id);
    expect(row.place_attempts).toBe(0);
    expect(row.place_resolved_at).toBeNull();
  });
});

describe("reverseGeocode against the provider", () => {
  const realFetch = globalThis.fetch;
  const calls: URL[] = [];

  function stub(body: unknown, status = 200) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)));
      return { ok: status < 400, status, json: async () => body } as unknown as Response;
    }) as typeof fetch;
  }

  beforeEach(() => { calls.length = 0; clearReverseCache(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("asks /reverse at settlement zoom and reduces the answer to a place", async () => {
    stub({
      display_name: "Kondapur, Serilingampally, Hyderabad, Ranga Reddy, Telangana, 500084, India",
      address: { suburb: "Kondapur", city: "Hyderabad", state_district: "Ranga Reddy", state: "Telangana", country: "India", licence: "x" },
    });
    const place = await reverseGeocode(KONDAPUR.lat, KONDAPUR.lng);
    expect(place.place_name).toBe("Kondapur, Hyderabad, Telangana");
    expect(place.place_detail).toMatchObject({ suburb: "Kondapur", display_name: expect.stringContaining("Kondapur") });
    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("zoom")).toBe("14");
    expect(Number(url.searchParams.get("lat"))).toBeCloseTo(KONDAPUR.lat, 4);
    expect(Number(url.searchParams.get("lon"))).toBeCloseTo(KONDAPUR.lng, 4);
  });

  it("answers from the cache for a position within about a hundred metres", async () => {
    stub({ address: { village: "Kolluru", state: "Andhra Pradesh" } });
    await reverseGeocode(15.8300, 78.0400);
    // 0.0004° is about 45 m: the same crew, the same yard.
    await reverseGeocode(15.8304, 78.0396);
    expect(calls).toHaveLength(1);
    expect(reverseCacheKey(15.8300, 78.0400)).toBe(reverseCacheKey(15.8304, 78.0396));
    // A kilometre away is a different place.
    await reverseGeocode(15.8400, 78.0400);
    expect(calls).toHaveLength(2);
  });

  it("treats 'unable to geocode' as a final, nameless answer and a fault as an error", async () => {
    stub({ error: "Unable to geocode" });
    expect(await reverseGeocode(-40, -30)).toEqual({ place_name: null, place_detail: null });
    clearReverseCache();
    stub({}, 503);
    await expect(reverseGeocode(-40, -30)).rejects.toThrow(/503/);
  });
});

describe("what a punch carries for the surveyor", () => {
  it("returns UTM, the datum's grid and the place status on the detail's events", async () => {
    const employeeId = await createActiveEmployee(w.app, w.admin);
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/attendance/events", headers: { ...w.admin, ...idem() },
      payload: {
        employee_id: employeeId, event_type: "CHECK_IN", client_timestamp: new Date().toISOString(),
        latitude: KONDAPUR.lat, longitude: KONDAPUR.lng, gps_accuracy: 7, altitude: 600, altitude_accuracy: 20,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { event, record } = res.json() as { event: Record<string, unknown>; record: { id: string } };
    const expected = toUtm(KONDAPUR.lat, KONDAPUR.lng)!;
    expect(event.utm_zone).toBe(44);
    expect(event.utm_hemisphere).toBe("N");
    expect(event.utm_easting).toBeCloseTo(expected.easting, 2);
    expect(event.utm_northing).toBeCloseTo(expected.northing, 2);
    // Kondapur: the geoid is about 77 m under the ellipsoid, so 600 m on the phone is about 677 m.
    expect(event.height_egm96 as number).toBeGreaterThan(670);
    expect(event.height_egm96 as number).toBeLessThan(685);

    const detail = await w.app.inject({ method: "GET", url: `/api/v1/attendance/records/${record.id}`, headers: w.admin });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { employee_name: string; employee_emp_no: string; check_in_place_status: string; events: Array<Record<string, unknown>> };
    expect(body.employee_name).toBeTruthy();
    expect(body.employee_emp_no).toBeTruthy();
    expect(body.check_in_place_status).toBe("resolving");
    expect(body.events[0]).toMatchObject({ utm_zone: 44, place_status: "resolving", altitude: 600 });
  });
});
