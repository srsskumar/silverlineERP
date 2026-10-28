# Silverline ERP — security audit report, 2026-10-28

## Executive summary

A full-scope, evidence-based review of the repository (API, web, mobile, shared
package, database, CI, deployment) with remediation applied in the same round.
Four read-only review lanes (authorization, input/files/SSRF, authentication and
sessions, web and mobile clients) produced 27 findings; this round fixed 19,
mitigated 2, accepted 2 with reasons, and left 4 dependency upgrades open with
dated, reasoned ignores. Every fix carries a regression test that was seen
failing first.

The single most consequential discovery was not a vulnerability in the
application: **CI had been red on every push since 2026-10-09**, failing in the
test-database setup before any test or the dependency-audit gate ran, so nothing
had been enforcing the gates on `main` for three weeks. That is fixed, and a
second workflow now adds secret scanning, OSV dependency scanning and semgrep.

The highest-severity application finding was a **cross-tenant write**: an
administrator in one organisation could change the MFA requirement on the
shared system roles for every organisation on the deployment. It is fixed with a
per-organisation policy table. The remaining Medium findings were a bulk-edit
endpoint that skipped record scope, impersonation paths that let a view-as
session hijack push and sessions, in-memory rate limits that were decorative on
serverless, a missing MFA recovery path, missing CSP on the Vercel deployment,
and the administrator's own refresh token persisted during view-as.

Overall assessment: the codebase was already in good shape (parameterised SQL
throughout, allow-listed sort/table names, HMAC-signed and SSRF-guarded
webhooks, encrypted PII, bearer-only auth with refresh rotation and reuse
detection, masked logs). The findings are concentrated at tenant boundaries of
shared rows, serverless assumptions inherited from the one-VM design, and
client-side storage choices forced by the static web export.

## Architecture and attack surface

- **API**: Fastify + raw `pg`, one Vercel serverless function (`apps/api/api/index.js`
  → `dist/createApp.js`), 485 routes under `apps/api/src/modules/*/routes.ts`, Supabase
  Postgres via the transaction pooler, daily cron `/api/v1/jobs/run` (CRON_SECRET,
  timing-safe). Auth: HS256 access JWT (15 min), opaque refresh token (SHA-256 stored,
  family rotation, reuse revokes the family, 7 days), TOTP MFA with per-org role
  policy, device registrations with remote wipe, impersonation with a forbidden-path
  list. Authorization: permission codes per role + record scope (self/team/geo/project)
  via `common/recordScope.ts` and `common/domain.ts`.
- **Web**: Next.js 15 static export on Vercel; Bearer tokens in `localStorage`;
  no cookies; CORS allow-list predicate.
- **Mobile**: Expo SDK 57 / RN 0.86; tokens in SecureStore; per-account AES-GCM
  sealed SQLite queue; cleartext traffic off; minimal permissions; scheme `silverline`.
- **Data**: PII encrypted at rest and masked; uploads stored encrypted in Postgres with
  magic-byte validation and optional ClamAV; audit table append-only by trigger.
- **Outbound**: geocoder (env-configured), webhooks (HTTPS, public-IP-only, pinned DNS,
  HMAC-SHA256 + timestamp, bounded retries), survey mail relay (env URL).
- **CI/CD**: GitHub Actions `Verify Silverline` (lint, test, build, audit) + new
  `Security` workflow; Vercel builds from pushes to `main`.

## Scope and methodology

Phases 1–8 of the master instruction. Read-only discovery by hand (route inventory,
config, CI, secrets patterns across tree and history, dependency audit); four parallel
read-only reviewer agents with evidence-only briefs; every reported finding verified
in code by the lead before changing anything; fixes made with a failing regression
test first (repo convention), then the affected suites, then the full gate. No live
production testing beyond `GET /health`; no production data touched. Scanners
available locally: `npm audit` only (gitleaks/semgrep/osv-scanner are not installed on
this machine and installs are blocked by the session's permission policy), so those
run in CI from this commit onward.

## Findings by severity

See `SECURITY_FINDINGS.md` for the register. Counts (excluding the two integrity
bugs found on the way):

| Severity | Found | Fixed | Mitigated | Accepted | Open |
|---|---|---|---|---|---|
| Critical | 1 (DEP-1 bundle, dev-only criticals) | 1 | 0 | 0 | 0 (dev-only remainder tracked as DEP-4) |
| High | 3 (CI-1, A-1, DEP-2) | 2 | 0 | 0 | 1 (DEP-2 zod 4, bounded) |
| Medium | 8 (A-2, C-1, C-2, C-3, C-4, C-11/D-2, D-1, DEP-3) | 6 | 1 | 0 | 1 (DEP-3 build-time) |
| Low | 12 | 8 | 1 | 2 (A-3, C-5) | 1 (A-4) + DEP-5 |

## Root causes and attack scenarios (highlights)

- **A-1**: shared system role rows are one row per deployment; the per-org intent
  lived only in tests. Any `admin.configure` holder in tenant A could `PATCH
  /admin/roles/<global id>/mfa {mfa_required:false}` and remove the MFA floor from
  tenant B's payroll officers.
- **C-4**: the limiter comment itself said "one process on one box"; the deployment
  moved to serverless without it.
- **C-2**: the forbidden-path list was written for credential routes and not revisited
  when device registration and session routes were added.
- **CI-1**: the global setup assumed a database that had seen a migration before.

## Fixes implemented

Listed per finding in the register; grouped by commit in `SECURITY_REMEDIATION_LOG.md`.

## Verification

`SECURITY_TEST_RESULTS.md` has the commands and results. Summary: all four
workspaces lint clean; shared 1,056 tests, web 992, mobile 558, API 2,4xx (see the
results file for the exact count after this round) green; `npm audit --omit=dev
--audit-level=critical` passes; CI run on the pushed commit reaches the gates.

## Outstanding risks and limitations

- Web tokens stay in `localStorage` (static export). The CSP is the backstop; a
  shorter refresh TTL or in-memory refresh is the next step.
- `zod` 4 and `next` 16 upgrades are deliberate projects; both are bounded at runtime
  and tracked with dated ignores in `osv-scanner.toml`.
- Screenshot protection on payslip/MFA screens needs a native dependency this session
  could not add (`expo-screen-capture`).
- Worker tokens are only as safe as `JWT_SECRET`; keep it API-only.
- Not tested: iOS build and native layers (no Xcode build in this round), Android
  runtime on a device (owner asked for no APK builds), Vercel edge
  `X-Forwarded-For` sanitisation (assumed; `TRUST_PROXY=true` documented).
