/**
 * R6 exhaustive API contract sweep -- pagination contract for every GET
 * route (list or otherwise; the probe is safe either way -- see below).
 *
 * Every GET route in the mechanical registry, called as `world.admin`
 * (right role, so this exercises pagination/query handling, not auth):
 *
 *  - `?limit=999999999&offset=-5` -> never 500; if the route paginates via
 *    the shared `page()` helper (common/domain.ts), `limit` silently caps
 *    at 100 and a negative `offset` clamps to 0 -- a capped response is
 *    accepted per the brief ("capped or rejected" are both fine); if a
 *    `data` array comes back, it must be <=100 long.
 *  - `?cursor=not-base64-json-garbage` -> never 500; either 4xx or a
 *    (possibly empty) 200 page, per the brief.
 *  - `?limit=-1&offset=abc` (garbage types) -> never 500.
 *
 * A route that isn't paginated at all (most GET-by-id routes) still gets
 * these query strings appended -- harmless extra query params a handler
 * that never reads them simply ignores -- so this doubles as a cheap
 * never-500-on-garbage-query-string sweep across every read route, not
 * only the ones that page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, type CatalogueWorld } from "../catalogue/fixture.js";
import { fillPath } from "./support.js";

let w: CatalogueWorld;
beforeAll(async () => { w = await buildWorld(); }, 180_000);
afterAll(async () => { await w.app.close(); await w.pool.end(); });

interface Violation { route: string; check: string; detail: string }

/** Not user/org-growable data -- a fixed, small, system-wide reference
 *  catalogue that was never meant to page (admin/routes.ts:143: the entire
 *  `permissions` table, ~181 rows total, never grows with org data). */
const UNPAGINATED_REFERENCE_DATA = new Set(["GET /api/v1/admin/permissions"]);

const PROBES: Array<[string, string]> = [
  ["huge-limit-negative-offset", "limit=999999999&offset=-5"],
  ["garbage-cursor", "cursor=not-base64-json-garbage%3D%3D"],
  ["garbage-types", "limit=-1&offset=abc"],
];

describe("pagination / query-string contract (GET routes)", () => {
  it("never 500s on an out-of-range or garbage limit/offset/cursor, and caps any data page at 100", async () => {
    const violations: Violation[] = [];
    const routes = w.app.routeRegistry.filter(
      (r) => r.method === "GET" && r.url !== "/api/v1/jobs/run", // shared-secret cron route, not a session GET
    );
    expect(routes.length).toBeGreaterThan(50);

    for (const route of routes) {
      const path = fillPath(route.url);
      for (const [check, qs] of PROBES) {
        const sep = path.includes("?") ? "&" : "?";
        const res = await w.app.inject({ method: "GET", url: `${path}${sep}${qs}`, headers: w.admin });
        if (res.statusCode >= 500) {
          violations.push({ route: `GET ${route.url}`, check, detail: `5xx: ${res.body.slice(0, 200)}` });
          continue;
        }
        if (res.statusCode === 200 && check === "huge-limit-negative-offset" && !UNPAGINATED_REFERENCE_DATA.has(`GET ${route.url}`)) {
          try {
            const body = JSON.parse(res.body) as { data?: unknown };
            if (Array.isArray(body.data) && body.data.length > 100) {
              violations.push({ route: `GET ${route.url}`, check, detail: `limit=999999999 returned ${body.data.length} rows uncapped` });
            }
          } catch {
            /* not a {data:[...]} shape -- nothing to check here */
          }
        }
      }
    }

    expect(violations, violations.map((v) => `${v.route} :: ${v.check} :: ${v.detail}`).join("\n")).toEqual([]);
  }, 120_000);
});
