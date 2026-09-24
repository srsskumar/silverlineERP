/**
 * Shared support for the R6 API contract sweep (route-matrix / input-contract /
 * pagination test files under this directory).
 *
 * The route list itself is never grepped: it comes from `app.routeRegistry`,
 * built by an `onRoute` hook in `createApp.ts` from the actual preHandler
 * chain (see `requiredPermissions` tagging in `common/auth.ts`). This file
 * only adds what the registry cannot know on its own -- which of the
 * permission-less routes are deliberately public/self-scoped/inline-checked,
 * and how to fill in a path param that isn't an id.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import type { CatalogueWorld, Headers } from "../catalogue/fixture.js";
import { JWT_SECRET } from "../catalogue/fixture.js";
import type { RouteRegistryEntry } from "../../src/createApp.js";
import { ROLE_CODES } from "@silverline/shared";

export type RouteMode =
  /** Standard permission-gated route: full auth-state matrix applies. */
  | "permission"
  /** No permission tag, but auth is required and any signed-in user may
   *  call it (self-scoped, or scoped/checked another way inside the
   *  handler). Wrong-role/403 dimension does not apply. */
  | "auth-only"
  /** No auth at all, by design (pre-session). */
  | "public"
  /** Authenticated, but the real permission is enforced inline in the
   *  handler body rather than by a tagged preHandler -- documented here so
   *  the matrix can assert the *real* gate instead of skipping it. */
  | "inline-permission"
  /** Not session-JWT authenticated at all -- a shared-secret / cron-style
   *  route. Excluded from the JWT auth-state matrix entirely. */
  | "shared-secret";

export interface RouteOverride {
  mode: RouteMode;
  /** For "inline-permission": the permission a wrong-role caller lacks and
   *  the right-role caller has, so the matrix can still run a real 403/pass
   *  check even though it isn't in the tagged preHandler. */
  permission?: string;
  note: string;
}

function key(method: string, url: string): string {
  return `${method} ${url}`;
}

/**
 * Routes whose registry-derived `permissions` is `[]` for a reason other
 * than "a bug" -- every one of the 41 found by the enumeration walk (round
 * R6) is accounted for here. A newly added permission-less route that isn't
 * listed here falls through to `"auth-only"` by default (see
 * `classify()`), which is the safe default (still requires a valid,
 * unexpired, non-garbage token) but the route-matrix test flags any such
 * unclassified route so it gets a deliberate look, not a silent pass.
 */
export const ROUTE_OVERRIDES: Record<string, RouteOverride> = {
  // --- genuinely public / pre-session ---------------------------------
  [key("POST", "/api/v1/auth/login")]: { mode: "public", note: "pre-session" },
  [key("POST", "/api/v1/auth/refresh")]: { mode: "public", note: "pre-session, refresh-token gated" },
  [key("POST", "/api/v1/auth/logout")]: { mode: "public", note: "idempotent no-op without a session" },
  [key("POST", "/api/v1/auth/password-reset-request")]: { mode: "public", note: "self-service, pre-session" },
  [key("GET", "/api/v1/jobs/run")]: { mode: "shared-secret", note: "CRON_SECRET, not a user session" },
  [key("POST", "/api/v1/jobs/run")]: { mode: "shared-secret", note: "CRON_SECRET, not a user session" },

  // --- self-scoped: any signed-in user, no permission code -------------
  [key("POST", "/api/v1/devices/register")]: { mode: "auth-only", note: "requires a session (preHandler: auth); device pairing is post-login" },
  [key("POST", "/api/v1/client-errors")]: { mode: "auth-only", note: "requires a session (preHandler: [auth, rateLimit])" },
  [key("POST", "/api/v1/attendance/events")]: { mode: "auth-only", note: "self-punch needs no extra permission; punching for someone else needs attendance.decide, checked inline (findings-a A-003: verified, not a bug)" },
  [key("POST", "/api/v1/auth/mfa/setup")]: { mode: "auth-only", note: "self-service" },
  [key("POST", "/api/v1/auth/mfa/verify")]: { mode: "auth-only", note: "self-service" },
  [key("POST", "/api/v1/auth/mfa/disable")]: { mode: "auth-only", note: "self-service (A-005: nodeEnv-gated floor, DECISION)" },
  [key("POST", "/api/v1/auth/password")]: { mode: "auth-only", note: "self-service" },
  [key("GET", "/api/v1/auth/me")]: { mode: "auth-only", note: "self" },
  [key("POST", "/api/v1/auth/impersonate/stop")]: { mode: "auth-only", note: "ends your own impersonation session" },
  [key("GET", "/api/v1/auth/sessions")]: { mode: "auth-only", note: "self-scoped session list" },
  [key("POST", "/api/v1/auth/sessions/:id/revoke")]: { mode: "auth-only", note: "self-scoped" },
  [key("GET", "/api/v1/auth/preferences")]: { mode: "auth-only", note: "self" },
  [key("PATCH", "/api/v1/auth/preferences")]: { mode: "auth-only", note: "self" },
  [key("GET", "/api/v1/employees/me")]: { mode: "auth-only", note: "self" },
  [key("GET", "/api/v1/attendance/me")]: { mode: "auth-only", note: "self" },
  [key("POST", "/api/v1/attendance/exceptions")]: { mode: "auth-only", note: "any signed-in user may file one for themself" },
  [key("POST", "/api/v1/attendance/regularize")]: { mode: "auth-only", note: "self-service regularize request" },
  [key("GET", "/api/v1/leave/types")]: { mode: "auth-only", note: "org-wide reference data" },
  [key("GET", "/api/v1/leave/balances")]: { mode: "auth-only", note: "scoped to caller inline" },
  [key("GET", "/api/v1/leave/requests")]: { mode: "auth-only", note: "scoped to caller inline" },
  [key("GET", "/api/v1/leave/requests/:id")]: { mode: "auth-only", note: "ownership checked inline" },
  [key("POST", "/api/v1/leave/requests/:id/cancel")]: { mode: "auth-only", note: "own-request check inline" },
  [key("GET", "/api/v1/people")]: { mode: "auth-only", note: "org-wide people picker" },
  [key("GET", "/api/v1/project-categories")]: { mode: "auth-only", note: "org-wide reference data" },
  [key("GET", "/api/v1/project-types")]: { mode: "auth-only", note: "org-wide reference data" },
  [key("PATCH", "/api/v1/saved-filters/:id")]: { mode: "auth-only", note: "owner/admin-override checked inline" },
  [key("DELETE", "/api/v1/saved-filters/:id")]: { mode: "auth-only", note: "owner/admin-override checked inline" },
  [key("GET", "/api/v1/dashboards/role/:role")]: { mode: "auth-only", note: "data scoped server-side, by design (coverage.md)" },
  [key("GET", "/api/v1/dashboards/my-work")]: { mode: "auth-only", note: "self" },
  [key("GET", "/api/v1/search")]: { mode: "auth-only", note: "cross-entity search, scoped inline -- flagged in coverage.md as worth watching, not a new finding here" },

  // --- inline permission check (real gate, just not preHandler-tagged) -
  [key("POST", "/api/v1/leave/requests/:id/decision")]: {
    mode: "inline-permission", permission: "leave.decide",
    note: "checked inline at leave/routes.ts:1078 (findings-a A-004: verified, not a bug)",
  },
  [key("POST", "/api/v1/reports")]: {
    mode: "inline-permission", permission: "report.generate",
    note: "checked inline (report.generate + per-type data permission), s6/routes.ts",
  },
  [key("GET", "/api/v1/reports/:id/download")]: {
    mode: "inline-permission", permission: "report.generate",
    note: "checked inline, s6/routes.ts",
  },
  [key("GET", "/api/v1/saved-filters")]: {
    mode: "inline-permission", permission: "filter.read",
    note: "inline filter.read OR filter.manage (s5/routes.ts canReadOrManageFilter)",
  },
  [key("POST", "/api/v1/documents/:id/legal-hold")]: {
    mode: "inline-permission", permission: "document.legalhold",
    note: "document.legalhold to place / document.legalhold.release to release, chosen from body.legal_hold",
  },
};

/**
 * A body for routes whose inline permission check runs *after* body
 * validation -- an empty `{}` 422s on the shape before ever reaching the
 * inline `permission` check, which would mask the auth-state result the
 * matrix is actually trying to observe. Values are chosen only to be
 * shape-valid, never to make the call actually succeed against a random id.
 */
export const BODY_OVERRIDES: Record<string, unknown> = {
  [key("POST", "/api/v1/leave/requests/:id/decision")]: { decision: "APPROVE" },
  [key("POST", "/api/v1/reports")]: { type: "employees", format: "csv" },
};

export function bodyFor(route: RouteRegistryEntry): unknown {
  return BODY_OVERRIDES[key(route.method, route.url)] ?? {};
}

export function classify(route: RouteRegistryEntry): RouteOverride {
  if (route.permissions.length > 0) {
    return { mode: "permission", note: "tagged preHandler" };
  }
  const found = ROUTE_OVERRIDES[key(route.method, route.url)];
  if (found) return found;
  // Safe default for an unclassified permission-less route: still demands a
  // real session (auth-only), but the route-matrix test separately asserts
  // every such route is *listed* above so this default is never silently
  // relied on for a new route.
  return { mode: "auth-only", note: "UNCLASSIFIED -- add to ROUTE_OVERRIDES" };
}

// --- path param substitution ----------------------------------------------

/** Non-id path params that need a plausible, format-valid stand-in. Auth
 *  runs in preHandler, before any handler reads these, so the exact value
 *  never affects the auth-state matrix -- only that it doesn't itself 400. */
const PARAM_VALUES: Record<string, string> = {
  role: "EMPLOYEE",
  type: "client",
  code: "SAMPLE",
};

export function fillPath(url: string, randomId: () => string = randomUUID): string {
  return url.replace(/:([a-zA-Z_]+)/g, (_m, name: string) => {
    return PARAM_VALUES[name] ?? randomId();
  });
}

/** Same as `fillPath`, but the literal `:id` param (only) gets a
 *  syntactically-invalid value -- every other param still gets a
 *  well-formed stand-in, so only the id's shape is under test. */
export function fillPathWithBadId(url: string): string {
  return url.replace(/:([a-zA-Z_]+)/g, (_m, name: string) => {
    if (name === "id") return "not-a-uuid";
    return PARAM_VALUES[name] ?? randomUUID();
  });
}

// --- token crafting ---------------------------------------------------------

export function garbageToken(): string {
  return "not.a.real.jwt-token-garbage-value";
}

export function expiredToken(userId: string, orgId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, org_id: orgId, type: "access", family: randomUUID(), iat: now - 7200, exp: now - 3600 },
    JWT_SECRET,
  );
}

export function bearer(token: string): Headers {
  return { authorization: `Bearer ${token}` };
}

// --- response secret scan ---------------------------------------------------

/** Matches only inside JSON *values*, not keys -- so a field named
 *  `bank_account_number` flagging on its own key text is a false positive we
 *  don't want; the point is a raw, unmasked *value* leaking. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "password_hash", re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { name: "jwt-shaped-value", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "totp-secret-base32", re: /"(?:totp_secret|mfa_secret|secret)"\s*:\s*"[A-Z2-7]{16,}"/ },
  { name: "raw-aadhaar", re: /"[a-z_]*aadhaar[a-z_]*"\s*:\s*"\d{12}"/i },
  { name: "raw-pan", re: /"[a-z_]*pan[a-z_]*"\s*:\s*"[A-Z]{5}\d{4}[A-Z]"/i },
  { name: "raw-bank-account", re: /"[a-z_]*(?:bank_)?account_number"\s*:\s*"\d{6,}"/i },
  { name: "stack-trace", re: /at [A-Za-z0-9_.<>]+ \(.*:\d+:\d+\)/ },
];

export function scanForSecrets(body: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(body)) hits.push(name);
  }
  return hits;
}

// --- "who lacks this permission" -------------------------------------------

export interface RolePermissionIndex {
  /** role code -> set of permission codes it holds. */
  byRole: Map<string, Set<string>>;
}

export async function buildRolePermissionIndex(w: CatalogueWorld): Promise<RolePermissionIndex> {
  // `roles` is never truncated between test files on the shared throwaway
  // DB (it isn't in the volatile-tables list -- only `user_roles` is), so an
  // unfiltered query here can pick up a stray custom role left behind by an
  // earlier suite that has no logged-in headers in `world.role`, and a
  // caller-selection function that returns its code would then inject with
  // no Authorization header at all. Restrict to the 13 seeded system role
  // codes `buildWorld` actually logs a user in for.
  const rows = (
    await w.pool.query(
      `SELECT r.code, rp.permission_code FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.code = ANY($1::text[])`,
      [ROLE_CODES as readonly string[]],
    )
  ).rows as Array<{ code: string; permission_code: string }>;
  const byRole = new Map<string, Set<string>>();
  for (const { code, permission_code } of rows) {
    if (!byRole.has(code)) byRole.set(code, new Set());
    byRole.get(code)!.add(permission_code);
  }
  return { byRole };
}

// --- idempotency-key coverage classification --------------------------------

/**
 * The two commit wrappers that give a write route automatic Idempotency-Key
 * replay: `mutate()` (common/domain.ts, stores in `v2_operations`, rejects a
 * body mismatch with `IDEMPOTENCY_CONFLICT`/409) and `mutationRoute()`
 * (common/mutationRoute.ts, stores in `idempotency_keys`, rejects a mismatch
 * with `IDEMPOTENCY_MISMATCH`/409 -- a different, non-shared code for the
 * same failure mode; see the idempotency-replay-contract findings).
 *
 * Neither wrapper is visible on `app.routeRegistry` (it only carries the
 * preHandler chain), so this -- like `ROUTE_OVERRIDES` above -- is the
 * mechanical-but-static half of the classification: it reads the actual
 * route source once, at module load, rather than being hand-maintained, so a
 * newly added write route is picked up automatically instead of silently
 * defaulting to "covered".
 */
export type IdempotencyMode = "mutate" | "mutationRoute" | "none";

export interface IdempotencyClassification {
  mode: IdempotencyMode;
}

let idempotencyIndexCache: Map<string, IdempotencyMode> | undefined;

function buildIdempotencyIndex(): Map<string, IdempotencyMode> {
  const here = dirname(fileURLToPath(import.meta.url));
  const modulesDir = join(here, "..", "..", "src", "modules");
  const index = new Map<string, IdempotencyMode>();
  const registrationRe = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/gi;
  for (const mod of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const moduleDir = join(modulesDir, mod.name);
    // Not only routes.ts -- some modules split bulk-import routes into their
    // own file (inventory/import.ts, org/import.ts, survey/import.ts), which
    // scanning only routes.ts silently missed on the first pass of this
    // scanner (caught by the "every write route accounted for" test below).
    for (const entry of readdirSync(moduleDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const file = join(moduleDir, entry.name);
      const src = readFileSync(file, "utf8");
      const matches = [...src.matchAll(registrationRe)];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]!;
        const method = m[1]!.toUpperCase();
        if (method === "GET") continue;
        const url = m[3]!;
        const start = m.index!;
        const end = i + 1 < matches.length ? matches[i + 1]!.index! : src.length;
        const block = src.slice(start, end);
        const mode: IdempotencyMode = /\bmutationRoute\s*\(/.test(block)
          ? "mutationRoute"
          : /\bmutate\s*\(/.test(block)
            ? "mutate"
            : "none";
        index.set(key(method, url), mode);
      }
    }
  }
  // inventory/routes.ts registers several routes through a
  // `for (const [path, table, ...] of [...])` loop with a template-literal
  // URL (`` `/api/v1/${path}` ``) -- the regex scan above sees the literal
  // text "/api/v1/${path}", not the expanded route, so these are injected
  // by hand after reading the loop body once (it is one shared handler per
  // loop -- vendors/inventory-items/assets create+update, and
  // asset-types/asset-categories create -- and every one of them calls
  // `mutate(...)`, confirmed by inspection).
  for (const url of [
    "/api/v1/vendors", "/api/v1/inventory/items", "/api/v1/assets",
  ]) {
    index.set(key("POST", url), "mutate");
    index.set(key("PATCH", `${url}/:id`), "mutate");
  }
  for (const url of ["/api/v1/asset-types", "/api/v1/asset-categories"]) {
    index.set(key("POST", url), "mutate");
  }
  return index;
}

export function idempotencyModeOf(method: string, url: string): IdempotencyMode {
  idempotencyIndexCache ??= buildIdempotencyIndex();
  return idempotencyIndexCache.get(key(method, url)) ?? "none";
}

/**
 * Write routes confirmed (by reading the handler, not only the scan above)
 * to need no Idempotency-Key coverage -- pre-session auth, self-service
 * account actions, or a route that is a pure read/dry-run and writes
 * nothing. A route landing here for a reason *other* than "verified safe"
 * belongs in the findings ledger instead, per the brief.
 */
export const IDEMPOTENCY_EXEMPT = new Set<string>([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/mfa/setup",
  "POST /api/v1/auth/mfa/verify",
  "POST /api/v1/auth/mfa/disable",
  "POST /api/v1/auth/password",
  "POST /api/v1/auth/password-reset-request",
  "POST /api/v1/auth/impersonate",
  "POST /api/v1/auth/impersonate/stop",
  "POST /api/v1/devices/register",
  // Shared-secret (CRON_SECRET), not a user session -- there is no `u.id` to
  // scope an idempotency key to. Excluded from every other JWT-auth
  // dimension the same way (route-matrix.test.ts, C-004).
  "POST /api/v1/jobs/run",
  // A read-only dry run: computes and returns a result, persists nothing.
  "POST /api/v1/expense-claims/evaluate",
  // Fans out to per-item sub-requests, each already idempotency-keyed with a
  // key derived from the outer key (or requestId) plus the item id -- see
  // planning/routes.ts:173.
  "POST /api/v1/tasks/bulk",
  // A PUT (full replace of the column list) is naturally idempotent by HTTP
  // semantics without needing the key-replay machinery.
  "PUT /api/v1/boards/:id/columns",
  // Version-fenced instead: every decision requires If-Match on the leave
  // request's current version, so a retry of an already-decided request
  // 409s on the stale version rather than needing key replay.
  "POST /api/v1/leave/requests/:id/decision",
  // Upsert-on-code: a retry with the same code returns the existing row
  // (200), never a duplicate (employees/routes.ts:2040).
  "POST /api/v1/designations",
  // A "set these fields on these rows" bulk PATCH is naturally idempotent --
  // applying the same change twice leaves the same end state.
  "PATCH /api/v1/employees/bulk",
  // ON CONFLICT (task_id, user_id) DO NOTHING -- adding the same
  // collaborator twice is reported back as `{already: true}`, not a second
  // effect (work/routes.ts:2007).
  "POST /api/v1/tasks/:id/collaborators",
  // DELETE is naturally idempotent (a second call 404s on an already-gone
  // row, which is a fine, safe outcome for a retry).
  "DELETE /api/v1/tasks/:id/collaborators/:userId",
]);

/** A role (with a seeded headers entry in `world.role`) that holds none of
 *  the given permissions -- SUPER_ADMIN/ADMIN excluded, since they hold
 *  everything and would defeat the point. `undefined` if every role has at
 *  least one (extremely permissive permission -- worth knowing about, the
 *  caller should treat that as its own finding rather than skip silently). */
export function roleLacking(idx: RolePermissionIndex, permissions: string[]): string | undefined {
  // Missing *any one* of the required set is enough: `requireAllPermissions`
  // 403s on the first permission it doesn't find, so a role short of even
  // one of them is a valid negative tester. Prefer a role with none of them
  // at all when one exists (a cleaner, more legible failure) before settling
  // for "missing at least one".
  let partial: string | undefined;
  for (const [role, perms] of idx.byRole) {
    if (role === "SUPER_ADMIN" || role === "ADMIN") continue;
    if (permissions.every((p) => !perms.has(p))) return role;
    if (!partial && !permissions.every((p) => perms.has(p))) partial = role;
  }
  return partial;
}
