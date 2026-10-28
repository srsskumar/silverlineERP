# Remediation log — 2026-10-28

Everything below was done on `main` in this order. Commits are listed in
`git log` with the same titles; the audit-round commits follow `3d84265`.

## Files changed

API (`apps/api`)
- `test/globalSetup.ts` — migrate before cleanup (CI-1).
- `src/common/auth.ts` — `scopesForUserPermission` (request-free twin), per-org MFA
  flag via `role_mfa_policies` (A-1), must-change-password allow-list (C-9).
- `src/common/domain.ts` — `Object.hasOwn` in `sortClause` (B-1); `changed` field names in
  user audit payloads (C-7).
- `src/common/rateLimit.ts` — `WindowStore`, `createPgWindowStore` (C-4).
- `src/modules/auth/routes.ts` — DB-backed, per-limiter-scoped limiters (C-4); audit rows for
  wrong current password, wrong TOTP at verify/disable, device-revoked sign-in (C-6);
  effective MFA flag in the disable floor (A-1).
- `src/modules/auth/service.ts` — `auth.refresh_reused` audit row (C-6).
- `src/modules/admin/routes.ts` — SUPER_ADMIN grant guard (C-1), `mayManage` on device
  revoke (C-8), per-org MFA policy write and effective listing (A-1), `mfa_reset` (C-3),
  `changed` in the response (C-7), password max 72 (C-10).
- `src/modules/employees/routes.ts` — record scope on bulk edit (A-2).
- `src/modules/expenses/routes.ts`, `src/modules/inventory/routes.ts` — `Object.hasOwn` (B-1).
- `src/modules/jobs/surveyMail.ts` — attempt counter (B-3).
- `src/modules/leave/approverResolution.ts`, `src/modules/leave/routes.ts` — scope-aware
  approver cascade (LEAVE-1).
- `src/modules/attendance/routes.ts` — org-zone event matching (TZ-1); mock-location refusal
  ordering and approval block (earlier the same day, O-002).
- `src/database/migrations/117_role_mfa_policies.sql`, `118_auth_rate_hits.sql`,
  `src/database/migrate.ts` — new tables registered.
- `test/tables.ts` — new tables in the per-file truncate list.
- Tests: `account-authority.test.ts`, `impersonation.test.ts`, `auth-rate-limits.test.ts`,
  `catalogue/ut-auth.test.ts`, `catalogue/ut-lp.test.ts`, `catalogue/employee-bulk-edit.test.ts`,
  `contract/input-contract.test.ts`, `s3.test.ts`.

Shared (`packages/shared`)
- `src/auth.ts` — password caps (C-10). `src/impersonation.ts` — forbidden paths (C-2).
  `src/s6.ts` — `reportFiltersSchema` (B-2). Tests: `src/auth.test.ts`, `src/reports.test.ts`.

Web (`apps/web`)
- `vercel.json` — CSP, COOP, pinned `connect-src` (D-1/D-6). `public/_headers` — pinned
  `connect-src`. `lib/apiClient.ts` — impersonation state in `sessionStorage` (D-2).
  `tests/security-headers.test.ts` — Vercel headers asserted.
- `package.json` — `next` 15.5.28.

Mobile (`apps/mobile`)
- `src/device/auth.ts`, `src/device/vault.ts` — `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (D-4).
- `plugins/with-no-backup.js`, `app.config.js`, `test/no-backup.test.ts` — `allowBackup=false` (D-3).
- `app/(auth)/enroll.tsx` — clipboard cleared after 60 s (D-5).
- `package.json` — `expo` 57.0.31.

Repository
- `.github/workflows/ci.yml` — audit step narrowed to production-critical.
- `.github/workflows/security.yml` — gitleaks, osv-scanner, semgrep (new).
- `osv-scanner.toml` — dated, reasoned ignores for the open dependency items.
- `package-lock.json` — `npm audit fix`, `bcrypt` 6, `fastify` 5.12.7, `next`, `expo`.
- `.gitignore` — `graphify-out/`.
- `docs/security/2026-10-28/*` — this report set and the four lane reports.

## Vulnerabilities fixed

CI-1, A-1, A-2, B-1, B-2, B-3, C-1 (defence in depth), C-2, C-3, C-4, C-6, C-7, C-8,
C-9, C-10, D-1/D-6, D-3, D-4, DEP-1, LEAVE-1, TZ-1. Mitigated: C-11/D-2, D-5.

## Dependency changes

| Package | From | To | Why |
|---|---|---|---|
| (transitive, via `npm audit fix`) | — | — | 31 → 18 advisories without majors |
| next (web) | 15.5.25 | 15.5.28 | SSG/ISR cache-poisoning advisories |
| bcrypt (api) | 5.1.1 | 6.0.0 | drops node-pre-gyp/tar (critical tar advisory at install time) |
| expo (mobile) | 57.0.26 | 57.0.31 | patch release within SDK 57 |
| fastify (api) | 5.12.5 | 5.12.7 | header validation bypass (low) |

Result: 31 → 16 advisories; production-critical: 0. Remaining items are DEP-2..5 in the register.

## Configuration changes

- Vercel web headers (CSP, COOP). No environment variables changed. Two new database
  tables applied by the ordinary migration path (`npm run db:migrate` locally; on
  Supabase run migrations from a trusted machine as `docs/DEPLOY_VERCEL.md` says —
  **the API will refuse to boot with `REQUIRE_CURRENT_SCHEMA=true` until 117 and 118
  are applied**).

## Tests added

24 new or rewritten tests across API (18), shared (5), web (2), mobile (1); listed per
finding in the register.

## Commands executed (verification)

See `SECURITY_TEST_RESULTS.md`.

## Breaking-change risks

- Clients that sent report `filters` keys other than `employee_id`, `project_id`,
  `assignee_id` now get 422 (none found in web or mobile).
- New passwords longer than 72 characters are refused (login unchanged).
- A view-as session no longer survives closing the tab.
- A must-change-password account can no longer list sessions or start impersonation
  before choosing a password.
- Bulk employee edits by a scoped caller that include an out-of-scope person are
  refused whole.

## Manual actions still required

1. Apply migrations 117 and 118 to production before deploying the API (or in the
   same deploy window): `DATABASE_URL=<prod> npx tsx src/database/migrate.ts` from
   `apps/api` on a trusted machine, after a backup.
2. Add `expo-screen-capture` and `usePreventScreenCapture()` on `my-payslip.tsx` and
   `(auth)/enroll.tsx` (D-5), then rebuild the APK (the owner asked for no builds in
   this round; D-3/D-4 also only take effect in the next build).
3. Confirm in Vercel that `NODE_ENV=production` is set on the API project (the MFA
   floor and secret-strength checks are gated on it).
4. Plan the `zod` 4, `next` 16 and `vitest` 4 upgrades before 2026-12-31, when the
   OSV ignores expire.
