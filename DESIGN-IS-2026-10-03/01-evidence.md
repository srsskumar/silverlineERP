# 01 — Evidence

Surfaces audited: `app/layout.tsx`, `components/AppShell.tsx` (shared chrome/nav), `app/dashboard/page.tsx`, `app/survey/page.tsx` (3,877 lines), `app/survey/entry/page.tsx`, `app/survey/setup/page.tsx`.

No live instance was available: the local dev server crashes on every route with a React error ("invariant expected layout router to be mounted"), reproduced consistently after a cache clear and confirmed as a Windows path-casing artifact in this machine's `node_modules` (duplicate React/Next module instances fighting over router context) — unrelated to this app's code, and not present in the live Vercel deployment. All evidence below is from source inspection and is marked INFERRED/ESTIMATED where it substitutes for a live measurement.

## Structural Evidence

**AppShell (nav/chrome, 285 lines)**
- Interactive elements: 2 top-level Buttons (hamburger `AppShell.tsx:198`, Create `:216`) + 1 dropdown-trigger Button (account menu `:241`) + N nav Links (dynamic, permission-filtered) + 3 DropdownMenuItems (`:257,264,270`).
- Max nesting: 8 levels deep on the nav-item branch (`div > aside > div > Sheet > SheetContent > NavList > nav > div.group > Link > Icon`).
- Repeated pattern: nav-item Link markup defined once (`:81-97`) rendered twice (desktop rail `:172`, mobile Sheet `:188`); two visually-identical `<img>` logo blocks (`:166-170`, `:182-186`).
- No unused imports found by grep.

**Dashboard (256 lines)**
- Interactive elements: 3 Links (`:117,185,225`), 2 selects (`:146,170`), 1 checkbox (`:190`) — 6 total direct elements.
- Max nesting: 6 levels to the deepest `<select><option>`.
- Repeated pattern: Project/Board filter-select pair shares one `selectClass` string (`:24`) — same filter-dropdown affordance used twice in one file.

**Survey module**
- `survey/page.tsx`: 80 interactive-tag matches total (20 `<select>`), 13 named sub-components (`Progress:462, PeriodReport:948, MoveVillages:1408, Deployment:1485, NameList:1739, CrewAndRovers:1770, RoverIdleDays:2020, Bottlenecks:2125, Villages:2311, Timeline:2912, GcpRecorder:3131, ControlList:3330, Summary:3576`) plus the default `SurveyPage` switching across 10 tabs (4 primary + 6 behind a "More" toggle, `:49-50,62-65,300-304`) — **one 3,877-line file holding 14 components and 10 views.**
- `survey/entry/page.tsx`: 28 interactive-tag matches, 3 components (`RecentEntries:764, AmendEntry:866` + default).
- `survey/setup/page.tsx`: 35 interactive-tag matches, 8 components.
- Repeated pattern (module-wide): the same filter-dropdown affordance recurs independently in Villages (6 selects: `:2569,2575,2580,2589,2597,2605`), the top toolbar (`:240,272`), entry (`:321`) and setup (`:106,318`); a `Badge` status-pill reused 15+ times in `survey/page.tsx` alone; the identical class-string literal for a select field is independently redefined twice in the same file (`:490` and `:3695`) instead of shared.
- Max nesting: 9 levels observed in the Villages table row alone, before accounting for Table/Card/AppShell internals.

## Accessibility Evidence

- ARIA attributes: AppShell has 5 (`:47,85,202,203,244`); dashboard has 2 (`:147,171`); `survey/page.tsx` has 3 (`:302,2676,2741`); **`survey/entry/page.tsx` and `survey/setup/page.tsx` have zero** aria-*/role attributes.
- Keyboard reachability: zero `<div onClick>` patterns in any of the 6 in-scope files — every interactive affordance in scope is a native button/a/input/select or the shared `Button` component. Clean.
- Landmarks: `<nav>`, `<main>`, `<header>`, `<aside>` all live only in `AppShell.tsx` (`:65,278,197,156`); the three page files have none of their own, relying entirely on AppShell's instance. No skip-link anywhere. Focus-trap is delegated to the Sheet UI primitive for the mobile nav only.
- Focus-visible styling: the shared `Button` component (`components/ui/Button.tsx:9`) and dashboard's `selectClass` (`:24`) carry explicit focus-ring classes. **`survey/page.tsx`, `survey/entry/page.tsx`, and `survey/setup/page.tsx` have zero local `focus:`/`focus-visible:` classes** — their native selects/date/number inputs rely only on the global `:focus-visible` rule in `globals.css:142-145`, which does apply app-wide, so focus is not literally invisible, but the module makes no deliberate choice about it anywhere a custom input pattern is used.

## Visual Evidence (INFERRED — no live render)

- **Spacing scale**: 40 distinct Tailwind spacing values in use (full list in agent report), with heavy half-step usage (`gap-1` vs `gap-1.5` vs `gap-2`; `py-1`/`py-1.5`/`py-2`/`py-2.5` all present). This is a wide scale for 3 surfaces — no single file enforces a smaller subset.
- **Type scale**: a real custom scale exists (`tailwind.config.js:8-17`: 2xs/xs/sm/base/lg/xl/2xl/3xl), but these 3 surfaces only ever use the bottom 5 steps (`2xs` through `lg`) — `xl/2xl/3xl` are defined but never reached, so every heading on these pages tops out at `text-lg` (1rem).
- **Color**: all 18 color classes actually used route through the semantic CSS-variable token system (`globals.css`, `tailwind.config.js:19-51`) — zero raw/ad-hoc Tailwind palette classes (no stray `bg-blue-600` etc). One exception: `layout.tsx:26-27`'s `themeColor` meta uses two raw hex values (unavoidable — meta tags can't reference CSS vars), which do appear to match the `--canvas` token by eye. Two tokens (`info`, `status-*`) are defined but unused in these surfaces.
- **Lowest contrast (INFERRED)**: `text-text-subtle` (`#8891A0`) on `bg-surface-sunken` (`#F9FAFB`), concretely paired at `survey/page.tsx:2772` at the smallest type size (`text-2xs`) — computed ≈ **3.3:1**, below WCAG AA's 4.5:1 for normal text. `text-text-subtle` is the single most-used color class across all three surfaces (120 occurrences), so this isn't a one-off: it's the module's default "muted" text color, and at least one real pairing of it fails AA.
- **States checklist** (Empty / Loading / Error / Success / Focus / Disabled):
  | Surface | Empty | Loading | Error | Success | Focus | Disabled |
  |---|---|---|---|---|---|---|
  | Dashboard | ✓ | ✓ | ✓ | **missing** (no toast/confirmation anywhere in the file) | ✓ (local) | ✓ |
  | Survey main | ✓ | ✓ | ✓ | ✓ | only global rule, no local styling | ✓ |
  | Survey entry/setup | ✓ | ✓ | ✓ | ✓ | only global rule, no local styling | ✓ |

## Copy & Honesty Evidence

- 40+ user-facing strings sampled across all three surfaces (full list in agent report) — tone is consistently plain, direct, domain-specific ("No active programme", "Record today's progress", "This changes where a village's state lives").
- Inflations: **none found.** No marketing superlatives anywhere in scope.
- Dark patterns: **none found.** No forced continuity, hidden cost, fake scarcity, or confirmshaming; "Sign out"/"Clear" actions are neutrally worded.
- Jargon: `survey/page.tsx:3144` defaults a form field to `'GCP-1'` — "GCP" (Ground Control Point) is an uncommented surveying abbreviation exposed directly in an input default, with no inline explanation for a non-surveyor user. `dashboard/page.tsx:174`'s "ERP v2" footer label is opaque versioning with no explanation.
- Label→behavior mismatches: **none found** in the sampled handlers — every checked label matches its actual destination/action.

## Weight & Friction Evidence (ESTIMATED)

- **Bundle weight**: moderate-to-heavy wherever `maplibre-gl` + `@mapbox/mapbox-gl-draw` + `supercluster` load (the survey module's geo features) — this map/clustering stack alone is typically 200–300KB+. 9 separate `@radix-ui/*` packages add up incrementally. No heavy date library (no moment.js) and no dedicated charting library — the survey charts are hand-rolled, not a heavy dependency.
- **Network requests on initial view**: Dashboard fires up to 4 queries, **chained sequentially** rather than in parallel (`projects → boards → board detail → project detail`, each gated by `enabled` on the previous one resolving, `dashboard/page.tsx:49,64,78,85`) — each hop is a render-blocking round trip before the board can render. Survey's default tab fires 2 queries on mount; its other 9 tabs are lazily gated and don't fire until opened.
- **TTI risk (no live measurement possible)**: `survey/page.tsx` is a single 3,877-line `'use client'` component containing ~10 tab views and all their query/mutation logic, parsed and hydrated as one bundle regardless of which tab is active — a structural TTI cost independent of the per-tab query gating.
- **Animation**: none found on any idle screen in scope (`transition-colors` on AppShell nav links is hover-triggered, not idle).
- **Auto-firing UI on load**: `AppShell.tsx:33-52`'s unread-notification badge polls every 60s and renders automatically on every page using AppShell (which is all three surfaces) — the only auto-firing element found. No modals or toasts fire on mount; the toasts in scope are all mutation-triggered.
