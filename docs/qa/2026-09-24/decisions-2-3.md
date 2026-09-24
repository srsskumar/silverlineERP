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

- Full `apps/api` suite (`npx vitest run`, VM slot g, HEAD `e8b3daa`): pending —
  running in background at time of writing; result to be appended.
- Web: `tsc --noEmit`, `next build`, and full `npx vitest run` (77 files / 947
  tests) all green, run after the invoice.manage commit (which is web-touching
  and last in the branch).
- No migrations run against the live DB. No leave-module files touched.
