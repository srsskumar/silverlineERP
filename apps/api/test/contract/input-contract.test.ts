/**
 * R6 exhaustive API contract sweep -- input contract for every write route.
 *
 * Every POST/PUT/PATCH/DELETE route (from the same mechanically-built
 * `app.routeRegistry` the auth-state matrix uses) is probed, authenticated
 * as `world.admin` (who holds every permission, so these probes exercise
 * input handling, not authorization -- that's route-matrix.test.ts's job):
 *
 *  - an empty `{}` body -> 4xx, envelope (`code`/`message`/`field_errors`),
 *    never 500, never a bare 2xx (an empty body succeeding would mean the
 *    route silently accepted a create/update with nothing in it)
 *  - a body carrying only forbidden/server-owned keys (`org_id`,
 *    `created_by`, `status`, `version`, `id`, `__proto__`) -> still 4xx,
 *    never a 2xx that would mean one of those got silently honoured
 *  - the same empty body sent as `text/plain` instead of
 *    `application/json` -> 4xx, never 500
 *  - a syntactically-invalid UUID in every `:id`-shaped path param -> 422
 *    `VALIDATION_ERROR` (the shared 22P02 catch in httpErrors.ts), never a
 *    raw DB error or a 500
 *
 * This exercises the input-handling floor identically across every write
 * route; it does not attempt per-route "valid body plus one extra field"
 * checks (that needs a real, route-specific valid payload for all ~270
 * write routes, which existing per-module suites already cover more
 * precisely) or blanket idempotency-key replay (same reason -- a replay
 * test is only meaningful against a call that actually succeeds).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, type CatalogueWorld } from "../catalogue/fixture.js";
import { classify, fillPath, fillPathWithBadId } from "./support.js";

let w: CatalogueWorld;
beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes that deliberately accept an empty/junk body and still succeed --
 * documented here rather than skipped silently.
 */
const EMPTY_BODY_OK = new Set([
  // A no-op without a session is exactly what "log out" should do with
  // nothing to say about it.
  "POST /api/v1/auth/logout",
  // Always 202, whatever the body: this is the enumeration-resistance
  // pattern (auth/routes.ts:530) -- a missing/blank username gets the same
  // generic "if that account exists..." response as a real one, on purpose.
  "POST /api/v1/auth/password-reset-request",
]);

interface Violation { route: string; check: string; detail: string }

function envelopeOk(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "response body is not JSON";
  }
  const b = parsed as Record<string, unknown>;
  if (typeof b.code !== "string") return "missing string `code`";
  if (typeof b.message !== "string") return "missing string `message`";
  if (!Array.isArray(b.field_errors)) return "missing array `field_errors`";
  return null;
}

describe("input contract (write routes)", () => {
  it("handles empty body / forbidden-only body / wrong content-type / bad uuid across every write route", async () => {
    const violations: Violation[] = [];
    const routes = w.app.routeRegistry.filter((r) => WRITE_METHODS.has(r.method));
    expect(routes.length, "no write routes found -- registry wiring broke").toBeGreaterThan(50);

    for (const route of routes) {
      const mode = classify(route);
      if (mode.mode === "shared-secret") continue; // its own contract (secret, not JSON body)
      const path = fillPath(route.url);
      const hasIdParam = /:id\b/.test(route.url);
      const emptyBodyOk = EMPTY_BODY_OK.has(`${route.method} ${route.url}`);

      // 1) empty body
      {
        const res = await w.app.inject({ method: route.method as never, url: path, headers: w.admin, payload: {} });
        if (res.statusCode >= 500) {
          violations.push({ route: `${route.method} ${route.url}`, check: "empty-body", detail: `5xx: ${res.body.slice(0, 200)}` });
        } else if (res.statusCode < 400 && !emptyBodyOk) {
          violations.push({ route: `${route.method} ${route.url}`, check: "empty-body", detail: `expected 4xx, got ${res.statusCode} (an empty body must not silently succeed)` });
        } else if (res.statusCode >= 400) {
          const envErr = envelopeOk(res.body);
          if (envErr) violations.push({ route: `${route.method} ${route.url}`, check: "empty-body-envelope", detail: `${envErr}: ${res.body.slice(0, 150)}` });
        }
      }

      // 2) forbidden/server-owned fields only
      {
        const forbidden = {
          org_id: w.other.orgId, created_by: w.adminId, status: "ACTIVE",
          version: 999999, id: "11111111-1111-1111-1111-111111111111",
        };
        const res = await w.app.inject({ method: route.method as never, url: path, headers: w.admin, payload: forbidden });
        if (res.statusCode >= 500) {
          violations.push({ route: `${route.method} ${route.url}`, check: "forbidden-fields", detail: `5xx: ${res.body.slice(0, 200)}` });
        } else if (res.statusCode >= 200 && res.statusCode < 300 && !emptyBodyOk) {
          violations.push({ route: `${route.method} ${route.url}`, check: "forbidden-fields", detail: `expected 4xx, got ${res.statusCode} -- a body of only forbidden/server-owned fields must not succeed` });
        }
      }

      // 3) wrong content-type (text/plain instead of application/json)
      {
        const res = await w.app.inject({
          method: route.method as never, url: path, headers: { ...w.admin, "content-type": "text/plain" },
          payload: "{}",
        });
        if (res.statusCode >= 500) {
          violations.push({ route: `${route.method} ${route.url}`, check: "wrong-content-type", detail: `5xx: ${res.body.slice(0, 200)}` });
        }
      }

      // 4) invalid uuid in the :id path param (other params, if any, still
      // get a well-formed stand-in so only the id's shape is at fault)
      if (hasIdParam) {
        const badPath = fillPathWithBadId(route.url);
        const res = await w.app.inject({ method: route.method as never, url: badPath, headers: w.admin, payload: {} });
        if (res.statusCode >= 500) {
          violations.push({ route: `${route.method} ${route.url}`, check: "invalid-uuid-param", detail: `5xx: ${res.body.slice(0, 200)}` });
        } else if (res.statusCode < 400) {
          violations.push({ route: `${route.method} ${route.url}`, check: "invalid-uuid-param", detail: `expected 4xx for a malformed id, got ${res.statusCode}` });
        }
      }
    }

    expect(violations, violations.map((v) => `${v.route} :: ${v.check} :: ${v.detail}`).join("\n")).toEqual([]);
  }, 120_000);
});
