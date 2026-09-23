# Findings ledger — Lane A (auth/mfa/security, admin, org, employees, attendance, leave, payroll, my-payslip, audit, inbox)

Companion to `docs/qa/2026-09-24/coverage.md`. Lane B's ledger is `findings-b.md` (kept separate so
the two lanes never conflict on the same file; merge into one ledger at the end of the sweep).

| ID | Sev(P0–P3/DECISION/KNOWN-TLS) | Surface(web/mobile/api) | Module | Steps | Expected | Actual | Status | Fix commit |
|---|---|---|---|---|---|---|---|---|
| A-001 | P2 | mobile | inbox | Tap an unread notification row in `apps/mobile/app/inbox.tsx` (`openRow`, line 58) for a notification whose `inboxEntityHref()` (`apps/web/lib/notifications.ts:157`) would resolve to a link on web — the server-supplied `item.href`, or `/leave/:id` for `LEAVE*` types (task rows are resolved separately by the caller into `/projects/:projectId/tasks/:taskId`) | Navigates to the relevant detail screen, same as web's `InboxList.tsx:82` (`href = inboxEntityHref(item)`) | Only marks the notification read (`patchNotificationRead`, line 60); no navigation call anywhere in `openRow` — nothing visibly happens beyond the read-state flip | OPEN | |
| A-002 | P3 | mobile | my-payslip | Read `apps/mobile/app/payroll.tsx:3-4` ("My payslip already on the More tab"), then look for it in the More-tab launcher (`apps/mobile/src/modulesLauncher.ts:57-80`) | Either the code comment is accurate (a My-payslip screen exists) or the comment is corrected | `my-payslip` is absent from `BUILT_MODULE_ROUTES`; launcher shows it as "Coming soon" (`/coming-soon?code=my-payslip`) for any role with `payslip.read` — the comment describes a screen that was never built, unlike `org-locations` which has a documented owner exclusion. Fixed: `apps/mobile/app/payroll.tsx` header comment corrected to point at this row instead of asserting a My-payslip mobile screen exists (comment-only change, no test applies). The underlying gap (no My-payslip mobile screen) is unfixed and out of this task's small-fix budget — left as a tracked gap, not a P0/P1. | FIXED (comment) / gap OPEN | 5e8e68d |
| A-003 | — | api | attendance | Live-called `POST /api/v1/attendance/events` as `qa-admin-auditor` (AUDITOR: `attendance.read`, no `attendance.punch`, no `attendance.decide`) against `QA-EMP-ALPHA` (not self) | 403 if punching for someone else without `attendance.decide` | Got 403 `FORBIDDEN`: `"You can only punch for yourself... needs \"attendance.decide\"..."`. Read `assertPunchScope()` (`apps/api/src/modules/attendance/routes.ts:730-745`, comment: "Punch scope (frozen): self (linked employee) or attendance.decide") — **self-punch never requires `attendance.punch` at all**, by explicit, already-reviewed design ("frozen"); only punching *someone else* requires `attendance.decide`. `enforceRecordScope(req,'attendance.punch')` at line 851 only checks employee-record *scope* (self/team/geo), not permission presence. So the coverage-doc's original premise (attendance.punch gates self-punch) was wrong — checked and this is **not a bug**. | VERIFIED — NOT A BUG | — |
| A-004 | — | api | leave | Live-called `POST /api/v1/leave/requests/:id/decision` as `qa-mob-employee` (EMPLOYEE role: `leave.request`, no `leave.decide`) on their own freshly-created PENDING request | 403 | Got 403 `FORBIDDEN` `"Insufficient permissions"` — the inline check at `apps/api/src/modules/leave/routes.ts:1077-1078` (`if(!user.permissions.includes(LEAVE_DECIDE))...403`) fires correctly despite the weak `preHandler: authenticate`. Also verified in the same session: replaying the same decision after approval → 422 `REQUEST_CLOSED`; a state-machine jump (REJECT after already APPROVED) → 422 `REQUEST_CLOSED`; and idempotency-key replay on `POST /leave/requests` create → 200 with the same resource, no duplicate row. All correct. **Not a bug.** | VERIFIED — NOT A BUG | — |
| A-007 | P1 | web | org holidays | Open "New holiday" on `/org/holidays` as `qa-admin-hr` and type the placeholder's own suggested value, `PUBLIC`, into the Type field (`apps/web/app/org/holidays/page.tsx:72`, `placeholder="PUBLIC / FESTIVAL / REGIONAL…"`), then submit | Either the value is accepted, or the UI rejects/guides toward a value the server accepts | Client-side `holidaySchema.type` (`apps/web/lib/validation.ts:217`, pre-fix) was `z.string().min(1).max(50)` — any non-empty string passed, including the dialog's own default value `'PUBLIC'`. The server's `holidayTypeSchema` (`packages/shared/src/s1.ts:293-299`) is a strict lowercase enum (`national/regional/local/weekly_off/manual`) with no `public`/`festival` member at all — so the *default* value of a brand-new "New holiday" dialog, and every value the placeholder suggests, was **guaranteed to 422** on submit. An existing test (`apps/web/tests/s1.test.ts:112`, pre-fix) even asserted `type: 'PUBLIC'` as a *valid* client-side parse, enshrining the mismatch. Fixed: `HOLIDAY_TYPES` const added to `validation.ts` mirroring the server enum, `holidaySchema.type` now `z.enum(HOLIDAY_TYPES)`, the create dialog's Type `<Input>` replaced with a `<select>` (matching the existing `scope_type` picker) defaulting to `national`, and the stale test updated + a new one added (RED confirmed: pre-fix schema accepted `'PUBLIC'`/`'FESTIVAL'`; GREEN after fix, 23/23 `s1.test.ts` passing on the VM). | FIXED | 6ec0555 |
| A-008 | P0 | web | employees | On `/employees/:id` as `qa-admin-hr` (`employee.create`), click "Edit", change any single field (e.g. Department), leave everything else untouched, click "Save changes" | The patch succeeds | **Every edit of every employee failed, unconditionally.** `EmployeeForm`'s edit mode registered a "Status" `<select>` seeded from the employee's real (always-present) current status. React Hook Form includes every registered field's current value in the object handed to `onSubmit`, so every "Save changes" click sent `status: "<current>"` back to the API regardless of whether the picker was touched. `PATCH /api/v1/employees/:id` (`apps/api/src/modules/employees/routes.ts:1103-1111`) explicitly checks `"status" in req.body` and 422s before even parsing the rest of the patch: `"Status cannot be patched directly; use exit/reactivate"`. Live-reproduced on dev-thor: `PATCH /employees/{QA-EMP-ALPHA}` with `{department:"QA Dept", status:"ACTIVE"}` (the unchanged current status) → 422; the identical patch with the `status` key omitted → 200. Fixed: removed the Status control from `EmployeeForm.tsx` entirely (create mode never sent it to the server either — `employeeCreateSchema` has no `status` field, the server always inserts `'DRAFT'` — so the picker was a no-op there too) and made `clean()` unconditionally strip `status` from the submitted payload (belt-and-suspenders: React Hook Form still carries the field internally from `defaultValues` even with no control rendered for it). RED: `apps/web/tests-dom/employee-form-status.test.tsx` — "does not send status back on an untouched save" failed pre-fix (`sent.status === 'ACTIVE'`) and "has no writable Status control" failed pre-fix (select was present with stale DRAFT/ACTIVE/ON_LEAVE/EXITED/TERMINATED options, missing SUSPENDED — see A-009). GREEN after fix; full `apps/web` suite (56 files / 782 tests) passing on the VM. | FIXED | 1928da0 |
| A-009 | P1 | web | employees, org holidays | Edit an employee whose `gender` was never recorded (a real, common case — the field is optional), touch any other field, save; separately, create a holiday leaving "Scope type" on its default "Org-wide" option | The save succeeds; an org-wide holiday (no scope) is created | Both `gender: z.enum(GENDERS).optional()` (employees) and `scope_type: z.enum(ORG_UNIT_TYPES).optional()` (holidays), in `apps/web/lib/validation.ts` pre-fix, used bare `z.enum(...).optional()`. Zod's `.optional()` only treats an *absent* (`undefined`) value as unset — a native `<select>`'s blank first option ("Select gender" / "Org-wide") submits the literal empty string `""`, which fails enum validation. Because these are whole-form `zodResolver` schemas, one invalid field blocks the *entire* submission, not just that field — so any employee edit where gender was left blank (or an org-wide holiday, arguably the most common holiday shape) silently failed client-side validation with no network call at all. Every other optional field in this same file already carries a `.or(z.literal('').transform(() => undefined))` guard for exactly this reason (`optionalText`/`optionalPhone`/`optionalEmail`/`optionalDate`) — these two enum fields were the only ones missing it. Fixed: added a shared `optionalEnum(values)` helper using the same idiom, applied to both fields. RED: `employee-form-status.test.tsx`'s third test (blank Gender blocks save) and `s1.test.ts`'s new `scope_type: ''` assertion both failed pre-fix; GREEN after (full web suite green on the VM). | FIXED | 1928da0 |
| A-005 | DECISION | api | auth/mfa/security | Read `apps/api/src/common/auth.ts:148-151` (`mfaEnrollmentRequired = nodeEnv==='production' && !mfa_enabled && mfaRequired(...)`) and `apps/api/src/modules/auth/routes.ts:303-343` (`POST /auth/mfa/disable`: the same `nodeEnv==='production' && mfaRequired(...)` guard blocks disabling MFA for a floor/required role) | Either this is an intentional non-prod relaxation (documented) or the floor should hold in every environment | Both the enrollment-forcing gate and the disable-blocking gate for MFA-required roles (including the "a super administrator is never exempt" floor, per the comment at auth.ts:132-144) are **entirely inert whenever `NODE_ENV !== 'production'`** — i.e. on dev-thor and presumably any staging/QA deployment, a SUPER_ADMIN or any MFA-required-role account can freely disable its own MFA (self-security-change is otherwise blocked via `/admin/users/:id`, but `/auth/mfa/disable` is self-service and only gated by nodeEnv). Not fixed — deliberately touches a security floor with two call sites and unclear blast radius on existing QA/e2e automation that likely relies on the relaxed behavior in non-prod to avoid needing real TOTP secrets for every seeded account. **DECISION needed**: should the MFA-required floor (enrollment + disable-block) hold in staging/pre-prod too, with an explicit env-driven seed/bypass mechanism instead of blanket `nodeEnv==='production'`? | DECISION | — |

## Attacked and found clean (no finding filed)

Recorded so a successor doesn't repeat this work. All live-probed on dev-thor with QA- prefixed
data unless noted "(static)" for a code-reading-only check.

- **Cross-org IDOR**: `GET /employees/:id` and `GET /payroll/runs/:id` called with an org-2 token
  (`qa-admin-org2`) against org-1 seeded IDs (`QA-EMP-ALPHA`, the seeded payroll run) both correctly
  404 (no existence leak, no data leak).
- **Admin self-edit privilege escalation (static)**: `PATCH /admin/users/:id`
  (`apps/api/src/modules/admin/routes.ts:46-90`) blocks self-disable (`SELF_DISABLE`) and
  self password/MFA-policy change (`SELF_SECURITY_CHANGE`) server-side, matching the UI's
  self-edit field hiding — not UI-only. Also blocks exempting a floor (MFA-required) role from MFA
  regardless of how the request is phrased.
- **Leave decision hardening**: replaying an already-approved decision (same idempotency-key +
  stale `if-match`) → 422 `REQUEST_CLOSED`; a state-machine jump (REJECT after already APPROVED)
  → 422 `REQUEST_CLOSED`; idempotency-key replay on `POST /leave/requests` create → 200 with the
  same resource (no duplicate row, though note the replay response is `{applied, request}` while
  the original 201 is the bare resource — a shape inconsistency, cosmetic only, not filed).
- **Payroll run state machine (static)**: `submit-review`/`approve`/`lock`/`reopen` all go through
  a shared `transition()` helper (`apps/api/src/modules/payroll/routes.ts:777-820`) using an atomic
  `UPDATE ... WHERE status = '<from>'` — no race window, no way to skip a state.
- **Holiday scope validation (static)**: `scope_type` is a free-text field in the schema, but the
  create route (`apps/api/src/modules/holidays/routes.ts:266-271`) cross-checks it against the
  actual `org_units` row's real type and 422s on mismatch — an arbitrary `scope_type` string can't
  desync a holiday from its scope.
- **Audit query "SQL injection" false lead**: `orgZone` at `apps/api/src/modules/audit/routes.ts:96`
  is string-interpolated into the query, but it's a fixed subquery constant (not user input) that
  itself references a bound `$1` — not injectable.
- **`/payroll` page false "403" in the pre-existing baseline crawl** (`~/sl-e2e/admin/crawl-qa-admin-superadmin.json`,
  dated 2026-09-22, predates this task): the crawler's body-text heuristic mis-flagged the page as
  forbidden. Re-crawled live for `qa-admin-superadmin` (has `payroll.read`) — the page renders fully,
  zero failed requests. Stale baseline artifact, not a current bug; disregard that file's "403"
  verdicts on this page without re-checking live.

## Round 2 — additional clean-attack results (before the walk-status table)

- **Audit pagination attack pass** (live, `qa-admin-admin` token): `limit=999999999` → 422
  `too_big`; `limit=-5` → 422 `too_small`; a garbage (non-base64/JSON) cursor → 422 `invalid_string`;
  a structurally-valid base64url-JSON cursor with a non-UUID `id` → clean 422 `Malformed resource
  id` (not a raw DB error/500 — `decodeCursor`'s result is further validated before use); a cursor
  JSON missing `id` entirely → 200 with an empty page (odd but not a crash or a leak). All clean.
- **Role delete-in-use**: no such endpoint exists — `apps/api/src/modules/admin/routes.ts` has no
  `DELETE /admin/roles/:id` (only `POST /admin/roles` create and `PATCH .../mfa`); roles cannot be
  deleted at all via API or UI. N/A, not a gap.
- **Remove your own last admin permission**: `PUT /admin/users/:id/roles` refuses outright with
  `SELF_ROLE_CHANGE` the instant `id === caller.id` (`admin/routes.ts:133`) — you can never touch
  your own roles at all, let alone strip them; and `keepAdministrator()` is called after every
  other user's role change to guarantee at least one active `users.manage`+`admin.configure` holder
  remains org-wide. Attacked and found clean.
- **Attendance exceptions decide flow**: read (not live-clicked) in depth — version-conflict
  (optimistic concurrency), single-transition-only (`PENDING → APPROVED|REJECTED`, re-deciding an
  already-decided exception 422s `INVALID_TRANSITION`), a payroll-lock guard, and two independent
  self-decision guards (submitter, and same-employee-as-decider) are all present
  (`apps/api/src/modules/attendance/routes.ts:1556-1700`). Matches the same deliberate-hardening
  pattern already verified live for leave/payroll in round 1; not re-run live this session given
  time budget, but the code shape gives no reason to suspect a gap.
- **Payroll policy schema parity**: `apps/web/lib/validation.ts`'s `payrollPolicySchema`
  (`per_day_divisor` 1–31 int, `pf_pct` 0–100) matches `packages/shared/src/p1.ts`'s server schema
  exactly. No mismatch.
- **Admin MutationForm enum parity**: `auth_status` (`ACTIVE`/`DISABLED`) and `mfa_policy`
  (`INHERIT`/`REQUIRED`/`EXEMPT`) options in `admin/page.tsx`'s per-user security form match
  `packages/shared/src/auth.ts`'s `MFA_POLICIES` and the API's inline `auth_status` enum exactly.
  This form also doesn't share the A-009 bug shape (its `<select>` always has a real current value
  as default, and it isn't a client-side `zodResolver` form).
- **Mobile grep for the A-007/A-008/A-009 bug shapes**: searched `apps/mobile` for
  `ON_LEAVE`/`TERMINATED`/`PUBLIC`/`FESTIVAL` — none found. Consistent with employees and holidays
  being read-only on mobile (no create/edit forms to carry the bug).

## Walk status by module

| Module | Walked | Notes |
|---|---|---|
| Auth/MFA/security | Partial | Login/MFA/password-change flows reviewed by code + existing crawl data; MFA disable/enroll floor reviewed deeply (→ A-005). No fresh Playwright element-by-element walk of `/login`, `/mfa`, `/security` tooltips/buttons done this session (round 2 also did not get to this — see Round 2 report). |
| Admin (users/roles/module-visibility) | Partial | Self-edit, role-floor, self-role-change and last-administrator protections verified (code + live). Enum parity for the per-user security form verified clean (round 2). Role-visibility/module-visibility CRUD payload edge cases (negative/duplicate IDs, XSS in role name) not yet live-attacked. |
| Org holidays | Done for create-form correctness | A-007 (Type field guaranteed-422) and half of A-009 (scope_type blank-option) found and fixed round 2, both live-reproduced and regression-tested. Attack inputs on Name (blank/10k/unicode/`<script>`) not live-run — the field is a plain `z.string().trim().min(1).max(255)` on both client and server with no special handling, and holiday names render through plain React text interpolation (`{h.name}`) which auto-escapes, so this is low-risk but not confirmed live. Mobile web-only exclusion for org-locations confirmed via code, not live-toggled. |
| Employees | Done for edit-form correctness | **A-008 (P0, every employee edit broken) and half of A-009 (gender blank-option) found live-reproduced and fixed round 2** — this was the headline finding of this round. Bulk-import edge cases, document upload, and attack-string inputs (10k/unicode/XSS on name fields) not yet live-run, though schema bounds were reviewed in round 1 and rendering goes through plain React interpolation. |
| Attendance | Partial | Punch-scope gate live-verified (A-003, round 1). Exceptions-decide state machine reviewed in depth (round 2, static) — version conflict, single-transition, payroll-lock and dual self-decision guards all present; not live-clicked. IST-midnight/reversed-timestamp punches and mock-location/movement-anomaly paths not attacked. |
| Leave | Done for the decision/state-machine/idempotency surface (round 1) plus schema review (round 2: no optional-enum-select bug shape present — `leave_type_id` is a required min(1) string, not an enum). Balance upsert bounds, overlapping-date requests, and LOP-vs-Sunday business rule not separately re-verified. |
| Payroll | Partial | Run-lifecycle state machine reviewed (round 1) + cross-org IDOR verified + policy-schema parity confirmed exact (round 2). Cost-ledger reverse/post and payslip generation numeric edge cases not yet live-attacked. |
| My-payslip | Done | A-002 comment fixed (round 1); underlying "no mobile screen" gap left OPEN (documented, not P0/P1). |
| Audit | Done for pagination/filter attack surface | Round 2: huge/negative limit, garbage cursor, structurally-valid-but-garbage cursor, and a cursor missing a required field all handled cleanly (422s or an empty page, never a 500 or a raw DB error). SQL-injection lead chased and cleared in round 1. |
| Inbox | Not walked further | A-001 (mobile deep links) is a known, explicitly out-of-scope gap for this task per the brief — left OPEN for Task 5. No additional inbox work done. |

**Not walked this round, honestly listed**: a live Playwright element-by-element click-through
(every button/tab/tooltip, per role, per the brief's step 1) was **not** performed as a browser
automation pass in round 2 — time went instead into deep reading + live API/schema reproduction of
the create/edit forms, which surfaced three real, high-value, previously-undetected bugs
(A-007/A-008/A-009) that a page-level crawl (round 1's tool) structurally cannot catch, since it
never submits a form. A full 5-role × ~17-page interactive UI crawl (login/mfa/security tooltips,
admin role/module-visibility CRUD payload attacks, attendance exceptions live decide-and-replay,
bulk employee import, 10k/unicode/emoji/RTL/XSS string attacks rendered back on screen) remains
open for a follow-up pass. Given the shape of A-008 (a whole-feature-breaking bug that a
page-render-only crawl missed twice — round 1's baseline crawl included `/employees/:id` and never
submitted the edit form), the highest-value next step for a successor is almost certainly to run
*actual form submissions* (not just page loads) across the remaining Lane A create/edit surfaces
before spending time on tooltip-text/dead-link auditing.

None of the above partial items surfaced P0/P1 evidence during this session's probing — they are
listed so a successor can pick up exactly where this pass left off rather than re-deriving scope
from `coverage.md` alone.
