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
route's own GET/PATCH-lines/match). Payables' own invoice UI (`VendorInvoiceLines.tsx`) only manages
lines/match on an *existing* invoice and correctly reads the wrapped envelope from GET, so that screen is
unaffected. **Correction (fix round 1, item 6):** the claim that no web screen creates an invoice through
this route was wrong — the Inventory page's "Invoices" tab (`apps/web/app/inventory/page.tsx`) has a
"Record invoice" panel built from the generic `<MutationForm path="invoices" .../>`, which does POST here.
It was never actually broken by the bare shape, and works unchanged after the R5-001 fix wrapped it,
because `MutationForm` submits through `apiRequest()`, whose `unwrap()` already tolerates both a bare body
and a `{data:...}` envelope (see `apps/web/lib/apiClient.ts`) — confirmed with a dedicated DOM test
(`apps/web/tests-dom/invoice-mutation-form-envelope.test.tsx`) rather than left to inspection. Flagging was
still correct: any client written against the API's usual convention (as `smoke-deploy2.mjs` initially
was) would have silently gotten `undefined` for `.data.id`.

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
  **Closed in fix round 1, item 2** — see §6: `GET /api/v1/leave/preview` now gives both clients
  the server-computed figure directly, so this is no longer a gap.

## 6. Fix round 1 (2026-09-25)

Addresses seven numbered items raised against the round-1 write-up (§5), plus two owner decisions
the coordinator added mid-round. TDD throughout; RED shown per item. Commits are grouped by the
files they actually touch, same rationale as §5 — several items are concentrated in
`apps/api/src/modules/leave/{routes.ts,openYear.ts}` and don't split along the numbered
boundaries without forcing unrelated hunks apart.

### Item 1 (important) — open-year skipped an employee whose next-year row existed at opening 0

**Bug, exactly as reported.** Filing self-healed a `leave_balances` row for *every* year a leave
touched — including a year the sandwich rule (D-012) leaves at 0 days, now possible since fix
round 1 didn't exist yet when D-012 shipped in the original batch. Example given: paid CL Fri 31
Dec–Sun 2 Jan with 1 Jan a holiday — the new year's share is 0, but a row got created anyway, and
open-year then saw "row exists" and skipped it forever, so the employee started the year with
nothing.

**Fix, both sides:**
- Filing (`apps/api/src/modules/leave/routes.ts`): a year the request costs 0 days in is skipped
  entirely in the balance-check/self-heal loop — no row, no check. Same skip added to the
  approval-time re-check and the debit loop (a year that had days at filing can become 0 at
  approval if a holiday was added since — see item 3).
- Open-year (`apps/api/src/modules/leave/openYear.ts`, new — see item 3 for why this got factored
  out of the route): every (employee, type) pair is now classified into **created** (no row),
  **filled** (a row exists, every ledger term is 0, and there is no `leave.balance.upsert` audit
  entry for it — self-healed empty, not a deliberate admin 0) or **skipped** (a real balance, or a
  manually-set one, even a manual 0 — the audit trail is the only way to tell a manual 0 from a
  self-healed one). A **filled** row is backfilled to the entitlement and audited as
  `leave.balance.open_year_fill`. New `filled` count in the response; the web dialog shows it.

**RED.** `apps/api/test/s3.test.ts`, `describe("R5-008 fix round 1, item 1: ...")`: the exact
scenario (Fri 31 Dec–Sun 2 Jan, 1 Jan a holiday, using two explicit holidays rather than relying
on which weekday 31 Dec happens to fall on for determinism across run dates) — files with
total_days=1, no row for the new year before or after approval, then open-year opens it fresh
(`created:1, filled:0`). A second test seeds a genuinely self-healed empty row directly and a
separate manually-set-to-0 row, and asserts open-year fills the first (`filled:1`) and leaves the
second alone, and that a second open-year run doesn't re-fill what it already filled.

**GREEN.** Both pass; full API suite green (see §7).

**Files.** `apps/api/src/modules/leave/routes.ts`, `apps/api/src/modules/leave/openYear.ts` (new),
`apps/api/test/s3.test.ts`. Commit `f776539` (bundled with items 2/3/4/5, see below) plus the
`openYear.ts` extraction in `49a17df` (bundled with owner decision (b), see below).

### Item 2 (important) — pre-submit day preview counted calendar days, not the sandwich-rule figure

**Fix.** New `GET /api/v1/leave/preview?leave_type_id&from_date&to_date&employee_id?`
(leave.request; `employee_id` for someone else needs leave.admin, same rule as filing) —
returns `{total_days, years:[{year,days}], is_paid}` computed by filing's own `daysByYear` +
`sandwichSkipDates`, for the target employee's own effective holiday scope. One function, so the
preview and the actual charge cannot disagree. A range the sandwich rule reduces to 0 shows a
warning ("Every day in this range is a Sunday or a holiday") instead of "0 days".

Wired into both clients: `apps/web/components/LeaveRequestForm.tsx` (replacing the old
`inclusiveDays()` client-side count) and `apps/mobile/app/(tabs)/leave.tsx` (new preview line,
this screen had no day-count preview at all before).

**RED.** `apps/api/test/s3.test.ts`, `describe("GET /leave/preview ...")`: matches
`daysByYear`+sandwich exactly for a Fri–Mon paid range; matches what filing the same range
actually charges (direct comparison, not two hand-computed numbers); counts every calendar day for
LOP ignoring holidays; 401 anon; 422 DATE_RANGE; 404 unknown type; 403 previewing someone else
without leave.admin; 200 for leave.admin previewing someone else. `apps/web/tests-dom/leave-request-form-preview.test.tsx`
(new): the badge shows the server's total (3), not the calendar count (4) for a 4-day range with
one excluded day; a range reduced to 0 shows the warning, not "0 days".

**GREEN.** All pass; web suite green, `tsc --noEmit` clean, `next build` exit 0 (see §7).

**Files.** `apps/api/src/modules/leave/routes.ts`, `apps/api/test/s3.test.ts`,
`apps/web/lib/leave.ts`, `apps/web/components/LeaveRequestForm.tsx`,
`apps/web/tests-dom/leave-request-form-preview.test.tsx` (new), `apps/mobile/src/api/endpoints.ts`,
`apps/mobile/app/(tabs)/leave.tsx`. Commit `f776539`.

### Item 3 (important) — stored total_days could disagree with what was actually debited

**Fix.** total_days is now one source of truth. At the step that finally approves a request (the
same step that debits), the split is recomputed fresh — same as the approval-time balance
re-check already did — and persisted as `total_days` **and** a new `debited_days` JSONB column
(`[{year,days}]`, migration **102** — 101 is reserved for concurrently developed work) in the
same `UPDATE` as the status change, then the debit loop below reuses that identical computation
(one holiday query, one split, not two that could disagree). List/detail/web/mobile all read
`total_days`, so they show the figure actually charged.

**RED.** `apps/api/test/s3.test.ts`, in `describe("leave decisions", ...)`: files a paid Fri–Mon
CL request with no holiday configured (total_days=3 at filing, `debited_days:[]` since nothing's
debited yet), adds a holiday on the Saturday *after* filing but before approval, approves, and
asserts the decision response's `total_days` is now 2 (not the stale 3), `debited_days` is
`[{year,days:2}]`, the actual `leave_balances.consumed` is 2, and the GET detail afterward also
shows 2.

**GREEN.** Passes; full API suite green.

**Files.** `apps/api/src/database/migrations/102_leave_request_debited_days.sql` (new),
`apps/api/src/database/migrate.ts`, `apps/api/src/modules/leave/routes.ts`,
`apps/api/test/s3.test.ts`. Commit `f776539`.

### Item 4 (minor) — an all-excluded range filed as a 0-day request instead of refusing

**Fix.** A paid range the sandwich rule reduces to 0 days now gets 422 `ALL_DAYS_EXCLUDED`
("Every day in this range is a Sunday or a holiday; there is nothing to charge") at filing,
before any balance check or approval-chain assembly runs.

**RED.** `apps/api/test/s3.test.ts`, in the D-012 describe block: a paid range spanning exactly a
Saturday (declared a holiday) and the following Sunday gets 422 `ALL_DAYS_EXCLUDED`, and no
`leave_requests` row is created.

**GREEN.** Passes.

**Files.** `apps/api/src/modules/leave/routes.ts`, `apps/api/test/s3.test.ts`. Commit `f776539`.

### Item 5 (minor) — open-year's year check used a fixed IST year; banner sourced "next year" from the browser

**Fix.**
- `currentOrgYear()` (`apps/api/src/modules/leave/openYear.ts`) now reads
  `organizations.settings->>'timezone'` (default Asia/Kolkata) via the same `orgTodaySql`/
  `orgZoneSql` helpers D-006/D-013 already use, replacing the fixed-IST `currentIstYear()` for
  this one check (that function stays fixed-IST for the unrelated per-request backdating rule
  elsewhere in the same file — not in scope here).
- `year` in the open-year request body is now **optional**: omit it and the server resolves "next
  year" itself and echoes it back in the response. The web button/banner/dialog now source "next
  year" from a dry-run call with no `year` (`openYearBalances({dry_run:true})`), not
  `new Date().getFullYear()` — a skewed or differently-zoned browser clock can no longer ask to
  open the wrong year.

**RED.** `apps/api/test/s3.test.ts`: sets the org's `settings.timezone` to a non-Kolkata zone
(`Pacific/Kiritimati`) and confirms the year-bound error message names the year computed
independently via that same zone (proves the org-settings lookup is real, not just coincidentally
equal to IST today) — and that the same zone drives the omitted-`year` default. Web:
`apps/web/tests-dom/leave-open-year.test.tsx` rewritten for the new resolve-then-use flow: the
label-resolving query fires with no `year`; the dialog's own preview then asks for the resolved
year specifically; the banner still gates on December but no longer computes its own year.

**GREEN.** All pass.

**Files.** `apps/api/src/modules/leave/openYear.ts`, `apps/api/src/modules/leave/routes.ts`,
`packages/shared/src/s3.ts`, `apps/api/test/s3.test.ts`, `apps/web/lib/leave.ts`,
`apps/web/lib/query-keys.ts`, `apps/web/components/LeaveBalancesPanel.tsx`,
`apps/web/tests-dom/leave-open-year.test.tsx`. Commit `f776539`.

### Item 6 (minor) — correcting the "no web screen creates an invoice" claim

**Correction, not a code fix.** `apps/web/app/inventory/page.tsx`'s "Invoices" tab has a "Record
invoice" panel built from `<MutationForm path="invoices" .../>`, which does POST here — the
original R5-001 write-up (§5) was wrong to say no screen does. It was never actually at risk from
the R5-001 envelope change: `MutationForm` submits through `apiRequest()`, whose `unwrap()`
already tolerates both a bare body and a `{data:...}` envelope, so `onSaved` received the plain
row either way, before and after. Confirmed with a dedicated DOM test rather than left to
inspection, and the original paragraph in §1 corrected in place.

**Files.** `apps/web/tests-dom/invoice-mutation-form-envelope.test.tsx` (new),
`docs/qa/2026-09-24/findings-r5.md` (§1 correction). Commit `622e31d`.

### Item 7 (optional) — remaining mobile *Format.ts local tone maps

**Done: approvals.** Web's generic `financialTone` had no case for an approval instance's
`RECALLED` (silent neutral default) and disagreed with mobile's own `SUPERSEDED` (mobile read it
danger; web reads `SUPERSEDED` info for every other document type that carries it). New
`APPROVAL_STATUS_TONES` (`packages/shared/src/approvals.ts`) is the one map both now read:
`RECALLED` closes the web gap as danger (mobile's existing value), `SUPERSEDED` keeps web's
existing info.

**Deferred: projects and the rest.** `apps/mobile/src/projectsFormat.ts`'s `projectStatusTone`
and the remaining local tone maps were not checked against their web counterparts this round —
approvals was the one with an actual behavioural mismatch found while triaging item 7; a full
sweep of the others for cosmetic-only refactors (no divergence, just duplicated code) is left
undone rather than expanded further under this round's scope.

**RED.** `packages/shared/src/approvals.test.ts`: every `APPROVAL_STATUSES` value has an entry;
`RECALLED`→danger, `SUPERSEDED`→info. `apps/mobile/test/approvals-format.test.ts`: rewrote the
existing `SUPERSEDED`→danger assertion to `SUPERSEDED`→info (the old one pinned the mismatch).
`apps/web/tests/finance.test.ts`: new `approvalTone` tests.

**GREEN.** All pass.

**Files.** `packages/shared/src/approvals.ts` (+ `.test.ts`), `apps/mobile/src/approvalsFormat.ts`
(+ `.test.ts`), `apps/web/lib/finance.ts`, `apps/web/app/approvals/page.tsx`,
`apps/web/tests/finance.test.ts`. Commit `fbdc734`.

### Owner decision (a) — leave step-2 approver must be the org's HR manager, never "the oldest admin"

**Bug, exactly as reported.** `step2Approver` picked whichever of HR_MANAGER/ADMIN/SUPER_ADMIN had
the *oldest account* — an ADMIN account created before the org's HR_MANAGER account silently won
every time, so HR could go an entire deployment without ever seeing this step.

**Fix.** Two-phase, both excluding the applicant's own account:
1. The org's active HR_MANAGER, deterministically the **lowest user id** (org settings carries no
   designated-HR-approver override today; this is the ordering until one is added).
2. Only if none exists (or the only one is the applicant): fall back to ADMIN/SUPER_ADMIN, same
   lowest-id rule.

The applicant exclusion matters on its own: without it, an applicant who is themselves the org's
only/lowest-id HR manager would resolve to themselves, and `assembleApprovalChain`'s existing
self-approval check would then just *drop* the step rather than hand it to the next eligible
person — the wrong outcome for "the next eligible person" the decision calls for.

**RED.** `apps/api/test/s3.test.ts`, `describe("leave step-2 approver: HR manager preferred over
admin ...")`: (1) HR manager present → routes to them, not admin; (2) no HR manager in the org →
falls back to admin (regression-covers the pre-existing behaviour for the common case); (3)
applicant is the org's own lowest-id HR manager → routes to the *other* HR manager (determined by
querying actual id order, since UUIDs aren't creation-ordered — this makes the test deterministic
regardless of which account happens to get the lower id), never back to admin and never to the
applicant.

**Found by running the suite, not by inspection:** two pre-existing tests broke as a direct,
correct consequence of this behaviour change --
`apps/api/test/catalogue/ut-auth.test.ts`, UT-AUTH-06 "denies an out-of-scope user who merely
holds the decide grant" used HR_MANAGER as its "holds leave.decide but is not the named approver"
bystander -- exactly the role this decision now *does* route to. Switched the bystander to
PROJECT_MANAGER, which holds leave.decide too but has no path to being picked for that test's
employee either way (no `reports_to` relationship, not HR/admin).

**GREEN.** All pass; full suite green.

**Files.** `apps/api/src/modules/leave/routes.ts`, `apps/api/test/s3.test.ts`,
`apps/api/test/catalogue/ut-auth.test.ts`. Commit `b9f3557`.

### Owner decision (b) — leave year-open runs automatically on 1 January, org timezone

**Fix.** Extracted the open-year action itself out of the HTTP route into
`apps/api/src/modules/leave/openYear.ts` (`classify`/`previewOpenYear`/`runOpenYear`, unchanged
behaviour) so the manual endpoint and a new scheduled job call **exactly the same implementation**.

New `apps/api/src/modules/jobs/leaveYearOpen.ts`, wired into the existing worker pass (`runJobs`,
`apps/api/src/modules/automation/worker.ts`) the same way scheduled reports and SLA alerts already
are (`isolated(...)`, so one org's failure doesn't stop the rest): for every active org, resolves
its own current year (`currentOrgYear`, same org-timezone source as item 5) and, if that
(org, year) pair hasn't been auto-opened yet, runs it — idempotent (`ON CONFLICT DO NOTHING` on
the `leave_balances` natural key, same as the manual action), lapse-only (no carry-forward),
audited with `actor_id NULL` and `triggered_by:'scheduled_job'` in `after_state` so the trail
distinguishes it from a human's click. The manual button and December banner are unchanged and
stay available regardless.

Migration **111** (102 already used this batch; 103–110 reserved for concurrently developed
migrations) adds `leave_year_open_runs (org_id, year PRIMARY KEY, run_at, created, filled,
skipped, total)` — purely a per-(org, year) "already ran" marker, so a worker tick every few
seconds doesn't re-run the same pair for the rest of the year.

**Date gate.** Deliberately not a separate check: a year value only ever becomes an org's "current
year" once its own calendar actually reaches 1 January of it (`currentOrgYear`'s definition), so
there is no separate before/after-the-boundary state to construct. This is also why it can't be
tested by faking "before 1 Jan" — the test database's clock can't be frozen from inside a test.
What's directly tested is the mechanism that gate depends on: the per-(org, year) tracking is
exactly that, per year, not a one-time-ever flag.

**RED.** `apps/api/test/s3.test.ts`, `describe("automatic leave year-open ...")`: (1) opens the
org's current year, records the tracking row, audits with `actor_id NULL` and
`triggered_by:'scheduled_job'`; (2) a second run makes no further changes and adds no further
tracking row (idempotent); (3) two orgs are opened independently, each with its own tracking row
and its own balances; (4) a tracking row already present for `year-1` does not block `year` from
being opened, and the job never reaches into `year+1` — the closest a test in this environment can
get to proving the per-year gate without a fakeable clock.

**GREEN.** All pass; full API suite green, `fresh-database.test.ts` confirms migration 111 (and
102) apply cleanly to an empty database.

**Files.** `apps/api/src/modules/leave/openYear.ts` (new), `apps/api/src/modules/jobs/leaveYearOpen.ts`
(new), `apps/api/src/modules/automation/worker.ts`, `apps/api/src/database/migrations/111_leave_year_open_runs.sql`
(new), `apps/api/src/database/migrate.ts`, `apps/api/test/s3.test.ts`, `apps/api/test/tables.ts`.
Commit `49a17df`.

### Suite fixes found only by running the suite (not a numbered item)

Four pre-existing tests broke as accurate, intended consequences of behaviour actually changing
this round, not from any code defect — fixed in commit `dfde7e5`:
- `apps/api/test/s3.test.ts`: open-year's dry-run test still expected the old placeholder
  `created:0`; dry-run now reports the real would-be created/filled counts (item 1's response
  redesign).
- `apps/api/test/catalogue/ut-auth.test.ts` UT-AUTH-06 (two tests): one filed a single-day paid
  request on a date that happens to be a Sunday under this run's calendar (now correctly refused,
  D-012); the other is owner decision (a)'s bystander issue, above.
- `apps/api/test/catalogue/ut-lp.test.ts` UT-LP-02: the overlap-then-cancel probe used a
  single-day Sunday too.

## 7. Fix round 1 — verification

Full suites, VM slot `e`, after every commit in this round:
- **shared**: vitest, 29 files / 1029 tests, all green.
- **api**: vitest, 80 files / 2170 tests. One unrelated failure on a run that happened to cross a
  real midnight during an unusually contended (multiple other agents' concurrent slots) 19-minute
  run: `test/catalogue/survey-operations.test.ts` — "raises a village past the date somebody
  committed to" hardcodes an expected "5 days ago" against a fixed due date, which becomes "6 days
  ago" the instant the calendar actually turns over. Confirmed unrelated to this round (survey
  overdue-alert wording, nothing to do with leave/payables/invoices/approvals) and confirmed to
  fail identically in isolation on today's date regardless of load — a pre-existing date-drift
  fragility, not a regression, left unfixed as out of scope for this round.
- **mobile**: `tsx --test`, 420/420; `tsc --noEmit` clean (after hardlinking the missing
  `expo-image-picker`/`expo-document-picker` from `~/sl-test/node_modules` into slot `e`, per
  standing instructions).
- **web**: vitest, 81 files / 969 tests. Two timeouts on the full contended run
  (`tests-dom/documents-legal-hold.test.tsx`, `tests-dom/survey-tabs.test.tsx`, both `Test timed
  out in 5000ms`) that passed cleanly (37/37) when re-run in isolation seconds later — confirmed
  resource-contention flakes from the shared VM, not regressions, in modules this round never
  touched. `tsc --noEmit` clean. `next build` (`NEXT_VERIFY_BUILD=1`) exit 0, all 73 routes
  including `/leave/balances` and `/leave/new`.

Migrations this round: **102** (`leave_requests.debited_days`), **111**
(`leave_year_open_runs`) — 101 and 103–110 reserved for concurrently developed work per the
coordinator's instructions. Both confirmed to apply cleanly to an empty database
(`fresh-database.test.ts`).

## 8. Fix round 2 (2026-09-25)

Three items, both follow-ups to fix round 1's two owner decisions plus a nit. TDD throughout, RED
shown per item, no new migrations. API-only this round (no web files touched — web `tsc` skipped
per instructions).

### Item 1 (important) — decision (a) follow-up: a stale step-2 approver stuck a request forever

**Bug, exactly as reported.** `current_approver_id` is resolved once, at filing/step-advance time.
If that user later exits, is disabled, or loses the HR_MANAGER/ADMIN/SUPER_ADMIN role, the request
just sits — nobody eligible can see or decide it, and nothing re-resolves the assignment.

**Fix.** New `apps/api/src/modules/leave/approverResolution.ts`:
- `step1Approver`/`step2Approver` extracted from `routes.ts` unchanged (now reusable).
- `isEligibleStep2Approver(db, orgId, userId, applicantUserId)` — ACTIVE + one of the three roles
  + not the applicant.
- `reassignIfIneligible(db, req, ctx)` — re-resolves **only the last step in the chain** (step 2)
  in this round. If the current approver is no longer eligible, resolves a fresh `step2Approver`
  and, if that's a different eligible user, `UPDATE`s `current_approver_id`/`approval_chain`
  (guarded by `WHERE current_approver_id = $old` for race safety) and writes a
  `leave.request.reassign_approver` audit event (`actor_id NULL`).

  **Correction (round 3):** this round's write-up originally justified leaving step 1 unhandled as
  "a direct-report relationship that exit already unwinds via cancellation, not reassignment." That
  was wrong — the exit-flow cancellation covers only the *exiting employee's own* pending leave (as
  requester); it does nothing for leave belonging to someone else that the exiting employee was the
  current *approver* on, at whichever step. A stale step-1 approver was left exactly as stuck as a
  stale step-2 one was before this round's fix. See §10 for the round-3 correction (controller
  ruling), which extends re-resolution to every step.
- Wired at two points in `routes.ts`: `GET /leave/requests/:id` (re-resolve on read, before
  returning) and the decision handler (re-resolve on the `FOR UPDATE` row right after fetching it,
  before the status/version checks). The decision handler's `expectedVersion` was changed from
  `const` to `let`: a reassignment bumps the row's `version`, so if the caller's submitted
  `If-Match` version matches the *pre*-reassignment version, `expectedVersion` is advanced to match
  — otherwise a real stale-version conflict from the caller would be masked. Reasoned through and
  fixed before writing the test, not discovered as a failure.
- `apps/api/src/modules/employees/routes.ts`'s exit handler: in the same transaction as the
  existing "cancel the exiting employee's own pending leave" step, now also finds every PENDING
  `leave_requests` row where the exiting user is `current_approver_id` and calls
  `reassignIfIneligible` for each, recording the affected request ids in the exit's own audit
  (`after_state.offboarding.reassigned_approval_request_ids`) — audit-only, not in the exit
  endpoint's response body.

**RED.** `apps/api/test/s3.test.ts`, `describe("leave step-2 approver: reassigned when it becomes
stale ...")`: (1) exit flow — approver exits, request reassigns to the next eligible HR
manager/admin, confirmed via the exit's own audit trail; (2) disabled approver reassigned on
`GET` — reads with the stale approver still current-on-disk, response comes back re-resolved, then
decides successfully using that response's version; (3) disabled approver reassigned on `decision`
directly, no prior read, using the pre-disable version (proves the mid-request version bump is
handled, not just the read path); (4) never reassigns to the applicant even if they're the org's
only other HR manager.

**GREEN.** All pass; full API suite green (see below).

**Files.** `apps/api/src/modules/leave/approverResolution.ts` (new),
`apps/api/src/modules/leave/routes.ts`, `apps/api/src/modules/employees/routes.ts`,
`apps/api/test/s3.test.ts`. Commit `6e596d1` (logic), `5708708` (tests).

### Item 2 (important) — decision (b) follow-up: the January job had no date gate

**Bug, exactly as reported (controller ruling).** The scheduled open-year job only checked "has
(org, year) already run," not "is it actually January" — deploying in September would open next
year for every org on the very first worker tick.

**Fix.** `apps/api/src/modules/jobs/leaveYearOpen.ts`: new `currentOrgYearMonth()` resolves both
year and month from the org's timezone (same `orgTodaySql`/`orgZoneSql` source as `currentOrgYear`
elsewhere in this batch); the job now no-ops (`COMMIT` and move to the next org) for any org whose
current org-local month isn't January, before the existing "already opened" check. New
`RunLeaveYearOpenOptions.resolveOrgDate` override parameter — defaults to the real query, only
overridden in tests — since Postgres's `now()` can't be faked from a test.

**RED.** `apps/api/test/s3.test.ts`, `describe("automatic leave year-open: date gate ...")`: 24 Sep
→ no-op, nothing created, no tracking row; 1 Jan → opens; 15 Jan → opens once and is idempotent on
a second call the same day; 1 Feb → no-op (year already missed its window, doesn't retroactively
open). All four existing round-1 "automatic leave year-open" tests updated to pass
`{resolveOrgDate: forceOrgDate(currentTestYear(), 1)}`, since real September calls are now
correctly a no-op under the new gate.

**GREEN.** All pass.

**Files.** `apps/api/src/modules/jobs/leaveYearOpen.ts`, `apps/api/test/s3.test.ts`. Commit
`6286e06` (logic), `5708708` (tests).

### Item 3 (nit) — a request could still be approved into a 0-day debit if holidays changed after filing

**Fix.** `approvalBlocker()` in `apps/api/src/modules/leave/routes.ts` now runs the same
`daysByYear`+`sandwichSkipDates` split used by item 4 of round 1 *before* the balance gate, for
paid types: if every year in the range now nets 0 days (e.g. a holiday was added over a
previously-chargeable day between filing and approval), the decision is refused with 422
`ALL_DAYS_EXCLUDED` rather than silently approving a request that would debit nothing.

**RED.** `apps/api/test/s3.test.ts`, D-012 describe block: files a single non-Sunday weekday paid
request (passes filing's own `ALL_DAYS_EXCLUDED` check, since no holiday exists yet), then adds a
holiday on that exact day, then attempts to approve — expects 422 `ALL_DAYS_EXCLUDED`, and confirms
the request stays PENDING with `total_days`/`version` unchanged and no debit posted.

**GREEN.** Passes.

**Files.** `apps/api/src/modules/leave/routes.ts`, `apps/api/test/s3.test.ts`. Commit `6e596d1`
(logic), `5708708` (tests).

### Suite fix found only by running the suite (not a numbered item)

`apps/api/test/catalogue/ut-lp.test.ts` — "ends the request at the first rejection and requires a
note" filed its single-day paid CL request on raw `plusDays(100)`. Today's run date puts that
offset on 2027-01-03, a Sunday, so round 1's `ALL_DAYS_EXCLUDED` filing refusal (correctly) now
rejects it, leaving `request.id` undefined and blowing up downstream in `ifMatch`/`versionOf` —
same class of calendar-drift flake round 1 already fixed for two other tests in this same file,
just missed for this one at the time. Switched to the file's existing `nonSundayPlusDays()`
helper. Commit `f367b4d`.

## 9. Fix round 2 — verification

Full API suite, VM slot `e`, `TEST_DATABASE_URL` → `test_slot_e`:
- First run (before the `ut-lp.test.ts` fix above): 78 passed / 2 failed (2177/2179 tests) — the
  known pre-existing `survey-operations.test.ts` date-drift flake (§7) plus the new `UT-LP-03`
  Sunday-landing failure this section fixes.
- Targeted re-run of `test/catalogue/ut-lp.test.ts` alone after the fix: 44/44 green.
- Full re-run: **79 passed / 1 failed (2178/2179 tests)**, 597s. The one remaining failure is
  `test/catalogue/survey-operations.test.ts` > "raises a village past the date somebody committed
  to" — the same hardcoded "5 days ago" vs. actual-elapsed-days flake documented and left unfixed
  in §7 (unrelated module, confirmed pre-existing, confirmed to fail identically regardless of this
  round's changes).

Web `tsc` not run this round — no web files touched by any round-2 commit (`git status` checked
clean of web changes before each commit).

No new migrations this round.

## 10. Fix round 3 (2026-09-25)

One important gap, a controller ruling on round 2 item 1's fallback order. API-only, no new
migrations.

### Item 1 (important) — a stale step-1 approver was still stuck forever

**Bug, exactly as reported.** `reassignIfIneligible` no-ops for any non-final chain step
(`idx !== chain.length - 1`), so a **step-1** approver (normally the requester's reporting manager)
who exits, is disabled, or loses `leave.decide` leaves the request stuck exactly the way a stale
step-2 approver did before round 2 — the exit handler finds these rows (it queries
`current_approver_id = ANY(accountIds)` regardless of step) but the reassign call itself silently
does nothing for them. Round 2's write-up justified this scope as "step 1 is a direct-report
relationship that exit already unwinds via cancellation" — wrong: that cancellation only ever
covered the *exiting employee's own* leave as requester, never leave they were approving for
someone else. See the correction in §8, item 1.

**Fix (controller ruling on fallback order).** `apps/api/src/modules/leave/approverResolution.ts`:
`reassignIfIneligible` now re-resolves *whichever* step is currently pending, not just the last
one:
- **Step 2** ineligible: unchanged cascade (org HR manager, then admin — round 2's behaviour).
- **Step 1** ineligible: the ineligible approver's *own* reporting manager first (new
  `step1FallbackCascade` — same `step1Approver` lookup step 1 assembly itself uses, just applied to
  the stale approver's own employee record instead of the requester's), then falls through to the
  same HR-manager-then-admin cascade step 2 uses (new `step2FallbackCascade`, generalized from
  `step2Approver` to take an arbitrary exclusion set rather than just the applicant).
- **Never the applicant**, at any tier, either step (unchanged rule, now applied uniformly).
- **New: never duplicates the request's other step.** Every fallback tier now excludes whoever
  holds the request's *other* step (`chain.filter((_, i) => i !== idx)`), in addition to the
  applicant — a candidate that would put one person on both steps of the same request is skipped in
  favour of the next one down the cascade (manager → HR → admin), all the way to "leave the stale
  approver in place" if every tier is exhausted. This matters for either direction (a step-1
  fallback landing on the existing step-2 approver, or vice versa), not only the step-1 case the
  ruling called out.
- New `isEligibleStep1Approver` (active + holds `leave.decide` + not applicant) mirrors
  `isEligibleStep2Approver` for the step-1 case; new `firstEligibleByRole` factors the
  role-membership query both cascades share.
- CAS guard (`WHERE ... AND current_approver_id = $old`) and audit-once semantics
  (`leave.request.reassign_approver`, one row per successful reassignment) are untouched — the
  fallback-selection logic changed, not the write/audit path around it.

Comments in `apps/api/src/modules/leave/routes.ts` (GET and decide handlers) and
`apps/api/src/modules/employees/routes.ts` (exit flow) that described the old step-2-only scope
were corrected in the same commit.

**RED.** `apps/api/test/s3.test.ts`, `describe("leave step-1 approver: reassigned when it becomes
stale (fix round 3, item 1, controller ruling)")`: run against the round-2 source (`git stash` of
just the fix, keeping the new tests) before restoring the fix, all four failed for the intended
reason — no reassignment happened at all, or it landed on the wrong tier:
1. "reassigns to the exiting approver's own reporting manager" — a three-level chain (gm manages
   tl, tl manages the applicant); tl exits; expects the exit's own audit to list the reassignment
   and the new current approver to be gm, step 2's own approver left untouched.
2. "falls back to the org's HR manager when the exited approver had no manager of their own" — tl
   has no manager of their own; an HR manager is created *after* filing (so it's available for the
   fallback but wasn't part of the original chain); tl is disabled; expects reassignment to the new
   HR manager.
3. "skips an HR manager who is themselves the applicant, falling back to admin" — the org's only HR
   manager is the applicant; step 2 already fell back to *an* admin at filing (two admins exist in
   this org); tl (step 1) is disabled; expects the reassignment to land on the *other* admin (never
   the applicant, never the admin already on step 2).
4. "skips a manager candidate that would duplicate the request's step-2 approver, falling further
   down the cascade" — gm is deliberately *both* tl's own reporting manager *and* the org's only HR
   manager, so gm is already this request's step-2 approver; tl (step 1) is disabled; the naive
   "reassign to your manager" answer (gm) would duplicate step 2, so the fix must skip it (and skip
   the HR tier too, gm being the org's only HR manager) and land on admin instead.

**GREEN.** All four pass after restoring the fix; full `test/s3.test.ts` green (83/83), full
`ut-lp.test.ts` + `ut-auth.test.ts` green (101/101) — the 6 tests carried over from round 2's
step-2-only describe block are unaffected (same `reassignIfIneligible`, step-2 branch unchanged).

**Files.** `apps/api/src/modules/leave/approverResolution.ts`, `apps/api/src/modules/leave/routes.ts`
(comments only), `apps/api/src/modules/employees/routes.ts` (comment only),
`apps/api/test/s3.test.ts`. Commit `e8043ef`.

## 11. Fix round 3 — verification

Targeted run first (`test/s3.test.ts`, `test/catalogue/ut-lp.test.ts`, `test/catalogue/ut-auth.test.ts`,
VM slot `e`): **184/184 passed**.

Full API suite, VM slot `e`, `TEST_DATABASE_URL` → `test_slot_e`: **79 passed / 1 failed
(2182/2183 tests)**, 792s. The one remaining failure is the same pre-existing
`test/catalogue/survey-operations.test.ts` "5 days ago" date-drift flake documented in §7/§9
(unrelated module, confirmed pre-existing, not touched by this round's changes).

Web `tsc` not run — no web files touched this round.

No new migrations this round.
