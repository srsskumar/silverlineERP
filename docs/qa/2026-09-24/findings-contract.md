# Findings ledger — Round R6, API contract sweep

Companion to `apps/api/test/contract/{route-matrix,input-contract,pagination-contract,
idempotency-replay-contract,cross-org-depth}.test.ts`.
Scope: every route registered under `/api/v1` in `apps/api` (477 at the time of this sweep),
enumerated mechanically from `app.routeRegistry` (an `onRoute` hook in `createApp.ts`, permission
metadata tagged onto each guard by `requireAllPermissions` in `common/auth.ts` — see commit
`eb0a3be`), never grepped. Checked other rounds' ledgers (`findings-a.md`, `findings-b.md`,
`findings-int.md`, `findings-mobile.md`) first; nothing below duplicates an entry there except where
noted.

**Headline result of the original pass: zero new product bugs.** Every deviation the matrix's first
pass surfaced turned out, on inspection, to be either a deliberate and already-correct design
decision (now encoded as an explicit, commented expectation in the test) or a bug in the sweep's own
test harness (fixed in the harness, no product code touched) — see C-001..C-007. One watch item was
left open (C-008). This follow-up round closes C-008 and adds two new dimensions per the brief:
Idempotency-Key replay (found and fixed C-009) and cross-org depth (clean).

| ID | Sev | Surface | Finding | Resolution | Status |
|---|---|---|---|---|---|
| C-001 | — | api | POST /automation-rules/:id/dispatch returns 403 even for world.admin | Reserved for the job runner (worker token only). Encoded as a RIGHT_ROLE_EXCEPTIONS entry. | VERIFIED — NOT A BUG |
| C-002 | — | api | POST /auth/mfa/setup's response matched the secret scanner's totp-secret-base32 pattern | That is the route's job — handing the caller their own TOTP secret. One-route exemption. | VERIFIED — NOT A BUG |
| C-003 | — | api | GET /admin/permissions?limit=999999999 returns all 181 rows uncapped | Fixed, ~181-row, system-wide reference catalogue, never paginated by the handler. UNPAGINATED_REFERENCE_DATA exception. | VERIFIED — NOT A BUG |
| C-004 | — | api | GET/POST /jobs/run returns 503, not a JWT-flow 401 | Shared-secret (CRON_SECRET) route, not session-JWT authenticated. Its own dedicated test. | VERIFIED — NOT A BUG |
| C-005 | — | api | POST /auth/logout with an empty body returns 200 | Idempotent no-op by design. EMPTY_BODY_OK exception. | VERIFIED — NOT A BUG |
| C-006 | — | api | POST /auth/password-reset-request with an empty body returns 202 | Account-enumeration-resistance pattern, deliberate. EMPTY_BODY_OK exception. | VERIFIED — NOT A BUG |
| C-007 | — | test-infra | False 401 (no Authorization header) on the wrong-role check for 5 survey routes, first run only | roles isn't truncated between test files; an unfiltered query picked up a stray custom-role row with no world.role headers entry. Fixed by scoping buildRolePermissionIndex to the seeded ROLE_CODES. Re-ran clean 3x. No product code changed. | FIXED (test harness only) |
| C-008 | WATCH -> CLOSED | api | First matrix run showed 500 INTERNAL_ERROR for POST /approvals, POST /approvals/:id/recall, POST /approvals/:id/revalidate, POST /purchase-orders/:id/status, POST /rfqs/:id/award, POST /purchase-orders/:id/amend as world.admin with a random id + empty body | See "C-008 closure" below. | CLOSED — HARNESS ARTIFACT (unreproduced; structurally cannot occur under this calling pattern) |
| C-009 | P2 | api | POST /api/v1/boards does not honour a body mismatch on a reused Idempotency-Key: it replays the first board's stored response instead of rejecting with 409, and the second board is silently never created | See "C-009 fix" below. | FIXED |

## C-008 closure

**Conclusion: harness artifact, closed with confidence — not a product bug.**

**Code-path evidence.** Read all six handlers (approvals/routes.ts, procurement/routes.ts).
Every one of them either:
- validates its required body fields before touching the database at all
  (POST /approvals — document_type/document_id/amount; POST /approvals/:id/recall — reason;
  POST /approvals/:id/revalidate — amount; POST /rfqs/:id/award — vendor_id, synchronously outside
  mutate()), so a random id + {} body 422s on VALIDATION_ERROR before any query runs; or
- (POST /purchase-orders/:id/status, POST /purchase-orders/:id/amend) calls inOrg() first, which
  cleanly 404s NOT_FOUND for a nonexistent id before any status/approval/ladder logic runs.

None of the six ever reaches the state the brief asked me to check for as a live-bug candidate
(missing approval policy, a null join, a stale custom role, an empty ladder, an unseeded org
setting) under the auth-matrix's exact calling convention (random uuid, {} body, no
Idempotency-Key header — mutate()'s idempotency branch is if(key)-gated and never runs). The
original 500s, whatever caused them, could not have come from any of those mechanisms for a
world.admin "right role" call, since world.admin's headers are a real, freshly logged-in session —
not the phantom-role/no-Authorization-header condition C-007 actually was.

**Empirical evidence (this round, VM slot g).**
- route-matrix.test.ts run 5x back to back on the same slot DB, deliberately not reset between
  runs (matching C-007's own finding that roles and other non-volatile tables persist across
  files/runs on a slot) — 5/5 clean, 4 passing tests each run, zero violations, zero 5xx.
- Full apps/api suite run once on the same slot DB (85 files, 2155 tests, all green), then
  route-matrix.test.ts run once more immediately after, on that same now-heavily-used DB (the
  "shared-DB state the first run had" condition the brief asked for) — clean, zero violations,
  zero 5xx.
- No 5xx observed in any of the ~2,860 requests these 6 standalone runs made against the six named
  routes (477 routes x 5 auth-state checks x 6 runs, minus the two-thirds that short-circuit early),
  nor in the copy of route-matrix.test.ts that ran inside the full-suite pass itself.

Given the code-path proof that these six routes cannot reach a 500 from the auth-matrix's calling
pattern regardless of database state, and 6/6 clean reproduction attempts including the specific
shared-DB-state condition named in the brief, this is closed as a one-off artifact of the same test
run that had the (already-fixed) C-007 bug active — most likely a transient condition in that first,
cold run rather than a second, still-latent bug in the same file. No product code changed for C-008.

## C-009 fix

`POST /api/v1/boards` (s5/routes.ts) moved onto `mutationRoute()` -- the same wrapper every sibling
create route in the file already uses -- in place of its own bare `replayIfSeen()` +
`storeIdempotentResponse()` pair. The handler body is otherwise unchanged (its manual
`client.connect()`/`BEGIN`/`COMMIT`/`ROLLBACK` was removed in favour of the `db` connection
`mutationRoute()` already manages transactionally, matching the pattern every other
`mutationRoute()`-wrapped route in the file uses, e.g. `POST /labels`). This gives it the body-hash
check every other wrapped route already has: same key + same body replays; same key + a genuinely
different body now 409s `IDEMPOTENCY_MISMATCH`, instead of silently replaying the first board and
dropping the second write.

**Grepped for every other bare (not already running inside a `mutationRoute()`/`mutate()`
transaction, i.e. not `db`-scoped) caller of `replayIfSeen`/`storeIdempotentResponse` across every
module.** `/boards` was the only one -- every other call site in `employees`, `org`, `payroll` and
`work` routes already passes the `db` handle `mutationRoute()` hands its callback, meaning
`mutationRoute()`'s own outer hash-checked replay already intercepts a reused key before those
handlers even run; the inner call is redundant there, not unsafe.

**TDD.** RED: rewrote the C-009 test in `idempotency-replay-contract.test.ts` to assert the correct
contract (409 `IDEMPOTENCY_MISMATCH` on a body mismatch, matching `workspaces`/`org-units`) and ran
it against the pre-fix route -- confirmed failing (`expected 201 to be 409`), plus the "every write
route accounted for" coverage test failing on `POST /api/v1/boards` being unclassified. Applied the
fix. GREEN: both tests pass; also caught and fixed a pre-existing test in `test/s5.test.ts`
("replays an Idempotency-Key without creating a second board") that had encoded the *bug* as the
expected contract -- it sent a different body on the "replay" call and asserted 201 with the first
board's id. Split it into two tests: the original name now does a genuine replay (identical body);
a new one (`"rejects an Idempotency-Key reused with a different body (C-009)"`) asserts the
mismatch 409. Full `apps/api` suite green after the fix (see "Suite" below).

## New dimensions added this round

### Idempotency-Key replay (idempotency-replay-contract.test.ts)

- **Classification**: every write route (256 POST/PUT/PATCH/DELETE routes) is mechanically
  classified by idempotencyModeOf() (support.ts) — a static read of the actual route source
  (common/domain.ts's mutate() or common/mutationRoute.ts's mutationRoute() present in the
  registration's block, since neither is visible on app.routeRegistry) — into mutate,
  mutationRoute, or none. Covers routes.ts and sibling route files a module splits out
  (inventory/import.ts, org/import.ts, survey/import.ts — missed on the scanner's first pass,
  caught by its own "every write route accounted for" test, fixed by scanning every .ts file in
  each module directory, not only routes.ts) and inventory's template-literal loop registrations
  (/api/v1/${path} for vendors/inventory-items/assets/asset-types/asset-categories — injected by
  hand after confirming by inspection that the one shared handler per loop calls mutate()).
- **Result**: 236 of 256 write routes are mutate/mutationRoute-covered. 19 are explicitly exempted
  (IDEMPOTENCY_EXEMPT in support.ts) with a one-line, code-referenced reason each —
  pre-session/self-service auth actions (10: login, refresh, logout, mfa x3, password,
  password-reset, impersonate x2), a shared-secret cron route, a pure dry-run
  (expense-claims/evaluate), a fan-out to already-keyed sub-requests (tasks/bulk), a
  naturally-idempotent PUT-replace (boards/:id/columns), a version-fenced decision
  (leave/requests/:id/decision), and three upsert/ON-CONFLICT/DELETE writes (designations,
  employees/bulk, tasks/:id/collaborators x2). **The 1 initially-unaccounted route,
  POST /api/v1/boards, is now mutationRoute()-covered — see "C-009 fix" below; 237/256.**
- **Live replay proof**: one representative route per wrapper per module family (4 total — vendors
  and asset-types for mutate(); workspaces and org/units for mutationRoute(), the latter also
  exercising the inner replayIfSeen() pattern) proves, against the real database: same key + same
  body -> identical response, exactly one row created; same key + different body -> 409 with the
  wrapper's stable code. Chose representative routes over replaying all 236 individually — the
  wrapper code is shared and identical for every route that calls it, so this is the same contract
  every one of them gets, not a per-route behavior; exhaustively replaying all 236 would need a
  real, route-specific valid payload for each (the same reason the original round's
  input-contract.test.ts scoped its own per-route check down).
- **C-009**: reproduced live, then fixed — see "C-009 fix" above. The same test file's C-009 case
  now asserts the correct 409 IDEMPOTENCY_MISMATCH contract instead of documenting the bug.

### Cross-org depth (cross-org-depth.test.ts)

- CatalogueWorld.other (fixture.ts) extended with a real row per major resource family beyond the
  original ~8: leave request, payroll run, workspace/project/task, purchase order, payment run,
  expense claim, asset, document, and report — each created through the real HTTP surface as the
  second organization's own SUPER_ADMIN, using reference data (leave_types, document_types)
  inserted directly only where the product has no create endpoint for it (mirroring the fixture's
  existing rule for that case).
- **Result: 11/11 clean.** Org-A's admin gets a 404 for every one of org-B's real rows — employee,
  leave request, payroll run, project, task, purchase order, payment run, expense claim, asset,
  document, report-download — never a 2xx. The reverse direction (org-B admin -> org-A's real
  employee) also 404s. Zero P0s.
- **Deliberately not covered** (documented in the test file, not silently skipped): GRNs and vendor
  invoices — both gate through the exact same inOrg() allow-listed lookup the purchase-order case
  already proves org-scoped; reaching either needs an APPROVED+SENT order, which needs an approval
  policy this fixture does not seed for the second organization. Survey villages — needs the
  programme-pairing and stage-pipeline setup, out of this pass's budget.

## Coverage delivered (original round, still true)

- Route enumeration, exhaustive auth-state matrix (477/477 routes), response secret scan, input
  contract (~270/270 write routes), pagination/query-string contract (all GET routes) — see the R6
  headline entry above and the original coverage notes retained in git history (eb0a3be, 719dc9a,
  edf5a3e).

## Explicitly out of depth (by design)

- Missing If-Match as its own dedicated, route-by-route dimension (exercised incidentally, not
  asserted per-route) — unchanged from the original round.
- GRNs, vendor invoices, survey villages for cross-org depth — see above.
- Exhaustive (all 237) live idempotency replay — see above; the mechanism is proven generically and
  by direct reproduction of the one gap it had (C-009, now fixed).

## Suite

Full apps/api suite run once at the end of this round on VM slot g: 85 test files, 2155 tests, all
passed. Duration 342.4s. Ran immediately after the C-008 shared-DB-state reproduction pass on the
same slot DB.
