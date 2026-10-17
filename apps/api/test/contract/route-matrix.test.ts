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
 *  added or removed anywhere in the API (requirement 1 of the R6 brief).
 *
 *  477 when this sweep was written (branched from 98a1019). Bumped to 479
 *  for QA release 3 (merging qa/contract onto a main that had moved on):
 *  two routes were added upstream since the branch point --
 *  PATCH /api/v1/shifts/:id (allocation/routes.ts, guard('roster.manage'))
 *  and POST /api/v1/approval-policies/:id/deactivate (approvals/routes.ts,
 *  guard('approval.configure')). Both are tagged-permission + mutate()
 *  routes, so every dimension below (auth-state, input-contract,
 *  idempotency-classification-coverage) already exercises them
 *  mechanically via app.routeRegistry, with no per-route override needed --
 *  see findings-contract.md's "QA release 3 merge" note.
 *  Bumped in release 3 stage 2a: qa/survey-deep added
 *  POST /api/v1/survey/billing/:id/reverse (guard('survey.manage')) and
 *  qa/r5-parity added GET /api/v1/leave/preview (leave.request) and
 *  POST /api/v1/leave-balances/open-year (leave admin). All three are
 *  permission-tagged, so the matrix covers them mechanically. Plus two
 *  that qa/policy (stage 1) had already added: GET /api/v1/documents/
 *  due-for-purge and POST /api/v1/documents/purge (guard('document.delete')).
 *  484 in all. Bumped to 485 for the GSTIN-verification work (5f9dc9b):
 *  GET /api/v1/integrations/gstin-verify (guardAny(['client.manage',
 *  'inventory.manage'])), rate-limited and permission-tagged, so it too is
 *  covered mechanically. */
const EXPECTED_ROUTE_COUNT = 485;

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
      const wrong = roleLacking(idx, permission, mode.mode !== "inline-permission" && route.anyOf === true);
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

describe("universal-permission routes (no role lacks the permission)", () => {
  // notification.read is held by every seeded system role (098/100 closed
  // the last two gaps, GOVT_OBSERVER and SALES_BD_EXECUTIVE/BID_TENDER_
  // MANAGER -- see fresh-database.test.ts and s5.test.ts's "round-2 govt
  // crawl" note), so `roleLacking` has nothing to hand the main loop above
  // for GET /notifications, PATCH /notifications/:id/read and POST
  // /notifications/read-all: they show up in [contract]'s "no wrong-role
  // tester found" log instead of getting a real 403 check. Same contract
  // gap as every other route in the matrix, just with no seeded role left
  // to exercise it -- so one is made for the duration of this test, the
  // same way other suites in this repo borrow a row's state for one check
  // and hand it back (e.g. supply.test.ts's settings mutate/restore).
  it("still refuses a caller without notification.read on all three notification routes", async () => {
    const role = (
      await w.pool.query("SELECT id FROM roles WHERE code = $1 AND org_id IS NULL", ["EMPLOYEE"])
    ).rows[0] as { id: string };
    await w.pool.query(
      "DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'notification.read'",
      [role.id],
    );
    try {
      const checks: Array<[string, string]> = [
        ["GET", "/api/v1/notifications"],
        ["PATCH", fillPath("/api/v1/notifications/:id/read")],
        ["POST", "/api/v1/notifications/read-all"],
      ];
      for (const [method, path] of checks) {
        const res = await inject(method, path, w.role.EMPLOYEE);
        expect(res.statusCode, `${method} ${path} (got ${res.statusCode}) body=${res.body.slice(0, 200)}`).toBe(403);
      }
    } finally {
      // Handed back regardless of how the checks above came out, so a
      // failure here never leaves EMPLOYEE short of a grant every other
      // test in this file (and the next role-permission-index build) relies
      // on being universal.
      await w.pool.query(
        `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'notification.read')
         ON CONFLICT (role_id, permission_code) DO NOTHING`,
        [role.id],
      );
    }
  });
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
