# Security test results — 2026-10-28

## Tools and versions

| Tool | Version | Where |
|---|---|---|
| npm audit | npm 10 (Node 22.23) | local + CI |
| vitest | 3.2.7 | API, web, shared |
| node:test via tsx | Node 22 | mobile |
| tsc / eslint | repo-pinned | all workspaces |
| gitleaks-action v2, osv-scanner-action v2, semgrep (image `semgrep/semgrep`) | CI only (`.github/workflows/security.yml`) — not runnable locally in this session (installs blocked by the session's permission policy) |
| manual pattern scan | `git grep` for AWS/GitHub/Slack/Google/PostHog keys, private keys, JWTs, connection strings with passwords; `git log --diff-filter=A` for ever-committed env/cert/keystore files |

## Scans executed

- `npm audit --json` at start: 30 advisories (5 critical, 10 high, 9 moderate, 6 low).
- After `npm audit fix` and the targeted upgrades: 16 (2 critical dev-only, 5 high, 2 moderate,
  7 low). `npm audit --omit=dev --audit-level=critical` → exit 0.
- Secrets: no hits in tracked files; no env/cert/keystore ever committed; local-only
  sensitive files (`docs/CREDENTIALS.md`, `certs/supabase-ca.crt`, `.env`) are untracked.

## Test runs (final gate)

Command: `npm run lint && npm test && npm run build` from the repo root (Turbo across
workspaces; API tests against `TEST_DATABASE_URL`, shard 0 and 3 worker shards).

Result (2026-10-29 00:40 IST, tree at commit `c8e0db7`):

| Step | Result |
|---|---|
| `npm run lint` | 5/5 workspaces clean (tsc everywhere, eslint on web) |
| `@silverline/shared` tests | 30 files, 1,056 passed |
| `mobile` tests | 558 passed, 0 failed |
| `web` tests | 85 files, 992 passed |
| `api` tests | 89 files, 2,408 passed, 13 skipped (deliberate), 0 failed |
| `npm run build` | 4/4 (shared, api incl. migrations, web static export, mobile bundles) |
| `npm audit --omit=dev --audit-level=critical` | exit 0 |

Two earlier full runs the same evening found and fixed: a type error from the
`@fastify/cors` 10.1 bump (CORS origin callback now annotated) and the report
filter schema being stricter than the audit report's `from`/`to` keys (widened to
the keys the routes read).

## Regression tests seen RED before the fix

- `account-authority.test.ts`: device wipe guard (C-8), MFA reset (C-3), changed-fields
  audit (C-7). The SUPER_ADMIN grant test (C-1) passed even without the fix — recorded as
  not exploitable.
- `impersonation.test.ts`: four subject-reaching paths (C-2).
- `catalogue/ut-auth.test.ts`: sessions/impersonate under must-change-password (C-9);
  cross-organisation MFA policy (A-1); four audit events (C-6); scoped approver (LEAVE-1).
- `catalogue/employee-bulk-edit.test.ts`: scoped caller (A-2).
- `contract/input-contract.test.ts`: prototype keys (B-1) — first run 401 because earlier
  probes revoke the fixture admin; fixed with a fresh sign-in.
- `auth-rate-limits.test.ts`: second-instance limit (C-4) — first implementation shared one
  table across limiters and broke the refresh/MFA tests; fixed by scoping per limiter.
- `packages/shared`: password length (C-10), report filters (B-2).
- `apps/web/tests/security-headers.test.ts`: Vercel CSP (D-1).
- `catalogue/ut-lp.test.ts`: detail events in another zone (TZ-1).
- Fresh-database reproduction of CI-1 on `silverline_fresh_test`.

## Failed tests

None at the final gate (see above). One intermittent failure earlier in the day
(UT-AUTH-06) turned out to be a real resolver bug (LEAVE-1) and is fixed.

## False positives and justification

- C-1 as reported (ADMIN mints SUPER_ADMIN): refused already by the permission-subset
  check; explicit guard kept.
- Lane-D's `connect-src` concern on `_headers`: real for that file, but Vercel never read
  it; both files are now pinned.
- SkillSpector-style keyword hits were not part of this audit.

## Environment limitations

- No local gitleaks/semgrep/osv-scanner; they run in CI from this commit.
- No production credentials: the password-change and MFA flows were verified by tests
  and code, not against production.
- No device/simulator runs: mobile verified by typecheck + unit tests; iOS not built.
- `NODE_ENV=production`-gated behaviour (MFA floor) is inert in tests by design (A-005).

## Components not tested

iOS native layer and entitlements beyond `app.json`; Android runtime behaviour of the
new backup and Keychain settings; Vercel edge header sanitisation; Supabase RLS (the API
uses a single role and does not rely on RLS); ClamAV path (disabled on Vercel).

## Recommended follow-up tests

Negative cross-org tests for webhooks, automation rules, approval delegations, saved
filters, notifications, survey villages, GRNs, payslip PDF, evidence/document downloads
(lane A gap list); CSV formula cell unit tests; webhook `deliver()` against a private-IP
resolver and a 3xx; `report_schedules` filter persistence; worker-token semantics; a
config-level assertion of `allowBackup` after prebuild; a Playwright check that the
deployed web sends the CSP.

## Post-deployment verification — 2026-10-29

| Check | Result |
|---|---|
| `git push origin main` (0f800c3 → ca75975) | Deployed API `silverline-erp-gv1xbgf4g` and web `silverline-erp-61dmk96fu` on Vercel |
| `Verify Silverline` on ca75975 | **success** — first green run since 2026-10-09 |
| `Security` on ca75975 | failure: OSV action tag missing (CI-2); semgrep 47 blocking findings (SA-1..SA-7); secret scan passed |
| `GET /health` after cutover | 503 `SERVICE_UNAVAILABLE` for ~25 min (OPS-1), then `{"status":"ok"}` after the URL was rewritten without `sslmode` and the build redeployed |
| `POST /auth/login` as `admin` | 200, `must_change_password: true`, roles `SUPER_ADMIN` |
| Web headers at `silverline-erp-web.vercel.app` | CSP, COOP `same-origin`, HSTS preload, `X-Frame-Options: DENY` present |
| New database | `schema_migrations` 109 rows, latest `118_auth_rate_hits`; 165 public tables; seed: 1 org, 13 roles, 182 permissions, 1 user |

Local runs for the follow-up commit: `db-ssl.test.ts` RED (received `{}` for `ssl`) then
GREEN (22/22) after `withoutLibpqSslParams`; API `tsc` clean; mobile typecheck clean and
558 tests; web tsc + eslint clean and 992 tests; full API suite 89 files, 2,409 passed, 13 skipped
(run with only `TEST_DATABASE_URL` exported — sourcing the whole `.env` leaks `SEED_ADMIN_PASSWORD`
into the seed and turns every admin sign-in in the suite into a 401).

Second `Security` run (d561a61): secret scan passed; semgrep down from 47 to 1 finding (the
null-prototype map still matched `remote-property-injection`; replaced with
`Object.fromEntries`, survey suite 486/486); OSV job started this time but rejected
`--fail-on-vuln`, which osv-scanner 2.x does not have (it fails on findings by default).
Both fixed in the next commit. `Verify Silverline` green again. API `/health` ok and the web
CSP present on the d561a61 deployments.

Third `Security` run (96afeb6): secret scan and semgrep passed; OSV completed its first real
scan: 11 advisories filtered by `osv-scanner.toml`, 5 reported — postcss 8.4.31 nested under
`next` (2) and vite 7.3.6 under vitest (3), all with patched releases available. Fixed with npm
overrides (`next.postcss` → 8.5.28, `vite` → 7.3.7); verified by a clean `npm ci` from the new
lockfile (postcss 8.5.28, vite 7.3.7, no nested copy), the web static build, shared 1,056 and
web 992 tests, and two API files on the new vite.

Fourth `Security` run (398b682): all three jobs green (secret scan, OSV with the dated ignores,
semgrep 0 findings). D-5 closed the same day: `expo-screen-capture` installed via
`npx expo install`, wiring test RED (payslip) then GREEN, mobile typecheck clean, 560 tests,
`expo export` bundles both platforms, production-critical `npm audit` exit 0.

`Verify Silverline` on 96afeb6 failed on one unrelated test: `seed-reentrancy.test.ts` (60
back-to-back reseeds) hit its 60 s timeout on the shared CI runner; it takes ~10 s alone
locally. Timeout raised to 180 s; no code under test changed.

## Dependency majors — 2026-10-30

Branch `worktree-deps-majors` (plan: `docs/superpowers/plans/2026-10-29-dependency-majors.md`),
one commit per upgrade, full gate after each:

| Commit | Upgrade | Gate |
|---|---|---|
| vitest 3.2 → 4.1.12 | api, web, shared; `maxWorkers: 1, isolate: false` replaces `singleFork` | lint 5/5 · shared 1,056 · web 992 · api 2,409/13 skipped · build 4/4 · audit 0 |
| next 15.5 → 16.4.3 | Turbopack default; export unchanged (+`_not-found.html`); build output ignored by eslint | same, plus mobile 560 |
| zod 3.25 → 4.6.7 | shared, api, web, mobile; `@hookform/resolvers` 6; `.uuid()` → `.guid()`; `humanise` on zod 4 issues | same |

OSV ignores now: `deepmerge` (DEP-5, Expo tooling) and the zod 3 copy nested under `@expo/cli`
(DEP-2 closed for the application). Two calendar-dependent API tests were made deterministic on
the way (HR-1 work date, `nonSundayFutureDate`); HR-1's check-out step still depends on the wall
clock for the first 30 minutes after midnight IST.

Whole-branch review (fresh reviewer) found Z4-1 and Z4-2 (see the findings register); both
fixed RED→GREEN. Final gate after the fix pass: lint 5/5 · shared 1,059 · mobile 560 · web 992 ·
api 90 files, 2,417 passed, 13 skipped · build 4/4 · production-critical audit exit 0.
