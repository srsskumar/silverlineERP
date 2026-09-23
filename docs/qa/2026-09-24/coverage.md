# Coverage and parity matrix — 2026-09-24 QA sweep

Scope: `apps/web` (Next.js app router), `apps/mobile` (Expo), `apps/api` (Fastify), `packages/shared`.
Method: grep-extracted (not full-file reads) from web `page.tsx`/`DetailClient.tsx` files, mobile
`app/*.tsx` screens, and API `apps/api/src/modules/*/routes.ts`. Every row cites `file:line`. Gate
strings are the literal permission dot-codes; web reads them from `apps/web/lib/nav.ts` /
`packages/shared/src/modules.ts` (authoritative — both are asserted equal by
`apps/web/tests/module-catalog.test.ts`), mobile from `apps/mobile/src/rbac.ts` /
`apps/mobile/src/modulesLauncher.ts`, API from the `guard('x')` / `requirePermission(auth, X)`
argument at the route's `preHandler`.

**Two access-control patterns to watch for while walking this matrix** (found while building it,
not a summary — check both on every route you test):
1. **preHandler weaker than the real gate.** Several routes gate only `authenticate` (or a coarse
   permission) at `preHandler`, then check the real permission *inside* the handler body against
   `req.body`/`user.permissions`. A permission-only audit of route registration will under-report
   what's actually enforced, and a bug there won't show up in a route-table scan — it has to be
   called. Confirmed instances: `apps/api/src/modules/leave/routes.ts:1056` (decision route's
   `preHandler` is bare `authenticate`; `LEAVE_DECIDE` checked at line 1078),
   `apps/api/src/modules/s6/routes.ts:737,853` (`POST /reports`, `GET /reports/:id/download`:
   `preHandler: authenticate`; `report.generate` + per-type data permission checked at 758/882),
   `apps/api/src/modules/stock/routes.ts:240` (`POST /stock-transactions`: `preHandler:
   guard('stock.read')`; the real `stock.issue`/`stock.adjust`/`stock.transfer` by
   `transaction_type` checked at line 243 — this one is `read` as the floor, not a full bypass).
2. **Module-visibility is UI-only.** `packages/shared/src/modules.ts`'s
   `MODULE_VISIBILITY_IS_NOT_A_PERMISSION` — hiding a module via admin's role-visibility screen
   changes what web/mobile render, never what the API accepts. A QA agent testing "is this module
   hidden" must separately confirm the API still permission-checks it independently (it does, by
   inspection — every route above requires its own `guard()`/`requirePermission`, none consult the
   visibility table).

Findings ledgers: `docs/qa/2026-09-24/findings-a.md` (Lane A modules), `findings-b.md` (Lane B).

---

## Lane A

### Auth / MFA / Security

**Web** — `apps/web/app/login/page.tsx`, `apps/web/app/mfa/page.tsx`, `apps/web/app/security/page.tsx`. No nav entry (pre-session / always-available); `/security` has no permission gate by design (`packages/shared/src/modules.ts:88-90` — changing your own password/MFA can't be locked behind a permission that would then lock the user out of fixing it).

| Element | File:Line | Gate / validation |
|---|---|---|
| Username/password `<Input>`×2, submit `<Button>` | login/page.tsx:78,86,102 | none (public) |
| "Forgot password" flyout: username `<Input>`, Ask `<Button disabled={!who.trim()}>`, Cancel | login/page.tsx:161,180-190 | none (public) |
| MFA code `<Input placeholder="123456">`, submit | mfa/page.tsx:60,65,73 | session must be MFA-pending |
| "Set up authenticator" `<Button>` | security/page.tsx:9 | shown only if `!session.user.mfa_enabled` |
| MFA verify `MutationForm` (code, required) | security/page.tsx:9 | `auth/mfa/verify` |
| Change password `MutationForm` (current+new, both required) | security/page.tsx:9 | `auth/password` |
| Active sessions `Collection` + "Revoke selected session" | security/page.tsx:9 | `auth/sessions`, `auth/sessions/:id/revoke` |

**Mobile** — `apps/mobile/app/(auth)/login.tsx`, `mfa.tsx`, `enroll.tsx`, `password.tsx`. No permission gate (pre-session).

| Element | File:Line |
|---|---|
| Mobile-number `TextInput`, password `TextInput`, submit `onPress` | login.tsx:81,97,116 |
| MFA code `TextInput`, submit | mfa.tsx:63,81 |
| Enrol: start-setup `onPress`, code `TextInput`, confirm `onPress`, sign-out `<Button>` | enroll.tsx:105,117,128,141,152 |
| Change password: two `TextInput` (current/new), submit | password.tsx:78,86,106 |

**API** — `apps/api/src/modules/auth/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| POST /auth/login | 101 | `loginRateLimit` only |
| POST /auth/refresh | 167 | `refreshRateLimit` |
| POST /auth/logout | 192 | none (public) |
| POST /auth/mfa/setup | 239 | `[authenticate, mfaSetupRateLimit]` |
| POST /auth/mfa/verify | 266 | `[authenticate, mfaRateLimit]` |
| POST /auth/mfa/disable | 302 | `[authenticate, mfaRateLimit]` |
| POST /auth/password | 365 | `[authenticate, passwordRateLimit]` |
| GET /auth/me | 399 | `authenticate` (returns `permissions[]` + `modules{}`) |
| POST /auth/password-reset-request | 519 | `resetRequestRateLimit` |
| GET /auth/impersonate/targets | 643 | `admin.impersonate` |
| POST /auth/impersonate | 696 | `[admin.impersonate, impersonateRateLimit]` |
| POST /auth/impersonate/stop | 743 | `authenticate` |
| GET /auth/sessions, POST /auth/sessions/:id/revoke | admin/routes.ts:160-161 | `auth` (bare authenticate — self-scoped) |

**Parity**: 1:1 web/mobile for login, MFA setup/verify, password change. No mismatch. Impersonation is admin-only and has no UI on either surface (API-only) — worth a probe: is it callable from a browser devtools/API client only, intentionally?

---

### Admin (users, roles, module visibility)

**Web** — `apps/web/app/admin/page.tsx` (nav: `users.read`, module code `admin`), `apps/web/app/admin/import-templates/page.tsx` (`users.read`).

| Element | File:Line | Gate |
|---|---|---|
| Users `Collection` | admin/page.tsx:16 | `users.read` (page-level) |
| "Create user" panel, `MutationForm` (username/phone/password/email/employee/must_change_password, username+password required) | admin/page.tsx:16 | `Can permission="users.manage"` |
| Per-user security `MutationForm` (status/phone/password/mfa_policy/must_change_password) | admin/page.tsx:16 | `Can permission="users.manage"`; self-edit path hides status/password/mfa fields |
| "Assign role to user" `MutationForm` (role_id required + scope pickers) | admin/page.tsx:16 | `Can permission="admin.configure"` |
| "Create custom role" `MutationForm` (code/name/permissions, all required) | admin/page.tsx:16 | `Can permission="admin.configure"` |
| Org settings (`OrgSettingsForm`) | admin/page.tsx:16 | `Can permission="admin.configure"` |
| "Create project type" `MutationForm` | admin/page.tsx:16 | `Can permission="admin.configure"` |
| Catalogue `Collection` + edit `MutationForm` | admin/page.tsx:16 | `Can permission="catalogue.read"` / `catalogue.manage` |
| "Add to the catalogue" `MutationForm` | admin/page.tsx:16 | `Can permission="catalogue.manage"` |
| Roles `Collection` + per-role MFA-required toggle `MutationForm` | admin/page.tsx:16 | `Can permission="admin.configure"` |
| Devices `Collection` + "Revoke sessions and request device wipe" | admin/page.tsx:16 | `Can permission="users.manage"` |
| `PasswordResetQueue` | admin/page.tsx:16 | `Can permission="users.manage"` |
| `RoleVisibility`, `ModuleVisibility` panels | admin/page.tsx:16 | `Can permission="admin.configure"` |
| Upload & download (CSV import/export hub) | import-templates/page.tsx:27-32 | `RequireDestination` on `/admin/import-templates` |

**Mobile** — **N/A**: `admin` is not in `BUILT_MODULE_ROUTES` (`apps/mobile/src/modulesLauncher.ts:57-80`) → falls through to `/coming-soon?code=admin` in the More-tab launcher. No screen exists; nothing to test beyond "does it correctly show Coming soon and not silently 404" (`apps/mobile/app/coming-soon.tsx`).

**API** — `apps/api/src/modules/admin/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET /admin/users | 27 | `users.read` |
| POST /admin/users | 28 | `users.manage` |
| PATCH /admin/users/:id | 46 | `users.manage` |
| GET /admin/roles | 103 | `users.read` |
| PATCH /admin/roles/:id/mfa | 116 | `admin.configure` |
| GET /admin/permissions | 131 | `admin.configure` |
| POST /admin/roles | 132 | `admin.configure` |
| PUT /admin/users/:id/roles | 136 | `admin.configure` |
| GET/PATCH /admin/settings | 151-152 | `admin.configure` |
| GET/POST /admin/devices, /admin/devices/:id/revoke | 166-167 | `users.manage` |
| GET /admin/password-reset-requests, POST .../resolve | 178,205 | `users.manage` |
| GET/PUT /admin/role-visibility[/:code] | 229,248 | `admin.configure` |
| GET/PUT /admin/module-visibility | 302,320 | `admin.configure` |

**Parity**: ⚠ **Mobile has zero admin surface** — user/role/module-visibility management is web-only. This is consistent with the round-2 mobile scope (admin wasn't built), not a bug, but record it: any P0/P1 admin action can only be tested on web.

---

### Org (holidays; locations is web-only by owner decision)

**Web** — `apps/web/app/org/holidays/page.tsx` (nav: `holiday.read`), `apps/web/app/org/locations/page.tsx` + `.../import/page.tsx` (nav: `org.units.read`).

| Element | File:Line | Gate |
|---|---|---|
| Holiday form: date/name/type/scope `<Input>`s, submit | org/holidays/page.tsx:66-94 | create form gated by `canManage = hasPermission(..., HOLIDAY_MANAGE)` (line 106) |
| "New holiday" `<Button>` | org/holidays/page.tsx:132 | `canManage` |
| Year filter `<Input>`, scope `<span title=...>` tooltip | org/holidays/page.tsx:121,159 | — |
| Page gate | org/holidays/page.tsx:178 | `RequirePermission code={PERMISSIONS.HOLIDAY_READ}` |
| Location create form (code/name, required) | org/locations/page.tsx:127-165 | `canManage = hasPermission(..., ORG_UNITS_MANAGE)` (line 177) |
| Tab switch, search `<Input>`, "New {tab}" `<Button>` | org/locations/page.tsx:216,225-226 | `canManage` for create |
| Deactivate `<Button disabled={deactivate.isPending}>` | org/locations/page.tsx:263-264 | `canManage` (inferred from context — same panel) |
| Page gate | org/locations/page.tsx:306 | `RequirePermission code={PERMISSIONS.ORG_UNITS_READ}` |
| CSV import: file input, textarea, "Load sample template", "Validate N rows" `disabled={!rows.length||rows.length>500}`, "Import N validated rows" | org/locations/import/page.tsx:15 | `RequirePermission code="org.units.manage"` |

**Mobile** — `apps/mobile/app/org-holidays.tsx` (74 lines; module code `org-holidays`, module-catalog gate `holiday.read`). **Read-only**: year prev/next `onPress` at lines 47,49 — no create/edit form at all. Locations: **N/A — web-only by owner decision** (`WEB_ONLY_CODES = ["org-locations"]`, `apps/mobile/src/modulesLauncher.ts:54`); never listed, not even as Coming soon.

**API** — `apps/api/src/modules/holidays/routes.ts`, `apps/api/src/modules/org/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET /holidays | holidays:94 | `holiday.read` |
| POST /holidays | holidays:217 | `holiday.manage` |
| PATCH /holidays/:id | holidays:323 | `holiday.manage` |
| GET /org/units, GET /org/units/:id | org:114,308 | `org.units.read` |
| POST /org/units | org:193 | `org.units.manage` |
| PATCH /org/units/:id | org:339 | `org.units.manage` |

**Parity**: ⚠ Holidays — web has full create/edit (`holiday.manage`), mobile is read-only by omission (no code path checks `holiday.manage` at all on mobile — not even a hidden button). If a holiday-manage-only field user needs to add a holiday, they must use web. Locations: correctly N/A per owner ruling — confirm `canSeeModule`/launcher never surfaces `org-locations` even when an admin explicitly enables it in module-visibility (the exclusion is a hardcoded array, not driven by the visibility table, so an admin toggling it "on" server-side would have no mobile effect — expected, but worth one negative test).

---

### Employees

**Web** — `apps/web/app/employees/page.tsx` (nav: `employee.read`), `.../[id]/page.tsx` → `DetailClient.tsx`, `.../new/page.tsx` (`EMPLOYEE_CREATE`), `.../import/page.tsx` (`EMPLOYEE_IMPORT`).

| Element | File:Line | Gate |
|---|---|---|
| Search `<Input id="emp-search">` | employees/page.tsx:94 | — |
| Row `<Button>`(s), "load more" | employees/page.tsx:130,228 | — |
| Empty/error states | employees/page.tsx:137,139 | — |
| Page gate | employees/page.tsx:245 | `RequirePermission code={PERMISSIONS.EMPLOYEE_READ}` |
| New-employee form gate | new/page.tsx:17 | `RequirePermission code={PERMISSIONS.EMPLOYEE_CREATE}` |
| Import: "Validate" `<Button disabled={!parsed.rows.length}>`, "Import" `<Button disabled={mutation.isPending||!report.validated}>` | import/page.tsx:84-90,129 | `RequirePermission code={PERMISSIONS.EMPLOYEE_IMPORT}` |
| Detail page gate | DetailClient.tsx:66 | `RequirePermission code={PERMISSIONS.EMPLOYEE_READ}` |
| "Edit" `<Button>` | DetailClient.tsx:81 | `canUpdate` (local var; confirm exact permission string when walking — likely `EMPLOYEE_CREATE`, see API note below) |
| "Exit" `<Button variant="danger">`, shown `{!exited && canExit}` | DetailClient.tsx:86 | `canExit` → `employee.exit` |
| "Reactivate" `<Button>`, shown `{exited && canReactivate}` | DetailClient.tsx:91 | `canReactivate` → `employee.reactivate` |

**Mobile** — `apps/mobile/app/employees.tsx` (155 lines; module `employees`, gate `employee.read`). Search `TextInput` (line 68), row-select `onPress` (line 85). **Read-only** — no create/exit/reactivate/import action found in the file.

**API** — `apps/api/src/modules/employees/routes.ts`. Permission vars: `canRead=EMPLOYEE_READ`, `canCreate=EMPLOYEE_CREATE`, `canExit=EMPLOYEE_EXIT`, `canReactivate=EMPLOYEE_REACTIVATE`, `canImport=EMPLOYEE_IMPORT` (lines 445-459).

| Method/Path | Line | Gate |
|---|---|---|
| GET /employees | 510 | `canRead` |
| POST /employees | 602 | `canCreate` |
| GET /employees/:id | 1052 | `canRead` |
| **PATCH /employees/:id** (edit) | 1102 | **`canCreate`** (`employee.create`, not a distinct `employee.update`) |
| POST /employees/bulk-import | 726 | `canImport` |
| GET /employees/me | 1014 | `authenticate` |
| POST /employees/:id/exit | 1304 | `canExit` |
| POST /employees/:id/activate | 1518 | `canReactivate` |
| POST /employees/:id/suspend | 1602 | `canExit` |
| POST /employees/:id/reactivate | 1685 | `canReactivate` |
| GET /employees/:id/documents | 1766 | `canReadDocs` (`requireAllPermissions`, line 472) |
| POST /employees/:id/documents | 1859 | `canUploadDocs` (line 476) |
| GET /employees/:id/documents/:documentId/download | 1755 | `canReadDocs` |
| GET/POST /designations | 1984,2013 | `canRead` / `canCreate` |
| PATCH /employees/bulk | 2096 | `canCreate` |
| GET /employees/:id/assignments | 2271 | `users.read` |
| PUT /employees/:id/assignments | 2355 | `users.manage` |

**Parity**: ⚠ **Mobile is read-directory-only** — no create, edit, exit, reactivate, import, or document upload on mobile at all; every mutation is web-only. Confirm this is intended scope for round-2, not an oversight — it's a bigger gap than the other Lane A modules (attendance/leave both have mobile write paths).

---

### Attendance

**Web** — `apps/web/app/attendance/page.tsx` (nav: `attendance.read`, `anyOf: attendance.punch`), `.../exceptions/page.tsx`, `.../records/[id]/page.tsx`.

| Element | File:Line | Gate |
|---|---|---|
| Name filter, date-range `<Input type="date">`×2 | attendance/page.tsx:89,93,97 | — |
| "Show map" toggle `<Button onClick>` | attendance/page.tsx:109-111 | — |
| Row action `<Button variant="secondary">` | attendance/page.tsx:117 | — |
| "load more" | attendance/page.tsx:225 | — |
| `required` field (punch form, exact field TBD by walker) | attendance/page.tsx:247 | — |
| Regularization request form (date/in/out `<Input>`s) | exceptions/page.tsx:95-101 | submit at 117 |
| `hasPermission(..., ATTENDANCE_DECIDE)` gates decision UI | exceptions/page.tsx:127 | `attendance.decide` |
| Exception lookup by date `<Input>`, "Lookup" `<Button>` | exceptions/page.tsx:175-177 | — |
| Manual-ID decide path: ID `<Input>`, version `<Input>`, submit `disabled={!manualId.trim()}` | exceptions/page.tsx:204-212 | `attendance.decide` |
| Decision rationale `<Input>`, approve/reject | exceptions/page.tsx:230-244 | `attendance.decide` |
| Page gate | exceptions/page.tsx:282 | `RequirePermission code={PERMISSIONS.ATTENDANCE_READ}` |

**Mobile** — `apps/mobile/app/(tabs)/attendance.tsx` (468 lines; `TAB_PERMISSIONS.attendance = [ATTENDANCE_PUNCH, ATTENDANCE_READ]`).

| Element | File:Line |
|---|---|
| "Locate me" `onPress` | 295 |
| Check-in `onPress` → `punch("CHECK_IN")` | 382 |
| Check-out `onPress` → `punch("CHECK_OUT")` | 391 |
| "File exception" reason `placeholder="Reason (required)"`, submit | 440,450 |
| Regularization reason `placeholder` | 368 |

`apps/mobile/app/attendance-exceptions.tsx` (243 lines, separate module screen, `attendance-exceptions` code, gate `attendance.read`):

| Element | File:Line |
|---|---|
| Manual lookup ID `TextInput` | 111 |
| Row select `onPress={... canDecide ...}` | 139 |
| Decision rationale `TextInput` | 221 |
| Approve/Reject `onPress` | 227,234 |

**API** — `apps/api/src/modules/attendance/routes.ts`. `canRead=S2_PERMISSIONS.ATTENDANCE_READ`, `canDecide=ATTENDANCE_DECIDE` (lines 717-718).

| Method/Path | Line | Gate |
|---|---|---|
| POST /attendance/events (punch) | 825 | `[authenticate, punchRateLimit]`; inline `enforceRecordScope(req,'attendance.punch')` at **line 851** |
| GET /attendance/me | 1262 | `authenticate` |
| GET /attendance/records | 1280 | `canRead` |
| GET /attendance/events/map | 1371 | `canRead` |
| GET /attendance/records/:id | 1446 | `canRead` |
| POST /attendance/exceptions | 1488 | `authenticate` (any signed-in user may file one) |
| PATCH /attendance/exceptions/:id/decision | 1561 | `canDecide` |
| POST /attendance/regularize | 1803 | `authenticate` |

**Parity**: 1:1 — both surfaces punch, file exceptions, and (with `attendance.decide`) approve/reject. No mismatch found. Note the punch route's real gate is inline (`attendance.punch` at line 851, not in `preHandler`) — test a user with `attendance.read` but not `attendance.punch` actually gets refused on POST /attendance/events.

---

### Leave

**Web** — `apps/web/app/leave/page.tsx` (nav: `leave.request`), `[id]/DetailClient.tsx`, `new/page.tsx`, `balances/page.tsx`.

| Element | File:Line | Gate |
|---|---|---|
| Name filter `<Input>` | leave/page.tsx:64 | — |
| View-tab switch `onClick` | leave/page.tsx:150 | tabs conditioned on `hasPermission(LEAVE_DECIDE)` (131) / `hasPermission(LEAVE_READ)` (132) |
| Page gate | leave/page.tsx:167 | `RequirePermission code={PERMISSIONS.LEAVE_REQUEST}` |
| New-request form gate | new/page.tsx:102 | `RequirePermission code={PERMISSIONS.LEAVE_REQUEST}` |
| Detail gate | [id]/DetailClient.tsx:104 | `RequirePermission code={PERMISSIONS.LEAVE_REQUEST}` |
| Balance upsert form (year/opening, `<Input>`s) | balances/page.tsx:133,136 | `hasPermission(..., LEAVE_ADMIN)` (154) |
| Employee search, year filter, "Load mine" | balances/page.tsx:204-216 | — |
| Page gate | balances/page.tsx:258 | `RequirePermission code={PERMISSIONS.LEAVE_REQUEST}` |

**Mobile** — `apps/mobile/app/(tabs)/leave.tsx` (291 lines; `TAB_PERMISSIONS.leave = [LEAVE_REQUEST, LEAVE_READ]`).

| Element | File:Line |
|---|---|
| Approver-only inbox gate | 50: `canAny(permissions, LEAVE_APPROVER_PERMISSIONS)` |
| Leave-type pick `onPress` | 182 |
| Start/end date `TextInput` (YYYY-MM-DD) | 191,199 |
| Reason `TextInput` | 208 |
| Submit request | 217 |
| Approve/Reject `onPress` | 268,276 |

No mobile equivalent of the balances admin screen (`leave.admin`) — expected, that's an HR-desk tool, not flagged as a gap.

**API** — `apps/api/src/modules/leave/routes.ts`. `canRequest=LEAVE_REQUEST`, `canAdmin=LEAVE_ADMIN` (303-304); `LEAVE_DECIDE` checked **inline**, not via preHandler var.

| Method/Path | Line | Gate |
|---|---|---|
| GET /leave/types | 381 | `authenticate` |
| GET /leave/balances | 400 | `authenticate` |
| POST /leave/balances | 466 | `canAdmin` |
| POST /leave/requests | 547 | `canRequest` |
| GET /leave/requests | 837 | `authenticate` (scoped inline) |
| GET /leave/requests/:id | 950 | `authenticate` |
| **POST /leave/requests/:id/decision** | 1056 | `authenticate` at preHandler; **inline `LEAVE_DECIDE` check at line 1078**, else `403 FORBIDDEN` |
| POST /leave/requests/:id/cancel | 1287 | `authenticate` |

**Parity**: 1:1 for request/approve/reject/cancel. No mismatch. Confirm the inline-decide pattern (1078) actually 403s for a plain `leave.request`-only holder hitting `/decision` directly — this is exactly the shape of bug the automation seed finding (B-001) caught in a different module.

---

### Payroll

**Web** — `apps/web/app/payroll/page.tsx` (nav: `payroll.read`), `[id]/DetailClient.tsx`, `new/page.tsx` (`PAYROLL_GENERATE`).

| Element | File:Line | Gate |
|---|---|---|
| Policy edit gate | payroll/page.tsx:39 | `hasPermission(..., PAYROLL_CONFIGURE)` |
| Policy form (divisor/PF% `<Input>`s) | payroll/page.tsx:160,163 | `PAYROLL_CONFIGURE` |
| "New run" trigger | payroll/page.tsx:180 | `hasPermission(..., PAYROLL_GENERATE)` |
| Page gate | payroll/page.tsx:264 | `RequirePermission code={PERMISSIONS.PAYROLL_READ}` |
| New-run form gate | new/page.tsx:135 | `RequirePermission code={PERMISSIONS.PAYROLL_GENERATE}` |
| Run-detail action buttons, gated per-action | [id]/DetailClient.tsx:74 | `hasPermission(perms, action.perm)` — data-driven, each action (calculate/submit-review/approve/lock/reopen) carries its own perm string |
| Approve remark `<Input required disabled={!allowed}>` | [id]/DetailClient.tsx:150-154 | — |
| Reopen reason `<Input required disabled={!allowed}>` | [id]/DetailClient.tsx:162-166 | — |
| Page gate | [id]/DetailClient.tsx:264 | `RequirePermission code={PERMISSIONS.PAYROLL_READ}` |
| Cost-ledger reverse/post `<Button disabled={...}>` | [id]/DetailClient.tsx:470-488 | `hasPermission(perms,'cost.read'/'cost.adjust')` (356-357) |

**Mobile** — `apps/mobile/app/payroll.tsx` (191 lines; module `payroll`, gate `payroll.read`). **Documented read-only by design** (file header comment, lines 2-6: "generating, approving and locking a run is a period-close action" — deliberately web-only). Row select `onPress` at line 86 is the only interaction; no calculate/submit/approve/lock/reopen action anywhere in the file.

**API** — `apps/api/src/modules/payroll/routes.ts`. Vars at 174-188: `canRead=PAYROLL_READ`, `canGenerate=PAYROLL_GENERATE`, `canApprove=PAYROLL_APPROVE`, `canLock=PAYROLL_LOCK`, `canConfigure=PAYROLL_CONFIGURE`, `canPayslipRead=PAYSLIP_READ`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/PATCH /payroll/policy | 214,233 | `canRead` / `canConfigure` |
| POST /payroll/runs | 289 | `canGenerate` |
| GET /payroll/runs[/:id] | 362,426 | `canRead` |
| POST /payroll/runs/:id/calculate | 456 | `canGenerate` |
| POST /payroll/runs/:id/submit-review | 847 | `canGenerate` |
| POST /payroll/runs/:id/approve | 878 | `canApprove` |
| POST /payroll/runs/:id/lock | 922 | `canLock` |
| POST /payroll/runs/:id/reopen | 955 | `canLock` |
| GET /payroll/runs/:id/payslips | 1006 | `canRead` |
| GET /payslips/me | 1102 | `canPayslipRead` |

**Parity**: ⚠ **By design** — web has the full run lifecycle (generate/calculate/submit/approve/lock/reopen); mobile is read-only (list + detail view only). Documented intentionally in code, not a bug, but record it as the widest deliberate read/write split in Lane A.

---

### My-payslip

**Web** — `apps/web/app/my-payslip/page.tsx` (nav: `payslip.read`).

| Element | File:Line | Gate |
|---|---|---|
| Period pick, "Load" `<Button disabled={!start||!end}>` | my-payslip/page.tsx:58 | — |
| Empty/error states | 66,73,78,82 | — |
| Page gate | 93 | `RequirePermission code={PERMISSIONS.PAYSLIP_READ}` |

**Mobile** — **N/A — genuine gap, not an owner-decided exclusion.** `my-payslip` is absent from `BUILT_MODULE_ROUTES` (`apps/mobile/src/modulesLauncher.ts:57-80`) and is not in `WEB_ONLY_CODES` either — it just wasn't built. It surfaces in the More-tab launcher as "Coming soon" for any role with `payslip.read` visibility on. Unlike org-locations, there is no owner ruling excluding it; this looks like an oversight given payroll.tsx explicitly calls out "My payslip already on the More tab" in its own header comment (payroll.tsx:3-4) — **the comment describes a screen that doesn't exist.**

**API** — GET /payslips/me, `payroll/routes.ts:1102`, gate `canPayslipRead`.

**Parity**: ⚠ Flag as a finding (see findings-a.md) — the payroll.tsx code comment asserts my-payslip exists on mobile; it does not.

---

### Audit

**Web** — `apps/web/app/audit/page.tsx` (nav: `audit.read`).

| Element | File:Line | Gate |
|---|---|---|
| Access gate | 41 | `hasPermission(perms, 'audit.read')` |
| Filters: action/entity/actor-id/record-id `<Input placeholder=...>` | 108,114,131 | — |
| "Reset" / "Search" `<Button>` | 148-154 | — |
| Pagination "back"/"next" `<Button disabled={...}>` | 241-246 | — |

**Mobile** — **N/A**: `audit` not in `BUILT_MODULE_ROUTES` → Coming soon in launcher.

**API** — `apps/api/src/modules/audit/routes.ts:53`, `canReadAudit = requirePermission(authenticate, "audit.read")`.

**Parity**: mobile has no audit surface at all. Consistent with the round-2 scope (audit is an admin/compliance tool); no code comment contradicts this one, so not a finding — just a documented gap.

---

### Inbox

**Web** — `apps/web/app/inbox/page.tsx` (nav: `notification.read`) → `apps/web/components/InboxList.tsx`.

| Element | File:Line |
|---|---|
| Row `<a href={href} onClick={onOpen}>` — **navigates to `/record?type=...&id=...`** | InboxList.tsx:65,124 |
| "Mark as read" `<Button onClick={e=>{stopPropagation();mark}}>` | InboxList.tsx:135,138 |
| "Mark all read" `<Button>` | InboxList.tsx:242 |
| Filter/reset `<Button>` | InboxList.tsx:245 |
| Pagination `<Button onClick={...cursorStack}>` | InboxList.tsx:275,278 |

**Mobile** — `apps/mobile/app/inbox.tsx` (155 lines, module `inbox`, gate `notification.read`).

| Element | File:Line |
|---|---|
| "Mark all read" | 88 |
| Unread-only toggle | 96 |
| Type filter chips | 103,109 |
| Row tap → `openRow(n)` | 145 |

`openRow` (lines 58-67) **only calls `patchNotificationRead`** — it does not navigate anywhere. There is no mobile equivalent of web's `/record` deep-link redirect page, and no per-type routing table mapping a notification's `entity_type`/`entity_id` to a mobile screen+id.

**API** — `apps/api/src/modules/s5/routes.ts`. `canReadNotif = NOTIF_READ` (line 303).

| Method/Path | Line |
|---|---|
| GET /notifications | 1343 |
| PATCH /notifications/:id/read | 1409 |
| POST /notifications/read-all | 1443 |

**Parity**: ⚠ **Confirmed known gap — "notification deep links on mobile."** Web's `InboxList.tsx:65` sends the user to `/record?type=<entity_type>&id=<id>` (`apps/web/app/record/page.tsx`, which dynamically renders the right detail view for employee/leave/payroll/project/task/board/attendance). Mobile's `openRow` (`apps/mobile/app/inbox.tsx:58`) marks-read only and does not push to any screen — tapping a notification does nothing visible beyond the read-state change. Seeded in findings-a.md.

---

## Lane B

### Dashboard

**Web** — `apps/web/app/dashboard/page.tsx` (nav: `dashboard.read`, `requires: [project.read, board.read]`).

| Element | File:Line | Gate |
|---|---|---|
| Access check | 40 | `hasPermission(actor, PROJECT_READ) && hasPermission(actor, BOARD_READ)` |
| Project picker `disabled={projects.length===0}` | 154 | — |
| Empty/error states (no projects/boards visible, board load failed) | 113,209,212,218,221,237 | — |
| Board render gate | 239 | `RequirePermission code={PERMISSIONS.BOARD_READ}` |

**Mobile** — `apps/mobile/app/(tabs)/index.tsx` (Home tab, 208 lines; no dedicated module code — stitched landing page per `rbac.ts:174-177`).

| Element | File:Line |
|---|---|
| "Sync now" `onPress` | 111 |
| "Go to attendance" `onPress` → `/(tabs)/attendance` | 152 |
| Task-card tap → `/(tabs)/tasks?taskId=...` | 181 |

**API**: dashboard has no dedicated route module; it composes `work` (projects) and `s5` (boards) endpoints already covered under Projects and Planning below, plus `s6`'s `GET /dashboards/role/:role` and `GET /dashboards/my-work` (`apps/api/src/modules/s6/routes.ts:538,640`, both gated `authenticate` only — no permission narrowing beyond session, since the data itself is scoped server-side).

**Parity**: not a true 1:1 — web's dashboard is a project-board viewer; mobile's Home is a personal daily-action landing page (punch shortcut, task shortcut, sync). Different purposes by design; not a gap.

---

### Projects

**Web** — `apps/web/app/projects/page.tsx` (nav: `project.read`), `[id]/page.tsx`→`DetailClient.tsx`, `[id]/board/page.tsx`→`BoardClient.tsx`, `[id]/tasks/[taskId]/page.tsx`→`DetailClient.tsx`, `new/page.tsx` (`PROJECT_CREATE`, quick-create), `edit/page.tsx`.

**Mobile** — `apps/mobile/app/projects.tsx` (module `projects`, gate `project.read`).

**API** — `apps/api/src/modules/work/routes.ts`, vars at 531-543: `canManageWs=WS_MANAGE`, `canReadWs=WS_READ`, `canCreateProject=P_CREATE`, `canReadProject=P_READ`, `canUpdateProject=P_UPDATE`, `canCloseProject=P_CLOSE`, `canCreateTask=T_CREATE`, `canReadTask=T_READ`, `canUpdateTask=T_UPDATE`, `canTransitionTask=T_TRANSITION`, `canReorderTask=T_REORDER`, `canAssignTask=T_ASSIGN`, `canCommentTask=T_COMMENT`.

| Method/Path (representative) | Gate |
|---|---|
| GET/POST /projects, GET/PATCH /projects/:id, POST /projects/:id/close | `canReadProject`/`canCreateProject`/`canUpdateProject`/`canCloseProject` |
| GET/POST /tasks, PATCH /tasks/:id, POST /tasks/:id/transition, /reorder, /assign, /comment | `canReadTask`/`canCreateTask`/`canUpdateTask`/`canTransitionTask`/`canReorderTask`/`canAssignTask`/`canCommentTask` |
| GET /tasks/:id/evidence/:evidenceId/download | `canReadTask` (`work/routes.ts:2825`) |

*(Task-level walk deferred to lane implementer — `work/routes.ts` is large; module has ~28 routes per the master extraction. Use `canReadTask`/`canUpdateTask`/etc. as the reference gate set; every route uses exactly one of the thirteen vars above.)*

**Mobile detail**: create/quick-add in `apps/mobile/app/(tabs)/tasks.tsx` (see My-work below) — task CRUD is available on mobile via the Tasks tab, but full **project** create/edit (workspace-level settings, close) has no mobile screen — `projects.tsx` lists/opens projects, task management happens from the Tasks tab, not from within `projects.tsx` itself. Confirm during the walk whether `projects.tsz` exposes "New project" (nav quick-create only exists on web, `apps/web/lib/nav.ts:163`).

**Parity**: ⚠ project-level create/edit/close (`PROJECT_CREATE`/`PROJECT_UPDATE`/`PROJECT_CLOSE`) — verify whether mobile's `projects.tsx` has any write action; from the file list it appears read/navigate-only, same pattern as employees/clients/tenders (see below).

---

### Planning

**Web** — `apps/web/app/planning/page.tsx` (nav: `cycle.read`, `requires: [project.read]`).

| Element | File:Line | Gate |
|---|---|---|
| View switch | 30 | — |
| Bulk task move, `disabled={!selected.length}` | 33 | `Can permission="task.update"` |
| "New cycle" | 35 | `Can permission="cycle.manage"` |
| SLA/deadline thresholds | 36 | `Can permission="project.update"` |
| Workflow editor | 37 | `Can permission="board.manage"` |
| Custom field "Define field" | 38 | `Can permission="custom_field.manage"` |
| Project chooser, checklist add | 40,43 | — |

**Mobile** — `apps/mobile/app/planning.tsx` (175 lines, module `planning`, gate `cycle.read`, `requires: project.read`). **Read-only**: project picker (91,102) + `CycleGroups`/`CycleRow` render (lines 114-166) with no create/edit/move action anywhere in the file — confirmed no `cycle.manage`, `task.update`, `board.manage`, or `custom_field.manage` reference in the screen at all.

**API** — `apps/api/src/modules/planning/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/PUT /projects/:id/workflow | 30,35 | `project.read` / `board.manage` |
| POST /project-types | 62 | `project.create` |
| GET/PUT /projects/:id/sla-policy | 81,82 | `project.read` / `project.update` |
| GET /projects/:id/people, /dependencies | 83,97 | `task.read` |
| GET/POST /cycles | 105,109 | `cycle.read` / `cycle.manage` |
| POST /cycles/:id/start, /close | 117,121 | `cycle.manage` |
| GET/POST /custom-fields, PATCH /custom-fields/:id | 137,138,142 | `task.read` / `custom_field.manage` |
| GET/PATCH /tasks/:id/planning | 146,147 | `task.read` / `task.update` |
| GET /projects/:id/activity, /tasks/:id/activity | 160,167 | `project.read` / `task.read` |
| POST /tasks/bulk | 169 | `task.update` |

**Parity**: ⚠ **mobile Planning is entirely read-only** — no cycle create/start/close, no SLA config, no workflow editor, no custom fields, no bulk task move. Every write path on the web page (5 distinct permission-gated actions) has zero mobile counterpart. Larger gap than the brief's seed list called out; worth a findings-b.md row.

---

### My-work

**Web** — `apps/web/app/my-work/page.tsx` (nav: `task.read`, no explicit permission besides session — auth-only per nav.ts comment at line 74-76).

| Element | File:Line |
|---|---|
| "Load more" | 103,106 |
| Pending-approvals empty/error | 151,157 |
| Unread-count error | 214 |
| Page gate | 246: `RequirePermission code={PERMISSIONS.TASK_READ}` |
| "Overdue mine" / "Assigned to me" filters | 290,298 |

**Mobile** — `apps/mobile/app/(tabs)/tasks.tsx` (435 lines; `TAB_PERMISSIONS.tasks=[TASK_READ]`, module code `my-work`).

| Element | File:Line |
|---|---|
| Quick-add toggle, project pick, title `TextInput`, submit | 120,148,156,166 |
| Search `TextInput` | 173 |
| "Only mine" / "All" filter | 178,184 |
| Task select | 213 |
| Transition `advance(n)` | 353 |
| Evidence capture start | 380 |
| Comment `TextInput` + send | 410,421 |

**API**: `work/routes.ts` `T_*` vars (see Projects above) — `canCreateTask`, `canUpdateTask`, `canTransitionTask`, `canAssignTask`, `canCommentTask`.

**Parity**: mobile Tasks tab is actually **richer** than web's My-work page for day-to-day task action (quick-add, transition, evidence capture, comment all present) — no gap found; likely 1:1 or better on mobile for this one.

---

### Automation

**Web** — `apps/web/app/automation/page.tsx` (nav: `automation.read`).

| Element | File:Line | Gate |
|---|---|---|
| Rules list | 15 | (page-level `automation.read`) |
| "Create a rule" | 15 | `Can permission="automation.manage"` |
| Execution history | 15 | — |
| "Register endpoint" (webhook), fields required×3 | 15 | `Can permission="webhook.manage"` |
| Provider connections | 15 | `Can permission="admin.configure"` |
| My notification preferences | 15 | — |

**Mobile** — `apps/mobile/app/automation.tsx` (219 lines, module `automation`, gate `automation.read`). Project picker (102), rule-select `onPress` (130). No "create rule" or webhook-registration action found — appears **read-only** (rule list + execution history view).

**API** — `apps/api/src/modules/automation/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET /automation-rules | 13 | `automation.read` |
| POST /automation-rules | 17 | `automation.manage` |
| **GET /automation-rules/:id** | 24 | **`automation.manage`** |
| PATCH /automation-rules/:id | 29 | `automation.manage` |
| POST /automation-rules/:id/dispatch | 39 | `automation.manage` |
| GET /automation-rules/:id/executions | 57 | `automation.read` |
| GET/POST /webhooks | 61,62 | `webhook.manage` |
| PATCH /webhooks/:id | 66 | `webhook.manage` |
| GET /webhooks/:id/deliveries | 67 | `webhook.manage` |

**Parity**: ⚠ **Seeded finding B-001** (see findings-b.md) — `GET /automation-rules/:id` requires `automation.manage` while the list (`GET /automation-rules`) and executions (`GET .../executions`) only require `automation.read`; a rule-list viewer with `automation.read` alone gets a 200 from the list but a 403 opening any one rule's detail. Confirm whether mobile's rule-detail view (line 130 `onPress={() => setSelected(r)}`) surfaces this 403 gracefully for a read-only role, or fails silently.

---

### Analytics

**Web** — `apps/web/app/analytics/page.tsx` (nav: `analytics.read`, `requires: [project.read]`).

Thin composition page (10 lines): "Flow by status", "30-day work completion", "Team workload", "Cycle velocity", "Delivery advisory" panels, one `required` field (project picker).

**Mobile** — `apps/mobile/app/analytics.tsx` (227 lines, module `analytics`, `requires: project.read`). Project picker `onPress` at line 101; otherwise chart/read display, no write actions on either surface (analytics is inherently read-only).

**API** — `apps/api/src/modules/analytics/routes.ts`. `read = requirePermission(auth,'analytics.read')` (line 10).

| Method/Path | Line | Gate |
|---|---|---|
| GET /analytics/projects/:id | 11 | `read` |
| GET /insights/projects/:id[, /workforce, /reviews] | 22,28,37 | `read` |
| POST /insights/reviews/:id/decision | 42 | `project.update` (escalated from plain `read`) |
| POST /insights/feedback | 47 | `read` |
| GET /search | 51 | `authenticate` only |

**Parity**: 1:1 (read-only both sides). Note `GET /search` at line 51 has no permission gate beyond session — confirm what it can return across modules; a broad cross-entity search with only `authenticate` is worth a probe for over-exposure.

---

### Reports

**Web** — `apps/web/app/reports/page.tsx` (nav: `report.generate`). "Your reports", "Recurring reports", "Schedule a report" (2 required fields).

**Mobile** — `apps/mobile/app/reports.tsx` (185 lines, module `reports`, gate `report.generate`). Report-type select (126), "Generate" `onPress` (135), download `onPress={canDownload ? ... : undefined}` (167).

**API** — `apps/api/src/modules/jobs/routes.ts` (`guard = requirePermission(auth,'report.generate')`, line 11) and `apps/api/src/modules/s6/routes.ts` (report execution).

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST /report-schedules, PATCH /report-schedules/:id | jobs:12,13,18 | `report.generate` |
| GET /reports | jobs:22 | `report.generate` |
| **POST /reports** (generate) | s6:737 | `preHandler: authenticate`; **inline** `report.generate` + per-type data permission at s6:758 |
| **GET /reports/:id/download** | s6:853 | `authenticate`; inline check at s6:882 |

**Parity**: 1:1 on the surface (both generate + download). Same "inline, not preHandler" pattern flagged at the top of this document — test a session with `report.generate` but missing the underlying data permission (e.g. a payroll report without `payroll.read`) actually gets the documented 403 message ("needs both...") on **both** web and mobile, not just one.

---

### Leads / Clients / Tenders

**Web** — `apps/web/app/leads/page.tsx` (nav: `lead.read`) + `new/page.tsx`, `edit/page.tsx`; `apps/web/app/clients/page.tsx` (nav: `client.read`); `apps/web/app/tenders/page.tsx` (nav: `tender.read`) + `new/page.tsx`, `convert/page.tsx`.

| Element | File:Line | Gate |
|---|---|---|
| Lead card open/close, stage-move reason `<Input placeholder="Reason (required to mark lost or disqualified)">`, move `<Button disabled={needsReason(stage)}>` | leads/page.tsx:157,212,247,259-260 | `lead.manage` (via quick-create `permission='lead.manage'`) |
| New/Edit lead forms | leads/new,edit/page.tsx | quick-create gate `lead.manage`, `requires:['client.read']` |
| Client create form, required×3 | clients/page.tsx:20-25,40-43 | `Can permission="client.manage"` |
| Tender stage-move `<Button disabled={gated(status)}>`, override reason `placeholder="Override reason"` | tenders/page.tsx:255,269-296 | `hasPermission(...,'tender.override')`(145) / `'tender.convert'`(146) |
| "Create the project" | tenders/page.tsx:307 | — |
| New tender form, required×2 | tenders/new/page.tsx:18-19 | quick-create gate `tender.manage`, `requires:['client.read','lead.read']` |
| Convert-to-project form | tenders/convert/page.tsx:144-151 | `hasPermission(PROJECT_CREATE)` + `hasPermission('client.manage')`; page gate `RequirePermission code="tender.convert"` (164) |

**Mobile** — `apps/mobile/app/pipeline.tsx` (295 lines, module `pipeline`), `clients.tsx` (202 lines, module `clients`), `tenders.tsx` (224 lines, module `tenders`).

| Screen | Elements (file:line) | Notes |
|---|---|---|
| pipeline.tsx | search 85; stage filter chips 95,102; row select 124; stage-confirm reason `placeholder="Why?"` 245, confirm 254 | Has stage-move (≈ `lead.manage`), **no "new lead" create form** |
| clients.tsx | search 79; row select 92 | **Read-only — no create form** |
| tenders.tsx | search 79; status filter 89,96; row select 118 | **Read-only — no create/convert/override** |

**API** — `apps/api/src/modules/crm/routes.ts` (clients/leads/contacts/opportunities), `apps/api/src/modules/tender/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST/PATCH /clients | crm:56,76,116 | `client.read` / `client.manage` |
| GET/POST/PATCH /leads, POST /leads/:id/stage | crm:237,286,312,334 | `lead.read` / `lead.manage` |
| GET/POST /tenders, PATCH /tenders/:id, POST /tenders/:id/status | tender:45,90,126,155 | `tender.read` / `tender.manage` |
| POST /tenders/:id/corrigenda, /eligibility, /competitors | tender:216,257,290 | `tender.manage` |
| POST /tenders/:id/convert, /proposals/:id/convert | tender:486,493 | `tender.convert` |

**Parity**: ⚠ **Mobile has no create/edit for leads, clients, or tenders** — pipeline stage-transitions exist on mobile (matching `lead.manage`), but "New lead", "Add a client", "New tender", tender override/convert are web-only. Clients and tenders are entirely read-only on mobile (no write permission referenced anywhere in either file).

---

### Billing / Receivables / Payables / Expenses / Ledgers

**Web** — `apps/web/app/billing/page.tsx` (nav: `rabill.read`, `requires:[project.read]`, 1043 lines), `receivables/page.tsx` (`ar.read`), `payables/page.tsx` (`ap.read`), `expenses/page.tsx` (`expense.read`) + `policies/page.tsx`, `reports/page.tsx`.

| Element | File:Line | Gate |
|---|---|---|
| Bill stage-move `<Button disabled={s}>` | billing/page.tsx:346-354 | `hasPermission('rabill.manage')`/`'rabill.certify'` (228-229) |
| Retention release: amount/reason `<Input placeholder>`, "Release" `<Button disabled={!Number(amount)}>` | billing/page.tsx:485-500 | `hasPermission('retention.release')` (434) |
| BOQ measured-items management | billing/page.tsx:727 | `hasPermission('boq.manage')` |
| Receivables: client-row expand `onClick`, action `<Button>` | receivables/page.tsx:219,295 | `hasPermission('ar.read')` (39) — read-only ledger, no write action found |
| Payables: hold/unhold `<Button disabled={pending}>`, reason `placeholder="Why is it being held?"` | payables/page.tsx:331-367 | `hasPermission('payable.hold')` (42) |
| Payment-run build `<Button variant="primary">` | payables/page.tsx:411 | `hasPermission('paymentrun.manage')` (386) |
| Payment-run approve `<Button disabled={decide.isPending}>` | payables/page.tsx:460-472 | `hasPermission('paymentrun.approve')` (387) |
| **No "execute"/"release" action anywhere in the file** — line 497 states in copy: *"Releasing needs `paymentrun.approve`, and in any case the person who built a run..."* but no button follows it | payables/page.tsx:497 | — |
| Expense claim create "New expense claim" | expenses/page.tsx:89 | `hasPermission('expense.manage')` (36) |
| Reimbursement amount/UTR `<Input placeholder>`, "Reimburse" `<Button disabled={!Number(payment.amount)}>` | expenses/page.tsx:436-456 | `hasPermission('expense.reimburse')` (224) |
| Approve/Reject with reason `required`, Withdraw `disabled={!reason.trim()}` | expenses/page.tsx:492-514 | — |
| **No receipt-upload input (`type="file"`) anywhere in the file** — only prose at line 814: *"A draft is saved first so receipts can be attached..."* | expenses/page.tsx:814 | — |
| Expense policy "New policy" form, `required`×1, cap fields | expenses/policies/page.tsx:94,146 | `hasPermission('expense.policy.manage')` (34) |

**Mobile** — `apps/mobile/app/project-finance.tsx` (billing), `receivables.tsx`, `payables.tsx`, `expenses.tsx`. *(Not individually grepped in this pass — flagged for the lane walker: confirm each is read-only against the same gates above, especially payment-run and expense-reimburse, since none appeared in the mobile file inventory with obvious write forms.)*

**API** — `apps/api/src/modules/billing/routes.ts`, `apps/api/src/modules/ledgers/routes.ts`, `apps/api/src/modules/expenses/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST /projects/:id/boq | billing:70,80 | `boq.read`/`boq.manage` |
| POST /advances | billing:134 | `rabill.manage` |
| GET/POST /ra-bills, /:id, /:id/status, /:id/dispute | billing:151-435 | `rabill.read`/`rabill.manage` |
| GET/POST /projects/:id/retention[/release] | billing:456,474 | `retention.read`/`retention.release` |
| GET /ar/ageing, /ar/statement/:clientId | ledgers:76,174 | `ar.read` |
| GET /ap/ageing | ledgers:315 | `ap.read` |
| POST /ap/invoices/:id/hold | ledgers:376 | `payable.hold` |
| GET/POST /payment-runs | ledgers:394,429 | `paymentrun.read`/`paymentrun.manage` |
| POST /payment-runs/:id/decision | ledgers:534 | `paymentrun.approve` |
| **(no execute/disburse endpoint exists at all)** | — | — |
| GET/POST /expense-claims, PUT .../lines, POST .../submit,/withdraw,/decision,/reimburse | expenses:326-714 | `expense.read`/`expense.manage`/`approval.act`/`expense.reimburse` |
| GET /expense-reports | expenses:761 | `expense.read_all` |
| **(no receipt-file endpoint — expense-claims has no multipart/attachment route in this file)** | — | — |

Also confirmed: **no "New advance" or "New RA-bill" creation control anywhere in `billing/page.tsx`** (`grep -n "New advance\|New RA bill\|New bill\|MutationForm"` → zero hits besides an unrelated `<Stat>` label) — `POST /advances` and `POST /ra-bills` exist server-side (billing:134,188) but have no web (or mobile) form; the page only offers stage-move/dispute/retention-release on bills that already exist.

**Parity**: ⚠⚠ **Four seeded gaps confirmed end-to-end (API + web), not just missing UI**: (1) **payment-run execute** — the API has `paymentrun.manage` (build) and `paymentrun.approve` (decide) but no disbursement/execute route; a run can be approved and then has no path to "paid". (2) **expense receipt upload** — no attachment/file route on `expense-claims`, matching the web page's file-less form and its own copy admitting the gap. (3) **vendor-invoice lines / MSME** — confirmed **zero hits** anywhere in the repo for `vendor.invoice`, `vendor_invoice`, `VendorInvoice`, or `msme` (case-sensitive greps across `apps/api/src/modules` and `apps/web/app`) — the three-way-match feature genuinely has no vendor-invoice-lines/MSME data model at all, not just a missing screen. (4) **advance / RA-bill creation** — `POST /advances` and `POST /ra-bills` exist server-side with no web or mobile form to call them; only status-move/dispute/retention-release on existing bills is reachable from a client.

---

### Procurement

**Web** — `apps/web/app/procurement/page.tsx` (nav: `requisition.read`, 755 lines).

| Element | File:Line | Gate |
|---|---|---|
| Tab switch (requisitions/PO/GRN/RFQ) | 90 | — |
| Row select `<Button onClick>` | 219,222 | — |
| Submit `<Button loading={submit.isPending}>` | 356 | — |
| PO status-move `<Button loading={move.isPending}>` | 547,554 | `hasPermission('po.manage')` (374) |
| RFQ award: justification `placeholder`, "Award" `<Button disabled={!awardTo}>` | 714-735 | `hasPermission('rfq.manage')` (583) |
| **No "New requisition"/"New PO"/"New RFQ"/"New GRN" creation control anywhere in the file** (`grep -n "MutationForm\|New requisition\|New order\|New RFQ\|Create"` → zero hits) | — | — |

**Mobile** — `apps/mobile/app/procurement.tsx` (486 lines, module `procurement`, gate `requisition.read`).

| Element | File:Line | Gate |
|---|---|---|
| `canReadReq = canDo("requisition.read")`, `canManageReq = canDo("requisition.manage")` | 57-58 | — |
| "Raise" `<Button>` toggles a **requisition creation form** (`showForm`/`submitNewRequisition`) | 172-180, 255 | shown only `tab==="requisitions" && canManageReq` |
| Tab switch (requisitions/orders) | 194,200 | — |
| Requisition/PO row select | 273,302 | — |
| PO submit action | 430 | — |

**API** — `apps/api/src/modules/procurement/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST /requisitions, POST /:id/submit | 49,64,77,105 | `requisition.read`/`requisition.manage` |
| GET/POST /purchase-orders, /:id/submit, /:id/status, /:id/amend, /:id/acknowledge | 126-816 | `po.read`/`po.manage`/`po.amend` |
| POST /grns, GET /purchase-orders/:id/grns | 316,394 | `grn.manage`/`grn.read` |
| POST/GET /invoices/:id/match | 418,486 | `invoice.manage`/`match.read` |
| GET/POST /rfqs, /:id/quotes, /:id/comparison, /:id/award | 496-667 | `rfq.read`/`rfq.manage` |
| POST/GET /vendor-returns | 848,920 | `return.manage`/`return.read` |

**Parity**: ⚠⚠ **Inverted from the assumed gap** — the open-decisions note (2026-09-22) says creation screens for requisition/PO/RFQ/GRN are missing, and that's still true **on web** (zero creation UI in `procurement/page.tsx`), but **mobile already has requisition creation** (`apps/mobile/app/procurement.tsx:172-255`, gated correctly on `requisition.manage`, matching `POST /requisitions`'s `requisition.manage` gate). PO/RFQ/GRN creation remains missing on both surfaces. Update the open-decisions assumption; seed this precisely in findings-b.md rather than the blanket "missing on both" framing.

---

### Inventory / Stock

**Web** — `apps/web/app/inventory/page.tsx` (nav: `inventory.read`, 6 lines — thin composition wrapper).

| Element | File:Line | Gate |
|---|---|---|
| "New item", "Post stock movement", "Add vendor", "Record invoice", "Send invoices to accounting" — each a `MutationForm` | inventory/page.tsx:6 | `Can permission="inventory.manage"` |

**No web page exists for the `stock` module at all** (`stock-locations`, `stock-counts`, `stock-reservations`, `stock/reorder` — zero references anywhere under `apps/web/app` or `apps/web/components`).

**Mobile** — `apps/mobile/app/inventory.tsx` (240 lines, module `inventory`, gate `inventory.read`). Row select (90), direction toggle IN/OUT (194,200), "Post" (211) — has a stock-movement post action. **No mobile equivalent of the `stock` module either.**

**API** — `apps/api/src/modules/inventory/routes.ts` (assets live here too, see next section) and `apps/api/src/modules/stock/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST /inventory/transactions | inventory:123,128 | `inventory.read`/`inventory.manage` |
| GET/POST /invoices | inventory:149,150 | `invoice.read`/`inventory.manage` |
| GET/POST /stock-locations, PATCH /:id | stock:70,86,105 | `location.read`/`location.manage` |
| PATCH /inventory/items/:id/master | stock:137 | `inventory.manage` |
| GET /stock-locations/:id/stock | stock:170 | `stock.read` |
| GET/**POST** /stock-transactions | stock:208,240 | preHandler `stock.read`; **inline** `stock.issue`/`stock.adjust`/`stock.transfer` by `transaction_type` (line 243) |
| GET/POST /stock-reservations, /:id/release | stock:308,326,349 | `reservation.read`/`reservation.manage` |
| GET/POST /stock-counts, /:id/approval | stock:368,384,399,439 | `stockcount.read`/`stockcount.manage`/`stockcount.approve` |
| GET /stock/reorder | stock:513 | `stock.read` |

**Parity**: ⚠ **Confirmed known gap, and broader than "creation screens"** — the entire `stock` module (multi-location stock, transfers, reservations, physical counts, reorder points) has **no UI on either web or mobile**; it is API-only. `inventory.page.tsx` covers the older single-location inventory/vendor-invoice flow, which does have full web CRUD, but nothing in `stock-locations`/`stock-counts`/`stock-reservations` is reachable from either client.

---

### Assets / Asset movements

**Web** — `apps/web/app/assets/page.tsx` (nav: `asset.read`, 578 lines), `assets/movements/page.tsx` (`asset.read`).

| Element | File:Line | Gate |
|---|---|---|
| "Register an asset" `MutationForm` | 81-83 | `Can permission="asset.manage"` |
| Assign/transfer/return `MutationForm`s | 122,158,188,217 | `asset.manage` (panel-scoped) |
| "Issue a kit" basket, remove `<Button onClick>` | 242,477,480 | `asset.manage` |
| "New physical audit" | 287-288 | `asset.manage` |
| Issue-kit submit `<Button loading={issue.isPending}>` | 541-542 | — |
| Movements pagination | movements/page.tsx:221-224 | page gate `hasPermission('asset.read')` (40); `asset.manage` referenced (43) but no write action on this page — it's a read log |

**Mobile** — `apps/mobile/app/(tabs)/assets.tsx` (443 lines; `TAB_PERMISSIONS.assets=[ASSET_READ]`, module `assets`). Notably **richer than web** for field use:

| Element | File:Line |
|---|---|
| `can(code)` helper | 114 |
| Search, QR "Scan" `onPress` | 199,207 |
| Audit-mode toggle | 215 |
| Audit note/status `TextInput` | 236,239 |
| Transfer flow: reason, employee search, confirm `onPress` | 257,274,314,336,346,358,367,391 |
| `can(data)` (post-scan permission check) | 417 |
| Scanner close | 432 |

`apps/mobile/app/asset-movements.tsx` (181 lines, module `asset-movements`, gate `asset.read`): row select (81), pagination (91,98) — read-only log, matching web.

**API** — `apps/api/src/modules/inventory/routes.ts` (assets share this file with inventory).

| Method/Path | Line | Gate |
|---|---|---|
| GET /assets/resolve, /:id | 203,209 | `asset.read` |
| POST /assets/:id/assign, /transfer | 253,285 | `asset.manage` |
| PATCH /asset-allocations/:id | 325 | `asset.manage` |
| GET /assets/movements | 359 | `asset.read` |
| POST /assets/assign-bulk | 425 | `asset.manage` |
| POST /assets/:id/transition | 455 | `asset.manage` |
| GET/POST /asset-audits | 486,487 | `asset.read`/`asset.manage` |
| GET /assets/eligible-employees | 21 | `asset.manage` |

**Parity**: 1:1, arguably mobile-favoured (QR scan + on-the-spot transfer is mobile-only convenience, backed by the same `asset.manage` gate as web). No mismatch found.

---

### Documents

**Web** — `apps/web/app/documents/page.tsx` (nav: `document.read`, 568 lines).

| Element | File:Line | Gate |
|---|---|---|
| Tab switch (renewals/register) | 89-94 | `hasPermission('document.read')`(39) |
| "New document" (create trigger) | 115 | `hasPermission('document.manage')`(40) |
| Renew: `<Button loading={renew.isPending}>` | 318 | `document.manage` |
| Create: `<Button loading={create.isPending}>` | 562 | `document.manage` |

**Mobile** — `apps/mobile/app/documents.tsx` (225 lines, module `documents`, gate `document.read`). Tab switch (87,93), row select (134). **No create/renew action found** — appears read-only.

**API** — `apps/api/src/modules/documents/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET /document-types, /documents, /documents/renewals, /:id | 133-224 | `document.read` |
| POST /documents | 246 | `document.manage` |
| PATCH /documents/:id, POST /:id/renew | 285,342 | `document.manage` |
| POST /documents/:id/legal-hold | 410 | conditional: `isRelease(body) ? releaseGuard : holdGuard` — resolve both permission strings when walking (likely `document.legalhold`/`document.legalhold.release` per open-decisions "AUDITOR holding document.legalhold(.release)") |
| DELETE /documents/:id | 436 | `document.delete` |

**Parity**: ⚠ mobile Documents is read-only (register + renewals browsing, no create/renew/hold/delete) — web has the full lifecycle. Not previously seeded in open-decisions; add to findings-b.md as a newly-found gap.

---

### Approvals

**Web** — `apps/web/app/approvals/page.tsx` (nav: `approval.read`), `delegations/page.tsx`.

| Element | File:Line | Gate |
|---|---|---|
| Tab switch | 121 | — |
| Decide: Approve `<Button loading={decide.isPending}>`, Reject `onClick={()=>decide.mutate('REJECT')}` | 385,388-392 | `hasPermission('approval.act')` (40,225) |
| "Recall" `<Button>` | 399 | — |
| Delegation create, `disabled={!ready}` | delegations/page.tsx:183 | `hasPermission('approval.delegate')` (37) |
| Revoke `<Button onClick={()=>revoke.mutate(...)}>` | delegations/page.tsx:249 | `approval.delegate` |

**Mobile** — `apps/mobile/app/approvals.tsx` (338 lines, module `approvals`, gate `approval.read`). Tab switch (155,162), row select (188), reject-reason `placeholder="Why? (required to reject)"` (301), approve/reject/recall `onPress` (307,314,329). **No delegation screen** (matches module catalog — delegations has no separate `code` entry; it's a web-only sub-route of the same `approvals` module).

**API** — `apps/api/src/modules/approvals/routes.ts`.

| Method/Path | Line | Gate |
|---|---|---|
| GET/POST /approval-policies | 120,133 | `approval.read`/`approval.configure` |
| POST/GET /approvals, /:id | 175,232,255 | `approval.read` |
| GET /approvals/inbox | 282 | `approval.act` |
| POST /approvals/:id/decision | 313 | `approval.act` |
| POST /approvals/:id/recall | 391 | `approval.read` (identity-scoped inline, presumably to the requester — confirm during the walk that a *different* user with only `approval.read` cannot recall someone else's request) |
| POST /approvals/:id/revalidate | 422 | `approval.read` |
| POST/GET /approval-delegations, POST /:id/revoke | 486,513,529 | `approval.delegate`/`approval.read` |

**Parity**: ⚠ Delegations are web-only (no mobile screen), matching the open-decisions "approvals: should delegation cover role-based rungs" open policy question — this is a feature-scope gap, not obviously a bug, but confirm `approval.delegate` holders on mobile have no path to delegate at all (they'd need to switch to web).

---

### Survey

**Web** — `apps/web/app/survey/page.tsx` (nav: `survey.read`, **3874 lines** — largest page in the app), `entry/page.tsx` (**980 lines**, quick-create `survey.enter`), `setup/page.tsx` (**924 lines**, `survey.manage`).

| Element | File:Line | Gate |
|---|---|---|
| Dashboard tab | 98 | `hasPermission('survey.dashboard')` |
| Entry link | 105 | `hasPermission('survey.enter')` |
| Manage tab | 106 | `hasPermission('survey.manage')` |
| Forecast tab | 109 | `hasPermission('survey.forecast')` |
| Certify (finals) | 112 | `hasPermission('survey.certify')` |
| Village search, tab switches | 289-306 | — |
| Query answer | 376 | `hasPermission('survey.answer')` |
| Entry: stage buttons, save | entry/page.tsx:547,737 | `survey.enter` |
| Amend (admin override) | entry/page.tsx:874,973 | `hasPermission('survey.manage')` |
| Setup: create programme, add village/mandal, run (dry-run/import) `<Button loading={run.isPending}>` | setup/page.tsx:174-395,555-564 | `survey.manage` |

**Mobile** — `apps/mobile/app/(tabs)/survey.tsx` (176 lines; `TAB_PERMISSIONS.survey=[SURVEY_READ]`). "Record return" `onPress={mayEnter?...}` (124), "Record point" (142), close sheet (159) — entry-only (matches nav.ts's comment that `survey.enter` gates *forms*, `survey.read` gates the tab). **No dashboard, forecast, certify, or setup on mobile** — by design per mobile `rbac.ts`'s own comment (lines 65-66: "the master list and the targets completion is measured against are `survey.manage` and `survey.target`, neither of which the app asks for").

**API** — `apps/api/src/modules/survey/routes.ts` (6442 lines, ~75 routes — largest module in the API). Representative gates: `survey.read` (list/lookup), `survey.manage` (programme/village/crew/rover CRUD), `survey.enter` (`POST /survey/villages/:id/stage`, line 1221), `survey.target` (line 1184), `survey.certify` (finals, lines 3435,3483), `survey.forecast` (line 4480), `survey.dashboard` (lines 4881,4894,5605), `survey.answer` (line 5828).

**Parity**: intentional split, documented in both web nav copy and mobile's own code comment. Not a gap — but this module is large enough (75 API routes vs ~10 mobile interactive elements) that a full route-by-route walk should be scoped explicitly to the mobile-reachable subset (`survey.enter`/`survey.read`/`survey.answer`) rather than attempted exhaustively; flag anything beyond that subset as "web-only by design, low priority for mobile parity testing."

---

### Record (deep-link redirect page)

**Web only** — `apps/web/app/record/page.tsx` (16 lines). Reads `?type=&id=` from the URL and dynamically renders one of: `EmployeeDetailView`, `LeaveDetailView`, `RunDetailView` (payroll), `ProjectDetailView`, `TaskDetailView`, `BoardView`, `RecordDetailView` (attendance). Validates `id` against `/^[0-9a-f-]{36}$/i` (line 12) before dispatch; unknown `type` renders "Unknown record type."

No permission gate of its own — falls through to each embedded detail view's own `RequirePermission`.

**Mobile** — no equivalent route exists (confirmed: `find apps/mobile/app -iname "*record*"` → no matches). This is the mechanism the inbox-deep-link gap (Lane A) depends on — see Inbox section above.

**API**: none (client-side routing only).

**Parity**: N/A as a route (mobile has per-screen navigation instead of one generic redirect), but its *absence* is precisely why mobile notification taps can't deep-link — there is no single mobile screen (or router table) that "type+id → open".
