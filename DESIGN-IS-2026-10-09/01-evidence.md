# 01 — Evidence

## Structural Evidence

### Mobile (apps/mobile)
35 screen files total. **35/35 (100%) import the shared `src/ui/primitives.tsx`** (564 lines). Zero bespoke screens.

### Web (apps/web)
70 `page.tsx` files. 13 import `components/v2/Workbench` (a CRUD scaffold: `Panel`/`Collection`/`MutationForm`/`Can`). 57 do not import Workbench directly, but **54 of those import the exact same underlying kit Workbench is itself built on** — confirmed directly: `Workbench.tsx` imports `AppShell`, `Button`, `Combobox`, `ErrorCard`, `Input`, `Textarea`, `NativeSelect` from `components/AppShell`/`components/ui/*`, the same paths the other 54 pages use. This is **one system, two abstraction levels**, not two rival systems. ~10 of the 57 are trivial route-wrapper stubs (12-35 lines) delegating to local `DetailClient`/`BoardClient` siblings (out of scope, not yet audited).

Large pages with one-off components stacked atop the shared kit (highest-risk candidates): `survey/page.tsx` (3,880 lines — the prior audit's subject — plus `BillingBulkBar`/`ReversePaymentDialog`/`VillageDetail`/`Charts`/`ExportMenu`/`Paged`), `billing/page.tsx` (1,111), `survey/entry/page.tsx` (987), `survey/setup/page.tsx` (943), `expenses/page.tsx` (937), `procurement/page.tsx` (921), `payables/page.tsx` (701), `documents/page.tsx` (688).

## Visual Evidence (INFERRED — no live render; no dev server running)

**Web**: 8-step type scale (tailwind.config.js:8-17, 11px-28px); spacing uses Tailwind's default 4px step (no custom base override, tailwind.config.js:70-76 only adds named rows/sidebar/topbar); 34 semantic color tokens (globals.css:14-126), zero raw hex/palette-class leakage outside an isolated `@media print` block (globals.css:259-346). Full deliberate state coverage: loading (Button.tsx:35,49-53, Skeleton.tsx), empty (EmptyState.tsx), error (ErrorCard.tsx, fully developed — code-aware advice text, field errors, request id, retry), disabled, focus-visible (consistent ring, Button.tsx:9/Input.tsx:10-11), success (Badge tone), invalid (Input.tsx:5,21). Only 3 one-off inline styles found across survey/billing/procurement, all justified dynamic progress-bar widths (survey/page.tsx:886,3107; billing/page.tsx:708).

**Mobile**: 6-step spacing on a 4pt rhythm (theme.ts:98-105: 4/8/12/16/24/32), 6-step type scale (theme.ts:115-123, 11-26px, explicitly larger base than web for phone legibility), 22-key dual palette ×2 light/dark (theme.ts:43-95), one justified raw-hex exception (`#ffffff` on a colored-fill button override, primitives.tsx:294). Good state coverage (loading via `ActivityIndicator`, empty via dedicated `EmptyState`, disabled via opacity, a mobile-appropriate "pressed" state Button/ListRow have no web equivalent need for) but **two real gaps**: no dedicated error-display component matching web's `ErrorCard` (only `Input`'s error prop + generic `Banner`), and no explicit focus-state styling (relies on OS default, unconfirmed how that renders).

## Copy & Honesty Evidence

No marketing inflation found on either platform (searched powerful/seamless/effortless/revolutionary/etc — zero user-facing hits). No dark patterns found — confirm dialogs disclose real consequences honestly (e.g. `BoardClient.tsx:499`: "Remove this board? Its tasks are kept, and the board is archived rather than destroyed."). Checked multiple destructive/important actions (approve/reject/withdraw, deactivate/reactivate, remove-board) on both platforms — all labels matched their actual behavior.

**One systemic, concrete issue**: raw permission-code jargon leaks into user-facing 403/empty-state text on **both platforms** — `Forbidden.tsx:25` ("needs the `employee.read` permission"), `apps/mobile/app/employees.tsx:87`, `documents.tsx:98`, `approvals.tsx:150` all do the same thing. Same fix would apply to both: a permission-code → plain-English label map. Minor secondary note: unexplained domain abbreviations ("RA", "BOQ") in billing on first use.

Tone is consistent and plain across both platforms — no register divergence found (side-by-side: error/load-failure, permission-denied, and empty-state copy all follow the same voice on web and mobile).

## Weight & Friction Evidence

**Web**: one confirmed **dead dependency** — `@mapbox/mapbox-gl-draw` (package.json:9) has zero imports anywhere in the codebase, pure install-size weight. `KanbanBoard`/`@dnd-kit` is **not code-split** — statically imported into `dashboard/page.tsx:8`, loading on every dashboard visit regardless of whether the user drags anything. `maplibre-gl` remains correctly split via `next/dynamic` on the attendance page (confirmed, matches prior audit). Survey page is well-optimized despite 20 query call sites — almost all are tab-gated, so only ~2 requests fire on initial load. Dashboard fires ~5 initial requests. Zero continuous/idle animation found; no unprompted modals/toasts on load.

**Mobile**: `react-native-reanimated` and `react-native-worklets` (package.json:35,40) are installed but **100% unused** — zero `Animated.`/`useAnimatedStyle`/`withTiming`/`withSpring` calls found anywhere in app code, meaning pure native-module init cost at startup for zero benefit. Home tab fires 2 initial queries plus an indefinite 5-second-interval background sync poll (reasonable for an offline-first field app, but a real ongoing cost worth knowing about). Loading handled lightly (`ActivityIndicator` only). No unprompted modals on load.

## Accessibility Evidence

**Web**: `AppShell.tsx`, `Button.tsx`, `Input.tsx`, `Select.tsx`/`NativeSelect`, `Table.tsx` all **pass** — real ARIA landmarks (nav/aside/header/main), `aria-current`, `aria-expanded`, keyboard-reachable (Radix-based sheet/select with focus trap), consistent `focus-visible` ring wired through the shared `Button`/`Input`, semantic `<table>` with `scope="col"` and real `<button>` sort controls. Confirms the prior audit's findings still hold. Spot-check of `survey/page.tsx` (3,880 lines): zero raw `div`/`span onClick` bypasses found — every interactive handler uses the shared `Button`/`button`. **One real gap**: no skip-link anywhere in the app (grepped, zero matches) — keyboard users must tab through the full nav/header to reach `<main>` on every page load.

**Mobile**: `BackHeader`'s back button is the exemplar — explicit `accessibilityRole="button"` + `accessibilityLabel="Go back"` (primitives.tsx:128-129). `Button`, `ListRow`, `Banner` all set `accessibilityRole` correctly but rely on implicit text-child announcement rather than an explicit `accessibilityLabel` (works in the common case, not declared). **One real, concrete bug**: `Input`'s visual label (primitives.tsx:323-327) is a plain sibling `<Text>`, never wired to the `TextInput` via `accessibilityLabel`/`accessibilityLabelledBy` — screen-reader users focusing the field will not hear the label at all. Touch targets consistently meet/exceed the 44pt guideline (Button 44, Input 44, ListRow 50).
