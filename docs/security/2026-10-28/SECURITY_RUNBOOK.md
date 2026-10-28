# Security runbook — Silverline ERP

## Secret rotation

No secret was found exposed in this audit, so no rotation is required now. When one
is: `JWT_SECRET` (rotating signs everyone out; worker tokens use the same secret),
`ENCRYPTION_KEY` (**cannot** be rotated without re-encrypting every PII column and
blob; treat as permanent and back it up out of band), `CRON_SECRET` (rotate freely;
update the Vercel cron header), Supabase database password (update `DATABASE_URL` in
Vercel; the API reconnects on next cold start), ADMIN_MFA_SECRET. Rotate from the
Vercel project settings, then redeploy; never commit values.

## Secure deployment

- `main` → Vercel builds `silverline-erp-api` and `silverline-erp-web`. Migrations do
  **not** run on Vercel: run `npx tsx src/database/migrate.ts` from `apps/api` with the
  production `DATABASE_URL` from a trusted machine, after a backup, before or with the
  deploy. `REQUIRE_CURRENT_SCHEMA=true` makes the API refuse to boot otherwise.
- Required API env: `NODE_ENV=production`, `TRUST_PROXY=true`, `JWT_SECRET` (≥32 chars),
  `ENCRYPTION_KEY` (64 hex), `CRON_SECRET`, `DATABASE_SSL=verify-full` with the CA,
  `PGPOOL_MAX=2`, `MALWARE_SCANNER_DISABLED=true` (no ClamAV on Vercel; uploads are
  magic-byte validated and stored encrypted), `CORS_ORIGIN` = the web origin.
- Web headers (CSP, COOP, HSTS, frame-deny) ship in `apps/web/vercel.json`; a different
  API origin must be reflected in `connect-src` there and in `public/_headers`.
- Mobile: production builds require an HTTPS `EXPO_PUBLIC_API_URL`; cleartext is refused
  by the network policy plugin. Rebuild after D-3/D-4/D-5 changes.

## Monitoring

- `GET /health` (DB connectivity, schema status) and `GET /api/v1/operations/metrics`
  (requires `admin.configure`).
- Audit table `audit_events` (append-only by trigger). Watch for: `auth.login_failed`
  bursts per IP/account, `auth.refresh_reused` (token theft signature), `auth.mfa_reset`,
  `auth.password_change_failed`, `auth.mfa_verify_failed`, `device.revoke`,
  `user.roles`, `role.mfa_update`, `auth.impersonate*`.
- Rate limiting now counts in `auth_rate_hits`; 429s with `Retry-After` on
  `/auth/login`, `/auth/refresh`, `/auth/password`, `/auth/mfa/*`,
  `/auth/password-reset-request`, `/auth/impersonate`.
- Webhook deliveries record failures in the automation delivery tables; retries are bounded.

## Incident response

1. Suspected account compromise: `PATCH /admin/users/:id {auth_status:"DISABLED"}` (signs
   out everywhere), then reset password with `must_change_password:true`; `mfa_reset:true`
   if the authenticator is suspect; revoke devices under Administration → Devices (remote
   wipe on next connect).
2. Suspected token theft (`auth.refresh_reused` rows): the family is already revoked;
   check the actor's recent `auth.login` rows for unfamiliar IPs/user agents and disable
   if in doubt.
3. Secret exposure: rotate as above; for `ENCRYPTION_KEY` exposure, treat PII as
   disclosed and follow the organisation's breach process.
4. Preserve `request_id`s and the relevant `audit_events` rows; the table cannot be
   edited or deleted by the application role.

## Backup and recovery

Supabase automated backups plus the repo's `scripts/backup.mjs` / `scripts/restore.mjs`
(encrypted, see `docs/OPERATIONS.md`). Recovery requires the same `ENCRYPTION_KEY`.
Rehearse restores; verify row counts and a sample decrypt.

## Ongoing vulnerability management

- `Verify Silverline` workflow: lint, tests, build, `npm audit --omit=dev
  --audit-level=critical`.
- `Security` workflow (push, PR, weekly): gitleaks (history), osv-scanner (all lockfiles,
  ignores in `osv-scanner.toml` with reasons and expiry dates), semgrep (default, OWASP
  Top Ten, TypeScript packs).
- When an ignore expires the gate goes red: upgrade or renew the entry with a new reason.
- Re-run the lane briefs (in `lane-*.md`) after large features; keep
  `docs/qa` findings ledgers updated.

## Required CI/CD gates

Both workflows must be green before merging to `main`. Branch protection on `main`
requiring the `verify`, `secrets`, `dependencies` and `static-analysis` checks is the
recommended next step (GitHub settings, not in this repo).
