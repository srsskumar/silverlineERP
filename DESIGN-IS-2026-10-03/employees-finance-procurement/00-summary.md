# Design audit — employees / finance / procurement cluster

Second design-is pass this session, per owner's "pick for me" instruction. Scope: `employees`, `procurement`, `receivables`, `payables`, `expenses`, `billing` ("Project finance"), `payments` — the highest-traffic data-entry/finance screens outside the survey module. Evidence this time is **live, in-browser** (screenshots + computed styles), not source-inferred: the local dev server's crash was traced to a real root cause mid-session — this machine has the repo reachable under two path casings (`Desktop` vs `desktop`), and running the dev server from the actual on-disk casing (`C:\Users\Admin\Desktop\...`) instead of the casing used earlier eliminated the duplicate-React-instance crash entirely. All screenshots and computed-style checks below are real, not inferred.

## What was checked

Screenshots taken with real seeded data (`seed-volume.ts`, 40 rows/table) across: Dashboard (re-verified), Employees directory, Employees new-record form, Payments, Procurement (requisitions tab), Receivables (empty-state), Payables (real aging data), Expenses, Project finance (billing).

## Findings and fixes (both shipped this session)

1. **Confirmed, systemic AA-contrast failure — `text-text-subtle` at `text-2xs`.** Computed live on the Receivables page: `rgb(136,145,160)` on white ≈ **3.18:1**, below WCAG AA's 4.5:1 — worse than the instance already found and fixed in the survey module. Traced to the single shared `Stat`/`Field`/`StatusBadge`/`RecordSheet` components in `components/finance/Primitives.tsx`, used by every stat card and labelled field across employees, procurement, receivables, payables, expenses, billing, **and** the survey dashboard (same shared component). Fixed at the source — `text-text-subtle` → `text-text-muted` in all 4 locations in that one file — which corrects every stat card and record-sheet label app-wide in one change, rather than patching each page.

2. **Confirmed, same raw-`<select>`/`<input>`-with-no-focus-ring pattern as survey**, in employees, procurement, receivables, payables, expenses, and billing (48 instances total). Same fix as the survey module: migrated every one to the existing `NativeSelect`/`Input`/`Textarea` components, added 19 missing `aria-label`s, deleted two now-dead ad hoc className locals. Checkboxes and the CSV file input correctly left alone.

## Scorecard (abbreviated — same ten principles, see survey audit for full rubric)

| # | Principle | Score | Note |
|---|---|---|---|
| 1 | Innovative | 1/3 | Standard ERP patterns, same as survey — no novel pattern found or expected here. |
| 2 | Useful | 2/3 | Every checked page completes its primary task directly (view employee, record payment, raise a requisition) with no decoy actions. |
| 3 | Aesthetic | 2/3 | Color/type discipline matches survey's finding (token-driven, no ad hoc palette use); the one confirmed systemic contrast failure is now fixed. |
| 4 | Understandable | 3/3 | Strong inline micro-copy throughout — procurement's "No title matches…" hint, receivables'/payables' explanatory empty and zero states, MSME compliance callout on Payables. |
| 5 | Unobtrusive | 2/3 | Same shared AppShell chrome as survey — visible but quiet. |
| 6 | Honest | 3/3 | No inflated claims, accurate status badges, honest empty-state copy ("Nothing outstanding — every certified bill has been settled"). |
| 7 | Long-lasting | 3/3 | No trend-chasing styling; utilitarian and durable. |
| 8 | Thorough | 2/3 | Empty states are genuinely excellent where checked; focus-ring gap is now fixed; loading/error/disabled states not independently live-verified this pass. |
| 9 | Environmentally friendly | 2/3 | No heavy map/animation dependency in this cluster; motion off. |
| 10 | As little design as possible | 2/3 | The duplicated raw-input/select pattern (same violation as survey) is now fixed at the source. |

**Total: 22/30 → REFINE.** No principle scored 0, total clears the ≥20 threshold. This is a materially better outcome than the survey module's 18/30 REDESIGN — the bones here were already sound; the two issues found were both shared-component-level defects (fixed once, fixed everywhere) rather than survey's per-file structural duplication problem.

## Remaining, lower-priority (not done this pass)

- Loading/error/disabled states across this cluster were not independently live-triggered and verified (would need deliberately broken network conditions or forced error responses to check honestly) — flagging as unverified rather than claiming either way.
- A full click-through of every form (procurement's award flow, expenses' claim submission, billing's RA-bill creation) wasn't done — screenshots covered the list/landing view of each page, not every modal/sheet.

No handoff prompt needed — REFINE at this total with the identified fixes already shipped means there's no further implementation to commission from this audit.
