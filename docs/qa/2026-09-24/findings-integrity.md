# Findings ledger: data integrity and concurrency

This round looked for places where two users, a retry, a clock boundary or a large dataset can corrupt data, money or state. Branch `qa/integrity`, off main `7bd6f7d`.

**How it was tested:**

- **Races.** `Promise.all` over `app.inject`, so each request takes its own pooled connection and Postgres sees transactions that really overlap. These ran in the VM rig, slot g, on a throwaway DB.
  - Regression files: `apps/api/test/catalogue/integrity.test.ts` and `integrity-scale.test.ts`.
- **Live confirmation.** `~/sl-e2e/integrity/live.mjs`, run as `qa-fin-admin` on the VM's live API. It only touched `QA-INT-` data. Reservations were released and catalogue items archived afterwards.
- **RED.** Each fixed bug's test failed on the old code before the fix went in. The RED output is quoted in the Actual column.

| ID | Sev | Surface | Module | Steps | Expected | Actual | Status | Fix commit |
|---|---|---|---|---|---|---|---|---|
| D-001 | P1 | api | stock | 10 units on hand at one location; 8 concurrent `POST /stock-reservations` of 4 each | At most 2 accepted, reserved <= 10, the rest `INSUFFICIENT_STOCK` | RED: all 8 accepted, 28 of 10 reserved. Live on 7bd6f7d: 3 accepted, 12 of 10 reserved. The reservation read availability without the item lock that issues take. | FIXED: item row locked, so reservations and issues serialise | dd413ee |
| D-002 | P1 | api | leave | Employee with 12 CL; 6 concurrent `POST /leave/requests` for the same two days, each with its own key | 1 request stands, the rest `LEAVE_OVERLAP` | RED: all 6 returned 201 and stood as PENDING. The overlap and balance rules read and then insert, with no lock. | FIXED: employee row `FOR UPDATE` before the rules run | 0f3888a |
| D-003 | P3 | api | expenses (budget) | Two concurrent `PUT /projects/:id/budget` revisions | Both applied as consecutive revisions, one live row per head | RED: `[200, 409 DUPLICATE_RECORD]`. The index kept the data safe, but the second editor got a bare "record already exists". | FIXED: project row locked, so the second becomes revision N+2 | 0a305f0 |
| D-004 | P2 | api | all offset-paged lists | 40 payments written in one statement (same `paid_on` and `created_at`, which is what a payment-run execution writes), paged at `limit=7` | Every row exactly once | RED: 44 rows seen, one twice and another skipped. Top-N heap sort puts ties in a different order for each LIMIT/OFFSET. | FIXED: a unique `id` tie-breaker on 20 list queries (payments, bank lines, stock txns/counts, POs, PRs, RFQs, returns, advances, cost entries, claims, approvals, payment runs, allocations, asset audits, reports, schedules, automation rules, activity, people picker) | f0f9b09 |
| D-005 | P2 | api | procurement, stock | `POST /purchase-orders` to an INACTIVE vendor; `POST /stock-transactions` PURCHASE_RECEIPT onto an INACTIVE item | 422 `VENDOR_INACTIVE` / `ITEM_INACTIVE` (the older `/inventory/transactions` already refuses) | RED: both 201 | FIXED: new orders and new stock (receipt, opening balance) are refused. Existing orders and draining existing stock are unaffected. | b993dae |
| D-006 | P2 | api | reports (audit) | Audit events at 2031-03-09T20:00Z (01:30 IST on 10 Mar) and 2031-03-10T20:00Z (11 Mar IST); audit report with `from=to=2031-03-10` | Only the 10-Mar-IST event, which is how `GET /audit-events` filters | RED: only the 11-Mar-IST event came back. `created_at::date` used the session's UTC day. | FIXED: `(created_at AT TIME ZONE org tz)::date` | 5afd841 |
| D-007 | P3 | api | every search box (employees, clients, contacts, leads, tenders, items/assets, org units, projects, tasks, catalogue, people and impersonation pickers) | `GET /employees?q=%` | % and _ are taken literally, so no match | RED: 100 of 100 rows came back. Live: 5 of 5 (limit 5). "50%" really meant "50 followed by anything". | FIXED: shared `likeContains()` escapes backslash, % and _ | 25eec47 |
| D-008 | P1 | api | finance + expenses | (a) APPROVED claim of 1000 reimbursed via `/expense-claims/:id/reimburse`, then a payment allocated to it for 1000; (b) the same in the reverse order; (c) allocation to a DRAFT/SUBMITTED claim; (d) receipt allocated to a DRAFT RA bill | (a)(b) the second payment refused; (c)(d) refused | RED: all four were accepted, so the claim was paid in full twice. Each path summed only its own table, and allocation had no status gate. | FIXED: each path counts the other's payments under the claim row lock. `DOCUMENT_NOT_PAYABLE` for a claim that is not APPROVED/REIMBURSED or an RA bill that is not CERTIFIED/PAID. | 06683b5 |
| D-009 | P2 | api | catalogue | 12 items, each with concurrent `PATCH {standard_rate}` and `PATCH {name}` | Both edits survive | RED: 6 of 12 lost an edit. Live: 4 of 6. The route read the row unlocked and wrote every column back. The stale If-Match test also failed (200). | FIXED: `FOR UPDATE` on the read, and an If-Match is honoured when it is sent | 2bfe469 |
| D-010 | P3 | api + shared | procurement, billing (BOQ), expenses | PO lines 0.5 x 4.35 (= 2.175) and 0.3 x 2.15 (= 0.645); mileage 12.5 x 4.35 (= 54.375) | 2.18, 0.65 and 54.38, half up the way NUMERIC and the invoice side round | RED: 2.17, 0.64 and 54.37 (the float product is x.xx4999...). A zero-tolerance 3-way match can fail by a paisa. | FIXED: shared `paise()` / `round2` trim to 12 significant digits before rounding | ce5e6b9, 63f6a5c |
| D-011 | P2 | api | leave | File CL from 30 Dec to 2 Jan | Days split across the two leave years, or the request refused and split into two | Code: `periodYear = from_date.slice(0,4)`, so all 4 days are checked against and deducted from the December year's balance. The next year is never touched. | OPEN (policy: split or refuse). Recommended fix: refuse with `LEAVE_SPANS_YEARS` | n/a |
| D-012 | DECISION | api | leave | Leave over a Sunday or a holiday | Owner rule for payroll (2026-09-22): Sundays and holidays are paid non-working days | `inclusiveDays()` counts calendar days, so a Fri-Mon CL request debits 4 days, including the Sunday | OPEN, owner decision (sandwich rule or not) | n/a |
| D-013 | P3 | api | survey, employees, alerts, billing | Actions between 00:00 and 05:30 IST | IST dates | `CURRENT_DATE` (the DB session is UTC; no session TimeZone is set) stamps yesterday on survey crew `assigned_on`/`released_on` (employees/routes.ts:2413, 2425), on the survey alert day-counts (jobs/surveyAlerts.ts) and in two survey duration queries. `measured-proposal` defaults `period_to` to the UTC date and dates task completions in UTC on purpose (see the comment at billing/routes.ts ~735). | OPEN. Cheapest fix: set the session TimeZone per org, or use `(now() AT TIME ZONE tz)::date` | n/a |
| D-014 | P3 | mobile | approvals, payables, receivables, payroll, projects, clients, pipeline | Look at an amount with paise | Same figure as web (`money()`, 2 dp) | Mobile `money()` helpers use `maximumFractionDigits: 0`, so an approver sees Rs 1,500 for Rs 1,499.60 | OPEN, display only; no data affected | n/a |
| D-015 | P3 | api/web | expenses, reimbursement | Double-click "Reimburse" on a claim with a partial amount | One payment | The web client mints a new Idempotency-Key per call, so a double submit is two requests. For a partial amount, both fit under the outstanding cap. | OPEN (UI: disable while pending) | n/a |
| D-016 | INFO | api | idempotency | Reuse one key on a `mutate()` route and on a `mutationRoute()` route | Rejected | The two helpers keep receipts in different tables (`v2_operations`, `idempotency_keys`), so the second is processed. Clients mint a UUID per call, so this is unreachable in practice. | OPEN (info) | n/a |
| D-017 | INFO | api | stock | Compare item on-hand with the sum across locations | Equal | Legacy `/inventory/transactions` posts with no location, so the item total includes it and no location does. `reversal_of` is filtered in location views and not in item totals (no code writes reversal rows yet). | OPEN (info) | n/a |

## Attacked and found clean

These were code-reviewed under the lock, version or constraint shown. Some were also fired concurrently (marked "tested").

- **Stock issue of the last unit.** Item lock. Covered by the existing UT-OPS-01.
- **Asset issue of one asset to two people.** `asset_one_assignment` partial unique index.
- **Receipt allocation beyond outstanding.** Tested: 4 concurrent 800s against a 1000 invoice gave 1 accepted, 3 refused, and the total stayed <= 1000. `documentValue(..., lock)` does this.
- **Payment runs.** Build is under an org advisory lock plus the one-open-run index (080). Decide and execute are under a row lock, If-Match and `staleLines()` recheck. Execute twice gives INVALID_TRANSITION.
- **Approvals.** Decide approve+reject, and two approvers on one step: instance `FOR UPDATE`, If-Match and `NOT_PENDING`.
- **Payroll.** Tested: 5 concurrent calculates, then 4 concurrent submit-reviews. No duplicate payslips, <= 1 transition. Calculate is under an org advisory lock, transitions are conditional `UPDATE ... WHERE status=`, and payslip regeneration takes `FOR UPDATE` on the prior slips.
- **GRN over-receipt and PO amendment while a GRN posts.** Both take a PO row lock.
- **RA bills.** One open bill per project (`uk_ra_one_open`), and certification is under a row lock with If-Match. The advance recovery is written at certification.
- **Expenses.** Submit, withdraw and decide are under a row lock with If-Match. Reimburse is under a row lock with the outstanding cap.
- **Documents.** Renew and version work under a row lock plus `uq_documents_supersedes` (existing section-46 concurrency tests).
- **Survey billing milestones.** `UNIQUE(survey_village_id, milestone)`, village `FOR UPDATE` in `withinHundredOr422`.
- **Attendance.** Punch-in twice in the same second: existing s2 burst test.
- **Number sequences.**
  - Tested: a burst of 6 employee creates with no `emp_no` gave 6 distinct numbers (org row lock).
  - RA `bill_no` is max+1 under the project lock.
  - PO, GRN, payment, run and count numbers are user-supplied, with unique indexes.
- **Idempotency.**
  - Tested: 6 concurrent same-key creates on a `mutate()` route gave one row and one id.
  - Tested: 5 concurrent same-key employee creates (`mutationRoute`) gave one employee.
  - Tested: the same key with a different body is refused with 409 on both helpers.
- **Referential.**
  - Employee exit disables logins, cancels pending leave and flags open tasks (HR-14).
  - An org unit cannot be deactivated while it has active children or employees.
  - A cost head that has been retired is refused in budgets.
- **GST split.** `splitGst` gives CGST = total - half, so the parts always sum to the total.
- **MSME 15/45-day windows, FY rollover and leap day.** All use UTC date arithmetic on YYYY-MM-DD.

## Scale

~10k rows were seeded in the test DB: 1,000 items, 20,000 stock txns, 10,000 payments, 5,000 employees and 10,000 tasks. Timings in ms:

- items 11
- payments 7
- payments at offset 9800: 22
- employees 6
- employee search 12
- tasks 10
- stock-transactions 21
- inventory-transactions 16
- ap/ageing 6

`limit=100000` is capped at 100. Nine hostile search strings (% _ quote backslash %_% SQL-injection Devanagari paren regex) all returned 200. A 5,000+ row export is queued asynchronously (202) as designed. No N+1 hotspot showed at this size.