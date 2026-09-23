# Findings ledger — Lane A (auth/mfa/security, admin, org, employees, attendance, leave, payroll, my-payslip, audit, inbox)

Companion to `docs/qa/2026-09-24/coverage.md`. Lane B's ledger is `findings-b.md` (kept separate so
the two lanes never conflict on the same file; merge into one ledger at the end of the sweep).

| ID | Sev(P0–P3/DECISION/KNOWN-TLS) | Surface(web/mobile/api) | Module | Steps | Expected | Actual | Status | Fix commit |
|---|---|---|---|---|---|---|---|---|
| A-001 | P2 | mobile | inbox | Tap an unread notification row in `apps/mobile/app/inbox.tsx` (`openRow`, line 58) for a notification whose `inboxEntityHref()` (`apps/web/lib/notifications.ts:157`) would resolve to a link on web — the server-supplied `item.href`, or `/leave/:id` for `LEAVE*` types (task rows are resolved separately by the caller into `/projects/:projectId/tasks/:taskId`) | Navigates to the relevant detail screen, same as web's `InboxList.tsx:82` (`href = inboxEntityHref(item)`) | Only marks the notification read (`patchNotificationRead`, line 60); no navigation call anywhere in `openRow` — nothing visibly happens beyond the read-state flip | OPEN | |
| A-002 | P3 | mobile | my-payslip | Read `apps/mobile/app/payroll.tsx:3-4` ("My payslip already on the More tab"), then look for it in the More-tab launcher (`apps/mobile/src/modulesLauncher.ts:57-80`) | Either the code comment is accurate (a My-payslip screen exists) or the comment is corrected | `my-payslip` is absent from `BUILT_MODULE_ROUTES`; launcher shows it as "Coming soon" (`/coming-soon?code=my-payslip`) for any role with `payslip.read` — the comment describes a screen that was never built, unlike `org-locations` which has a documented owner exclusion. Fixed: `apps/mobile/app/payroll.tsx` header comment corrected to point at this row instead of asserting a My-payslip mobile screen exists (comment-only change, no test applies). The underlying gap (no My-payslip mobile screen) is unfixed and out of this task's small-fix budget — left as a tracked gap, not a P0/P1. | FIXED (comment) / gap OPEN | 5e8e68d |
| A-003 | — | api | attendance | Live-called `POST /api/v1/attendance/events` as `qa-admin-auditor` (AUDITOR: `attendance.read`, no `attendance.punch`, no `attendance.decide`) against `QA-EMP-ALPHA` (not self) | 403 if punching for someone else without `attendance.decide` | Got 403 `FORBIDDEN`: `"You can only punch for yourself... needs \"attendance.decide\"..."`. Read `assertPunchScope()` (`apps/api/src/modules/attendance/routes.ts:730-745`, comment: "Punch scope (frozen): self (linked employee) or attendance.decide") — **self-punch never requires `attendance.punch` at all**, by explicit, already-reviewed design ("frozen"); only punching *someone else* requires `attendance.decide`. `enforceRecordScope(req,'attendance.punch')` at line 851 only checks employee-record *scope* (self/team/geo), not permission presence. So the coverage-doc's original premise (attendance.punch gates self-punch) was wrong — checked and this is **not a bug**. | VERIFIED — NOT A BUG | — |
| A-004 | — | api | leave | Live-called `POST /api/v1/leave/requests/:id/decision` as `qa-mob-employee` (EMPLOYEE role: `leave.request`, no `leave.decide`) on their own freshly-created PENDING request | 403 | Got 403 `FORBIDDEN` `"Insufficient permissions"` — the inline check at `apps/api/src/modules/leave/routes.ts:1077-1078` (`if(!user.permissions.includes(LEAVE_DECIDE))...403`) fires correctly despite the weak `preHandler: authenticate`. Also verified in the same session: replaying the same decision after approval → 422 `REQUEST_CLOSED`; a state-machine jump (REJECT after already APPROVED) → 422 `REQUEST_CLOSED`; and idempotency-key replay on `POST /leave/requests` create → 200 with the same resource, no duplicate row. All correct. **Not a bug.** | VERIFIED — NOT A BUG | — |
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

## Walk status by module

| Module | Walked | Notes |
|---|---|---|
| Auth/MFA/security | Partial | Login/MFA/password-change flows reviewed by code + existing crawl data; MFA disable/enroll floor reviewed deeply (→ A-005). No fresh Playwright element-by-element walk of `/login`, `/mfa`, `/security` tooltips/buttons done this session. |
| Admin (users/roles/module-visibility) | Partial | Self-edit and role-floor protections verified (code + live crawl matrix across 6 roles). Role-visibility/module-visibility CRUD payload edge cases (negative/duplicate IDs, XSS in role name) not yet live-attacked. |
| Org holidays | Partial | Create/patch schema and scope-type cross-check reviewed (static). Live create/patch with attack inputs (blank/whitespace/10k/unicode name, `<script>`, same-date duplicate) not yet run. Mobile web-only exclusion for org-locations confirmed via code (hardcoded `WEB_ONLY_CODES`), not live-toggled. |
| Employees | Partial | Schema bounds reviewed (all fields have max-length; required fields have min(1)). Cross-org IDOR verified clean. Bulk-import edge cases, document upload, and live create/edit attack-input pass not yet run. |
| Attendance | Partial | Punch-scope gate live-verified (A-003). Regularization, exceptions decide flow, IST-midnight/reversed-timestamp punches, mock-location/movement-anomaly review paths not yet live-attacked. |
| Leave | Done for the decision/state-machine/idempotency surface (A-004 + clean list above). Balance upsert (negative/huge opening_balance), overlapping-date requests, and LOP-vs-Sunday business rule (see memory) not separately re-verified this session. |
| Payroll | Partial | Run-lifecycle state machine reviewed (static) + cross-org IDOR verified + page-render false-positive chased down and cleared. Policy edit (divisor/PF% bounds), cost-ledger reverse/post, and payslip generation numeric edge cases not yet live-attacked. |
| My-payslip | Done | A-002 comment fixed; underlying "no mobile screen" gap left OPEN (documented, not P0/P1). |
| Audit | Partial | SQL-injection lead chased and cleared; filter/pagination attack inputs (huge limit, malformed cursor) not yet run. |
| Inbox | Not walked further | A-001 (mobile deep links) is a known, explicitly out-of-scope gap for this task per the brief — left OPEN for Task 5. No additional inbox work done. |

None of the above partial items surfaced P0/P1 evidence during this session's probing — they are
listed so a successor can pick up exactly where this pass left off rather than re-deriving scope
from `coverage.md` alone.
