# Overnight report: QA sweep, 24–25 Sep 2026

Status: DRAFT (finalised after deploy 3). The ledger with every ruling is `.superpowers/sdd/2026-09-24-full-qa-sweep/progress.md`. Detailed findings are in `docs/qa/2026-09-24/findings-*.md`.

## What's live / what ships in deploy 3
- **Deploy 1 (7bd6f7d)** and **deploy 2 (0649788)** are live on dev-thor.
- **Deploy 3 (release/qa-2026-09-24-d)** contains:
  - the API contract sweep: 484 routes, each tested with no, bad and expired tokens, the wrong role, the wrong org, malformed input, pagination and idempotency;
  - the people and records policies;
  - the mobile audit of 16 screens (Retry, pull-to-refresh);
  - survey lanes 1 and 2;
  - leave (sandwich rule, year opening, approver re-resolution);
  - approvals and finance (your decisions 2 and 3, delegation, scope, segregation of duties, RA-bill allocation safety, invoice.create).
- **Migrations:** 101, 102, 110, 111, 112 (093–100 are already live).

## Highest-impact bugs found and fixed overnight
- **Survey, P0:** no daily return or GCP could be filed from the phone since 21 Sep (the display date was sent to the schema).
- **Survey, critical:** offline replay overwrote supervisor corrections and zeroed measures. The outbox was rebuilt over 5 reviewed rounds (base-version CONFLICT, supersede newest op, lock, bounded history).
- **Survey:** paid claims couldn't be reversed. There's now an admin reversal with a reason and an audit record, on the API and web. Stage and start dates were being erased. Crew, rover and move writes bypassed the staffing rule.
- **Finance, critical:** RA-bill receipts could be over-allocated or stranded when a bill was certified, cancelled or sent back to draft.
- **Approvals:** decisions ignored project scope. Delegation leaked across projects. One person could approve two levels.
- **Leave:** open-year skipped employees; the preview showed calendar days; approvals got stuck when an approver left. The 1-January job would have opened 2026 for everyone. It's now gated to January.
- **Mobile:** asset assign crashed; 15 lists hid their load errors; tasks never showed a due date.

## Decisions I made for you (change any)
1. The leave 1-January auto-open runs only between 1 and 31 January (org timezone). Mid-year uses the manual button.
2. When a leave approver leaves: step 1 goes to their manager, then HR, then admin; step 2 goes to HR, then admin. Never the applicant, and never one person on both steps.
3. Purge removes the register entry only. The audit records where the content lives.
4. INVENTORY_MANAGER gets a narrow `invoice.create` permission, not the full invoice.manage.
5. Survey billing reversal takes a claim from PAID back to APPROVED (admins only, reason required).
6. On a phone correction, a cleared pre-filled figure is left unchanged; type 0 to remove it.
7. A ladder whose levels can only resolve to one person is caught when the policy is saved.

## Needs you (numbered; reply in plain text)
1. **Approve** giving employees and staff `holiday.read` (the holiday calendar). The permission-grant safety check blocked it.
2. **Approve** enabling the survey stage-completion rule you decided (SV-001). The code and tests are ready; the safety check blocked the enabling edit.
3. **Allow** browser tests against the VM's public address, so the survey web pages can be tested in a real browser.
4. **Purge:** should it also delete the underlying file, or only the register entry?
5. **Daily returns:** limit filing to the assigned crew and their managers (like GCPs), or keep it open to any surveyor?
6. **Amending** a survey return: should it need a separate permission?
7. **Task-linked survey stages:** does the task or the stage row govern? This decides the fix for the dashboard vs progress mismatch (SG-009).
8. **Survey billing lifecycle:** the requirements doc doesn't define it. Confirm Submitted → Approved/Rejected → Paid (with the reversal).
9. **Later:** HTTPS domain, email/SMS provider, APK build. All on hold until you say.

## Still open (minor, logged)
- SV-029: employees/:id/assignments writes survey enrolments without the survey staffing rule (safe with the shipped roles).
- SG-010: dashboard positions ignore the period end.
- SG-016: the entry PATCH ignores rovers.
- The shared `pastDate()` check is still on IST.
- A rare error while settling a sync can leave one survey op in SENDING until restart (recovered on open).
