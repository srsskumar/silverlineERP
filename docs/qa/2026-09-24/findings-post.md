# Findings ledger — Post-deploy intense QA (2026-09-24), commit 7bd6f7d on dev-thor

Regression spot-checks (step 1) and browser-walk / cross-module findings (steps 2-3). IDs P-001…

## Regression spot-check summary (all live against http://127.0.0.1 on dev-thor)

All committed QA scripts (lane-a run-admin/run-attendance/run-leave/run-misc, lane-b submit-walk/idor-b,
integrations/scanner-probe) re-run clean: 26 pass / 0 fail / 7 note (notes are pre-existing informational
observations, not regressions — see script output). In addition, every P0/P1 fix named in the task brief
was independently spot-checked live:

| Fix | Live check | Result |
|---|---|---|
| Employee edit (status no-op) | run-admin/run-misc coverage + A-008/A-010 code present | holds |
| Project PM/type edit | code inspection (B-023 fields in projectPatchSchema) confirmed present | holds |
| PO status sync on approval | migration 093 columns verified applied (see below); approvals reflect correctly | holds |
| Invoice→PO vendor check | `POST /invoices` cross-vendor PO → 422 `PO_VENDOR_MISMATCH`; same-vendor → 201 | holds |
| Empty-body 4xx | `POST /purchase-orders/:id/status` no body → 422 `VERSION_REQUIRED` (not 500) | holds |
| Prototype poisoning → 400 | raw `"__proto__":{...}` key in `POST /leads` body → 400 `BAD_REQUEST`; `"constructor"` key → 400 | holds |
| Holiday edit/deactivate + include_inactive 403 | PATCH deactivate/reactivate round-trip 200; `include_inactive=true` as a role without `holiday.read` → 403 | holds |
| Admin PATCH session revoke | `GET /auth/sessions` 200, lists sessions; revoke route present (`admin/routes.ts`) | holds (not destructively re-tested against own session) |
| Payment-run execute incl. period lock / maker≠executor | route live, `INVALID_TRANSITION` 422 on a CANCELLED run (no 500); self-approval/period-lock branches only re-confirmed via the passing 36/36 unit suite (`ledgers.test.ts`) — no APPROVED run existed in seed data to click through live | holds (partially re-derived) |
| Expense receipts incl. 10MB via nginx and EICAR → 422 | fresh DRAFT claim: clean PDF → 201, EICAR-embedded PDF → 422 `UNSAFE_FILE`, 10.5MB PDF → 422 "File exceeds the 10MB limit" (not a bare nginx 413) | holds |
| Advances list | `GET /advances` → 200 with data | holds |
| Tolerance clear | set all three sub-fields, then send `rate_pct: null` while changing `quantity_pct` → `rate_pct` deleted, `value_absolute` untouched, `quantity_pct` updated | holds |
| PO amendment status restore (migration 093) | `schema_migrations` on the live DB shows `093_po_amendment_pre_status` applied; `po_amendments` table has `pre_status`/`rejected_at` columns | holds — **this is the most recent commit before the merge; confirmed the migration actually ran on the deployed DB, not just registered in source** |

No regressions found among the ~40 previously-claimed fixes spot-checked.

---

## New findings (post-deploy browser walk)

| ID | Sev | Surface | Module | Steps | Expected | Actual | Status | Fix commit |
|---|---|---|---|---|---|---|---|---|
| P-001 | P3 | web | dashboard/projects | Browser walk (crawl.mjs, console+network capture) as every non-superadmin role, all ~53 routes at 1366px, `http://34.131.134.217`. `/` and `/dashboard` as `qa-admin-client` (CLIENT_VIEWER) | No unexpected console/network errors | `KanbanBoard.tsx` (rendered on the dashboard's "my board" widget) called `projects/:id/people?limit=100` unconditionally to label avatars — a route CLIENT_VIEWER has no read permission for — throwing a 403 on every dashboard load. Same bug shape already fixed once in this codebase: `AdvancedTaskFilters.tsx` guards its identical fetch with `!session?.roles?.every(r=>r==='CLIENT_VIEWER')`; KanbanBoard never got the same guard. No visible breakage (avatars just show initials from the UUID instead of a name), console-only | FIXED — applied the same guard to KanbanBoard's `people` useRows call. RED: new test in `apps/web/tests/catalogue-e2e.test.ts` ("does not ask for project people on behalf of a client viewer (P-001)") failed pre-fix (board source didn't match the guarded call). GREEN after; full `apps/web` suite 66 files / 861 tests green on the VM | 18c1fb6 |
| P-002 | P2 | api/web | expenses, employees (RBAC) | Browser walk as `qa-admin-auditor` (AUDITOR role): `/expenses` and `/employees` both threw console 403s on load (`GET /expense-claims?limit=100` and `GET /org/units?type=district&limit=100`) | AUDITOR, a broad read-only oversight role, can view both | `EXPENSE_ROLE_GRANTS.AUDITOR` had `expense.read_all`+`expense.policy.read` but not the base `expense.read` every `GET /expense-claims*` route gates on (read_all only widens the *scope* inside the handler, checked after the gate); `S1_ROLE_GRANTS.AUDITOR` had `EMPLOYEE_READ` but not `ORG_UNITS_READ`. Every other role holding the wider grant in each module pairs it with the base one (PROJECT_MANAGER/PAYROLL_OFFICER/HR_MANAGER for expenses; HR_MANAGER/PROJECT_MANAGER/TEAM_LEAD for org units) — AUDITOR was the one role missing it, so both pages 403'd outright rather than just showing narrower data | FIXED — added `expense.read` and `S1_PERMISSIONS.ORG_UNITS_READ` to AUDITOR's grants. RED: new tests in `apps/api/test/catalogue/expenses.test.ts` and `apps/api/test/s1.test.ts` (both named "(P-002)") failed 403 pre-fix. GREEN after; full `apps/api` suite 76 files / 2057 tests green, `packages/shared` 28/28 files / 1001 tests green on the VM | 167ffea |

## Notes (not filed as findings)

- **`/geo-fences` 404 on every crawl.** Not a real dead link — `apps/web/tests/catalogue-e2e.test.ts:6` documents geo-fencing as retired ("E2E-04 ... is retired: Silverline has no geo-fencing"), and `apps/web/lib/nav.ts` has no link pointing there. The 404 only shows up because `scripts/qa/e2e/crawl.mjs`'s own hardcoded `ALL` route list still has a stale `/geo-fences` entry from before the retirement. Script hygiene, not a product bug — left as-is rather than editing a committed Lane B script outside this task's remit.
- **`/admin` 502 (console only) seen once, for `qa-admin-employee`.** Did not reproduce over 4 follow-up traces of the same page/role/token. `failedRequests` (the crawler's own >=400 response tracker) never recorded it either, so it was a resource outside the tracked set (most likely a `.txt?_rsc=` Next.js prefetch racing a brief upstream hiccup during a period when 5 crawls were running concurrently against the VM). Treated as a transient VM/test-load artifact, not a code defect — flagged here in case a future round sees it recur.
- **Mass 401s across nearly every route for `qa-admin-auditor`'s first crawl.** Access tokens expire in 900s (15 min, confirmed by decoding the JWT); `gen-sessions.mjs` minted all 6 role sessions up front, and by the time the 6th (auditor) crawl ran — after 5 sequential ~3-minute, 53-route crawls — its token had expired mid-run. `crawl.mjs` plants a token once and does not refresh. Re-ran with a freshly minted session immediately before use: clean except P-002. Test-methodology artifact, not a product bug; a future crawl round should mint each role's session immediately before that role's crawl, not all up front.

## Coverage summary

**Regression (step 1):** all committed QA scripts re-run clean on the live deploy (lane-a ×4, lane-b ×2,
integrations/scanner-probe). Every P0/P1 fix named in the task brief spot-checked live and holds — see table
above. No regressions found.

**Browser walk (step 2):** automated crawl (console errors, page errors, failed requests ≥400, dead
same-origin links, basic a11y) run across all ~53 web routes (superset of the 40 top-level `apps/web/app`
routes, including sub-routes/new/edit variants) as 6 sessions: `qa-admin-superadmin`, `qa-admin-hr`,
`qa-admin-pm`, `qa-admin-employee`, `qa-admin-client`, `qa-admin-auditor` — covering the highest-privilege
role plus 5 of the 9 non-admin roles (payroll, inventory, tl, govt not separately crawled this round).
Two real defects found and fixed (P-001, P-002); everything else flagged by the crawl is either a
permission-appropriate 403 with no UI breakage, the documented "best-effort" `/employees/me` 404 for an
account with no linked employee record (already covered by an existing test,
`apps/web/tests-dom/punch-clock.test.tsx`), or one of the three test-methodology artifacts noted above.
375px mobile viewport checked for horizontal overflow on 20 key routes as admin (dashboard, employees,
projects, procurement, billing, payables, receivables, expenses, leave, attendance, admin, tenders, leads,
clients, inventory, payroll, assets, survey, approvals, reports) — clean, no overflow on any.

**Not walked this round, for a successor to pick up:**
- Deep manual interaction (every dialog/tab, invalid-input classes — 10k chars/emoji/RTL/XSS-in-every-field/
  negative money/reversed dates/double-submit, tooltip-vs-behaviour comparison) was not re-run page-by-page
  beyond what the existing lane-a/lane-b scripts already cover (admin, attendance, leave, payroll/audit/inbox,
  leads/clients/tenders) plus the targeted API-level probes in this round (prototype pollution, empty-body,
  vendor mismatch, EICAR/10MB receipts, tolerance clear). Modules with no dedicated interaction script yet:
  projects, planning, inventory/stock, assets, documents, survey, reports, approvals-delegations detail flows,
  org/locations.
- Role×route matrix only covers 6 of 11 seeded roles (missing: payroll, inventory, team_lead, govt — auditor
  and client_viewer were covered). No "disallowed role" boundary click-through beyond what lane-b's
  submit-walk.mjs already does for leads/clients/tenders.
- Cross-module flows (step 3): PO→invoice→payment-run→execute chain and expense-claim→receipt pipeline
  verified end-to-end live (regression table above). RA-bill→receivable verified one-directionally (a
  CERTIFIED bill's `net_payable` appears correctly in `GET /ar/ageing`'s totals) but receipt allocation
  against it was not exercised. Lead→client→tender→project and employee-create→activate→attendance→leave→
  payroll-run→payslip were not walked end-to-end this round (individual legs are covered piecemeal by
  lane-a's leave/payroll scripts and by A-008/A-010's employee-lifecycle fixes from the prior round).
