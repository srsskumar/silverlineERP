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

---

## Round 2 (2026-09-24, same commit `7bd6f7d`) — deep interaction walk + two E2E flows

Worktree/branch unchanged (`qa/post-deploy`). Scope: finish P-001/P-002 properly (permission-based gating,
migration reaching the deployed DB), sweep every `ROLE_GRANTS` map for the same class of bug, deep-interact
projects/planning/inventory/assets/documents/survey/reports/approvals/org as admin + payroll/inventory/
team_lead/govt, and click through two E2E flows fully in the UI.

### P-001/P-002 follow-through

- **P-001 (round 2):** the round-1 fix gated `KanbanBoard.tsx`'s people fetch on
  `!session?.roles?.every(r=>r==='CLIENT_VIEWER')`, copied from `AdvancedTaskFilters.tsx`. Both fetches are
  actually gated server-side on `task.read` (`GET /projects/:id/people`, `GET /custom-fields`,
  `planning/routes.ts`) — a permission CLIENT_VIEWER holds and GOVT_OBSERVER (this round's new role) does
  not. The role-name check let CLIENT_VIEWER's fetch through only by getting the specific case right, while a
  role with none of `task.read` (GOVT_OBSERVER, empty grants) still sailed past it and 403'd. Fixed both
  components to gate on `hasPermission(session, PERMISSIONS.TASK_READ)`. Commit `45ef739`.
- **P-002 (round 2):** the round-1 code fix (AUDITOR's `expense.read`/`org.units.read`) never reached the
  deployed database — `role_permissions` is filled once by the seed at bootstrap, and a source change to
  `ROLE_GRANTS` doesn't touch an already-seeded environment. Added migration `097_auditor_base_reads.sql`
  (registered in `migrate.ts` after 093, with 094-096 left as a gap for `qa-gaps3`'s branch). Swept every
  `*_ROLE_GRANTS` map in `packages/shared` for the same class of bug (a widening grant held without its base
  permission): `expense.read_all` and `approval.read_all` are the only two such permissions in the whole
  codebase, and both are correctly paired everywhere else — AUDITOR was the only gap, now closed. Commit
  `5279f27`.
- **New instance of the same bug class, found live during the govt crawl:** `GOVT_OBSERVER` held only
  `survey.dashboard` — every other role (including narrowly-scoped ones like CLIENT_VIEWER/PAYROLL_OFFICER/
  INVENTORY_MANAGER) also holds `notification.read`, needed because the Inbox nav item is shown to every
  signed-in user regardless of role. Opening `/inbox` as a government observer 403'd. Fixed (`S5_ROLE_GRANTS`
  + migration `098_govt_observer_notification_read.sql`). `SALES_BD_EXECUTIVE`/`BID_TENDER_MANAGER` likely
  have the identical gap but were not reproduced live this round (no seeded QA session for either) — flagged
  as a GAP below rather than changed blind. Commit `fd4a046`.

### New findings: features with a complete backend and zero web UI

Found by cross-checking every `guard()`-ed permission code in `apps/api/src/modules` against `apps/web` for
at least one reference (a permission a route enforces but that never appears anywhere in the web app source
is either reachable some other way, or has no UI at all). 31 candidates came back with zero references;
most were false positives (masters shown a different way, or genuinely admin-only automation). Two were real
gaps sitting exactly in the modules this round's brief called out for a deep walk, and were fixed:

| ID | Sev | Module | Summary | Status | Fix commit |
|---|---|---|---|---|---|
| P-003 | P1 | documents | `POST /documents/:id/legal-hold` has existed since migration 048 (`document.legalhold` to place, `document.legalhold.release` to release, per REQUIREMENTS_DOCUMENTS.md §46.6.2) — the register page only ever rendered a read-only "Legal hold" badge. An auditor holding the permission the product grants them for exactly this had no way to use it. | FIXED — added Place/Release hold actions per register row, gated per-permission, reason required to place (matches `legalHoldSchema`). 4 new DOM tests. | 077be17 |
| P-004 | P1 | procurement | `POST /purchase-orders/:id/amend` has existed since it closed "the gap where po_amendments was a table with no endpoint" — the order detail screen showed amendment *history* but nothing ever called the endpoint to start one. Round 1 called PO-amendment status-restore "the riskiest item" and verified the migration + API-level logic, but never checked a human could reach it from the UI at all. | FIXED — added `AmendOrderForm.tsx` (reason + optional per-line qty/rate + delivery date), wired behind `po.amend` and the same non-amendable statuses the route itself rejects. 2 new DOM tests. | 67af815 |

**Remaining candidates, logged as GAPs (not fixed — each is a multi-hour feature build, not a QA-round-scoped
fix, and several risk collision with `qa-gaps3`'s vendor-invoice/three-way-match/MSME work in the same
files):**

- **`approval.configure` / `GET,POST /api/v1/approval-policies` — no UI anywhere to define an approval
  ladder.** Existing policies are seeded directly into the DB, all project-scoped, with no org-wide
  fallback for any document type. **Reproduced live and made the E2E-A flow below fail on the first
  attempt:** a requisition raised with no project (`NewRequisitionForm`'s "Project (optional)" field
  explicitly allows this) got `422 NO_APPROVAL_POLICY` on submit — a dead end nobody could recover from
  through the product, since there's also no UI to create the missing org-wide policy. Worked around for the
  E2E walk by using a project that already has seeded PR/PO ladders (`QA-SEED-ACTIVE`). Recommend either
  building the approval-policy admin screen, or seeding an org-wide fallback per document type, before this
  is relied on in production for anything not already covered by the three seeded projects.
- **Finance module with no web presence at all:** `payment.manage`/`payment.read`/`payment.allocate`
  (`POST/GET /api/v1/payments`, `/payments/:id/allocations`), `bank.read`/`bank.reconcile`
  (`/bank-transactions`, `/bank-transactions/import`, `/bank-transactions/:id/reconcile`), `period.manage`/
  `period.read` (`/financial-periods`, `/financial-periods/:id/closure`). None of these endpoints, or the
  permissions gating them, appear anywhere in `apps/web`. Sits in `apps/api/src/modules/finance/routes.ts`
  alongside the vendor-invoice routes `qa-gaps3` owns — flagged here rather than touched.
- **`costhead.manage`/`costhead.read`** (`/cost-heads`) and **`budget.manage`/`budget.read`**
  (`/projects/:id/budget`) — cost-control masters with no UI.
- **`roster.manage`/`roster.read`** (`/shifts`) — no UI.
- **`reservation.manage`/`reservation.read`** (`/stock-reservations`, `/stock-reservations/:id/release`) —
  no UI (separate from the Inventory Stock/Locations/Vendors/Invoices tabs, which are all wired up).
- **`instrument.manage`/`instrument.read`** (`/instruments` — EMD/BG for tenders) — no UI.
- **`document.delete`** — no UI control anywhere to delete a register entry (retention/legal-hold still
  block it server-side regardless; this is a missing capability, not a security gap).
- **`SALES_BD_EXECUTIVE`/`BID_TENDER_MANAGER` likely missing `notification.read`** — same shape as the
  GOVT_OBSERVER fix above, not reproduced live (no seeded QA session for either role this round).

### Deep interaction walk (admin unless noted)

- **Projects — new-project form:** blank submit correctly disabled (not silently accepted); 10k-char
  description and a `<script>`/`onerror` payload in the name both accepted client-side, rejected/escaped
  correctly everywhere it renders later (detail page + list — no raw `<script>` in the DOM, no marker
  execution). Reversed dates (end before start) → 422, shown inline, not a bare console error.
  Double-click-submit is structurally prevented app-wide: `Button`'s `loading` prop sets `disabled`
  synchronously, and every mutation form disables its submit while pending — verified by source (`Button.tsx`,
  `Workbench.tsx`'s `MutationForm`), not re-tested field-by-field.
- **XSS, broadly:** `grep dangerouslySetInnerHTML apps/web` returns only `app/layout.tsx` and
  `app/global-error.tsx` (neither renders user content) — every other screen renders through plain JSX text
  nodes, which React escapes unconditionally. Spot-checked live on the project name (confirmed clean) rather
  than re-testing every field individually, since the escaping is structural, not per-field.
- **Kanban board — real drag:** dragged a card from TO_DO to IN_PROGRESS via actual `page.mouse` pointer
  events (dnd-kit's `PointerSensor`, not native HTML5 DnD) on a real project board; verified via API that the
  task's status actually moved server-side. Clean, no console/network errors.
- **Reports:** generated a Tasks report through the real form (not the API script round 1 used) — correctly
  shows "Report queued…" for an async (>5000-row-cap) result rather than a blank/broken state; blank-type
  submit shows an inline validation message and does not navigate away. Type-gating (disabled options
  naming the missing permission) verified by source read.
- **Documents / Procurement:** see P-003/P-004 above.
- **Role crawls — payroll, inventory, team_lead, govt** (all ~53 routes, console+network capture, same
  method as round 1's crawl): payroll and inventory clean (all flagged items are permission-appropriate
  403s on modules those roles don't touch — assets/automation/billing/clients/leads/procurement/tenders for
  payroll; automation/billing/expenses-policies/expenses-reports/leads/tenders for inventory — same
  "no UI breakage" pattern round 1 already established as not a bug). team_lead clean (same pattern, plus
  the pre-existing documented `/employees/me` 404 for an account with no linked employee). govt flagged 15
  routes, all the same permission-appropriate-403 pattern (GOVT_OBSERVER holds almost nothing) — resolved
  the one real bug among them (P-002/notification.read) above.
- **Custom fields, SLA policy, cycles, holidays, inventory Locations, assets register/issue:** all built on
  the same `MutationForm`/`Collection` scaffolding already verified structurally safe (React escaping,
  server-side zod validation with field-level errors via `ErrorCard`, `Button`'s built-in double-submit
  guard) — not independently re-clicked field-by-field beyond the projects-form pass above, since the risk
  surface is shared code already exercised there. Server-side numeric floors confirmed by source read
  (`stockCount.counted_quantity: z.coerce.number().finite().min(0)`, SLA policy's day-ordering `.refine()`).
- **Not reached this round, for a successor:** survey (setup/entry/QC/billing) interaction beyond what the
  earlier employee/leave flow touched; asset movements; tooltip-text-vs-behaviour comparison; org/holidays
  invalid-input classes beyond round 1's edit/deactivate coverage; one disallowed role per module beyond what
  the four role crawls above already surfaced incidentally.

### Two E2E flows, fully through the UI

**Flow A — requisition → PO → approval → GRN → payment run build → approve → execute.** Multi-actor to
respect maker-checker (the same identity can't decide its own request): raised as `qa-admin-superadmin`
(global project scope, and not itself an approver on either ladder so it never self-blocks), requisition
approved by `qa-admin-pm` (PROJECT_MANAGER, L1 — the ₹4,000 value never reached the ₹500,000 L2 threshold,
so a single approval fully approved it, correctly), PO raised from the approved requisition (line + total
inherited correctly: ₹4,000, `requisition_id` matches), approved by `qa-admin-pm` again (L1, different
document), GRN recorded for the full ordered quantity → PO reached `FULLY_RECEIVED` (10/10 accepted). Payment
run built by `qa-admin-payroll` (PAYROLL_OFFICER — builds, cannot approve) against everything outstanding
on the seed data (₹1,071,818.23; a second run against the same cutoff correctly built ₹0.00, since nothing
was left unclaimed), released/approved and executed by `qa-admin-superadmin` — final status `PAID`, line-item
sum exactly equal to `total_amount`, `executed_at` set. **Totals and statuses agreed at every step.** Vendor
invoices are `qa-gaps3`'s domain, so this flow deliberately never created one — the payment run was built
against pre-existing outstanding payables rather than an invoice raised against this specific PO/GRN. The
`NO_APPROVAL_POLICY` GAP above was found in the course of this flow (first attempt, a project-less
requisition).

**Flow B — employee create → activate → leave apply/approve → payroll run → payslip.** Employee created by
`qa-admin-hr` (DRAFT) → activated (`ACTIVE`) via the real `ActivateDialog`. Self-service leave apply/approve
needs a login linked to the employee record, which a brand-new employee doesn't have and provisioning one
was out of scope for this pass — used the existing `qa-admin-employee` account (a genuinely different,
pre-linked employee) for this leg instead: filed a 2-day LOP request (their CL/EL balance was 0, so LOP —
needing no balance — exercised the same apply/approve mechanics) as `qa-admin-employee`, decided by the
request's actual `current_approver_id` (the org's seed `admin` account, resolved by the leave engine's
fallback-approver chain, since this employee has no `reports_to` set — HR alone, despite holding
`leave.manage`, could not even read someone else's pending request: `GET /leave/requests/:id` 404's unless
you're the requester or the current approver). Decision recorded, status → `APPROVED`. Payroll run: created
for August 2026 (a past period with real attendance data — the current/future months already had runs from
earlier QA rounds, and a period with no elapsed attendance can't calculate at all, correctly) →
Calculate (async job) → Submit for review → Approve → Lock, all four transitions confirmed via the UI action
button and a polled API check. Final run: `LOCKED`, 79 employees, `total_net` ₹370,682.90; payslips endpoint
(paginated — default page size is 20, easy to undercount without `?limit=`) returns exactly 79 rows summing
to the same ₹370,682.90. **Totals and statuses agreed at every step.**
