# Security findings — 2026-09-24 (branch qa/security, base main 7bd6f7d)

Dedicated adversarial security round against the Silverline ERP on dev-thor
(HTTP only; TLS-dependent items tagged KNOWN-TLS and not counted as bugs).
Test surface: on-VM against http://127.0.0.1 (`/api/v1`), plus static review of
the qa/security worktree. Probe scripts: `scripts/qa/security/` (copied to
`~/sl-e2e/security/` on the VM).

IDs S-###. Earlier rounds (findings-a/b/int/mobile) not re-logged.

## Result summary

No P0/P1/P2 security defect was found. The application has clearly been through
multiple prior security-focused rounds (AUTH-*, HR-*, B-*, section-notes in code)
and is hardened across every scope area tested. Details below, then the
informational / KNOWN-TLS notes.

Counts: found 0, fixed 0, open 0. Migrations: none. No throwaway accounts
created (existing QA users only; no data mutated).

---

## 1. AuthN & sessions — PASS

- Login enumeration: unknown user and wrong password return the identical body
  (INVALID_CREDENTIALS). Timing equalised with a constant TIMING_DUMMY_HASH
  bcrypt compare on the no-user and non-active paths. Inactive account returns
  the same generic shape. Password-reset request always 202.
- Lockout: 5 fails -> 15-min lock (423); counter reset atomic in the UPDATE;
  success clears it.
- MFA: TOTP verified then spent via a monotonic mfa_last_counter compare-and-set
  in the WHERE clause -> single-use, replay-proof, race-safe. Skew = 0 steps.
  Brute force limited (10/min/user). Disable needs a current code and is refused
  in production when the role still mandates MFA. Enrol/verify/disable revoke all
  sessions. Secret encrypted at rest.
- Tokens: access = 15-min HS256 JWT, verify pinned to algorithms:['HS256'] (no
  alg-confusion/none). Refresh = 256-bit random, sha256 at rest, single-use
  rotation per family; a retired token revokes the whole family (theft
  detection). Idle + absolute 7-day expiry enforced on refresh and on every
  access request (session row checked live: revoked/expired/idle/device).
- Logout/revocation: revokes by refresh token AND by bearer family; revoked
  refresh no longer works; password change revokes every session.
- Password reset: no emailed link/token — admin-mediated, 10-min per-user
  throttle + IP/account rate limit; no takeover primitive.
- Impersonation (s075): gated by admin.impersonate + canImpersonate (cannot
  impersonate an account with permissions you lack); subject roles/perms/scopes
  recomputed from DB every request; borrowed session non-refreshable and dies
  when the register row ends; blocked from changing subject password/MFA; fully
  audited.

## 2. AuthZ — PASS

- Route census: all 465 /api/v1 registrations enumerated statically. Exactly one
  lacks an auth preHandler: POST /api/v1/auth/logout (intentionally anonymous/
  idempotent). login/refresh/password-reset-request are public by design with
  rate-limit preHandlers.
- Runtime (probe-authz.js): no-token -> 401; garbage token -> 401; EMPLOYEE ->
  admin/payroll/integrations/metrics/impersonate -> 403; EMPLOYEE self-granting
  a role -> 403.
- Tenant isolation: org-2 admin reading org-1 project and employee by id -> 404
  (never 200). Queries carry org_id=$n; scoped reads use $n params.
- Mass assignment: all bodies via parse(zodObject, body); zod strips unknown
  keys; no .passthrough() and no ...req.body spread into any INSERT/UPDATE.

## 3. Injection — PASS

- SQL: every query-string interpolation is either a $n placeholder or a
  table/column name from a fixed in-code whitelist. No user value concatenated,
  incl. sort/order.
- CSV/formula: s6 csvCell prefixes leading = + @ - TAB CR with ' and quotes
  " , CR LF; xlsx writer emits every value as inlineStr (never a formula).
- XSS (web): only two dangerouslySetInnerHTML, both a static theme-init script.
- SSRF: only provider gateways; weather takes range-validated numeric lat/lng,
  not a URL; accounting-export enqueues an encrypted job, no outbound user URL.
- Header injection: download filenames via encodeURIComponent in
  Content-Disposition filename*.

## 4. Files — PASS

- Extensions restricted to pdf/jpg/jpeg/png (+evidence list); magic-byte
  signature validated vs extension; ClamAV INSTREAM scan, fail-closed in
  production unless MALWARE_SCANNER_DISABLED=true (announced at boot).
- Blobs stored encrypted in the DB (no filesystem path -> no traversal, no
  archive/XML parser to bomb).
- All three binary downloads (employees 1762, expenses 869, work 2913) send
  nosniff + Content-Disposition attachment; permission- and record-scope gated.

## 5. Transport & headers — PASS (probe-transport.js)

- nginx serves CSP (frame-ancestors 'none', object-src 'none', no unsafe-eval),
  nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy — on HTML
  and repeated per-location.
- CORS: arbitrary Origin NOT reflected (predicate names the project; wildcard
  cannot cross a dot); credentials only for allow-listed origins.
- Error bodies: malformed JSON -> generic 400, no stack/SQL/paths. /health only
  {status}. /operations/metrics unauth -> 401.
- .git/config, .env, _headers, _redirects, *.map -> 404; _next/static/ listing
  -> 403. Prototype pollution refused at Fastify's secure JSON parser.

## 6. Abuse & business logic — PASS

- Rate limits per endpoint class (login/mfa/password/reset/refresh/punch), by IP
  and by account separately; 429 + Retry-After; refusals not counted. login
  10/min, punch 30/min.
- Self-approval (maker-checker) enforced in approvals, attendance exceptions,
  expenses, leave, payment runs, stock variance — each with an audited
  approval.self_approve override where policy allows.
- Privilege escalation blocked: role.create and user-role assignment refuse to
  grant any permission or scope the actor does not hold; created roles
  non-system; CLIENT_VIEWER forced to explicit project scope.

## 7. Data protection — PASS

- PII encrypted at rest; full values only with employee.pii.read, else null +
  last-4; list masked for everyone (HR-15). Audit afterState PII-redacted.
- Logs: only method/route/status/duration/request_id; Authorization/Cookie in
  the pino redact list. No password/secret/PII observed.
- Audit coverage present for login, failed login, refresh, logout, MFA
  setup/verify/disable, password change/reset, impersonation start/stop, role
  and export actions.

---

## Informational / KNOWN-TLS (not counted as bugs)

- KNOWN-TLS: HSTS, Cross-Origin-Opener-Policy and upgrade-insecure-requests are
  deliberately omitted while the site is plain HTTP (documented in
  nginx-silverline.conf); add them with the certificate.
- INFO: worker tokens (claims.worker, ttl <= 60s, no family) intentionally
  bypass the session/MFA/password gates for background jobs; internally minted
  with the JWT secret and short-lived — acceptable, noted for awareness.

## Untested / partial (time-boxed)

- Full 465-route x 11-role x 4-variant authz matrix at runtime was sampled, not
  exhaustively executed; static census (every route guarded) + representative
  runtime checks stand in.
- Login rate-limit 429 verified by code review (existing AUTH-3 unit tests)
  rather than tripped at runtime, to avoid disrupting the parallel QA agent that
  shares the loopback IP bucket.
- Per-module stored-XSS checked at the sink level (web render + export), not by
  injecting into every free-text field of every module.
