# Lane A — Authorization and tenant isolation review (2026-10-28)

Read-only review of `apps/api` (485 registered routes). Method: read `common/auth.ts`, `recordScope.ts`, `domain.ts`; walked every route family for (a) guard preHandler, (b) org constraint on every id taken from params/body/query, (c) record-scope application, (d) JOIN leakage, (e) mass assignment; scanned every id-keyed `SELECT/UPDATE/DELETE` without `org_id` in a 25-line window and spot-checked each; checked background workers and the existing contract/catalogue suites.

## Confirmed findings

### A-1 — Cross-tenant write: any org admin can flip `mfa_required` on a *global* system role (High)

`apps/api/src/modules/admin/routes.ts:133-141`

```ts
app.patch('/api/v1/admin/roles/:id/mfa',{preHandler:guard('admin.configure')},async req=>{
  ...
  const role=(await db.query('SELECT id,code,org_id FROM roles WHERE id=$1 AND (org_id IS NULL OR org_id=$2)',[id,u.orgId])).rows[0] ...
  await db.query('UPDATE roles SET mfa_required=$2 WHERE id=$1',[id,i.mfa_required]);
```

System roles are single shared rows with `org_id IS NULL` (migrations `001_init.sql`, `031_commercial_permissions.sql:32`, `071_village_ladder.sql:151`; `016_automation_authority.sql` and `112_...sql` address them as `code=... AND org_id IS NULL`). The lookup deliberately admits `org_id IS NULL`, and the UPDATE then mutates the shared row. `buildAuthenticate` (`common/auth.ts:181-185`) derives `mfaEnrollmentRequired` from `r.mfa_required` for *every* org, so:

*Attack*: an `admin.configure` holder in tenant A sends `PATCH /api/v1/admin/roles/<global PAYROLL_OFFICER id>/mfa {"mfa_required":false}` (role ids are listed by `GET /admin/roles`, which returns global rows). Payroll/finance staff in every other tenant lose the production MFA floor; the reverse (`true`) locks other tenants' field roles behind enrolment. Only `SUPER_ADMIN` is protected (`mfaFloorRole`). The test `ut-auth.test.ts:1262 "lets an organisation excuse a field role"` documents per-organisation intent, so this is design-vs-implementation drift, not a decision.

*Fix*: store the override per org (a `role_mfa_policies(org_id, role_code, mfa_required)` table, same shape as `role_scope_policies` used by `PUT /admin/role-visibility/:code` at `admin/routes.ts:285-320`), and resolve it in `auth.ts` with `LEFT JOIN ... ON p.org_id=$orgId`. Minimal stop-gap: refuse the UPDATE when `role.org_id IS NULL`.

### A-2 — `PATCH /employees/bulk` bypasses the employee record scope that `PATCH /employees/:id` enforces (Medium)

`apps/api/src/modules/employees/routes.ts:2320-2353`

```ts
app.patch("/api/v1/employees/bulk", { preHandler: canCreate }, async (req, reply) => {
  ...
  const rows = (await client.query(
    `SELECT ${SELECT_COLS} FROM employees WHERE org_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
    [user.orgId, input.employee_ids])).rows
```

No `employeeScopeClause`/`employeeInScope` call anywhere in the handler (lines 2320-2470), and `enforceRecordScope` (`common/recordScope.ts`) only inspects `params.id` on `/employees/:id` and a scalar `body.employee_id`, never an `employee_ids[]` array. The single-record PATCH is scoped (via the `/api/v1/employees/:id` prefix branch at `recordScope.ts:49`); the bulk one is not.

*Attack*: a user whose `employee.create`-bearing role is assigned with a `district`/`mandal`/`team` scope (`PUT /admin/users/:id/roles` accepts those) can `PATCH /employees/bulk {employee_ids:[<any org employee>], changes:{district_id|designation_id|reports_to|...}}` and move/retag employees outside their directory scope. Tenant isolation holds (`org_id=$1`); record scope does not. `employee-bulk-edit.test.ts` has no scoped-caller case.

*Fix*: after the `FOR UPDATE` select, filter `rows` through `employeeInScope(user.orgId, user, id)` (helper already defined at `employees/routes.ts:543`) and report out-of-scope ids as 403 (or treat as `missing`).

## Needs manual verification

### A-3 — Worker tokens are minted from a long-lived shared HS256 secret and skip session, MFA and password gates (Low / design)

`modules/automation/worker.ts:103`, `modules/jobs/reports.ts:9`, `modules/jobs/scheduled.ts:35` sign `{sub, org_id, type:'access', worker:true}` with `jwtSecret`; `common/auth.ts:67` accepts any `worker` token with `exp-iat<=60` and no `family`, then `auth.ts:217,246` exempt it from the MFA-enrolment and must-change-password gates, and the session-revocation check is skipped (no `family`). Authority is re-derived from the subject's *current* roles on every request and `automation.manage`/`webhook.manage` are re-checked (`worker.ts:102,143`; `dispatch` route refuses non-worker callers), so this is not a privilege escalation by itself. Uncertain: whether `JWT_SECRET` is shared with anything outside the API process (e.g. the web host or ops tooling). If it is, anyone holding it can mint a 60s token for any user id and act as them with revocation and MFA bypassed. Worth a separate secret or an `aud:'worker'` claim bound to a worker-only key.

### A-4 — `GET /api/v1/search` re-enters the app with the caller's bearer (Low)

`modules/analytics/routes.ts:52-55` uses `app.inject` with `req.headers.authorization`. Functionally scope-preserving (delegates to the scoped list routes), but it re-runs authenticate three times and any future auth-only route added to the delegation list inherits whatever that route's scoping is. No exploit found; flag for the next reviewer rather than a bug.

## Verified safe (sampled)

- **Guards**: every route is permission-tagged or classified in `test/contract/support.ts` (41 permission-less routes documented); `route-matrix.test.ts` mechanically asserts 401/403/right-role for all 485 routes and a snapshot route count.
- **Org-wide-only permissions**: `payroll.*`, `inventory.*`, `webhook.manage`, `admin.configure`, `users.manage`, `users.read` reject scoped holders (`auth.ts:297`).
- **Admin**: users list/patch/roles/devices/password-reset all `WHERE org_id=$1` or `inOrg(... 'users')`; role assignment validates role org, scope record org (`admin/routes.ts:157`), "cannot grant what you don't hold", `mayManage`/`canManageAccount` (sensitive-permission ceiling), self-disable/self-role/self-security refusals, `keepAdministrator`. `POST /admin/roles` creates org-prefixed roles only. `role-visibility` is per-org.
- **Impersonation** (`auth/service.ts:647-760`, `auth/routes.ts:669-790`): subject must be same org (404 otherwise), `canImpersonate` subset rule + SUPER_ADMIN block, register row re-checked every request (`auth.ts:195-205`), forbidden paths via `impersonationBlocks`, refresh secret discarded, audit rows carry `impersonator_id`.
- **Employees**: PII masked unless `employee.pii.read` (audited at `employees/routes.ts:1141`); `/employees/:id/documents/:documentId/download` requires both `document.read` and `employee.read` (`requireAllPermissions`) plus `employeeInScope` and `org_id` on the document row; single PATCH `WHERE id=$1 AND org_id=$2 AND version=$32` with scope from `enforceRecordScope`; `status` rejected on PATCH (exit/reactivate only); `employee_id` relink not in the admin PATCH schema.
- **Expenses**: every read/receipt/download/delete does `inOrg('expense_claims')` then claimant/requester or `expense.read_all` check; receipts additionally `AND org_id=$3`.
- **Payroll**: list/run routes org-scoped; `/payroll/payslips/:id/pdf` requires `p.org_id=$2`, owner-or-`payroll.read`+`employeeAccess`, APPROVED/LOCKED only, audited.
- **Reports (s6)**: `POST /reports` needs `report.generate` + domain read, org-wide for inventory/assets/invoices/payroll, scope fingerprint stored; download requires `created_by=$3 AND org_id=$2`, re-checks permissions, PII permission and scope fingerprint; `x-report-job-id` honoured only for worker tokens. `report_schedules` are `created_by`-scoped.
- **Documents register**: all reads/writes `liveDocument`/`inOrg` with `org_id`; confidential fields gated on `document.confidential` for both read and write; `ownerExists` validates owner org.
- **Leave**: balances/requests/:id/cancel are self-or-`leave.read`/`leave.admin` with `employeeAccess`; decision uses org-scoped lookup.
- **Attendance**: self-punch only unless `attendance.decide` (`routes.ts:959-965`); exceptions/regularize validate `employee_id` in org and `assertExceptionScope`; decision lookup joins `employees e ... e.org_id=$2`, self-approval refused.
- **Automation/webhooks**: `inOrg` on rules, subscriptions, recipients, events; action permissions re-checked on create/patch; `acting_user_id` always set to the caller (`automation/routes.ts:42`), not from the body; `dispatch` is worker-only and verifies `rule.acting_user_id===u.id`; worker re-fetches rule under the acting user's token. Webhook delivery requires creator still holds org-wide `webhook.manage`; SSRF guard on destinations.
- **Jobs**: `/jobs/run` is `CRON_SECRET` with `timingSafeEqual`, 503 when unset (tested). Scheduled reports and automations re-authorize through `app.inject` with the creator's current permissions.
- **Approvals**: decision/withdraw/delegation use `inOrg('approval_instances'|'users')`, project scope 403, approver-rung ordering.
- **Procurement/billing/CRM/finance/allocation/planning/analytics/integrations/org units**: body FKs (`vendor_id`, `project_id`, `parent_id`, `to_employee_id`, `cycle_id`, `custom_field` ids) all go through `inOrg`/`org_id=$n` lookups; id-keyed UPDATEs without `org_id` are all preceded by an `inOrg(..., lock=true)` in the same transaction (spot-checked 26 sites).
- **Client viewers**: forced project scope, route blocklist on encoded paths uses `routeOptions.url`, `preSerialization` field allow-list for tasks/projects.
- **Notifications/saved filters/people**: `recipient_id`/`owner_id` + `org_id` constrained.

## Test coverage gaps

1. **Global-role mutation across tenants**: no test asserts that `PATCH /admin/roles/:id/mfa` by org-A leaves org-B's `mfaEnrollmentRequired` unchanged (would RED today). Same shape worth adding for `GET /admin/roles` exposing global ids.
2. **Scoped caller on bulk endpoints**: `employee-bulk-edit.test.ts` only uses `w.admin`; add a district/team-scoped `employee.create` holder expecting 403/`missing` for out-of-scope ids. Audit other array-id routes for the same shape (`integrations/accounting-export` is already org-wide-only; survey bulk routes are covered by `survey-authority.test.ts:535`).
3. **cross-org-depth** covers 11 resource families; missing live org-B rows for: webhooks/automation rules, approval instances/delegations, saved filters, notifications, attendance records/exceptions, survey villages, GRNs/vendor invoices (documented as out of budget), payslip PDF, task evidence download, employee document download.
4. **Record scope on secondary ids in bodies**: no negative tests for `body.project_id`/`body.employee_id` outside a scoped caller's range on `POST /cycles`, `POST /custom-fields`, `POST /automation-rules`, `POST /leave/balances`.
5. **Worker-token semantics**: no test that a `worker:true` token with `family` set, or `exp-iat>60`, is rejected, nor that a worker token for a DISABLED user is refused (it is, via `auth_status`, but untested).
6. **Impersonation + scope**: `impersonation.test.ts` exists; add a case that an impersonated subject's `record scope` (not just permissions) is what applies on a scoped list route.
