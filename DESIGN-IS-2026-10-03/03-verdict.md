# 03 — Verdict

**REDESIGN.** Total score is 16/30 — below the ≥20 REFINE threshold — driven by five principles scoring 1/3 (aesthetic, understandable, thorough, environmentally friendly, as-little-as-possible), none of which is a one-line fix: they share a common root cause, which is that the survey module (the audit's named priority) was built as one 3,877-line file with no shared design-system discipline enforced within it, rather than a deliberate layout/token pass.

This is a REDESIGN of the survey module's internal structure and design-system discipline, not of the product's identity: the honesty (3/3) and long-lasting (3/3) scores, and the clean color-token system, are real strengths worth keeping. The shared `AppShell` chrome (nav, topbar, account menu) also scored well on accessibility (ARIA present, focus-visible wired through the shared `Button` component, real landmarks) and should not be touched by this pass.

## Top 5 moves

1. **#10 as-little-as-possible / #3 aesthetic — Extract one shared `FilterSelect` component.** The same filter-dropdown affordance is independently reimplemented across the survey toolbar (`survey/page.tsx:240,272`), the Villages view (6 selects, `:2569-2605`), entry (`:321`), and setup (`:106,318`), and an identical class-string literal is defined twice in one file (`survey/page.tsx:490` vs `:3695`) instead of shared. One component ends the duplication and gives every select the same focus/contrast treatment for free.

2. **#8 thorough — Give every native input in the survey module a local, deliberate focus style and ARIA label.** `survey/page.tsx`, `survey/entry/page.tsx`, and `survey/setup/page.tsx` currently have zero local `focus:`/`focus-visible:` classes and (for entry/setup) zero ARIA attributes, relying only on one global catch-all rule (`globals.css:142-145`). This should route through the same `FilterSelect`/input components from move 1 so the fix is structural, not per-instance.

3. **#4 understandable — Replace raw domain codes in user-facing defaults/filters with plain labels.** `survey/page.tsx:3144` defaults a field to the unexplained abbreviation "GCP-1"; `:181`'s `'OUTSTANDING'` enum value is wired directly into a filter. Add a label map (code → plain phrase, e.g. "Not yet done") at the point these values reach the UI.

4. **#3 aesthetic — Fix the one confirmed AA-contrast failure and consolidate the spacing scale.** `text-text-subtle` on `bg-surface-sunken` at `text-2xs` (`survey/page.tsx:2772`) computes to ≈3.3:1, below AA, and `text-text-subtle` is the single most-used color class across all three surfaces (120 occurrences) — this is a systemic default, not a one-off. Alongside that, collapse the 40-value spacing scale actually in use down to a documented subset (the half-step pairs like `gap-1`/`gap-1.5`/`gap-2` should resolve to one choice per context, not three).

5. **#9 environmentally friendly — Confirm whether the map/clustering stack (`maplibre-gl` + `@mapbox/mapbox-gl-draw` + `supercluster`) is lazy-loaded and only shipped to the specific survey views that render a map.** If it currently loads with the rest of `survey/page.tsx`'s single bundle, splitting it out is the highest-leverage weight fix available, independent of any visual change.

## Preserve

- The semantic color-token system in `globals.css`/`tailwind.config.js` — zero ad hoc Tailwind-palette classes were found anywhere in scope; every color routes through a token.
- `components/AppShell.tsx` and `components/ui/Button.tsx` — nav/chrome landmarks, ARIA, and focus-visible styling are already correct here; this pass should not touch them.
- All sampled copy — no inflation, no dark patterns, no label/behavior mismatches found; the plain, direct tone is a strength to carry into any rewritten components.
