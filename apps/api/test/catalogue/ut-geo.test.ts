/**
 * Catalogue: the geocoder (UT-GEO-12..13).
 *
 * UT-GEO-01..11 were the geo-fence rows: geometry decisions, tolerance, fence
 * resolution, assignments, the effective-fence read and its RBAC. Silverline
 * has no geo-fencing since 2026-09-22 (owner decision), so those rows are
 * retired in the catalogue and their tests are gone. The place search stays,
 * because attendance is about to name the place a punch was made from, and
 * these two rows are what keep the provider contract honest.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, uniq, type CatalogueWorld } from "./fixture.js";

let w: CatalogueWorld;

beforeAll(async () => {
  w = await buildWorld();
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await w.pool.end();
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

  it("requires attendance.read — an ordinary employee cannot search places", async () => {
    // The fence permissions went with the fences; the search now takes the
    // attendance register's read grant, which an EMPLOYEE does not hold.
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
