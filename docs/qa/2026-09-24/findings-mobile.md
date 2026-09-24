# Findings ledger — Mobile deep QA (T5.5)

Companion to `docs/qa/2026-09-24/coverage.md` (already has a per-module static
walk of every mobile screen) and `findings-a.md`/`findings-b.md` (lane A/B,
including mobile parity notes: A-001 inbox no-navigate, A-002 my-payslip
comment, B-006 requisition creation confirmed present on mobile, B-008 stock
module has no mobile UI, B-009 documents read-only, B-010 planning read-only,
B-011 pipeline/clients/tenders read-only except lead-stage). This ledger adds
what those static passes did not do: live API calls against dev-thor with
real QA- data and every seeded role, and write-path attacks.

Scope note: `apps/mobile/app/payables.tsx` and `expenses.tsx` are owned by
the parallel `qa-gaps` lane — reviewed and logged here (M-003), not fixed.

| ID | Sev(P0-P3/DECISION/GAP) | Surface | Module | Steps | Expected | Actual | Status | Fix commit |
|---|---|---|---|---|---|---|---|---|
| M-001 | P1 | mobile | approvals, procurement, inventory, pipeline, reports | Live-called `POST /tasks {project_id:"not-a-uuid", title:""}` as `qa-mob-employee` giving `422 {"code":"VALIDATION_ERROR","message":"Validation failed","field_errors":[{"field":"project_id",...},{"field":"title",...}]}`. Read every mobile write screen's catch block (`grep -rn "instanceof Error ? e.message" `) | A 422 with several bad fields tells the user which field and why | `client.ts` already parses `field_errors` onto `ApiError.fieldErrors`, but `approvals.tsx` (decide/recall), `procurement.tsx` (raise/submit requisition), `inventory.tsx` (post transaction), `pipeline.tsx` (lead stage) and `reports.tsx` (generate/save) all rendered only the top-level `message` -- a fixed, generic "Validation failed" whenever more than one field failed zod validation. Screens whose writes go through the offline queue (leave, tasks, attendance, assets) already had this right via `queueCore.ts`'s `describeRequestError`; the gap was specifically the five screens that call `postXxx()` directly. | FIXED | 858f36e |
| M-002 | P2 | mobile | attendance (tab) | Read `src/rbac.ts`'s `TAB_PERMISSIONS` doc comment ("screens that lack permission show a locked-state message instead of data"), then grep for consumers -- zero. Live-checked `qa-admin-client` (CLIENT_VIEWER, permissions `project.read, task.read, cycle.read, notification.read, dashboard.read, board.read`, no `attendance.*`) against `GET /attendance/me` | The Attendance tab shows a locked-state message, matching Assets (`canDo("asset.read")` gate) and Survey (`canDo("survey.enter")` gate) | Got `404 NO_EMPLOYEE_LINK` from the API, silently swallowed -- the screen rendered the full punch UI (map, Check in/Check out) unconditionally, with no permission check anywhere in the file, and fired a device GPS permission prompt on mount for a user who could never punch | FIXED | a1cfe26 |
| M-003 | P1 | mobile | expenses (owned by qa-gaps lane) | Same grep as M-001 against `app/expenses.tsx` | N/A -- logged only, not fixed (owned by the parallel lane per this task's brief) | Same bug shape as M-001: `postExpenseClaim`/`postExpenseClaimSubmit`/`postExpenseClaimWithdraw`'s three catch blocks (`app/expenses.tsx:152,166,180`) all do `e instanceof ApiError ? e.message : "<fallback>"`, dropping `field_errors` on a multi-field 422 | OPEN -- logged for the qa-gaps lane | -- |
| M-004 | P2/GAP | mobile | clients, tenders, pipeline (leads), procurement (requisitions, purchase orders) | Live-called each list endpoint (`GET /clients?limit=50`, `/tenders?limit=50`, `/leads?limit=50`, `/requisitions?limit=50`, `/purchase-orders?limit=50`) -- all return `has_more`/`next_offset`. Grepped all four screens for "hasMore" -- zero matches | Some way to see past the first page -- a "Load more" control or at least an indicator, matching `asset-movements.tsx`'s own offset-tracking pattern | `getClients`/`getTenders`/`getLeads`/`getRequisitions`/`getPurchaseOrders` (`src/api/endpoints.ts`) all fetch and return `hasMore`, but none of the five screens ever reads it -- a page beyond the first 50 rows is silently invisible with no indication more exist. Current QA data is under the 50-row limit everywhere probed (clients=10, tenders=7, requisitions=3, POs=3) so this has not yet manifested live, but it will the first time any of these lists grows past 50. `employees.tsx`/`documents.tsx` mitigate the same shape with a search box instead of pagination, which only narrows the problem. Not fixed -- implementing real "load more" across 4-5 screens is beyond a single P2's time budget; flagged as a GAP rather than attempting a partial fix. | OPEN -- GAP | -- |
| M-005 | P3 | mobile | leave (tab) | Same check as M-002 applied to `app/(tabs)/leave.tsx` | Locked state when neither `leave.request` nor `leave.read` is held | No gate either -- same shape as M-002, but materially lower risk: `LEAVE_REQUEST`/`LEAVE_READ` are near-universal base-employee permissions (every seeded qa-admin-* role except CLIENT_VIEWER/GOVT_OBSERVER holds at least one), so the locked state is rarely if ever the thing a real user hits. Not fixed this round -- budget went to M-002 (attendance has the added GPS-permission-prompt side effect on mount, which leave.tsx does not). | OPEN | -- |
| M-006 | P3 | mobile | more (notification preferences) | Read `app/(tabs)/more.tsx`'s `setPreference()` -- its catch block is bare `catch { setPreferenceError("Connect to the internet to update notification preferences.") }`, no inspection of the thrown error at all. Live-called `PATCH /auth/preferences {not_a_real_channel:true}` giving `422 VALIDATION_ERROR` (not a connectivity failure) | An error message that reflects what actually happened | The UI can only ever say "Connect to the internet...", even for a genuine 403/422/500 while fully online -- low real-world risk since the three toggles (`push`/`sms`/`whatsapp`) always send a valid `{key: boolean}` the schema accepts, but misleading if a future channel or a server-side policy ever rejects a real user's toggle | OPEN | -- |
| M-007 | -- | api | leave | Live idempotency-key attack: `POST /leave/requests` with key A gives 201; replay same key A with the same body gives 200 (same resource, no duplicate); a genuinely new request with the same body but a fresh key gives 422 LEAVE_OVERLAP (server's own date-overlap rule, not a duplicate) | Idempotency-Key dedups a retried submit; a real second attempt is governed by business rules, not silently duplicated | Confirmed exactly that -- clean | VERIFIED -- no bug | -- |
| M-008 | -- | api | auth (preferences) | Live-attacked `PATCH /auth/preferences` with an unrecognised key (`{not_a_real_channel:true}`) and a wrong-typed value (`{push:"yes"}`) | 422 with a specific field-level reason | Got `field_errors` naming the unrecognised key and, separately, "Push must be yes or no" for the wrong-typed value -- clean, specific, no 500 | VERIFIED -- no bug | -- |
| M-009 | -- | api/mobile | projects, planning, analytics, billing, automation | Live-called `GET /projects/:id`, `/cycles?project_id=`, `/analytics/projects/:id`, `/insights/projects/:id`, `/automation-rules?project_id=`, `/projects/:id/ra-bills`, `/ra-bills/:id` first as `qa-admin-pm` (a PROJECT_MANAGER scoped to one specific project) against an out-of-scope project (QA-SEED-ACTIVE) -- all seven 403'd. Re-ran the same seven against `qa-admin-admin` (org-wide) and against the PM's own scoped project | 403 on an out-of-scope project for a scoped role; 200 with a shape matching the TS interface for an in-scope/unscoped caller | Confirmed exactly that on all seven -- project-scope enforcement is consistent across every mobile-reachable project-scoped endpoint, and every response shape (ProjectDetail.counts, Cycle.metrics, ProjectAnalytics.summary/flow/cycles/workload, ProjectInsight.prediction/factors, RaBill.gross_value/net_payable/items) matched `src/api/endpoints.ts`'s interfaces exactly, including the `[k:string]:unknown` catch-all fields the mobile client doesn't type but tolerates | VERIFIED -- no bug | -- |
| M-010 | -- | mobile | (broad GET sweep) | Live-called ~35 GET endpoints across `qa-mob-employee`, `qa-admin-hr`, `qa-admin-pm`, `qa-admin-admin`, `qa-admin-inventory`, `qa-admin-payroll` covering attendance/tasks/leave/notifications/preferences/employees/projects/documents/approvals/inventory/clients/leads/tenders/ra-bills/ageing/requisitions/purchase-orders/payroll runs/cycles/reports/asset-movements. Compared every response's top-level and one-level-nested keys against the TS interfaces in `src/api/endpoints.ts` | Field names and envelope shapes (`{data,has_more,next_cursor}` vs bare array vs `{data:{...}}`) match what the client's `asList`/`asItem`/`asPage` helpers and each screen expect | No shape mismatches found anywhere in the sweep -- `asList`/`asItem`/`asPage`'s tolerant-envelope design (accepts enveloped or bare) absorbs most of the risk class that caused 2 P0s on web, and every interface's optional/`[k:string]:unknown` fields matched what the server actually sends | VERIFIED -- no bug across the sweep | -- |

## Attacked and found clean (no finding filed)

- Double-submit / idempotency across write screens: `postRequisition` (no
  explicit key passed, so `client.ts` auto-generates one) is guarded
  client-side by `disabled={submitting}` on its button, same pattern as every
  other submit button in the app; a genuine same-body resubmit after the
  button re-enables goes through `client.ts`'s auto-key path and is a real
  new request, correctly governed by server-side business rules (see M-007
  for the leave case, same mechanism).
- 401 handling (code review, not independently re-run live this round):
  `src/api/client.ts`'s single-refresh-then-logout path (lines 286-312) is
  already covered by `retry-after.test.ts`/`replay-body.test.ts`/
  `remote-wipe.test.ts`; reads correctly (a revoked-device 401 skips refresh
  entirely and wipes; an ordinary expired-token 401 gets exactly one refresh
  attempt, then signs out with a typed ApiError).
- Reversed-date leave request server-side: bypassing the client's own
  `validateLeaveRequest` and posting `from_date > to_date` directly still
  fails -- separately confirmed clean in `findings-a.md`'s round 1 (near
  A-004); not re-litigated here.

## Not covered this round (honestly listed)

Given the size of the module list (28 screens + 7 tabs) and the time this
pass spent going deep (live shape verification across ~35 endpoints, plus
finding/fixing M-001 and M-002 with RED then GREEN), the following were
NOT independently live-attacked this round, beyond what `coverage.md`'s
static pass and `findings-a.md`/`findings-b.md` already recorded:

- Attendance punch's full adversarial payload sweep (huge/NaN/negative
  lat-long, RTL/emoji device_id) -- the equivalent attack on survey GCPs was
  already run live in an earlier round (`~/sl-e2e/qa-boundary.mjs`) and found
  clean; punch shares the same device_signals/coordinate validation path but
  was not independently re-attacked here.
- Task evidence upload (`postTaskEvidence`, base64 JSON, <=5MB) -- huge
  payload and non-image-content attacks not attempted live.
- Survey tab (`app/(tabs)/survey.tsx`) -- out of this pass's time budget;
  `coverage.md` already covers it structurally, and survey has its own
  dedicated test file (`test/survey.test.ts`).
- Documents, org-holidays, employees, project-finance, receivables,
  automation, analytics, asset-movements screens -- read-only per
  `coverage.md`'s static walk (confirmed live only incidentally, via the
  M-010 GET sweep, not independently attacked for pagination/error-state
  edge cases beyond what's logged above).
- Deep-link param validation for the one real deep link in the app
  (`/(tabs)/tasks?taskId=...` from Home) -- not attacked with a malformed
  or foreign-org taskId this round.
- Offline queue replay/duplicate semantics beyond what `queue.test.ts`/
  `outbox-housekeeping.test.ts`/`replay-body.test.ts` already assert (no
  live airplane-mode device walk was possible -- no emulator/device
  available, per this task's constraints).
