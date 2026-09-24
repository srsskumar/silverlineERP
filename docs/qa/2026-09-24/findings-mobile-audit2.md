# Findings: mobile field-by-field audit, round 2 (2026-09-24)

Branch `qa/mobile-audit2`, off `main` 0649788 (the deployed build). Covers the
16 mobile screens that earlier rounds swept only for status tones
(findings-r5.md): documents, tenders, approvals, clients, assets (tab),
asset-movements, automation, planning, pipeline, tasks (tab), reports, inbox,
analytics, employees, payroll, org-holidays. Nothing here repeats
findings-mobile.md (M-*, A-001, B-009, B-011) or findings-post.md.

Method, per screen:
1. Listed every field, label, badge and number from the screen source and
   `src/api/endpoints.ts`.
2. Called the same endpoints live on dev-thor as all ten `qa-admin-<role>`
   users. That gives the status for each role (so the lowest allowed role and
   the 403 roles) and the key and type shape of the first row. Scripts are in
   `~/sl-e2e/ma2/` (probe, probe2, probe3, perms, writes).
3. Loaded the web page for the same data in Playwright (`~/sl-e2e/ma2/web.mjs`)
   and compared wording, dates and money against it. The web bundle calls
   `http://34.131.134.217/api/v1`, so the browser has to load the page from
   that origin. From `127.0.0.1` the CSP blocks every call and the page stays
   on the sign-in form.
4. Checked the loading, empty, 403 and network-error states. Sent the write
   payloads live (QA- records only).
5. Checked each deep-link target against the server's `NOTIF_COLS` href
   mapping (`apps/api/src/modules/s5/routes.ts`).

Lowest allowed role, as measured live: documents: tl. Tenders: pm. Approvals:
employee (read) and tl (act). Clients: pm or inventory. Leads: admin or
auditor only. Asset movements: employee. Payroll: hr. Holidays: hr (employee
gets 403). Notifications: every role. Reports: tl. Employees: tl (list comes
back empty; detail 403). Tasks and projects: employee. Assets: employee.
Eligible employees: inventory. Automation, cycles and analytics: pm or admin,
depending on project scope.

## Findings

| ID | Sev | Screen | Finding | Evidence | Status |
|---|---|---|---|---|---|
| MA-001 | P1 | assets (tab) | Opening an AVAILABLE or RETURNED asset as an asset manager crashed the screen. The code read `e.name.toLowerCase()` on `GET /assets/eligible-employees` rows, but the API sends `{id, emp_no, first_name, last_name}` with no `name`. The TypeError hit the screen boundary, so assigning an asset from the phone could not work at all. | Live shape as `qa-admin-inventory`. `apps/api/src/modules/inventory/routes.ts:22`. | FIXED: `src/assetsFormat.ts` `eligibleEmployeeLabel`/`filterEligibleEmployees` |
| MA-002 | P2 | assets (tab) | Condition (transition, assign, audit scan) was a free-text box. The API schema takes any text and stores it as sent: `POST /assets/:id/transition {condition:"good"}` returned 200 and wrote `good` to the register. Web offers the fixed `ASSET_CONDITIONS` dropdown. The register also showed the raw code (`GOOD`) where web shows "Good". | Live write on a QA asset, then reverted. | FIXED: picker built from shared `ASSET_CONDITIONS` (without OTHER, which needs a note this screen has no field for), `validateAssetCondition` checked before queueing, `assetConditionLabel` used in the list |
| MA-003 | P2 | documents, tenders, approvals, clients, pipeline, asset-movements, automation (rules, runs), planning (projects, cycles), reports, inbox, employees, payroll (runs, payslips), org-holidays | A failed list load with nothing cached (403, offline, 5xx) fell through to the empty state: "Nothing due for renewal", "No tenders found", "Inbox is empty". So an error read as a claim that there was no data. Real case: pm holds `automation.read` but `GET /automation-rules?project_id=` returns 403 for a project outside its scope, and the screen said "No rules on this project". | Live 403s listed above. Only tasks and assets had an error branch. | FIXED: `src/listState.ts` plus `src/ui/LoadError.tsx` (shows the server's own message) on every list in scope. Cached rows still take priority over an error. |
| MA-004 | P2 | reports | (a) The type picker ignored `report.generate`. An employee (holds `task.read`, not `report.generate`) was offered "Tasks", and every Generate returned 403. (b) The Employees report was gated on `employees.read`, a legacy code. The API (`REPORT_DOMAIN_READ`) and web check `employee.read`, so a team lead (has `employee.read`, not `employees.read`) never saw it on the phone. | `/auth/me` permissions for all roles. `packages/shared/src/s6.ts:122`. | FIXED: `REPORT_TYPE_META` moved to `src/reportsFormat.ts` (re-exported from endpoints) and corrected. `availableReportTypes` now requires `report.generate`. |
| MA-005 | P2 | tasks (tab) | The list's "Due …" line read `t.due_date`. `GET /tasks` rows have no such field (the date is `planned_end_date`), so the due date never showed. | Live `/tasks` shape. | FIXED: `taskDueDate()` |
| MA-006 | P2 | tasks (tab) deep link | `?taskId=` was read only as `useState`'s initial value. The tab stays mounted once visited, so after the first link a later inbox row or push for another task switched to Tasks without opening its sheet. | Code read (expo-router keeps tab screens mounted). | FIXED: `deepLinkTaskId()` plus an effect on the param |
| MA-007 | P3 | documents | The badge showed the raw state (`VALID`, `NO_EXPIRY`) where web shows `STATE_LABELS` ("In force", "No expiry"). Owner showed `employee · 1a2b3c4d` where web shows `OWNER_LABELS`. Every date was raw ISO (`2026-10-10`), not `day()` (`10-Oct-2026`). | Web `/documents` compared with mobile source. | FIXED |
| MA-008 | P3 | pipeline | New-lead "Estimated value" was sent as `Number(text)`. Non-numeric text became `null` in JSON and the API returned 422 with only "Invalid input". Detail showed raw Source (`PORTAL_WATCH`) and Type codes, a raw ISO follow-up date, and timeline entries with no date. | Live `POST /leads {estimated_value:null}` returned 422. | FIXED: validated in `validateLeadCreate`, plus labels and `day()`/`dayTime()` |
| MA-009 | P3 | approvals | "Waiting since" used `new Date().toLocaleDateString()`, which follows the device locale and zone rather than IST `day()`. Step titles showed the raw role (`PROJECT_MANAGER`); web shows "Project manager". Steps had no acted-on date (web shows one). Status badges were raw codes; web uses `statusLabel`. | Web `/approvals` as employee. | FIXED |
| MA-010 | P3 | tenders, clients, planning, analytics, automation, tasks, assets | Status and type badges showed raw codes (`UNDER EVALUATION`, `GOVERNMENT`, `IN_PROGRESS`, `ACTIVE`), where web's `statusLabel()` gives sentence case. Tender dates were raw ISO. The tender detail had no Type field (web shows one). | Web `lib/board-visuals.ts statusLabel`. | FIXED: `src/labels.ts codeLabel()` (same algorithm), `day()` for dates |
| MA-011 | P3 | asset-movements, automation | Movement time and automation run time were shown with `day()` (date only). Web shows `dayTime()` (`24-Sep-2026 22:54 IST`), and two handovers on one day could not be told apart. | Web `/assets/movements`. | FIXED |
| MA-012 | P3 | payroll, employees | Run "Locked/Approved" dates used `iso.slice(0,10)`, which is the UTC date: a lock at 00:30 IST showed the day before. Employee date of joining was raw ISO. | Live run `locked_at 2026-09-24T11:11Z`. | FIXED: `day()` |
| MA-013 | P3 | tasks (tab) | With "All" selected, the empty state still said "Nothing assigned / Tasks assigned to you appear here". | Code read. | FIXED |
| MA-014 | P3 | inbox (deep links) | The server's `NOTIF_COLS` gives `href` NULL for `attendance_exception` and `comment` notifications (both emitted via `emitNotification`), so the phone shows "no screen for this", even though an attendance-exceptions screen exists. Web has the same gap, so this is a server-side mapping. | `apps/api/src/modules/s5/routes.ts:221`. | OPEN: server-side (and web). Not a mobile-only fix. |
| MA-015 | DECISION | org-holidays | The screen's own header says it is "the lookup a field employee actually needs". Live, EMPLOYEE (and tl, pm, payroll, inventory) lack `holiday.read`, so they get the locked state. | `/auth/me` for all roles; `/holidays` 403. | OPEN: RBAC decision for the owner (grant `holiday.read` to employee?) |
| MA-016 | P3 | employees | The directory fetches the first 50 (`limit=50`) and ignores `next_cursor`/`has_more`, with no "more" affordance. Search is server-side, so a specific person is still findable, but browsing stops at 50. | Live `has_more:true` for hr. | OPEN: minor, would need cursor paging UI |
| MA-017 | P3 | automation, analytics | The project chips come from `getProjects()` (`limit=100`, first page only). Admin sees 74 today; past 100 projects the rest are unreachable. The same helper feeds tasks quick-add. | Live `/projects` for admin: 74, `has_more`. | OPEN |
| MA-018 | P3 (web) | web analytics | The web advisory prints `prediction_timestamp` as a raw ISO instant. Mobile already uses `day()`. | Web `/analytics` source. | OPEN: web, outside this lane |

Checked and clean (no finding): documents renew payload against
`documentRenewSchema`. Client create (`{name, client_type}`) returns 201 and
the server derives `code`. Tender create (`{tender_no, tender_type}`) returns
201 DRAFT. Lead create with a numeric value returns 201. Payroll run and
payslip amounts are rupees (`total_net 370682.9`, `net_pay 10666.58`) and
`formatMoney` renders them to paise the same way web does. Every field the
payroll, holidays, asset-movements, clients, tenders, documents, approvals and
analytics screens read exists live with the expected name and type.
Asset-movement badges ("Went out"/"Came back") match web. Holiday
date/type/scope wording matches web. Payroll and employee status badges show
raw codes on both platforms (parity, left as is). The inbox deep-link
targets for task, leave, employee, reports, expenses, procurement, billing,
assets and survey all resolve to existing mobile routes.

Not covered: no device or emulator, so the fixes are verified by unit tests,
`tsc` and code review, not a live tap-through. Analytics and cycles live
data had to be read as admin (no pm-scoped project has cycles or tasks).

## Fix round 1

| ID | Sev | Change | Status |
|---|---|---|---|
| MA-019 | P2 | `LoadError` never offered a retry and no screen had pull-to-refresh, so after a network error the user was stuck once react-query's single silent retry had run. `src/listState.ts` now has `canRetryLoad`/`retryAction`: a network failure (status 0 or a non-API error), 5xx, 408 or 429 offers Retry wired to the query's `refetch`, and 401/403/404/422 offers none. `LoadError` takes the query and shows the Retry button. One `src/ui/usePullRefresh.ts` hook, passed into `Screen`'s new `refresh` prop (a `RefreshControl`), covers the 14 list screens: documents, tenders, approvals, clients, pipeline, asset-movements, automation, planning, reports, inbox, employees, payroll, org-holidays and analytics. It refetches only the queries that are enabled for the current tab or project. Analytics' "Could not load" state now uses `LoadError` as well. | FIXED b9ba779 (test/retry-policy.test.ts) |
| MA-020 | P3 | `packages/shared` `assetConditionLabel` fell back to the raw value's own casing, so free text stored as `good` (MA-002) read "good". It now title-cases the fallback ("Good", "Needs repair"). Web's duplicate local `label()` in `apps/web/app/assets/page.tsx` is removed in favour of the shared function. | FIXED 36940ff (assets.test.ts) |

Verification (slot f, tar 14.4 MB): mobile 443/443 pass and tsc clean;
shared vitest 1019/1019 pass; web tsc clean; `next build` exit 0. Not
verified on a device.
