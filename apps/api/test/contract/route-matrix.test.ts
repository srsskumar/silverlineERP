/**
 * R6 exhaustive API contract sweep -- route enumeration + auth-state matrix.
 *
 * Every route comes from `app.routeRegistry` (an `onRoute` hook in
 * createApp.ts, permission metadata tagged by `requireAllPermissions` in
 * common/auth.ts) -- never grepped. `support.ts` classifies each route's
 * 41 permission-less members (public / self-scoped "auth-only" / inline
 * permission checks / shared-secret) so the matrix runs the right dimensions
 * against every one of them instead of skipping them.
 *
 * For every route this asserts, across the auth-state matrix:
 *  - no token -> 401 (except "public" routes, which must NOT 401)
 *  - malformed/garbage token -> 401
 *  - expired-but-otherwise-valid token -> 401
 *  - a valid token missing the route's permission -> 403 ("permission" /
 *    "inline-permission" modes; skipped where every non-admin seeded role
 *    holds the permission -- collected and reported, not silently ignored)
 *  - the right role (world.admin, who holds every permission) -> never
 *    401/403/5xx
 * and, piggy-backing on every response the matrix already collects: no
 * response body anywhere in the whole run contains a password hash, a
 * JWT-shaped value outside auth's own token fields, a raw TOTP/Aadhaar/PAN/
 * bank-account value, or a stack trace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorld, type CatalogueWorld } from "../catalogue/fixture.js";
import {
  bearer,
  bodyFor,
  buildRolePermissionIndex,
  classify,
  expiredToken,
  fillPath,
  garbageToken,
  roleLacking,
  scanForSecrets,
  type RolePermissionIndex,
} from "./support.js";

/**
 * Routes where the *right* role is still legitimately refused for a reason
 * that has nothing to do with which permission it holds -- e.g. a route
 * reserved for a worker/service token, never a person's session, however
 * privileged. Each entry documents why, per the brief's "encode deliberate
 * differences as explicit, commented expectations" instruction.
 */
const RIGHT_ROLE_EXCEPTIONS = new Map<string, number>([
  // automation-rules/:id/dispatch is "reserved for the job runner" (its own
  // error message) -- no human session, however privileged, may call it
  // directly; only the worker token minted for a scheduled/triggered run can.
  ["POST /api/v1/automation-rules/:id/dispatch", 403],
]);
import type { RouteRegistryEntry } from "../../src/createApp.js";

let w: CatalogueWorld;
let idx: RolePermissionIndex;

beforeAll(async () => {
  w = await buildWorld();
  idx = await buildRolePermissionIndex(w);
}, 180_000);
afterAll(async () => {
  await w.app.close();
  await w.pool.end();
});

/** Snapshot: forces a deliberate look at this file whenever a route is
 *  added or removed anywhere in the API (requirement 1 of the R6 brief). */
const EXPECTED_ROUTE_COUNT = 477;

interface Violation {
  route: string;
  check: string;
  detail: string;
}

async function inject(
  method: string,
  url: string,
  headers?: Record<string, string>,
  payload?: unknown,
) {
  return w.app.inject({ method: method as never, url, headers, payload });
}

const HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

describe("route enumeration", () => {
  it("registers exactly the expected number of routes", () => {
    expect(
      w.app.routeRegistry.length,
      "Route count changed -- a route was added or removed without this " +
        "matrix (and EXPECTED_ROUTE_COUNT) being updated to cover it.",
    ).toBe(EXPECTED_ROUTE_COUNT);
  });

  it("every permission-less route is deliberately classified, not defaulted", () => {
    const unclassified = w.app.routeRegistry
      .filter((r) => r.permissions.length === 0)
      .map((r) => `${r.method} ${r.url}`)
      .filter((k) => classify({ method: k.split(" ")[0], url: k.split(" ")[1], permissions: [] }).note.startsWith("UNCLASSIFIED"));
    expect(unclassified, unclassified.join("\n")).toEqual([]);
  });
});

describe("auth-state matrix", () => {
  const violations: Violation[] = [];
  const secretHits: string[] = [];
  const noNegativeCoverage: string[] = [];

  function record(
    route: RouteRegistryEntry,
    check: string,
    status: number,
    ok: boolean,
    detail: string,
    body: string,
  ) {
    if (!ok) {
      violations.push({ route: `${route.method} ${route.url}`, check, detail: `${detail} (got ${status}) body=${body.slice(0, 200)}` });
    }
    if (status >= 500) {
      violations.push({ route: `${route.method} ${route.url}`, check, detail: `5xx from ${check} (${status}): ${body.slice(0, 200)}` });
    }
    const hits = scanForSecrets(body);
    for (const h of hits) {
      // mfa/setup's entire job is handing the caller the TOTP secret to
      // enrol their own authenticator with -- that is the response, not a
      // leak of somebody else's.
      if (h === "totp-secret-base32" && route.url === "/api/v1/auth/mfa/setup") continue;
      // The token-issuing routes legitimately return an access/refresh
      // token; nothing else should ever match "jwt-shaped-value".
      if (h === "jwt-shaped-value" && /\/auth\/(login|refresh|impersonate)/.test(route.url)) continue;
      secretHits.push(`${route.method} ${route.url} [${check}]: ${h}`);
    }
  }

  it("passes the auth-state matrix for every route", async () => {
    for (const route of w.app.routeRegistry) {
      const mode = classify(route);
      const path = fillPath(route.url);

      if (mode.mode === "shared-secret") continue; // covered separately below

      if (mode.mode === "public") {
        const res = await inject(route.method, path);
        record(route, "no-token(public)", res.statusCode, res.statusCode !== 401, "public route must not 401 with no token", res.body);
        continue;
      }

      const body = HAS_BODY.has(route.method) ? bodyFor(route) : undefined;

      // no token
      {
        const res = await inject(route.method, path, undefined, body);
        record(route, "no-token", res.statusCode, res.statusCode === 401, "expected 401 with no Authorization header", res.body);
      }
      // garbage token
      {
        const res = await inject(route.method, path, bearer(garbageToken()), body);
        record(route, "garbage-token", res.statusCode, res.statusCode === 401, "expected 401 with a malformed token", res.body);
      }
      // expired token
      {
        const res = await inject(route.method, path, bearer(expiredToken(w.adminId, w.orgId)), body);
        record(route, "expired-token", res.statusCode, res.statusCode === 401, "expected 401 with an expired token", res.body);
      }

      if (mode.mode === "auth-only") {
        const res = await inject(route.method, path, w.admin, body);
        record(route, "auth-only-right", res.statusCode, res.statusCode !== 401, "an authenticated caller must not 401", res.body);
        continue;
      }

      const permission = mode.mode === "inline-permission" ? [mode.permission!] : route.permissions;

      // wrong role (missing the permission)
      const wrong = roleLacking(idx, permission);
      if (!wrong) {
        noNegativeCoverage.push(`${route.method} ${route.url} [${permission.join(",")}]`);
      } else {
        const res = await inject(route.method, path, w.role[wrong as keyof typeof w.role], body);
        record(route, "wrong-role", res.statusCode, res.statusCode === 403 || res.statusCode === 404, "expected 403 (or a deliberate 404) for a caller missing the permission", res.body);
      }

      // right role (admin holds every permission)
      {
        const res = await inject(route.method, path, w.admin, body);
        const rightRoleOk = RIGHT_ROLE_EXCEPTIONS.has(`${route.method} ${route.url}`)
          ? res.statusCode === RIGHT_ROLE_EXCEPTIONS.get(`${route.method} ${route.url}`)
          : res.statusCode !== 401 && res.statusCode !== 403;
        record(
          route,
          "right-role",
          res.statusCode,
          rightRoleOk,
          "the right role must not be blocked by auth",
          res.body,
        );
      }
    }

    if (noNegativeCoverage.length) {
      // Not a failure by itself -- every non-admin seeded role holding a
      // permission is a legitimate shape for a broadly-granted permission --
      // but it must be visible, not silently skipped.
      // eslint-disable-next-line no-console
      console.log(`[contract] no wrong-role tester found for ${noNegativeCoverage.length} route(s):\n${noNegativeCoverage.join("\n")}`);
    }

    expect(violations, violations.map((v) => `${v.route} :: ${v.check} :: ${v.detail}`).join("\n")).toEqual([]);
    expect(secretHits, secretHits.join("\n")).toEqual([]);
  }, 120_000);
});

describe("shared-secret route (jobs/run)", () => {
  it("refuses a missing/wrong CRON_SECRET and never 500s", async () => {
    for (const method of ["GET", "POST"] as const) {
      const res = await inject(method, "/api/v1/jobs/run", bearer("wrong-secret"));
      // 503 here is deliberate (CRON_NOT_CONFIGURED when CRON_SECRET isn't
      // set in this env, code fires before the secret comparison) -- 401 is
      // the wrong-secret outcome once it is set. Neither is the generic
      // 500 INTERNAL_ERROR the error handler emits for an unhandled throw.
      expect([401, 503]).toContain(res.statusCode);
    }
  });
});
