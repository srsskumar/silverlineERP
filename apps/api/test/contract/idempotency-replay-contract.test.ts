/**
 * R6 exhaustive API contract sweep -- Idempotency-Key replay contract.
 *
 * Every write route lands in exactly one bucket, mechanically classified by
 * `idempotencyModeOf()` in `support.ts` (a static read of the actual route
 * source, since `app.routeRegistry` cannot see which commit wrapper a
 * handler calls):
 *
 *  - `mutate` (common/domain.ts) or `mutationRoute` (common/mutationRoute.ts)
 *    -- both give the route automatic Idempotency-Key replay: the same key
 *    plus the same body replays the stored response with no second effect;
 *    the same key with a *different* body is rejected with a 409 (the two
 *    wrappers disagree on the exact code -- `IDEMPOTENCY_CONFLICT` for
 *    `mutate`, `IDEMPOTENCY_MISMATCH` for `mutationRoute`; see the finding
 *    below). This file proves the mechanism live against one representative
 *    route per wrapper per module family rather than replaying all ~230
 *    covered routes individually -- the wrapper code is shared and
 *    identical for every route that calls it, so this is the same contract
 *    every one of them gets, not a per-route behavior.
 *  - `IDEMPOTENCY_EXEMPT` (support.ts) -- routes verified by reading the
 *    handler to need no key replay: pre-session/self-service auth actions, a
 *    pure read/dry-run, or a write that is already naturally idempotent
 *    (upsert-on-conflict, a version-fenced decision, a PUT full-replace, a
 *    fan-out to already-keyed sub-requests).
 *  - Neither -- currently exactly one route, `POST /api/v1/boards` (finding
 *    C-009 below): it replays a *stored* response for a reused key, but
 *    unlike every other wrapped route, it never checks whether the second
 *    request's body actually matches the first. A caller who reuses a key
 *    for a genuinely different board silently gets back the *first* board's
 *    response, and no second board is ever created -- the opposite of a
 *    500, but just as wrong: the write is silently dropped, unflagged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, type CatalogueWorld } from "../catalogue/fixture.js";
import { IDEMPOTENCY_EXEMPT, idempotencyModeOf } from "./support.js";

let w: CatalogueWorld;
beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The one route known, by direct reproduction below, not to honour a body
 *  mismatch on a reused key -- see the file header and findings-contract.md
 *  C-009. Carved out of the "every write route is accounted for" assertion
 *  so that assertion keeps proving the *rest* of the surface is clean. */
const KNOWN_UNSAFE_REPLAY = new Set(["POST /api/v1/boards"]);

describe("idempotency classification coverage", () => {
  it("every write route is mutate/mutationRoute-covered, explicitly exempt, or a documented finding", () => {
    const unaccounted = w.app.routeRegistry
      .filter((r) => WRITE_METHODS.has(r.method))
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => {
        const [method, url] = [k.split(" ")[0]!, k.split(" ").slice(1).join(" ")];
        if (idempotencyModeOf(method, url) !== "none") return false;
        if (IDEMPOTENCY_EXEMPT.has(k)) return false;
        if (KNOWN_UNSAFE_REPLAY.has(k)) return false;
        return true;
      });
    expect(unaccounted, unaccounted.join("\n")).toEqual([]);
  });
});

describe("idempotency-key replay (representative per wrapper/module)", () => {
  it("mutate()-wrapped create (vendors): same key+body replays once, different body 409s IDEMPOTENCY_CONFLICT", async () => {
    const key = idem();
    const code = `IDV${Date.now().toString(36)}`;
    const bodyA = { code, name: "Idempotency Test Vendor A" };
    const bodyB = { code, name: "Idempotency Test Vendor B (different)" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/vendors",
      headers: { ...w.role.INVENTORY_MANAGER, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);

    const replay = await w.app.inject({
      method: "POST", url: "/api/v1/vendors",
      headers: { ...w.role.INVENTORY_MANAGER, ...key }, payload: bodyA,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());

    const count = await w.pool.query("SELECT count(*)::int AS n FROM vendors WHERE code = $1", [code]);
    expect(count.rows[0].n, "same key + same body must have exactly one effect").toBe(1);

    const mismatch = await w.app.inject({
      method: "POST", url: "/api/v1/vendors",
      headers: { ...w.role.INVENTORY_MANAGER, ...key }, payload: bodyB,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("mutate()-wrapped create (asset-types, lookup module): same replay/mismatch contract", async () => {
    const key = idem();
    const code = `IDA${Date.now().toString(36)}`.toUpperCase();
    const bodyA = { code, label: "Idempotency Test Asset Type A" };
    const bodyB = { code, label: "Idempotency Test Asset Type B (different)" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);

    const replay = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());

    const count = await w.pool.query("SELECT count(*)::int AS n FROM asset_types WHERE code = $1", [code]);
    expect(count.rows[0].n).toBe(1);

    const mismatch = await w.app.inject({
      method: "POST", url: "/api/v1/asset-types", headers: { ...w.admin, ...key }, payload: bodyB,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("mutationRoute()-wrapped create (workspaces): same key+body replays once, different body 409s IDEMPOTENCY_MISMATCH", async () => {
    const key = idem();
    const name = `Idempotency Test WS ${Date.now().toString(36)}`;
    const bodyA = { name };
    const bodyB = { name, description: "different body -- description added" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/workspaces", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);

    const replay = await w.app.inject({
      method: "POST", url: "/api/v1/workspaces", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());

    const count = await w.pool.query("SELECT count(*)::int AS n FROM workspaces WHERE name = $1", [name]);
    expect(count.rows[0].n, "same key + same body must have exactly one effect").toBe(1);

    const mismatch = await w.app.inject({
      method: "POST", url: "/api/v1/workspaces", headers: { ...w.admin, ...key }, payload: bodyB,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("mutationRoute()-wrapped create (org/units, with an inner replayIfSeen too): same replay/mismatch contract", async () => {
    const key = idem();
    const code = `IDU${Date.now().toString(36)}`.toUpperCase();
    const bodyA = { type: "district", code, name: "Idempotency Test District A" };
    const bodyB = { type: "district", code, name: "Idempotency Test District B (different)" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/org/units", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);

    const replay = await w.app.inject({
      method: "POST", url: "/api/v1/org/units", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());

    const count = await w.pool.query("SELECT count(*)::int AS n FROM org_units WHERE code = $1", [code]);
    expect(count.rows[0].n).toBe(1);

    const mismatch = await w.app.inject({
      method: "POST", url: "/api/v1/org/units", headers: { ...w.admin, ...key }, payload: bodyB,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_MISMATCH");
  });
});

describe("C-009: POST /api/v1/boards does not honour a body mismatch on a reused key", () => {
  it("reproduces the silent-drop: second board is never created, first board's response is replayed instead", async () => {
    const key = idem();
    const bodyA = { project_id: w.activeProject, name: "Idem Board A", view_type: "LIST" };
    const bodyB = { project_id: w.activeProject, name: "Idem Board B (different)", view_type: "LIST" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/boards", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.name).toBe("Idem Board A");

    // What every other wrapped create route does here is 409
    // IDEMPOTENCY_CONFLICT/IDEMPOTENCY_MISMATCH. `/boards` instead silently
    // replays board A's stored response -- no error, no second board.
    const second = await w.app.inject({
      method: "POST", url: "/api/v1/boards", headers: { ...w.admin, ...key }, payload: bodyB,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(firstBody); // board A's response, not an error, not board B

    const count = await w.pool.query(
      "SELECT count(*)::int AS n FROM boards WHERE project_id = $1 AND name LIKE 'Idem Board%'",
      [w.activeProject],
    );
    expect(count.rows[0].n, "board B was silently never created").toBe(1);
  });
});
