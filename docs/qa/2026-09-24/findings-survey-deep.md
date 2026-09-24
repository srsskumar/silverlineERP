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
