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
