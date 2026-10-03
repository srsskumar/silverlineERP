# 02 — Scorecard

1. Good design is innovative — Score: 1/3
   Evidence: standard filter-dropdown/kanban/tab patterns throughout (01-evidence.md, Structural).
   Justification: imitates conventional ERP UI with domain variation (village/mandal filters), no pattern that refreshes a known affordance with a clear improvement.

2. Good design makes a product useful — Score: 2/3
   Evidence: primary tasks (view board, record survey progress) complete directly via labeled controls; dashboard chains 4 sequential queries before the board renders (`dashboard/page.tsx:49,64,78,85`).
   Justification: primary task completes with no decoy actions, but the adjacent query-chaining adds avoidable round-trip delay on the critical path — not a clean 3.

3. Good design is aesthetic — Score: 1/3
   Evidence: 40 distinct spacing values with heavy half-step overlap (`gap-1`/`1.5`/`2`, `py-1`/`1.5`/`2`/`2.5`); an identical select-field class string independently redefined twice in the same file (`survey/page.tsx:490` vs `:3695`); default muted text color fails AA contrast at 3.3:1 (`survey/page.tsx:2772`).
   Justification: color and type scale are disciplined, but spacing proliferation plus duplicated style definitions plus a failing-contrast default text color are 3+ inconsistencies, not ≤2.

4. Good design makes a product understandable — Score: 1/3
   Evidence: `survey/page.tsx:3144` defaults a form field to the unexplained abbreviation "GCP-1"; a raw enum value `'OUTSTANDING'` is wired directly into a filter (`:181`) without a confirmed plain-language label; "ERP v2" footer label is unexplained versioning (`dashboard/page.tsx:174`).
   Justification: 2+ controls carry jargon a first-time user wouldn't recognize without training — matches the "2-3 controls unclear, jargon present" band, not a single-tooltip fix.

5. Good design is unobtrusive — Score: 2/3
   Evidence: zero idle-screen animation found anywhere in scope; chrome (nav rail, topbar) is visually present but carries no decorative competing elements (01-evidence.md, Structural/Visual).
   Justification: chrome is visible but quiet — it recedes without being invisible, which is the "2" band, not the top band (no evidence content is unambiguously made the figure).

6. Good design is honest — Score: 3/3
   Evidence: zero marketing inflations, zero dark patterns, zero label→behavior mismatches found across 40+ sampled strings (01-evidence.md, Copy & Honesty).
   Justification: every claim and label maps to actual behavior with no exceptions found.

7. Good design is long-lasting — Score: 3/3
   Evidence: no idle animation, no trend-driven gradients or display typography, a restrained token-based visual language (01-evidence.md, Visual/Weight).
   Justification: nothing here reads as tied to a design fad; the visual language is utilitarian enough to age without looking dated.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: Dashboard has no Success state anywhere in the file; `survey/page.tsx`, `survey/entry/page.tsx` and `survey/setup/page.tsx` carry zero local focus-ring styling, relying entirely on one global catch-all rule; `survey/entry/page.tsx` and `survey/setup/page.tsx` have zero ARIA attributes.
   Justification: scoring the worst surface (Dashboard: 1 state fully missing; survey files: focus and ARIA never deliberately considered per-control) lands at 2-3 states rough or missing, not just 1.

9. Good design is environmentally friendly — Score: 1/3
   Evidence: survey pages load `maplibre-gl` + `@mapbox/mapbox-gl-draw` + `supercluster` plus 9 separate `@radix-ui/*` packages, likely placing survey's initial JS in the 500KB-2MB band; motion is fully off (not just gated) and dark mode is honored via tokens.
   Justification: scoring the worst surface (survey, the audit's named priority) against the bytes-primary rubric lands in the 1-point band even though motion and dark-mode handling alone would support a higher score.

10. Good design is as little design as possible — Score: 1/3
    Evidence: the same filter-dropdown affordance is independently reimplemented (not shared) across the toolbar, Villages view (6 selects), entry, and setup; an identical class-string literal is defined twice in one file instead of once; dashboard chains what could be parallel queries into sequential ones.
    Justification: 3+ genuinely removable/consolidatable redundancies at the code level (unshared repeated pattern, duplicate literal, avoidable query chaining) — matches the "3-5 removable elements" band.

**Total: 16/30**
