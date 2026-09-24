# Findings ledger — R5 parity sweep (2026-09-24), deploy 2 live on dev-thor (main 0649788)

Post-deploy smoke (step 1), mobile↔web parity (step 2), offline queue (step 3), leftover minors (step 4).
IDs R5-001…

## 1. Post-deploy smoke

Regression scripts re-run clean against the live deploy (`http://127.0.0.1`):

| Script | Result |
|---|---|
| `scripts/qa/post/regression-spotcheck.mjs` | 12 pass / 1 informational (see note below) |
| `scripts/qa/lane-a/run-admin.mjs` | 7 pass / 1 note (of 8) |
| `scripts/qa/lane-a/run-attendance.mjs` | 6 pass / 0 fail |
| `scripts/qa/lane-a/run-leave.mjs` | 4 pass / 3 note (of 7) |
| `scripts/qa/lane-a/run-misc.mjs` | 9 pass / 3 note (of 12) |
| `scripts/qa/lane-b/submit-walk.mjs` | all checks pass (leads/clients/tenders valid+dup, role boundaries) |
| `scripts/qa/integrations/scanner-probe.mjs` (EICAR) | clean PDF → 201, EICAR-embedded PDF → 422 `UNSAFE_FILE` |

Note on `regression-spotcheck.mjs`'s one "FAIL": `payment-run execute (status=APPROVED) -> proper 4xx, not 500`
got `status=200`. This is the script picking up whichever payment run happens to be first
(`/payment-runs?limit=1`) and finding it in `APPROVED` state — which is the state execute is *supposed* to
succeed from. Not a regression; the assertion is stale for that state combination. All lane-a/lane-b "note"
lines are pre-existing informational observations (documented in earlier rounds), not regressions.

### Deploy-2 feature spot-check (live, as admin, `scripts/qa/post/smoke-deploy2.mjs`)

New script exercising every deploy-2 feature named in the brief directly against the live API with
throwaway QA- records (VM has no seeded stock/PO in a state that supports every scenario, so a couple of
checks fall back to a freshly-created record — noted inline). 20/20 pass, 0 failures:

| Feature | Check | Result |
|---|---|---|
| Vendor invoice + 3-way match | Invoice created with a line's real `po_line_id`, quantity = received qty, rate = the PO line's exact rate (matched to 4dp) → `POST /invoices/:id/match` | `matched: true`, no exceptions |
| Approval policy | `POST /approval-policies` (PURCHASE_ORDER, CUMULATIVE, one level) | 201 |
| Payment + allocation | `POST /payments` (PAYABLE, NEFT) then `POST /payments/:id/allocations` against the invoice created above | 201 / 201 |
| Bank CSV import, 1 bad row | `POST /bank-transactions/import` with one well-formed + one malformed (`value_date: "not-a-date"`) row | 422 `VALIDATION_ERROR`, whole batch refused — the good row was never written (confirmed via follow-up GET); a clean single-row import afterwards succeeds |
| Financial period close/reopen | Create → close (200) → reopen w/o reason (422, correctly refused) → reopen w/ reason (200) | all as expected |
| Shift | `POST /shifts` | 201 |
| Stock reservation | Found a location/item with real available stock (75 available) → reserve 1 (201) → attempt to over-reserve 10000 on top → 422 `INSUFFICIENT_STOCK` (confirms the stock-reservation concurrency fix holds for a fresh reservation) → release (200) |
| Tender instrument | `POST /instruments` (EMD, tied to the seeded tender) | 201 |
| Legal hold | Place (200, with If-Match) → delete attempt while held → 409 `RETENTION_BLOCKED` ("Under legal hold...") → release (200) | as expected |
| PO amend | Seeded PO was FULLY_RECEIVED (not amendable); found a PARTIALLY_RECEIVED PO and amended a line's quantity → 201, revision 2 | as expected |
| Document delete | Fresh throwaway doc (with `issued_on` so retention is computable) → delete, no hold → 200 | as expected |

R5-001 (P2, envelope inconsistency, not fixed — out of task-4 scope): `POST /api/v1/invoices`
(`apps/api/src/modules/inventory/routes.ts:355`, `return reply.code(201).send(row)`) sends the created row
bare, unlike every other create endpoint in the API (which wrap as `{data: row}`, including this same
route's own GET/PATCH-lines/match). No web screen calls this route directly today (payables' only invoice
UI is `VendorInvoiceLines.tsx`, which manages lines/match on an *existing* invoice and correctly reads the
wrapped envelope from GET), so nothing in the current UI is broken by it. Flagging because any client
written against the API's usual convention (as `smoke-deploy2.mjs` initially was) will silently get
`undefined` for `.data.id`.

## 2. Mobile ↔ web parity

Compared endpoint/field usage (`apps/mobile/src/api/endpoints.ts` vs. the equivalent web pages) and the
shared formatters both sides import (`apps/mobile/src/money.ts` / `@silverline/shared`'s `day()` vs.
`apps/web/lib/finance.ts`). Money formatting (paise-exact, Indian grouping, dash-for-absent) and date
formatting are already shared/consistent — the D-014 fix from an earlier round holds. Three concrete
status-tone divergences found; none affect the underlying data, all affect how urgent/severe a state
*looks* to the person switching between phone and desk:

| ID | Sev | Screens | Divergence |
|---|---|---|---|
| R5-002 | P2 | web `apps/web/app/payables/page.tsx` vs mobile `apps/mobile/app/payables.tsx` | Web: `on_hold` → `danger` badge, `disputed` → `warning` badge. Mobile: `on_hold` → `warning`, `disputed` → `danger` — the two tones are swapped. An invoice on hold reads as more severe than a disputed one on web, and the opposite on mobile. |
| R5-003 | P3 | web `financialTone()` (`apps/web/lib/finance.ts`) vs mobile `expenseStatusTone()` (`apps/mobile/src/expensesFormat.ts`) | `WITHDRAWN` claim: mobile → `danger` (red), web falls through `financialTone`'s `default` → `neutral` (grey, since `WITHDRAWN` isn't one of its cases). |
| R5-004 | P3 | same as above | `DRAFT` claim: mobile → `info` (blue), web → `neutral` (grey, same default-case reason). |
| R5-005 | P3 (informational) | web payables table (separate `contractual_due_date`/`statutory_due_date` columns, MSME row highlighted when statutory precedes contractual) vs mobile (`effective_due_date` only, "+ MSME" suffix) | Mobile collapses to the one number the server already resolved; not wrong, just less detail than web shows for the same invoice. Not filed as a bug — listed because the task asked for every divergence. |

Not fixed (out of task-4's specific list; logged per task-2's "list every divergence" instruction).

Attendance IST day-boundary and leave-balance display: both clients read pre-bucketed values from the API
(day boundaries are computed server-side against org timezone; the client never buckets locally), so no
client-side divergence risk there. Leave balances: see R5-008 below — the more consequential finding is on
the *data* side, not a display mismatch.

## 3. Mobile offline queue (`apps/mobile/src/sync/*`)

Read `queueCore.ts`, `engine.ts`, `policy.ts`, `replay.ts`, `api/sync.ts`, `api/client.ts`. Verified against
the live API rather than just by inspection:

- Replay after success → one effect. Live test: `POST /attendance/events` with a fixed
  `idempotency-key`, sent twice. First call → 201 (event created). Second call, same key → 200
  `{applied: true, event: {...same id...}}`. `classifySyncResponse` maps `applied:true` → `ALREADY_APPLIED`
  → `SUCCEEDED`, and the row's payload is blanked (`payload: "{}"`) rather than resent. Confirmed live: no
  duplicate attendance record.
- Replay after 409/422 → dropped with a user-visible reason. By code: `apiFetch` (`api/client.ts`)
  throws a typed `ApiError` for any non-2xx, before `postAttendanceEvent`'s own (dead) `!res.ok` branch is
  ever reached — `res.ok` there is hardcoded `true`, so that branch cannot execute; not a live bug since
  `apiFetch` already throws first. `queueCore.ts`'s `flushQueue` catch block picks up the thrown error:
  `status !== 401` and `!retryable` → row goes `FAILED`, `decision: status===409 ? 'CONFLICT' : 'REJECTED'`,
  `error: describeApiError(err, err.message)` — the server's own message (e.g. the specific
  `DUPLICATE_CHECKIN`/`VALIDATION_ERROR` text), shown on the sync-queue screen. Not silently dropped.
- Expired token mid-queue → refresh, then continues. `api/client.ts`'s `apiFetch` has a built-in
  401 → single refresh attempt → retry-once cycle, independent of the queue; a queued op that
  hits this transparently gets a fresh token and its request retried within the same executor call. If the
  refresh itself fails, `apiFetch` clears tokens and throws `UNAUTHENTICATED`; `syncNow()`'s
  `account !== await getAccount()` check then halts the rest of the flush rather than burning retries on a
  dead session.

No offline-queue bugs found. One design note (not filed as a bug): `postAttendanceEvent`'s local
`if (!res.ok)` branch is dead code (the hardcoded `ok: true` above it means it can never run) — harmless
today because `apiFetch` throws first, but worth deleting next time that file is touched so it doesn't
mislead a future reader into thinking it's live.

## 4. Leftover minors from the last review

R5-006 (a) FIXED — `apps/web/lib/finance.ts` `PAYMENT_MODES` duplicate.
`finance.ts` kept its own hand-copied list (`NEFT, RTGS, IMPS, UPI, CHEQUE, CASH, PAYROLL` — no `DD`, no
`ADJUSTMENT`) beside the real one in `packages/shared/src/financial-control.ts`.
`paymentRunExecuteSchema` (`apps/web/lib/validation.ts`) and therefore `ExecutePaymentRunForm`'s mode
picker read the stale local copy — a payment run settled by demand draft or adjustment had no way to
record that on execute. `expenses/page.tsx`'s reimbursement mode picker read the same stale list.
Fix: `finance.ts` now re-exports `PAYMENT_MODES` from `@silverline/shared` instead of duplicating it;
`validation.ts` now imports the shared list directly for the execute schema (removed the redundant
`@/lib/finance` import); the stale "one list rather than a second that drifts" comment (which was
describing the exact bug it sat next to) is corrected. RED: `payables-execute.test.tsx` new test asserting
the mode `<select>` offers all 9 shared modes, failing pre-fix (7 options, no DD/ADJUSTMENT). GREEN after.
Commit `9bc69a8`.

R5-007 (b) FIXED — stock-reservations: ungated list + duplicate panel.
`StockReservationsTab.tsx` (inventory Workbench's "Reservations" tab) showed its list unconditionally —
every other reservation control there (create, release) was already gated on `reservation.manage`, but the
list itself checked nothing, unlike the API route it reads (`reservation.read`). The same data was shown a
second time, read-only, from `StockSection.tsx` (the "Locations" tab), correctly gated but redundant.
Fix: wrapped `StockReservationsTab`'s list `Panel` in `<Can permission="reservation.read">`; removed
`StockSection`'s duplicate panel entirely (kept `StockReservationsTab` as the one screen, since it also has
the create/release forms `StockSection` never had). RED: new tests — `stock-reservations.test.tsx` ("the
reservations list itself is gated on reservation.read", asserting nothing renders for a no-access session)
and `stock-section-reservations-dup.test.tsx` ("no longer shows its own Reservations panel") — both failing
pre-fix. GREEN after. Commit `58c8e88`.

R5-008 (c) P1 GAP, logged not built — no leave-balance year-rollover mechanism.
Checked `apps/api/src/modules/leave/routes.ts` and `apps/api/src/modules/jobs/scheduled.ts` (the only
scheduled-job runner in the codebase — SLA alerts + report schedules, nothing leave-related) end to end:
there is no year-rollover or accrual job anywhere, scheduled or not. The only place a `leave_balances`
row gets a non-zero `opening_balance` is the admin "Adjust opening balance" dialog
(leave balances page, `leave.admin` permission) — a manual, one
employee × leave-type × year action with no bulk/org-wide equivalent.

Deploy-2's D-011 fix (leave split across years) does make the *request* side correct: applying for leave
that spans a year boundary now checks each year's days against that year's own balance, and self-heals a
missing `leave_balances` row via `INSERT ... ON CONFLICT DO NOTHING` so the balance query never errors.
But a self-healed row starts at `opening_balance = 0, credits = 0` — it exists, it just has nothing in it.

Live evidence (2026-09-24, employee QA-EMP-ALPHA):

    GET /leave/balances?employee_id=<QA-EMP-ALPHA>&period_year=2027  →  {"data": []}   (no row yet)

    POST /leave/requests { leave_type_id: CL, from_date: 2026-12-29, to_date: 2027-01-03, ... }
      → 422 INSUFFICIENT_BALANCE
        "Insufficient leave balance in 2027 (available: 0, requested: 3)"

An employee applying today for leave that runs three days into January would be refused for those three
days, purely because nobody has opened 2027 balances yet for them — not because they lack entitlement.

Proposed fix (not built, per instructions — this is a scope/policy decision, not a one-line patch):
add a scheduled job (in `apps/api/src/modules/jobs/scheduled.ts`, alongside the existing SLA/report-
schedule runner) that, ahead of each organisation's year boundary (org timezone), bulk-creates next-year
`leave_balances` rows for every active employee × leave-type-requiring-balance, with the opening balance
set from each leave type's policy-defined annual entitlement (and any carry-forward rule the policy
defines — the leave-type schema would need to say whether unused balance carries forward or lapses, which
it does not appear to today; worth confirming with the leave policy owner before implementing). Until that
exists, the interim workaround is procedural: an admin must run the "Adjust opening balance" dialog for
every employee/leave-type before the turn of the year, or a request that reaches into January will 422
until they do.

## 5. Fix batch (2026-09-24, branch `qa/r5-parity`)

Implements R5-001, R5-002/003/004, R5-008 and mobile-parity item 4, plus two owner decisions
the coordinator added mid-batch (D-012 sandwich rule; carry-forward = lapse for R5-008). TDD
throughout: RED shown per item below, then the fix. Full suites (shared/api/mobile/web) run green
on the VM after every item; web `tsc --noEmit` and `next build` also clean. Commits are grouped by
the files they touch rather than strictly one-per-numbered-item — see the DECISION at the end of
each item where that applies.

### R5-008 — leave-balance year rollover (P1 GAP → built)

**Plan.** Add `POST /api/v1/leave-balances/open-year` (leave.admin): for every ACTIVE employee ×
balance-requiring leave type in scope (optional `employee_ids`/`leave_type_ids` filters), create a
`leave_balances` row for `year` at the type's `annual_entitlement`, `ON CONFLICT DO NOTHING` on the
existing `uk_leave_balance(employee_id, leave_type_id, period_year)` unique key (already present —
no migration needed). `year` restricted to current/current+1 (IST). `?dry_run=1` returns the same
`{year, created, skipped, total}` counts without writing. Web: a button + confirm dialog on the
leave-balances admin screen, dry-run preview before commit, plus a from-1-December banner.

**DECISION (owner, 2026-09-24, relayed by coordinator):** carry-forward = lapse. The endpoint never
reads the prior year's balance; every opened row starts at the plain `annual_entitlement` and
nothing more. Recorded in the route's own comment (`apps/api/src/modules/leave/routes.ts`) and in
the shared schema's docstring (`packages/shared/src/s3.ts`), not left as an open placeholder.

**RED.** `apps/api/test/s3.test.ts`, new `describe("leave balances: open-year (R5-008)")`: 7 tests
(create-at-entitlement, idempotent-on-rerun, employee/type filters, dry-run-writes-nothing,
year-out-of-range 422, permission 403, cross-org isolation) — all 404 pre-fix (route didn't exist).
`apps/web/tests-dom/leave-open-year.test.tsx`, new file: 6 tests for the button/dialog/banner —
failed pre-fix (`openYearBalances` / `LeaveBalancesPanel` didn't exist).

**GREEN.** All above pass; full API suite 2149/2149, web suite 963/963.

**Files.** `apps/api/src/modules/leave/routes.ts`, `packages/shared/src/s3.ts`,
`apps/api/test/s3.test.ts`, `apps/web/lib/leave.ts`, `apps/web/lib/query-keys.ts`,
`apps/web/components/LeaveBalancesPanel.tsx` (new — moved out of `page.tsx`, see below),
`apps/web/app/leave/balances/page.tsx`, `apps/web/tests-dom/leave-open-year.test.tsx` (new).
Commits `10a7d8d`, `d9775c2`.

### D-012 — sandwich rule for paid leave (owner decision, added mid-batch → FIXED)

**Plan.** For PAID leave types, a Sunday or the employee's effective holiday inside the range is a
paid day off already and must not be deducted a second time; unpaid (LOP) keeps counting every
calendar day. Apply at the one place the balance check (filing), the re-check (approval) and the
debit already shared: `daysByYear()` in `apps/api/src/modules/leave/routes.ts`, which now takes a
`skipDates` set. New `sandwichSkipDates()` builds that set from Sundays plus
`resolveEffectiveHolidays()` (the same scope-precedence holiday resolution payroll already uses,
restricted to `active = true` rows) — called only when `leave_types.is_paid`. Filing's stored
`total_days` is now the sum of the (skip-aware) per-year day counts, so the figure web/mobile
display is correct at the source; neither client recomputes it independently.

Payroll cross-check: `calculatePayslip` (`packages/shared/src/p1.ts`) already computes its own
day-by-day calendar from `leave_requests` + holidays + Sundays, independent of
`leave_requests.total_days`, and a day is either Sunday/holiday (`paidOffDays`) or working
(`paidLeaveDays`/`lopLeaveDays`/`absentDays`), never both — so payroll was never double-counting a
paid-leave Sunday/holiday as an absence, and this change doesn't touch payroll at all. LOP/unpaid
payroll is unaffected (the skip set stays empty for unpaid types, same as before).

If the leave-type schema had lacked a paid/unpaid flag, `is_paid` (used by payroll already) would
have stood in for it — it did not need to, `leave_types.is_paid` already exists.

**RED.** New `describe("D-012 sandwich rule: paid leave does not debit Sundays/holidays")` in
`apps/api/test/s3.test.ts`, 5 tests: a paid Friday–Monday range debits 3 of 4 days (Sunday
excluded); the same range with a Saturday holiday added debits 2; the identical range as unpaid LOP
debits all 4; a withdrawn (inactive) holiday is not excluded (back to 3); a year-crossing paid
request splits by year with each year's own Sundays excluded, and the two years' debits sum to 6
of 7 (any 7-day span has exactly one Sunday, so this is deterministic regardless of run date). All
5 failed pre-fix (deducted full calendar days).

Pre-existing tests silently broken by the fix (found by running the suite, not by inspection):
several fixed-offset CL ranges (`plusDays(30)`..`plusDays(34)`/`plusDays(31)`) happened to straddle
a Sunday under today's calendar (2026-09-24), so `total_days`/`consumed` assertions hardcoded to the
old calendar-day count started failing. Fixed in `apps/api/test/s3.test.ts` (3 tests),
`apps/api/test/catalogue/e2e.test.ts` (1) and `apps/api/test/catalogue/ut-lp.test.ts` (1) by
computing the expected count via a small `workingDaysCount()` test helper instead of a literal, so
they hold on any run date rather than being re-broken by the calendar next time. Checked
`apps/api/test/catalogue/integrity.test.ts`'s D-011 year-crossing test (fixed Dec 30–Jan 2 range) —
no Sunday in that particular range, left as-is.

**GREEN.** Full API suite 2149/2149 (includes all of the above).

**Files.** `apps/api/src/modules/leave/routes.ts` (same commit as R5-008 — both changes are
concentrated in this one file's day-counting logic and didn't split cleanly into separate commits;
recorded as a DECISION rather than forced apart), `apps/api/test/s3.test.ts`,
`apps/api/test/catalogue/e2e.test.ts`, `apps/api/test/catalogue/ut-lp.test.ts`. Commit `10a7d8d`.

### R5-001 — POST /api/v1/invoices envelope (P2 → fixed)

**Plan.** Checked the actual convention before touching anything: `apps/api/src/modules/inventory/routes.ts`
has several other bare-body creates in the same file (vendors/items/assets/inventory-transactions,
all via the same `reply.code(201).send(row)` pattern) — the file is *internally* consistent, just not
consistent with the rest of the API. Fixed only the route named in the finding (invoices), per the
brief's literal scope; left the sibling bare routes alone as a **DECISION** (broadening to the whole
file is a separate, unscoped change with its own blast radius). Audited every consumer before
changing it: no web/mobile screen creates an invoice via this route today (confirmed again); the
QA scripts (`scripts/qa/post/smoke-deploy2.mjs`, `scripts/qa/seed-qa.mjs`) already read both shapes
(`body?.data?.id ?? body?.id`); `apps/api/test/catalogue/procurement.test.ts`'s own `send()` helper
already denests (`data: body?.data ?? body`) — so of the ~18+5 invoice-creation call sites in tests,
only `apps/api/test/v2.test.ts`'s 4 bare `.json().field` reads needed updating (its `call()` helper
returns the raw body; each test decides bare-vs-wrapped itself, matching that route's actual shape).

**RED.** New test in `apps/api/test/catalogue/procurement.test.ts`, "wraps the created invoice in
the {data:...} envelope like every other create" — asserts on the *raw* body (`res.body`, not the
tolerant `res.data`), so it actually pins the wire shape. 201 with `res.body.id` present and
`res.body.data` absent, pre-fix.

**GREEN.** New test passes; full API suite 2149/2149 (the 4 previously-missed `v2.test.ts` failures
were caught by the VM run and fixed in a follow-up commit — see below).

**Files.** `apps/api/src/modules/inventory/routes.ts`, `apps/api/test/catalogue/procurement.test.ts`,
`scripts/qa/post/smoke-deploy2.mjs` (stale comment). Commit `7ae5411`. Follow-up
`apps/api/test/v2.test.ts` fix (4 assertions, found only by running the suite — no literal
`/api/v1/invoices` string to grep for, it calls a generic `call('POST','invoices',...)` helper) in
commit `616100f`.

### R5-002/003/004 — status-tone maps, and mobile-parity item 4

**Plan.** Move each status/flag → tone mapping into `packages/shared` as the one source web and
mobile both read, instead of each keeping its own switch statement:

- `PAYABLE_INVOICE_FLAG_TONES` (`financial-control.ts`): payables `on_hold`/`disputed`. Mobile had
  the two severities swapped (R5-002).
- `EXPENSE_CLAIM_STATUS_TONES` (`expenses.ts`): `WITHDRAWN`/`DRAFT` fell through web's generic
  `financialTone`'s silent neutral default; mobile's explicit colours are kept (R5-003/004).

Task 4 ("compare every OTHER mobile screen... fix P2+ using the shared maps from item 2 where
possible") turned up the identical class of bug three more times while sweeping the remaining
screens — fixed the same way rather than just logged, since the mechanism was already built:

- `RA_BILL_STATUS_TONES` (`ra-billing.ts`): `financialTone` has no case for RA-bill `PAID` (only the
  differently-spelled `RECEIVED`) or `DRAFT`; both read neutral grey on web, mobile had them right.
- `PR_STATUS_TONES` / `PO_STATUS_TONES` (`procurement.ts`): mobile disagreed with web on a
  requisition's `CONVERTED`/`DRAFT` and, most visibly, a purchase order's `APPROVED` (read as
  still-pending amber on mobile instead of web's settled green). Also fixed a web-side gap of the
  same shape while at it: `FULLY_RECEIVED` fell through `financialTone`'s default on web too (only
  `CLOSED` and the differently-spelled `RECEIVED` were cases) — now success on both platforms.
- The same disputed-flag severity swap as R5-002, independently, on receivables and project-finance
  (RA bill) screens (`apps/mobile/app/receivables.tsx`, `apps/mobile/app/project-finance.tsx`):
  mobile showed `DISPUTED` as danger where web says warning.

`apps/web/lib/finance.ts` gains one thin per-entity function per map (`payableFlagTone`,
`expenseClaimTone`, `raBillTone`, `requisitionTone`, `poTone`); `StatusBadge`
(`apps/web/components/finance/Primitives.tsx`) takes an optional `tone` override so a screen can
hand it an entity-specific tone instead of the generic `financialTone` lookup. Mobile's `*Format.ts`
modules (`expensesFormat.ts`, `ledgersFormat.ts`, `raBillsFormat.ts`, `procurementFormat.ts`) now
delegate to the shared maps instead of hand-rolled switches.

**Screens checked but not changed** (read the mobile screen against its web equivalent; no P2+
divergence found beyond what's listed above): attendance (already covered in round 4, §2 above —
both clients read pre-bucketed server values), documents, tenders, approvals, clients, assets,
asset-movements, automation, planning, pipeline, tasks, reports, inbox, analytics, employees,
payroll, holidays. Not a field-by-field audit of every one — time-boxed to the tone-mapping class of
bug the earlier findings established as the recurring pattern; a deeper pass (labels, field
presence, formatting) on the untouched screens is follow-up work, not done here.

**RED.** `packages/shared/src/financial-control.test.ts`, `expenses.test.ts`, `ra-billing.test.ts`,
`procurement.test.ts`: new tests asserting each map's values (would fail to import — the exports
didn't exist — pre-fix). `apps/web/tests/finance.test.ts`: new tests for all five web tone
functions. `apps/mobile/test/procurement-format.test.ts`: rewrote the existing
`requisitionStatusTone`/`poStatusTone` assertions to the corrected values (the old ones pinned the
bug — `CONVERTED`→success, `APPROVED`(PO)→warning, etc. — and would now fail against the fix, which
is the point: they document what changed and why). `apps/mobile/test/expenses-format.test.ts`,
`apps/mobile/test/ra-bills-format.test.ts` already asserted the correct (mobile-original) values, so
they serve as regression coverage post-refactor with no changes needed.
`apps/mobile/test/ledgers-format.test.ts`: new test for `payableFlagTone`.

**GREEN.** Full suites: shared 1027/1027, api 2149/2149, mobile 420/420 (+ `tsc --noEmit` clean),
web 963/963 (+ `tsc --noEmit` clean, `next build` exit 0).

**Files.** `packages/shared/src/{financial-control,expenses,ra-billing,procurement}.ts` (+ matching
`.test.ts`), `apps/web/lib/finance.ts`, `apps/web/components/finance/Primitives.tsx`,
`apps/web/app/{payables,expenses,billing,procurement}/page.tsx`, `apps/web/tests/finance.test.ts`,
`apps/mobile/src/{expensesFormat,ledgersFormat,raBillsFormat,procurementFormat}.ts`,
`apps/mobile/app/{payables,receivables,project-finance}.tsx`,
`apps/mobile/test/{ledgers-format,procurement-format}.test.ts`. Commits `a4f95ea`, `a6d62f9` (a
`Tone`-widening type fix caught by mobile `tsc --noEmit`, not vitest).

### Remaining known gaps (not built, per brief scope)

- **R5-008's underlying design gap is still open**: the *manual* open-year action now exists, but
  there is still no *automatic* scheduled job that opens next year's balances on its own ahead of
  the boundary — an admin (or the December banner prompting one) has to act. Building that job is
  explicitly out of scope here (see §4 above); this batch only builds the tool an admin/the banner
  needs.
- **R5-005** (payables due-date detail on mobile) — informational only, not filed as a bug, not
  touched.
- The pre-submit day-count preview on the web leave request form (`inclusiveDays()` in
  `apps/web/lib/leave.ts`, used by `LeaveRequestForm.tsx`'s "N day(s) (inclusive)" badge) still
  shows the raw calendar-day count, not sandwich-rule-aware — it's an estimate shown before
  submission; the authoritative figure (`total_days` returned by the API and shown afterward, in
  lists and in mobile) is correct. Flagging as a minor known cosmetic gap rather than fixing, to
  keep this batch's scope to the named items; the client has no holiday calendar loaded to compute
  it correctly client-side without an extra request per keystroke.
