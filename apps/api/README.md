# Silverline ERP — API (S0)

Fastify + TypeScript backend. S0 scope only: health, auth (login / refresh /
logout / MFA / me with RBAC + lockout + rotating refresh families), audit
listing, shared error envelope, request ids, login rate limiting, CORS.

## Prerequisites

- Node 26, local Postgres 18 on `localhost:5432` (trust auth, no password)
- Databases `silverline_dev` / `silverline_test` (already created)
- Deps are pre-installed — **do not run `npm install`**

## Run (from the repo root)

```bash
# 1. Build shared contracts first (api consumes @silverline/shared/dist)
npm run build --workspace=@silverline/shared

# 2. Migrate + seed the dev DB
DATABASE_URL=postgresql://localhost:5432/silverline_dev npm run migrate --workspace=apps/api
DATABASE_URL=postgresql://localhost:5432/silverline_dev npm run seed --workspace=apps/api

# 3. Start the server (PORT default 3001)
DATABASE_URL=postgresql://localhost:5432/silverline_dev JWT_SECRET=dev-secret-change-me \
  npm run dev --workspace=apps/api
```

Seed credentials: username `admin`, password `ChangeMe123!` (SUPER_ADMIN, demo org).

## Verify

```bash
curl -s http://localhost:3001/health
curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123!"}'
```

## Tests (real DB `silverline_test`, auto migrated + truncated)

```bash
# from apps/api/
npx vitest run
# typecheck (build config + test-inclusive check config)
npx tsc -p tsconfig.json && npx tsc -p tsconfig.check.json
```

## Env vars

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/silverline_dev` | tests use `silverline_test` |
| `JWT_SECRET` | `dev-secret-change-me` | sign access JWTs (15 min) |
| `PORT` | `3001` | |
| `BCRYPT_ROUNDS` | `10` | bcryptjs cost |
| `LOGIN_RATE_LIMIT_MAX` | `10` | sign-in attempts per minute, counted separately per client address and per account name; MFA codes, password changes, reset requests, MFA setup and view-as use the same number in their own buckets, refresh six times it per address. In memory: correct for the single API process, not across several |
| `TRUST_PROXY` | `127.0.0.1,::1` | peers whose `X-Forwarded-For` is believed (Fastify `trustProxy`); a comma list of addresses/CIDRs, or `true`/`false` |
| `ENCRYPTION_KEY` | `0123456789abcdef…abcdef` (dev only) | 32-byte hex for AES-256-GCM PII encryption (aadhaar/pan/bank_account). Dev default is `0123…abcdef` repeated (64 hex chars, see `src/common/crypto.ts`); set a real secret everywhere else. Never logged. |
| `UPLOADS_DIR` | `./uploads` | local document storage root (S1 driver; files under `<dir>/<employee_id>/`) |
| `REPORTS_DIR` | `./exports` | local CSV report storage root (S6; files `<dir>/<report_id>.csv`, created at runtime) |
| `PUNCH_RATE_LIMIT_MAX` | `30` | attendance punches per authed user (else IP) per minute (S6) |

## Key endpoints

- `GET /health`
- `POST /api/v1/auth/login` → token pair or `{ mfa_required: true }`
- `POST /api/v1/auth/refresh` → single-use rotation; reuse revokes family (401)
- `POST /api/v1/auth/logout` → idempotent `{ success: true }`
- `POST /api/v1/auth/mfa/setup|verify` + `POST /api/v1/auth/mfa/disable`
- `GET /api/v1/auth/me`
- `GET /api/v1/audit` → needs `audit.read`; cursor pagination, `?action=&entity=&actor_id=&entity_id=&from=&to=&limit=&cursor=` (`from`/`to` are inclusive `YYYY-MM-DD` days in the organisation's timezone)

Errors always match `{ code, message, field_errors, request_id, retryable }`;
every response carries `x-request-id`. CORS allows `http://localhost:3000`.

## S6 — dashboards, my-work, reports, punch rate limit

- `GET /api/v1/dashboards/role/:role` → bare
  `{ template, generated_at, widgets: [{ key, title, value, link? }] }`
  (+ `scope_note` when a team/PM scope falls back to empty). `:role` is one
  of `super_admin|admin|hr_manager|project_manager|team_lead|employee|`
  `client_viewer|auditor`; the caller must hold the matching UPPER role code
  or gets `403 NOT_YOUR_ROLE`; unknown names get `422 UNKNOWN_TEMPLATE`.
  All widgets are live SQL in a single transaction per request, always
  caller-scoped (org of the caller; team = employees whose `reports_to` is
  the caller's linked employee — empty + zeros + `scope_note`, never a
  silent org-wide fallback). In-process cache (`Map`, key
  `${userId}:${template}`, TTL 60s; cache hits return the stored
  `generated_at`). No Redis. `attendance_today_pct` counts records with
  status `PARTIAL`/`COMPLETE` (`PRESENT` accepted if ever stored) over the
  active headcount, null-safe 0; "today" is
  `(now() AT TIME ZONE 'Asia/Kolkata')::date`.
- `GET /api/v1/dashboards/my-work` → bare
  `{ assigned_open, assigned_overdue: [{ id, title, project_id, planned_end_date }],`
  `pending_approvals: { leave: [{ id, employee_id, from_date, to_date }], exceptions_count },`
  `unread_count }`. Auth only (own data). `leave` = PENDING requests where
  the caller is `current_approver_id`. `exceptions_count` = org-pending
  attendance exceptions for holders of `attendance.decide`, else 0
  (exceptions carry no per-request approver column).
- `POST /api/v1/reports` `{ type: employees|attendance|tasks|leave, format: "csv", filters? }`
  → `201` bare `{ id, type, format, status: "READY", rows, download_url }`.
  Needs `report.generate` plus the domain read perm (`employee.read` /
  `attendance.read` / `task.read` / `leave.read`); over 5000 rows →
  `422 TOO_LARGE`. Synchronous in S6 (no job queue). Audited as
  `report.generate` with `{ type, format, rows }`.
- `GET /api/v1/reports/:id/download` → `200 text/csv` attachment (same
  perms as generate; `404` for unknown ids — the registry is an in-memory
  `Map`, so a restart loses old ids; files live under `REPORTS_DIR`).
- Stable CSV column order per type (header row + escaped values; `my_pending_requests`
  on the employee dashboard = PENDING leave requests for the linked employee
  + PENDING attendance exceptions submitted by the caller):
  - employees: `id,emp_no,first_name,last_name,phone,email,designation,`
    `department,status,date_of_joining,aadhaar,pan,bank_account,phonepe_number,salary_basic`
    (PII follows the caller's masking rules: full values only with
    `employee.pii.read`, otherwise masked last-4; `salary_basic` has no
    last-4 and is emitted empty without `pii.read`)
  - attendance: `id,employee_id,work_date,status,check_in_at,check_out_at,total_hours,geofence_violation`
    (filters: `employee_id`, `from`, `to`, `status`)
  - tasks: `id,project_id,title,status,assignee_id,priority,planned_start_date,planned_end_date`
    (filters: `project_id`, `status`, `assignee_id`)
  - leave: `id,employee_id,leave_type_id,from_date,to_date,total_days,status`
    (filters: `employee_id`, `status`, `from`, `to`)
  - employees filters: `status`, `department`. Unknown/malformed filter keys
    are ignored.
- `POST /api/v1/attendance/events` is rate-limited to 30/min per authed
  user (else IP), fixed window, in-memory. Exceeding it returns
  `429 RATE_LIMITED` with `retryable: true` and a top-level
  `retry_after_ms` hint. The login limiter is unchanged.

## RBAC (PRD §4 contract)

Role → grant summary (seeded by `src/database/seed.ts` from
`@silverline/shared` S0/S1/S2/S3/S4/S5/S6/P1 maps; re-seed converges):

| Role | Grants |
|---|---|
| SUPER_ADMIN / ADMIN | everything (full parity; ADMIN ≈ SuperAdmin in code today) |
| PAYROLL_OFFICER | payroll module only + `auth.login` (+ ambient `notification.read`, `dashboard.read`); NO employee/attendance/task codes |
| INVENTORY_MANAGER | no business perms — `auth.login` + own (unenforced) `inventory.*` + ambient `notification.read`, `dashboard.read` (no inventory module exists yet) |
| HR_MANAGER | employee.* + leave.* + holiday.* + `org.units.read` + document.* (+ `users.read/manage`, `attendance.*`, `payroll.read`, `payslip.read`, `report.generate`) |
| PROJECT_MANAGER | project.* + task.* + board.* + workspace.* + label.* + `attendance.read` (+`decide` kept) + `leave.read/decide` + `report.generate` |
| TEAM_LEAD | task.read/create/update/transition/assign/comment + `project.read` + `board.read` + `leave.read/decide` + `attendance.read/decide` + `report.generate` (+ ambient `employee.read`, `org.units.read`, `document.read`, `filter.*`, `label.read`) |
| EMPLOYEE | `employee.read` + `attendance.punch` (+`read` for own records) + task.read/create/comment + task.update **own assigned tasks only** (`assignee == caller`, enforced in `PATCH /tasks/:id`) + `leave.request` (+`read`) + `payslip.read` (own) + `notification.read` + `board.read` + `filter.*` |
| CLIENT_VIEWER | `project.read` + `task.read` + `board.read` only (+ ambient `notification.read`, `dashboard.read`) — no employee/audit/leave/payroll |
| AUDITOR | `audit.read` + `employee.read` (masked: no `employee.pii.read`) + `attendance.read` + `leave.read` + `project.read` + `task.read` + `payroll.read` + `report.generate` — zero write/decide/approve/manage codes |

Scope rules (`user_roles.scope_type/scope_id`, migration `008_scopes`;
helper `src/common/scopes.ts`, pure `resolveScopes` unit-tested in
`test/rbac.test.ts`): a NULL scope (missing type or id) is a GLOBAL
assignment (permission-gate only). Scoped assignments union-restrict:
`district|mandal|village` (ancestry-resolved over `org_units`),
`team` (scope_id = manager employee id → `reports_to` subtree, root
included), `project` (employees via tasks assigned to the project through
the assignee's linked employee; tasks via `project_id` directly).

Scope-filtered vs permission-only endpoints:

- Scope-filtered: `GET /api/v1/employees`, `GET /api/v1/tasks`.
- Permission-gated only (residual gap, by design): every detail/mutation
  endpoint (`GET /employees/:id`, `GET /tasks/:id`, leave/attendance
  queues, reports, dashboards) plus all other modules.
- Task-update sub-paths sharing the `task.update` gate (evidence upload,
  dependency add/remove, label attach/detach) do NOT apply the
  assignee==caller owner check — only `PATCH /tasks/:id` does.

Self-approval: leave chains already skip self (untouched). Attendance
exception decisions add a guard: the submitter cannot decide their own
exception (`403 SELF_DECISION`) unless they hold `users.manage`
(emergency override, audited with `reason` = decision note).

## Notes / deviations

- Password hashing is **bcryptjs** (per S0 brief); DEV_PLAN §4 mentions
  argon2id but argon2 is not an installed dep and `npm install` is off-limits.
- The brief says "9 role codes" but lists 10 — all 10 are seeded.
- `users.employee_id` / `created_by` self-refs from ARCHITECTURE.md §4 are
  deferred (no employees module in S0); `users.phone` is nullable for the same
  reason.
