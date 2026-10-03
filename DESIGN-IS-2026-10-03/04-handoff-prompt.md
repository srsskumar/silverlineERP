/make-plan Redesign the Silverline ERP survey module's internal structure and design-system discipline (`apps/web/app/survey/page.tsx` 3,877 lines, `apps/web/app/survey/entry/page.tsx`, `apps/web/app/survey/setup/page.tsx`). Current design failed audit at 17/30 with gaps in principles #3 (aesthetic), #4 (understandable), #8 (thorough), and #10 (as little design as possible). (#9 environmentally friendly was revised to 2/3 after confirming the survey module does not actually import the map/clustering stack the initial estimate assumed — see 02-scorecard.md and move 5 below, now resolved.)

Verdict paragraph (quoted from 03-verdict.md):
> Total score is 17/30 — below the ≥20 REFINE threshold — driven by principles scoring 1/3 (aesthetic, understandable, thorough, as-little-as-possible), none of which is a one-line fix: they share a common root cause, which is that the survey module was built as one 3,877-line file with no shared design-system discipline enforced within it, rather than a deliberate layout/token pass. This is a REDESIGN of the survey module's internal structure and design-system discipline, not of the product's identity: the honesty (3/3) and long-lasting (3/3) scores, and the clean color-token system, are real strengths worth keeping.

Why redesign and not refine: five principles independently scored 1/3, and they compound from one shared structural cause (no shared input/filter component, no deliberate focus/ARIA pass, no enforced spacing subset) rather than being five unrelated small fixes — fixing them as isolated patches would just re-create the duplication this audit flagged.

Preserve from current design:
- The semantic color-token system in `apps/web/app/globals.css` / `apps/web/tailwind.config.js` — all 18 color classes actually used in these files already route through tokens with zero ad hoc Tailwind-palette classes. Keep this; extend it, don't replace it.
- `apps/web/components/AppShell.tsx` and `apps/web/components/ui/Button.tsx` — nav/chrome landmarks (`<nav>`, `<main>`, `<header>`), ARIA attributes, and focus-visible styling are already correct. Do not touch these files.
- Every sampled user-facing string's tone (plain, direct, domain-specific — e.g. "No active programme", "Record today's progress") — no inflation, no dark patterns were found anywhere in scope. Preserve this voice in any rewritten copy.
- The existing states-present pattern (Empty/Loading/Error) already implemented via `isLoading`/`isError`/`EmptyState` across all three files — keep this pattern, just extend it structurally (see below).

Discard (structural patterns causing the failures):
- Per-view, unshared filter-select markup repeated independently in the toolbar (`survey/page.tsx:240,272`), the Villages view (6 selects, `:2569-2605`), entry (`:321`), and setup (`:106,318`). Evidence: each reimplements the same affordance with its own className string. Caused failure on principle #10 (as little design as possible) and #3 (aesthetic, via inconsistent spacing/focus per instance).
- The identical select-field class-string literal independently redefined twice in one file (`survey/page.tsx:490` and `:3695`) instead of being a single shared constant/component. Caused failure on principle #10.
- The absence of any local `focus:`/`focus-visible:` styling or ARIA attributes on native inputs in `survey/page.tsx`, `survey/entry/page.tsx`, and `survey/setup/page.tsx` (entry and setup have zero ARIA attributes at all) — currently covered only by one global fallback rule. Caused failure on principle #8 (thorough).
- Raw domain codes surfaced directly to users with no plain-language translation: `survey/page.tsx:3144`'s default field value `'GCP-1'`, and the raw enum `'OUTSTANDING'` wired into a filter at `:181`. Caused failure on principle #4 (understandable).
- `text-text-subtle` on `bg-surface-sunken` at the smallest type size (`survey/page.tsx:2772`) computing to ≈3.3:1 contrast, below WCAG AA — and `text-text-subtle` is the single most-used color class across all three files (120 occurrences), so this is the module's default muted-text behavior, not an isolated instance. Caused failure on principle #3 (aesthetic).

Top 5 moves from the audit (verbatim):
1. #10/#3 — Extract one shared `FilterSelect` component to replace every independently-reimplemented filter dropdown across the toolbar, Villages view, entry, and setup, and the duplicated class-string literal at `survey/page.tsx:490`/`:3695`.
2. #8 — Give every native input in the survey module a local, deliberate focus style and ARIA label, routed through the same shared input components from move 1 so the fix is structural.
3. #4 — Replace raw domain codes in user-facing defaults/filters (`'GCP-1'` at `:3144`, `'OUTSTANDING'` at `:181`) with a label map from code to plain phrase.
4. #3 — Fix the confirmed AA-contrast failure on `text-text-subtle`/`bg-surface-sunken` at `text-2xs` (`:2772`), and consolidate the 40-value spacing scale currently in use down to one documented choice per context instead of 3-way half-step duplicates (`gap-1`/`1.5`/`2`, `py-1`/`1.5`/`2`/`2.5`).
5. ~~#9 — Confirm whether the map stack is lazy-loaded~~ RESOLVED, no action: the survey module does not import `maplibre-gl`/`mapbox-gl-draw`/`supercluster` at all; that stack belongs to `/attendance` only and is already correctly split there via `next/dynamic(..., { ssr: false })`.

Redesign principles in priority order:
1. #10 (as little design as possible) — one shared, parameterized filter/select component used everywhere a filter dropdown currently appears, with zero per-instance style duplication.
2. #8 (thorough) — every interactive element in the module gets a deliberate focus-visible treatment and an ARIA label as part of the shared components, not left to a global fallback.
3. #4 (understandable) — no raw internal code, abbreviation, or enum value reaches a user-facing default or filter label without a plain-language translation.

Deliverables for the plan:
- New component inventory for the survey module: a shared filter/select component, a shared text-input component, and where each of the current ~14 duplicated-pattern instances in `survey/page.tsx`/`entry`/`setup` migrates to it
- A documented spacing subset (reduced from the current 40 ad hoc values) and a documented contrast-safe replacement for the `text-text-subtle`/`bg-surface-sunken` pairing, applied consistently
- A code→plain-language label map for domain abbreviations/enums currently shown raw to users (starting with `GCP-1` and `OUTSTANDING`)
- States checklist carried forward unchanged (Empty/Loading/Error already present; Success and Focus need deliberate per-surface treatment, not just a global fallback)
- Migration path: this is an internal refactor of existing pages, not a user-facing flow change, so no user migration/cutover plan is needed beyond normal QA — confirm no route/URL changes

Anti-patterns to guard against (specific to REDESIGN):
- Porting the current per-view duplicated filter markup under new class names instead of actually extracting a shared component
- Keeping both the old inline filter markup and a new shared component behind a flag indefinitely — migrate each instance and delete the old markup in the same pass
- Redesigning the visual language itself (color palette, typography) when the audit's actual findings are about structure, focus/ARIA discipline, one contrast failure, and bundle weight — the token system and overall look scored well and should not be redrawn
- Treating this as license to restructure navigation or the tab set — out of scope; the 10-tab structure itself was not flagged by this audit
