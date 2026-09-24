# Owner decisions 2 & 3, plus bound-in extras (2026-09-24)

Branch `qa/decisions`, worktree `C:\Users\Admin\sl-fix\qa-dec`. TDD throughout (RED
confirmed on the VM slot **g** before each fix, GREEN confirmed after). One commit
per item, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Item 1 — Receipts allocable to RA bills before certification

**Current behaviour found.** `documentValue()` in
`apps/api/src/modules/finance/routes.ts` (the R4 integrity round, D-008) only
treated a `CERTIFIED` or `PAID` RA bill as payable; `SUBMITTED` (and `DRAFT`/
`CANCELLED`) were refused with `DOCUMENT_NOT_PAYABLE`. The APAR-2 rule (no
TDS/advance on an RA-bill receipt) lives in a separate check and was untouched.
No web or mobile copy hardcoded the old "certified" wording (searched
`apps/web`, `apps/mobile` for "certified bill" / `DOCUMENT_NOT_PAYABLE"`), so
nothing needed updating there.

**Change.** Allow-list widened to `SUBMITTED`, `CERTIFIED`, `PAID`; the refusal
message now says "A submitted, certified or paid bill can take a receipt."
DRAFT and CANCELLED (and, if it is ever added, REJECTED — the allow-list
approach means any status not explicitly listed stays refused) keep the same
stable `DOCUMENT_NOT_PAYABLE` code.

**RED/GREEN.** New tests in `apps/api/test/catalogue/finance.test.ts`
(`makeRaBill(amount, status)` helper added): RED showed the SUBMITTED case
refused (422); GREEN showed SUBMITTED/CERTIFIED/PAID allowed (201) and
DRAFT/CANCELLED still refused (422, same code). Existing D-008 test
(`apps/api/test/catalogue/integrity.test.ts`, DRAFT bill refusal) still passes
unmodified.

**Files.** `apps/api/src/modules/finance/routes.ts`,
`apps/api/test/catalogue/finance.test.ts`.

**Migration.** None.

**Commit.** `17c4c42 fix(finance): allow receipts against submitted RA bills, not just certified`

---

## Item 2 — Org-wide fallback approval ladders (requisitions & POs)

**Current behaviour found.** The engine (`apps/api/src/common/approvalRouting.ts`
`submitForApproval`, and `apps/api/src/modules/approvals/routes.ts` `policyFor`)
already fell back to a `project_id IS NULL` policy — both order
`project_id NULLS LAST`. The actual gap: no organisation had ever been given
an org-wide policy for `PURCHASE_REQUISITION` or `PURCHASE_ORDER`, so a
project-less document had nothing to fall back to.

**Change.**
- `apps/api/src/database/migrations/101_org_fallback_approval_policies.sql`:
  backfills one minimal org-wide policy (single step, `ADMIN`, no amount band)
  per org × document type lacking an active one. Idempotent (`NOT EXISTS`
  against the same condition the `uk_ap_org_default` partial unique index
  enforces). Registered in `migrate.ts` after 100.
- `seedDatabase()` (`apps/api/src/database/seed.ts`) gets the same backfill
  loop, mirroring the existing per-org `payroll_policies` default, so a brand
  new org — and a fresh test DB, which never re-runs `migrate()` after
  seeding — gets it too, without overriding an administrator's own policy.
- `apps/web/components/approvals/ApprovalPoliciesManager.tsx`: corrected the
  stale "nothing is auto-seeded" copy; deactivating the only active policy
  left for a document type now shows a sharper confirmation naming the
  `NO_APPROVAL_POLICY` consequence (org-wide policies were already shown via
  the existing Scope column and already editable — POST supersedes).

**RED/GREEN.** `apps/api/test/catalogue/approvals.test.ts`, new describe
"organisation-wide fallback approval ladders": RED (4 failures) before the
migration/seed change — no fallback rows, project-less submission refused,
migration SQL file missing. GREEN after: fresh DB has both fallbacks (one
ADMIN step, no band); project-less requisition routes to ADMIN; a project's
own policy still wins; running migration 101's SQL twice adds no duplicates;
cross-org isolation made deterministic (this org's fallback switched off,
another org given an explicit active one, submission here still refused —
avoids relying on the shared test DB's incidental leftover state).
`apps/web/tests-dom/approval-policies.test.tsx`: RED/GREEN on the two
confirmation-message variants.

**Files.** `apps/api/src/database/migrate.ts`,
`apps/api/src/database/migrations/101_org_fallback_approval_policies.sql`,
`apps/api/src/database/seed.ts`, `apps/api/test/catalogue/approvals.test.ts`,
`apps/web/components/approvals/ApprovalPoliciesManager.tsx`,
`apps/web/tests-dom/approval-policies.test.tsx`.

**Migration.** `101_org_fallback_approval_policies.sql` — one INSERT…SELECT
CTE chain, idempotent, no live-DB run performed (per instructions).

**Commit.** `439b5d5 feat(approvals): org-wide fallback ladders for requisitions and purchase orders`

---

## Extra (a) — Delegation covers role-based ladder steps

**Current behaviour found.** `canAct()` (`packages/shared/src/approvals.ts`)
only checked delegation via `effectiveApprovers()` when a step named a
specific `approverUserId`. A role-based step ("any PROJECT_MANAGER") checked
only the actor's own `actorRoles` — a delegate with no PM role of their own
could not act on it even with a live delegation from a PM.

**Change.** `Delegation` gains `fromUserRoles` (role codes the delegating
user holds); `apps/api/src/modules/approvals/routes.ts` `delegationsFor()`
joins `user_roles`/`roles` to populate it. `canAct()`'s role branch now also
allows an actor who is a live delegate of anyone holding `step.approverRole`.
`ApprovalDecision` gains `onBehalfOf` (returned by both the named and role
branches) so the decision route's `acted_on_behalf_of` audit column can name
the principal for a role match — `current.approverUserId` doesn't exist for a
role-based step. Self-approval is unaffected: checked before any
role/delegation logic, so a delegate who is also the requester is still
refused regardless.

**RED/GREEN.** `packages/shared/src/approvals.test.ts` (role-based-steps
describe): RED confirmed the missing match, then a second RED confirmed
`onBehalfOf` before it was implemented. `apps/api/test/catalogue/approvals.test.ts`
adds an end-to-end case through `ladderPolicy()`'s role-based level 2
(TEAM_LEAD acting as PROJECT_MANAGER's delegate, `acted_on_behalf_of` checked)
and a self-approval-via-role-delegation guard on a single-level policy.

**Files.** `packages/shared/src/approvals.ts`,
`packages/shared/src/approvals.test.ts`,
`apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `c18e36e feat(approvals): delegation covers role-based ladder steps`

---

## Extra (b) — Approvals inbox respects project scope

**Current behaviour found.** `GET /api/v1/approvals/inbox` matched a pending
step against the actor's roles and delegated-to user ids only; nothing
filtered by the instance's `project_id`. A project-scoped approver (§4.1's
default for TEAM_LEAD/PROJECT_MANAGER) saw every pending item in the
organisation.

**Change.** The route resolves the actor's `approval.act` scope
(`resolveScopes`, the same helper `projectAccess()` uses) and, unless global,
only lists an instance when it is project-less or its `project_id` is one the
scope covers. This is a visibility filter on the listing only —
`POST /approvals/:id/decision` was not and is not project-scoped by this
change, so who can act on a document reached directly by id is unchanged.
While in there: a role-based step's live delegates (extra (a)) now also see it
in their inbox — previously the query added a delegate only to
`approver_user_id` matches.

**RED/GREEN.** New describe "inbox project scope" in
`apps/api/test/catalogue/approvals.test.ts`: RED showed an out-of-scope
project's item leaking into a freshly-created, project-scoped PROJECT_MANAGER's
inbox; GREEN confirmed it is excluded while the same project's item and an
org-wide item are included, and a globally-scoped PROJECT_MANAGER still sees
every project's items.

**Files.** `apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `94ef4a7 feat(approvals): inbox respects project scope`

---

## Extra (c) — POST /api/v1/invoices needs invoice.manage

**Current behaviour found.** `POST /api/v1/invoices` gated on
`inventory.manage` while every other vendor-invoice write (`PATCH
.../lines`, `.../status`, `.../dispute`, `.../match`) gated on
`invoice.manage`. `INVENTORY_MANAGER` held `inventory.manage` (and only
`invoice.read`, not `invoice.manage`) — its sole route to creating an invoice.

**Change.** Create route switched to `invoice.manage`.
`FINANCE_ROLE_GRANTS.INVENTORY_MANAGER` gains `invoice.manage` so it keeps
create ability — which, since `invoice.manage` is the one permission every
other vendor-invoice write already shared, also gives it match/status/dispute
(there is no narrower "create only" grant to hand out instead; a pre-existing
test that assumed INVENTORY_MANAGER could only read matches was updated to
reflect this, with a new positive test alongside it).
`apps/api/src/database/migrations/110_invoice_manage_grants.sql` backfills the
grant for an existing install (idempotent, `ON CONFLICT DO NOTHING` on
`role_permissions`'s own PK), registered in `migrate.ts` after 101.
`apps/web/app/inventory/page.tsx`'s "Record invoice" panel `Can` gate moved
from `inventory.manage` to `invoice.manage` to match. SUPER_ADMIN, ADMIN and
PAYROLL_OFFICER already held `invoice.manage`; PAYROLL_OFFICER gains create
ability it didn't have before (the intended consolidation, not a gap).

**RED/GREEN.** `apps/api/test/catalogue/procurement.test.ts`: RED showed
INVENTORY_MANAGER refused at create; GREEN showed
INVENTORY_MANAGER/PAYROLL_OFFICER allowed, AUDITOR/PROJECT_MANAGER still
refused. `packages/shared/src/financial-control.test.ts` pins the new grant
(RED/GREEN). Web: `tsc --noEmit`, `next build`, and the full web vitest suite
(77 files / 947 tests) all pass with the gate changed. No dedicated DOM test
was written for the single-line web gate change — `apps/web/app/inventory/page.tsx`
is a minified, single-line generic CRUD page with no existing test harness,
and standing one up (Workbench/AppShell/nav mocking) for a one-token literal
change was judged disproportionate; tsc + build + the full suite verify it
compiles and nothing else broke.

**Files.** `apps/api/src/modules/inventory/routes.ts`,
`apps/api/src/database/migrate.ts`,
`apps/api/src/database/migrations/110_invoice_manage_grants.sql`,
`packages/shared/src/financial-control.ts`,
`packages/shared/src/financial-control.test.ts`,
`apps/api/test/catalogue/procurement.test.ts`,
`apps/web/app/inventory/page.tsx`.

**Migration.** `110_invoice_manage_grants.sql` — single idempotent INSERT, no
live-DB run performed.

**Commit.** `e8b3daa fix(invoices): create route needs invoice.manage, matching every other write`

---

## Final verification

- Full `apps/api` suite (`npx vitest run`, VM slot g, HEAD `e8b3daa`, the last
  code commit): **2148 passed, 1 failed, 2149 total** (79/80 files green).
  Duration 1114s. The one failure —
  `test/catalogue/survey-operations.test.ts > alerting on work that has
  stopped > raises a village past the date somebody committed to`, expected
  "5 days ago" and got "It was due on 2026-09-19, 6 days ago" — is a
  pre-existing date-rollover flake: the VM's calendar day advanced from
  2026-09-24 to 2026-09-25 partway through this session, and that one
  assertion computes "days ago" against the live system clock rather than a
  frozen test clock the way the rest of the suite does. No file in the
  survey module or its tests was touched by any commit in this branch;
  confirmed with `git diff --stat` against every commit here. Not a
  regression from this work.
- Web (after `e8b3daa`, the last web-touching commit; the doc commit added
  afterward does not touch web): `tsc --noEmit` clean, `next build` clean,
  full `npx vitest run` — **947 passed, 0 failed** across 77 files.
- No migrations run against the live DB. No leave-module files touched.

---

# Fix round 1

Same worktree and branch. TDD throughout, one commit per item, same trailer.

## C1 (CRITICAL) — RA bill receipts could be over-allocated or stranded

**Current behaviour found.** `documentValue()` (`apps/api/src/modules/finance/routes.ts`)
capped a SUBMITTED bill's receipt allocation at `gross_value`, not
`net_payable` — the figure net of the TDS/retention the bill already
carries at raise time. Separately, nothing re-checked live allocations
when a bill's payable itself moved: certifying at a lower figure than
already claimed, sending a SUBMITTED bill back to DRAFT, or cancelling a
SUBMITTED or CERTIFIED bill each left money allocated against a payable
that had shrunk or vanished, with no mechanism to unwind it.

**Change.** `documentValue()` now uses `net_payable` for a SUBMITTED
bill's invoiced figure (falling back to `certified_amount` only once
CERTIFIED/PAID). `POST /ra-bills/:id/status`
(`apps/api/src/modules/billing/routes.ts`) computes live allocations
(`raBillLiveAllocated`, a sum of unreversed `payment_allocations`) against
the payable the target status would leave — the certified figure for
CERTIFIED, unchanged for PAID, zero for DRAFT/CANCELLED — and refuses with
`RA_BILL_OVER_ALLOCATED` (422), naming the amount to unallocate first, if
live allocations would exceed it. Both routes already row-lock the bill
(`inOrg(..., true)` / `documentValue(..., lock=true)`), so a concurrent
allocation and a status change serialise on that lock instead of racing.

**RED/GREEN.** New describe in `apps/api/test/catalogue/ra-billing.test.ts`:
RED showed the net_payable cap missing and all four transition guards
absent (5 failures); GREEN showed the cap enforced, each transition
(certify below allocated, →DRAFT, →CANCELLED from SUBMITTED, →CANCELLED
from CERTIFIED) refused while allocated and succeeding once unallocated via
payment reversal, plus a concurrent allocation-vs-certification race
(invariant-checked, re-run three times for stability).

**Files.** `apps/api/src/modules/finance/routes.ts`,
`apps/api/src/modules/billing/routes.ts`,
`apps/api/test/catalogue/ra-billing.test.ts`.

**Migration.** None.

**Commit.** `20a2dfb fix(billing): refuse to over-allocate or strand an RA bill's receipts`

---

## I1 — POST decision now enforces the inbox's project scope

**Current behaviour found.** `GET /approvals/inbox` filters a scoped
approver's list to their own projects plus org-wide documents (2026-09-24
decisions), but `POST /approvals/:id/decision` had no equivalent check — a
scoped user who knew or guessed a document's id could still decide it
directly, so the inbox's filtering was cosmetic, not a boundary.

**Change.** The decision route resolves the actor's `approval.act` scope
(`resolveScopes(u.scopes)`, the same call the inbox makes) right after
loading the instance and refuses `FORBIDDEN` (403) when the scope is not
global and the instance's `project_id` is not one it covers — wording
matches `projectAccess()`'s existing "outside your scope" message.

**RED/GREEN.** RED: a freshly scoped `PROJECT_MANAGER` could decide
another project's pending item by id (200 instead of 403). GREEN: refused,
and still free to decide their own project's.

**Files.** `apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `b151cd1 fix(approvals): POST decision enforces the same project scope as the inbox`

---

## I2 — Role-based delegation carries the principal's project scope

**Current behaviour found.** A role-based step ("any PROJECT_MANAGER")
lets a live delegate inherit the principal's role eligibility, but nothing
checked that the *principal* could reach the document's project — a
globally-scoped delegate of a project-scoped PM could decide a project
that PM never managed, simply by borrowing their role.

**Change.** `Delegation` gains `fromUserScope` (the principal's own
resolved project scope; `apps/api`'s `delegationsFor` resolves each
principal's `user_roles` rows the same way `resolveScopes` always has).
`canAct()` gains a `projectId` parameter; a role-based delegation match
now also requires `principalCanReachProject(projectId, fromUserScope)` —
the principal's scope is global, or the project is one of theirs. Absent a
`projectId` (org-wide document) or `fromUserScope` (older caller), the
check stays permissive. The decision route passes `instance.project_id`
through.

**RED/GREEN.** `packages/shared/src/approvals.test.ts` covers
reachable/unreachable projects, an org-wide document staying unrestricted,
a globally-scoped principal's delegate reaching anywhere, and the
permissive default. `apps/api/test/catalogue/approvals.test.ts`: ADMIN
(globally scoped, no PROJECT_MANAGER role) can decide a role-based step
only for the project its scoped-PM principal manages — refused
`NOT_THE_APPROVER` for another project even though ADMIN's own I1 scope
check would have let it through.

**Files.** `packages/shared/src/approvals.ts`,
`packages/shared/src/approvals.test.ts`,
`apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `0a5fdad feat(approvals): role-based delegation carries the principal's project scope`

---

## I3 — Segregation of duties: one person, at most one level

**Current behaviour found.** Nothing stopped the same physical person
deciding more than one level of an instance: a PM who cleared level 1
with their own role could then reach for a borrowed ADMIN delegation and
clear level 2 too. `canAct()` had no memory of who had already acted.

**Change.** `canAct()` is refactored into eligibility resolution
(`resolveEligibility`, behaviour unchanged) plus a segregation gate
applied to whatever it returns. The gate compares two identity sets:
everyone who already decided an earlier level (both `actedByUserId` and,
if delegated, `actedOnBehalfOf`) against both identities behind the
current attempt (the actor, and the principal if acting via delegation).
Any overlap refuses `SEGREGATION_OF_DUTIES`. A skipped step counts as
decided by nobody. `ApprovalStep` gains `actedOnBehalfOf`; `stepsFor()`
reads `acted_on_behalf_of` into it.

**RED/GREEN.** `packages/shared/src/approvals.test.ts`: a PM reaching for
a borrowed ADMIN role after clearing level 1 themselves; a second delegate
of the same principal finishing what the first delegate started; an
unrelated decider still allowed; a skipped step not counting.
`apps/api/test/catalogue/approvals.test.ts` adds the brief's exact case —
a PM at L1 who is also an ADMIN delegate can't approve L2 — and its
positive counterpart. Two earlier tests in this file had used the same
physical actor for both levels of an instance to demonstrate role-based
delegation, which this rule now correctly refuses; both were adjusted to
use a second, uninvolved role for the second level (one of those
adjustments also incidentally cleared a cross-test delegation-cycle
collision it had introduced with two other tests' own PROJECT_MANAGER/
ADMIN delegation pairs, all persisted unrevoked in the same run).

**Files.** `packages/shared/src/approvals.ts`,
`packages/shared/src/approvals.test.ts`,
`apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `078b038 feat(approvals): segregation of duties -- one person, at most one level`

---

## I4 — Narrow migration 110 to invoice.create (controller ruling)

**Current behaviour found.** Migration 110 (unreleased) gave
INVENTORY_MANAGER the full `invoice.manage` permission so `POST
/api/v1/invoices` moving off `inventory.manage` would not take away its
ability to create a vendor invoice. That grant was too broad —
`invoice.manage` also covers editing an invoice's lines, changing its
status, disputing it and recording a three-way match.

**Change.** New `invoice.create` permission
(`packages/shared/src/financial-control.ts`), narrower than
`invoice.manage` and meant only for creating a vendor invoice. Every role
already holding `invoice.manage` is granted `invoice.create` too (nothing
changes for them); INVENTORY_MANAGER gets `invoice.create` alone,
replacing its `invoice.manage` grant. `apps/api/src/common/auth.ts` gains
`requireAnyPermission` (an OR-gate); `POST /api/v1/invoices` uses it with
`['invoice.create', 'invoice.manage']`. Every other vendor-invoice write
stays `invoice.manage` only. Migration 110 was rewritten in place (never
released): inserts the `invoice.create` permission row, grants it to every
role holding `invoice.manage`, and grants it to INVENTORY_MANAGER
directly. `apps/web`'s `Can` component (`components/v2/Workbench.tsx`) now
accepts an array of permissions (any match); the inventory page's "Record
invoice" panel gates on `["invoice.create", "invoice.manage"]`.

**RED/GREEN.** `packages/shared/src/financial-control.test.ts` pins the
narrowed grant and that every `invoice.manage` holder also gets
`invoice.create`. `apps/api/test/catalogue/procurement.test.ts`: the
three-way-match role test has INVENTORY_MANAGER back among those refused
(it no longer holds `invoice.manage`); the create-route test's comments
updated. Web: `tsc`, `next build` and the full web vitest suite (947/947)
pass with the `Can`/gate changes; no dedicated DOM test was added for the
array-permission `Can` behaviour or the earlier single-permission gate
(apps/web/app/inventory/page.tsx has no existing test harness and building
one for a two-token literal change was judged disproportionate) —
compilation, build and the existing suite verify it instead.

**Files.** `apps/api/src/common/auth.ts`,
`apps/api/src/database/migrations/110_invoice_manage_grants.sql`,
`apps/api/src/modules/inventory/routes.ts`,
`apps/api/test/catalogue/procurement.test.ts`,
`apps/web/app/inventory/page.tsx`,
`apps/web/components/v2/Workbench.tsx`,
`packages/shared/src/financial-control.ts`,
`packages/shared/src/financial-control.test.ts`.

**Migration.** `110_invoice_manage_grants.sql` — rewritten (still
unreleased, no live-DB run performed): inserts the permission row, then
two idempotent grant inserts.

**Commit.** `75cd207 fix(invoices): narrow the invoice.manage grant to invoice.create`

---

## Minor — seed no longer resurrects a deactivated org-wide fallback

**Current behaviour found.** `seedDatabase()`'s org-wide fallback loop
only checked for an *active* policy before inserting a default — exactly
the state left behind after an administrator deactivates the seeded
default from Approvals → Policies. Re-running the seed (it re-converges
role grants and other canonical rows every run) would see no active row
and insert a fresh one on top of that deliberate choice.

**Change.** The check now looks for any org-wide policy row for the
document type, active or not; only a pair with no policy configured at
all gets the default. `scripts/seed-volume.ts` (bypasses `seed.ts`
entirely) gets the same fallback loop and the same either-state check.

**RED/GREEN.** Reuses the state the cross-org-isolation test (item 2)
already leaves behind — the org-wide PURCHASE_REQUISITION fallback
deactivated but not deleted. RED: re-seeding resurrected an active row.
GREEN: no active row reappears, the document type still refuses
NO_APPROVAL_POLICY, and the untouched PURCHASE_ORDER fallback is
unaffected. No dedicated test for `scripts/seed-volume.ts` (no existing
harness, manually-run CLI script, change mirrors seed.ts's tested pattern
exactly); verified with `tsc --noEmit`.

**Files.** `apps/api/src/database/seed.ts`,
`apps/api/src/scripts/seed-volume.ts`,
`apps/api/test/catalogue/approvals.test.ts`.

**Migration.** None.

**Commit.** `0b07bef fix(approvals): seed no longer resurrects a deactivated org-wide fallback`

---

## Fix round 1 — final verification

- Full `apps/api` suite (`npx vitest run` under `nohup`, VM slot g, HEAD
  `0b07bef`): **2158 passed, 1 failed, 2159 total** (79/80 files). Duration
  1172s. The one failure is the same pre-existing
  `test/catalogue/survey-operations.test.ts` date-rollover flake noted after
  the first batch (VM calendar day 2026-09-24 → 25 mid-session; that one
  assertion reads the live system clock rather than a frozen test clock).
  Still no survey file touched by any commit on this branch. Not a
  regression from fix round 1.
- Web (touched in I4 only; the Minor commit is apps/api-only): `tsc --noEmit`
  clean, `next build` clean, full `npx vitest run` — 947 passed, 0 failed
  across 77 files, verified at the I4 commit and unchanged since.
- No migrations run against the live DB. No leave-module files touched.

---

# Fix round 2

Same worktree and branch. TDD throughout, one commit per item, same trailer.

## Item 1 — C1 gap: count TDS/advance as settled

**Current behaviour found.** `raBillLiveAllocated` (C1, fix round 1) summed
only `payment_allocations.amount`, while
`settlementPosition`/`checkAllocation`
(`packages/shared/src/financial-control.ts`) count
`amount + tds_amount + advance_adjusted` as settled (not
`retention_amount` or `other_deduction`, which stay outstanding). A row
carrying non-zero `tds_amount`/`advance_adjusted` against an RA bill would
under-count what is already closed out, letting certification land below
the true settled figure.

**(a) Verification.** APAR-2 (`paymentAllocationSchema`'s `superRefine`,
already refusing `tds_amount`/`advance_adjusted` on an RA_BILL allocation)
is checked unconditionally on the one path that writes
`payment_allocations` with caller-controlled fields: `POST
/payments/:id/allocations`. The other write path
(`apps/api/src/modules/ledgers/routes.ts`'s payment-run execute — the
"bulk" path) never asks for a document type at all —
`payment_run_lines` is hard-wired to `VENDOR_INVOICE` when a run is built,
and its `INSERT` into `payment_allocations` names only `amount`, leaving
`tds_amount`/`advance_adjusted` at their column defaults. No gap found;
confirmed end to end rather than by reading the code alone.

**(b) Change.** `raBillLiveAllocated` now sums
`amount + tds_amount + advance_adjusted`, matching
`settlementPosition`/`checkAllocation` exactly — defence in depth against
any future path that bypasses the schema.

**RED/GREEN.** `apps/api/test/catalogue/ledgers.test.ts`: a bulk-executed
payment run's allocations are confirmed `VENDOR_INVOICE` with zero
TDS/advance (already true; not a RED/GREEN pair, a verification test).
`apps/api/test/catalogue/ra-billing.test.ts`: RED showed certifying at
440,000 succeeding despite 400,000 cash + 50,000 TDS (written directly,
bypassing the schema) already settling 450,000; GREEN showed it refused
`RA_BILL_OVER_ALLOCATED`, and certifying at 450,000 succeeding.

**Files.** `apps/api/src/modules/billing/routes.ts`,
`apps/api/test/catalogue/ledgers.test.ts`,
`apps/api/test/catalogue/ra-billing.test.ts`.

**Migration.** None.

**Commit.** `d326d1e fix(billing): count TDS/advance as settled in the over-allocation guard`

---

## Item 2 — I3 policy caveat: unresolvable ladders

**Current behaviour found.** Segregation of duties (I3) correctly refuses
the same physical person a second level of an instance, but nothing
stopped a ladder from naming that same only-possible person at two levels
in the first place — the same named approver twice, or a role with at
most one holder in the organisation, at two levels. Every instance under
such a policy would 422 forever, with no way to ever clear it, and the
inbox showed it as if it were actionable.

**(a) Save-time validation.** `POST /api/v1/approval-policies` now refuses
(`LADDER_UNRESOLVABLE`, 422) a ladder where the same `approver_user_id`
appears at two levels (always the same person), or the same
`approver_role` appears at two levels while the organisation currently has
at most one holder of it (a live count against `user_roles`). A role held
by two or more people is left alone — who holds it can change, and
different people legitimately clearing each level is exactly how the
ladder is meant to work. The web form (`ApprovalPolicyForm` via
`approvalPolicySchema`) catches the named-approver duplicate client-side,
before the round trip; the role-holder-count case needs a database lookup
the form does not have and is left to the API's 422.

**(b) Runtime message.** The `SEGREGATION_OF_DUTIES` 422 now names the
policy and tells the user to ask an administrator to change it, since no
amount of resubmitting fixes a policy design problem.

**(c) Inbox filtering.** `GET /approvals/inbox` now runs each candidate
through `canAct()` itself instead of a separate, narrower
"is it sequentially next" check, so sequence, delegation and segregation
of duties (I2/I3) all filter the list exactly as they would refuse the
decision — an item only a policy fix could ever clear no longer looks
actionable and 422s on click.

**RED/GREEN.** `apps/api/test/catalogue/approvals.test.ts`: RED showed the
named-duplicate and single-holder-role ladders saving successfully (201),
the runtime message missing "administrator", and a segregation-blocked
item still listed in the blocked user's inbox; GREEN showed all four
fixed, plus that a second holder or two different people/roles save fine,
and the real approver's inbox still lists the item.
`apps/web/tests-dom/approval-policies.test.tsx`: RED/GREEN on the
client-side named-duplicate refusal.

**Files.** `apps/api/src/modules/approvals/routes.ts`,
`apps/api/test/catalogue/approvals.test.ts`,
`apps/web/lib/validation.ts`,
`apps/web/tests-dom/approval-policies.test.tsx`.

**Migration.** None.

**Commit.** `4f79abe feat(approvals): refuse unresolvable ladders, name the policy, filter the inbox`

---

## Fix round 2 — final verification

- Full `apps/api` suite (`npx vitest run` under `nohup`, VM slot g, HEAD
  `4f79abe`): **2165 passed, 1 failed, 2166 total** (79/80 files). Duration
  1058s. The one failure is the same pre-existing
  `test/catalogue/survey-operations.test.ts` date-rollover flake noted in
  both earlier batches; still no survey file touched by any commit on this
  branch. Not a regression from fix round 2.
- Web (touched in item 2): `tsc --noEmit` clean, `next build` clean, full
  `npx vitest run` — **948 passed, 0 failed** across 77 files.
- No migrations run against the live DB. No leave-module files touched.
