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
 *
 * C-009 (fixed): `POST /api/v1/boards` used to call `replayIfSeen()`/
 * `storeIdempotentResponse()` directly -- its own bare pair, not the
 * `mutationRoute()` wrapper every sibling create route in s5/routes.ts uses
 * -- and `replayIfSeen()` only matches on key+method+path, never checking
 * the stored request's body against a new one. A reused key with a
 * genuinely different body silently replayed the *first* board's response
 * and never created a second board. Moved onto `mutationRoute()`
 * (s5/routes.ts, this commit), which gives it the same body-hash check
 * every other wrapped route already has. Every bare (non-`db`-scoped, i.e.
 * not already running inside a `mutationRoute()`/`mutate()` transaction)
 * caller of `replayIfSeen`/`storeIdempotentResponse` was grepped for across
 * every module at the time of the fix; `/boards` was the only one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, idem, type CatalogueWorld } from "../catalogue/fixture.js";
import { IDEMPOTENCY_EXEMPT, idempotencyModeOf } from "./support.js";

let w: CatalogueWorld;
beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

describe("idempotency classification coverage", () => {
  it("every write route is mutate/mutationRoute-covered or explicitly exempt", () => {
    const unaccounted = w.app.routeRegistry
      .filter((r) => WRITE_METHODS.has(r.method))
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => {
        const [method, url] = [k.split(" ")[0]!, k.split(" ").slice(1).join(" ")];
        if (idempotencyModeOf(method, url) !== "none") return false;
        if (IDEMPOTENCY_EXEMPT.has(k)) return false;
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

describe("C-009 (fixed): POST /api/v1/boards now honours a body mismatch on a reused key", () => {
  it("mutationRoute()-wrapped create (boards): same key+body replays once, different body 409s IDEMPOTENCY_MISMATCH -- not a silent replay of board A", async () => {
    const key = idem();
    const name = `Idem Board ${Date.now().toString(36)}`;
    const bodyA = { project_id: w.activeProject, name, view_type: "LIST" };
    const bodyB = { project_id: w.activeProject, name: `${name} (different)`, view_type: "LIST" };

    const first = await w.app.inject({
      method: "POST", url: "/api/v1/boards", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(first.statusCode).toBe(201);

    const replay = await w.app.inject({
      method: "POST", url: "/api/v1/boards", headers: { ...w.admin, ...key }, payload: bodyA,
    });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());

    const count = await w.pool.query(
      "SELECT count(*)::int AS n FROM boards WHERE project_id = $1 AND name = $2",
      [w.activeProject, name],
    );
    expect(count.rows[0].n, "same key + same body must have exactly one effect").toBe(1);

    // Before the fix this silently replayed board A's stored response (201,
    // board A's body) instead of rejecting -- no error, and board B was
    // never created. It must now behave exactly like every other
    // mutationRoute()-wrapped create route.
    const mismatch = await w.app.inject({
      method: "POST", url: "/api/v1/boards", headers: { ...w.admin, ...key }, payload: bodyB,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_MISMATCH");

    const stillOne = await w.pool.query(
      "SELECT count(*)::int AS n FROM boards WHERE project_id = $1 AND name LIKE $2",
      [w.activeProject, `${name}%`],
    );
    expect(stillOne.rows[0].n, "the mismatched body must never create a second board").toBe(1);
  });
});
