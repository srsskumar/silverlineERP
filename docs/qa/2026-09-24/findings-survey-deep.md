# Survey deep round, lane 1: findings (SV-*)

Relayed by the controller from lane 1's hand-back. The agent's harness refused the file write. Branch qa/survey-deep. The live fixture ids are in ~/sl-e2e/qa-survey.json, and the probes are in scripts/qa/survey/.

Coverage (live API): admin, PM, TL, crew A/B, client ×2, govt ×2, org2. It covers the full ladder walk (plus skip, backward and out-of-order moves), milestones (early, out of order, concurrent double-claim, >100%, forward-dated, bulk dry-run), certified totals, UNKNOWN_MEASURE (422), double submit, offline replay, amendments, rover ownership, cross-org and observer reads on every staff route, and IST-midnight alerts.
Not covered: web pages in a real browser (blocked: the public origin was refused as traffic redirection, and 127.0.0.1 is blocked by the CSP); mobile (lane 2); CSV/KML import beyond reading the code.

| ID | Sev | Status | What |
|---|---|---|---|
| SV-001 | OWNER DECISION | BLOCKED | Stage-completion rule (assigned employee, reporting manager, TL, PM or admin). The helper workAuthority/authorityCovers and the tests (describe.skip in survey-authority.test.ts) are ready. Enabling it was refused by the permission classifier and needs the owner's explicit go-ahead. Today any programme survey.enter holder can complete any stage. |
| SV-002 | OWNER DECISION | FIXED | GCP create/edit/delete limited to the same authority set; delete also keeps survey.manage. |
| SV-003 | OWNER DECISION | FIXED | Observers (CLIENT_VIEWER/GOVT_OBSERVER, even alongside a staff role) get contact phone, email and notes masked server-side. |
| SV-007 | P1 | FIXED | Completing a stage without started_on erased the start date. |
| SV-011 | P1 | FIXED | A PAID claim could go back to SUBMITTED or RETURNED. A transition table now applies, including on the bulk path. |
| SV-004 | P2 | FIXED | A garbage release date returned 500. |
| SV-005 | P2 | FIXED | start-gt accepted an EXITED employee. |
| SV-006 | P2 | FIXED | start-gt didn't carry the issued kit. |
| SV-008 | P2 | FIXED | A stage could be completed before its start or in the future. |
| SV-012 | P2 | FIXED | A claim decision could be dated before submission. |
| SV-013 | P2 | FIXED | A paid claim, or one with later milestones, could be deleted. |
| SV-009 | P3 | FIXED | A village extent couldn't be cleared. |
| SV-010 | P3 | FIXED | Reversed plan dates were accepted. |
| SV-015 | P3 | FIXED | The alert tests used the UTC day (the job itself was correct). |
| SV-014 | P2 | OPEN, owner question | Any programme survey.enter holder can file or amend today's return for any village (verified live). The recommendation is to apply the GCP rule. Same as lane 2's SG-D1. |
| SV-016 | P3 | OPEN | PUT finals has no If-Match, so concurrent certification is last-write-wins. |
| SV-017 | P3 | OPEN | Survey route "today" is fixed to IST; alerts use the org timezone. |
| SV-018 | P3 | OPEN | /projects/:id/employees enrolment uses directory scope, so a PM gets 403 while start-gt and crew assignment don't. |

Tests: api 2163/2164, with the one failure being SV-015, since fixed (survey-operations 136/136). The full suite wasn't re-run after that fix. api tsc clean; shared 1018; web tsc clean; web vitest 944/945 (the survey-tabs timeout passes when run alone); mobile 419 + tsc.

## Fix round 1 (relayed by the controller)
| ID | Sev | Status | What |
|---|---|---|---|
| SV-019 | Important | FIXED ad3d32d | Paid-claim reversal: `POST /survey/billing/:id/reverse` plus bulk `action: "REVERSE"`, PAID → APPROVED. Admin/SUPER_ADMIN only (403 ADMIN_ONLY), a reason of ≥5 characters (422), If-Match on the single route, bulk dry-run, and NOT_PAID skips. Audited as `survey.village.billing.reverse` with before/after/reason. Amounts are exact (49.99 → 50 / 123.4567 ac tested). The misleading message is fixed. No web UI yet. |
| SV-021 | Minor | FIXED 79809d9 | Phones masked on crew-assets and projects/:id/employees for observer-role holders; a shared masksPhones() rule. |
| SV-020 | Minor | FIXED ae68897 | GCP DELETE uses survey.enter plus the shared authority helper (crew, manager, TL, the project's PM, admin). A non-project PM holding survey.manage is now refused, matching create/edit. |
| SV-015 | P3 | FIXED 925f678 | The alert test flake: the org-IST day, and "N days ago" read the way the job computes it. |
| SV-022 | Minor | FIXED in round 2 (007b0cc) | Bulk DECIDE doesn't apply the SV-012 check (decision dated before submission). |

Full apps/api suite after fix round 1 (slot d, `/tmp/svd-lane1-full.log`): **82 files, 2174 passed, 13 skipped, 0 failed**. Web tsc clean.

## Round 2 (relayed by the controller)
| ID | Sev | Status | What |
|---|---|---|---|
| SV-022 | Minor | FIXED 007b0cc | Bulk DECIDE now applies the SV-012 rule row by row. A village whose claim was submitted after the decision date is skipped and named `DECIDED_BEFORE_SUBMITTED` (same in the dry run); the rest of the batch goes ahead. |
| SV-019b | Minor | FIXED 1251f84 | Bulk REVERSE reports `updated` as the reversals actually made under the lock, not the eligible count taken from the preview read. The race itself can't be forced in a test; the count is pinned. |
| SV-023 | Important (regression from SV-011) | FIXED b2975ce | The transition table left out APPROVED → SUBMITTED, so the web's existing "Undo decision" on a mistaken approval got 409. Allowed again; only PAID is closed. |
| SV-019 UI | — | DONE 91d063f | Web: "Reverse payment" on PAID claims in the village billing table, for ADMIN/SUPER_ADMIN only (`mayReversePayments`, matching the API gate). A confirm dialog requires a reason of ≥5 characters and sends If-Match. Undo, Edit and Remove are hidden on paid claims (the server refuses them). The bulk bar has a REVERSE option for admins, with a reason field, dry-run preview first. Component: `components/survey/ReversePaymentDialog.tsx`; tests: `tests-dom/survey-billing-reversal.test.tsx` (exact requests). The DOM tests were written alongside the new component, so their RED was a missing module rather than a failing assertion. |

Round 2 verification (slot d, `/tmp/svd-lane1-r2.log`): survey and village API tests 16 files, 569 passed, 13 skipped; web tsc clean; web suite 78 files, 949 passed; `next build` exit 0.

## Round 3 (relayed by the controller)
| ID | Sev | Status | What |
|---|---|---|---|
| SV-016 | P3 | FIXED 8350fad | Certified totals are optimistic-locked. Each final carries the `version` it replaces (none for a first certification). A missing version on an existing figure is 422 `VERSION_REQUIRED`; a stale one is 409 `VERSION_CONFLICT`; a first certification that loses a race is also 409. Rows are locked `FOR UPDATE` and every write bumps the version. `DELETE /finals/:code` needs If-Match. The web form sends the versions it read (tests-dom pin the PUT and DELETE; RED confirmed against the old form). A concurrent pair gives exactly one 200 and one 409. |
| SV-017 | P3 | FIXED 13bcfd1 | Survey "today" now uses the org's `settings.timezone` (default Asia/Kolkata), the same setting as `orgTodaySql`. Survey guards load the zone (`orgTimeZone`, cached 60 s); `today(orgId)` covers every default and check (crew assign/release, work date, stage dates, billing defaults, report periods, past-day amendment), and timestamps are converted to days in the org zone. Tested on the second tenant with a zone whose day differs from IST at run time. **Residual:** the shared `pastDate` schema check (mirrored on the phone) still reads IST. It only matters for an org east or west of IST around its midnight. |
| SV-018 | P3 | FIXED b391ba7 | Programme enrolment and single crew assignment now use the survey rule (`mayStaffProgramme`: admin, a TL on the programme, or the survey project's PM) instead of the employee-directory record scope. That scope refused the project's own PM, while start-gt and crew/bulk (arrays, never checked) let the same PM through. **Outside survey:** the one exemption lives in `common/recordScope.ts`, for exactly those two paths. A PM of another project gets 403 `NOT_ON_THIS_PROGRAMME`; the employee must be ACTIVE. |

Not touched, waiting on the owner: SV-001 (stage-completion rule), SV-014 (who may file returns).

Round 3 final verification (slot d, `/tmp/svd-lane1-r3.log`): full apps/api suite 82 files, 2190 passed, 13 skipped, 0 failed; web tsc clean; survey tests-dom 39/39; `next build` exit 0.

## Round 4 (relayed by the controller)
| ID | Sev | Status | What |
|---|---|---|---|
| SV-024 | Important | FIXED a9cb85d | Three SQL spots still used a literal `'Asia/Kolkata'` after SV-017: the unfiled-returns punch day (two places) and the period report's stage movements. All now use `orgZoneSql`. Tested on the second tenant in Pago Pago with an instant that is the 10th there and the 11th in IST. |
| SV-025 | Important | FIXED 1c6dc3f | `start-gt` and `crew/bulk` now apply `mayStaffProgramme`. Before, another project's PM holding org-wide `survey.manage` got 201 there while being refused on the single crew route. Both refuse the whole request with 403 `NOT_ON_THIS_PROGRAMME`: the rule is about the caller, so there is no per-row case to skip. Nothing is written when refused. The project's own PM succeeds on both. |
| SV-026 | Minor | FIXED ece5387 | A TEAM_LEAD now counts only on a programme they are enrolled or crewed on, in both `mayStaffProgramme` and `workAuthority`. Before, TEAM_LEAD + AUDITOR (which carries `survey.forecast`, so every programme is visible) could staff any programme, complete stages on it or plant GCPs there. Tests land in ece5387 with SV-025's. |

**How "the project's PM" and "today" are decided (item 4):**
- **Who counts as the project's PM.** A PROJECT_MANAGER whose role scope is org-wide (`user_roles.scope_type IS NULL`) passes as the PM of every survey project. It is the same test in `workAuthority` (stage completion and GCPs) and `mayStaffProgramme` (staffing). The other ways to qualify are being the paired project's `project_manager_id`, being enrolled on the programme as `PROJECT_MANAGER`, or having a role scoped to that project. So an unscoped PM is not refused on any programme; only a PM scoped to other projects is.
- **How the org's timezone is looked up.** `orgTimeZone` caches it per process for 60 seconds. After an admin changes the org's timezone, each API process can keep using the old zone for up to a minute. The SQL side (`orgTodaySql` / `orgZoneSql`) reads the setting live.
