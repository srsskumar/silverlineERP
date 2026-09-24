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
