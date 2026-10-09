# 05 — Implementation Plan

Refine pass for Silverline ERP's web + mobile UI, per `03-verdict.md`'s REFINE verdict (21/30) and `04-handoff-prompt.md`'s 5 prioritized moves. Each phase is self-contained and can be executed in a new session with only this file open.

## Phase 0 — Documentation Discovery (consolidated findings)

**Web:**
- `apps/web/components/Forbidden.tsx` (42 lines): `export function Forbidden({ required }: { required?: string })`. Renders the raw code verbatim in a `<code>` tag (lines 21-31: `This page needs the <code>{required}</code> permission...`). No existing permission-code→label mapping anywhere in `apps/web` (grepped `permissionLabels|PERMISSION_LABELS|permissionLabel` — zero matches). `apps/web/lib/permissions.ts` only has `PERMISSIONS` constants and `hasPermission()`, not labels.
- `apps/web/components/ui/ErrorCard.tsx` (147 lines) — reference only, not touched. Props: `{title?, error?, onRetry?, className?}`. Advice logic is the standalone `nextStep(error)` function (lines 31-67), switching on `error.code`.
- `apps/web/app/attendance/page.tsx:33-39` — the exact dynamic-import pattern to copy:
  ```tsx
  const PunchClusterMap = nextDynamic<PunchClusterMapProps>(
    () => import('@/components/map/PunchClusterMap').then((module) => module.PunchClusterMap),
    { ssr: false, loading: () => <Skeleton className="h-[420px] w-full" /> },
  );
  ```
  Depends on `import nextDynamic from 'next/dynamic';` (line 5) and `Skeleton` from `@/components/ui/Skeleton` (line 21).
- `apps/web/app/dashboard/page.tsx:8` — current static import: `import { KanbanBoard } from '@/components/KanbanBoard';`. Usage site, lines 243-248:
  ```tsx
  <KanbanBoard
    projectId={projectId as string}
    board={boardQuery.data}
    workflowStatuses={workflowStatuses}
    assigneeMe={mineOnly}
  />
  ```
- `apps/web/components/AppShell.tsx:278` — `<main className="min-w-0 flex-1 px-3 py-4 md:px-5 md:py-5">{children}</main>`, immediately after `</header>` (line 276). No id/tabIndex/skip-anchor exists. Tailwind's default `sr-only`/`focus:not-sr-only` utilities are active and unmodified (`tailwind.config.js` has no `corePlugins` override). Existing `sr-only` usage in the codebase (`QuickAddTask.tsx:73`, `KanbanBoard.tsx:584`) is always-hidden labeling, not a focus-reveal pattern — no skip-link precedent exists yet; this will be the first.
- `apps/web/package.json:22` — `"@mapbox/mapbox-gl-draw": "^1.5.1"` (zero imports anywhere, confirmed dead). `package.json:55` — devDependency `"@types/mapbox__mapbox-gl-draw": "^1.4.9"`, remove alongside it.
- `apps/web/package.json:18-20` — `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (kept — these power `KanbanBoard`, which is being code-split, not removed).

**Mobile:**
- The three permission-denied messages (`apps/mobile/app/employees.tsx:84-88`, `documents.tsx:95-99`, `approvals.tsx:147-151`) are byte-identical in structure — same `EmptyState` component, same 3 props (`icon="lock-closed-outline"`, `title`, `message`), only the title text and the raw permission code embedded in `message` differ.
- `apps/mobile/src/labels.ts` (12 lines) already exports `codeLabel(code)` — an underscore→title-case transform (`IN_PROGRESS` → "In progress"). It does **not** handle dot-delimited permission codes (`employee.read` → `codeLabel` would wrongly yield "Employee.read", only replacing `_` not `.`). Needs a sibling map, not reuse of `codeLabel` itself.
- `apps/mobile/src/ui/primitives.tsx:313-352` — `Input`'s exact current code: label is a plain sibling `<Text>` (lines 323-326), with zero `accessibilityLabel`/`accessibilityLabelledBy` linkage to the `TextInput` (lines 328-342).
- **Correction to the original audit evidence**: mobile does **not** lack a rich error-display component. `apps/mobile/src/ui/LoadError.tsx` (35 lines) already exists, composing `EmptyState` + a conditional `Button` (via `EmptyState`'s `action` slot) with retry gated by `retryAction()` (`src/listState.ts`) and message text from `describeApiError()` (`src/errorFormat.ts`) — functionally equivalent to web's `ErrorCard` in spirit (title + explanation + conditional retry), just composed from existing primitives rather than being one file. It's already used in 15 files. Verified (grep) only 4 screens with error-prone queries don't use it yet: `expenses.tsx`, `inventory.tsx`, `procurement.tsx`, `project-finance.tsx`. The real gap is adoption in those 4 screens, not a missing component.
- `apps/mobile/package.json:40,45` — `"react-native-reanimated": "4.5.1"`, `"react-native-worklets": "0.10.1"`, zero imports anywhere in `src`/`app` (confirmed dead — likely a transitive peer of `react-native-maps`). No babel plugin entry exists anywhere (`app.json`'s plugin list has no reanimated entry; no `babel.config.js` file exists at all) — removal is a pure two-line `package.json` edit, nothing else to clean up.

**Allowed APIs / anti-patterns to avoid:**
- Do NOT invent a new mobile error component — use existing `LoadError` (Phase 4).
- Do NOT use `codeLabel()` for permission codes as-is — it mishandles dots. Build a small, explicit map instead (Phase 1).
- Do NOT add a reanimated babel plugin when removing the package — none exists to remove, and none should be added.
- Web dynamic-import must match the attendance page's exact shape (`ssr: false` + a `Skeleton` loading fallback), not a bespoke variant.

---

## Phase 1 — Strip permission-code jargon (both platforms)

**Web** — `apps/web/components/Forbidden.tsx`:
1. Add a new file `apps/web/lib/permissionLabels.ts` exporting a `permissionLabel(code: string): string` function — a small object literal mapping known permission codes (`employee.read`, `document.read`, `approval.read`, and any others `grep -rn "required=" apps/web/app apps/web/components` turns up as actually passed to `Forbidden`) to plain English (e.g. `employee.read` → "view employee records"). Fall back to a generic `"view this page"` for any code not in the map, so an unmapped future permission never throws or renders `undefined`.
2. In `Forbidden.tsx`, import `permissionLabel` and replace the raw `<code>{required}</code>` interpolation with the mapped label, phrased as prose (e.g. "This page needs permission to **view employee records**, which your roles do not include.") — drop the `<code>` tag entirely since it's no longer a literal code being shown.

**Mobile** — `apps/mobile/app/employees.tsx:84-88`, `documents.tsx:95-99`, `approvals.tsx:147-151`:
1. Add a new file `apps/mobile/src/permissionLabels.ts`, same shape as web's (`permissionLabel(code: string): string`) — keep the two maps' English wording consistent with each other for the 3 shared codes (`employee.read`, `document.read`, `approval.read`), since the Copy & Honesty evidence found tone is already consistent across platforms and this should stay that way.
2. Update each of the 3 `EmptyState` `message` props to use `permissionLabel('employee.read')` etc. instead of the hardcoded string, via a template literal (e.g. `` `This screen needs permission to ${permissionLabel('employee.read')}.` ``).

**Verification:**
- `cd apps/web && npx tsc --noEmit` and `cd apps/mobile && npx tsc --noEmit` both clean.
- Grep `apps/web/components/Forbidden.tsx` and all 3 mobile files to confirm no raw dotted permission code remains in any user-facing string literal.
- Run `apps/web`'s and `apps/mobile`'s existing test suites — if any test asserts the old literal text (e.g. a snapshot or exact-string match on "needs the `employee.read` permission"), update that assertion to match the new copy; do not weaken the assertion to a substring match to avoid updating it.
- Live check: visit `/employees` as a user without `employee.read` on web, and open the Directory screen as the same user on mobile; confirm the new plain-English message renders.

---

## Phase 2 — Remove two dead dependencies (both platforms)

**Web:**
1. `cd apps/web && npm uninstall @mapbox/mapbox-gl-draw @types/mapbox__mapbox-gl-draw`.
2. Re-grep the whole `apps/web` tree for `mapbox-gl-draw` to confirm zero remaining references (should already be zero per Phase 0 findings; this re-confirms after the uninstall touches the lockfile).

**Mobile:**
1. `cd apps/mobile && npm uninstall react-native-reanimated react-native-worklets`.
2. Confirm no `babel.config.js` or `app.json` plugin entry needs touching (Phase 0 already confirmed none exists) — no further action needed there.

**Verification:**
- `cd apps/web && npx tsc --noEmit && npm run build` — confirms removing the mapbox-draw types doesn't break a build that never used them.
- `cd apps/mobile && npx tsc --noEmit` — confirms no source file silently depended on reanimated types.
- Run both full test suites (`apps/web`: `npm test`; `apps/api` is untouched by this plan, skip; `apps/mobile`: `npm test`) — all should pass unchanged, since neither dependency was imported anywhere.
- `npm install` (no args) in both `apps/web` and `apps/mobile` after uninstall, to confirm lockfiles resolve cleanly with the entries gone.

---

## Phase 3 — Code-split the dashboard's KanbanBoard (web only)

**File:** `apps/web/app/dashboard/page.tsx`

1. Replace the static import at line 8 (`import { KanbanBoard } from '@/components/KanbanBoard';`) with a dynamic one, copying the attendance page's exact pattern:
   ```tsx
   const KanbanBoard = nextDynamic<KanbanBoardProps>(
     () => import('@/components/KanbanBoard').then((module) => module.KanbanBoard),
     { ssr: false, loading: () => <Skeleton className="h-[420px] w-full" /> },
   );
   ```
   This requires: `import nextDynamic from 'next/dynamic';` and `import { Skeleton } from '@/components/ui/Skeleton';` added to `dashboard/page.tsx`'s imports (check first whether `Skeleton` is already imported there for some other purpose — Phase 0 noted dashboard already uses Skeleton placeholders elsewhere, so this import may already exist). You will also need a `KanbanBoardProps` type — check `@/components/KanbanBoard`'s own export for whether it already exports a named `KanbanBoardProps` type (matching the `PunchClusterMapProps` pattern); if not, define one locally from the 4 props already passed at the call site (`projectId: string; board: typeof boardQuery.data; workflowStatuses: typeof workflowStatuses; assigneeMe: boolean`), or use `React.ComponentProps<typeof KanbanBoardComponent>` style typing if that's cleaner given what's actually exported.
2. Leave the JSX call site (lines 243-248) completely unchanged — only the import/declaration changes.

**Verification:**
- `cd apps/web && npx tsc --noEmit` clean.
- `npm run build` and inspect the build output for a separate chunk containing `KanbanBoard` (Next.js build output lists chunks; confirm `KanbanBoard`'s code is no longer in the same initial chunk as the rest of `dashboard/page.tsx` — compare before/after build output if unsure how to read it directly).
- Live check: load `/dashboard` with a project selected, confirm the board still renders identically (drag-and-drop still works), and confirm (via browser devtools Network tab) that the dnd-kit/KanbanBoard JS loads as a separate request rather than being bundled into the initial page load.
- Run `apps/web`'s test suite — any existing dashboard/KanbanBoard test should still pass; if a test imports `KanbanBoard` directly from `@/components/KanbanBoard` (not through the page), it's unaffected by this change.

---

## Phase 4 — Close mobile's two concrete gaps

**4a. Wire Input's label to its TextInput (accessibility bug)** — `apps/mobile/src/ui/primitives.tsx:313-352`:

Current code (exact, from Phase 0):
```tsx
export function Input({
  label, error, hint, style, ...rest
}: TextInputProps & { label?: string; error?: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: space.md }}>
      {label ? (
        <Text style={{ fontSize: font.sm, fontWeight: "600", color: t.textMuted, marginBottom: space.xs }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        placeholderTextColor={t.textSubtle}
        style={[{ /* ... */ }, style]}
        {...rest}
      />
      {/* error/hint */}
    </View>
  );
}
```

Change: give the label `<Text>` a stable identifier and pass it to the `TextInput` as `accessibilityLabel` when `label` is set (React Native doesn't have a portable `accessibilityLabelledBy` equivalent to web's `aria-labelledby` across both iOS/Android reliably, so passing the label string directly as `accessibilityLabel` is the correct native pattern — do not attempt an `aria-labelledby`-style ID reference). Concretely: add `accessibilityLabel={rest.accessibilityLabel ?? label}` to the `TextInput` props, so a caller-supplied `accessibilityLabel` still wins if explicitly passed, but the common case (just passing `label`) now gets it for free.

**4b. Adopt `LoadError` in the 4 screens missing it** — `apps/mobile/app/expenses.tsx`, `inventory.tsx`, `procurement.tsx`, `project-finance.tsx`:

For each file: find where it currently handles an error state for its primary data query (grep the file for `isError` or `.error` per Phase 0's method) and check what it renders there now (likely nothing, or a bare `Banner`/text, since it's not using `LoadError`). Replace that spot with `<LoadError query={theQuery} what="<description>" />`, following the exact usage pattern already established in one of the 15 files already using it (e.g. check `apps/mobile/app/inbox.tsx` or `apps/mobile/app/(tabs)/attendance.tsx`, both confirmed as `LoadError` consumers in Phase 0, for the precise call-site shape to copy). Do not modify `LoadError.tsx` itself — only add call sites.

**Verification:**
- `cd apps/mobile && npx tsc --noEmit` clean.
- `npm test` — full mobile suite passes unchanged (or with updated assertions if any test specifically checked the absence of accessibilityLabel/LoadError in these 4 files, which is unlikely but check).
- Live/manual check (via Expo): focus the login screen's username/password fields with a screen reader active (VoiceOver/TalkBack) and confirm the label is now announced — this is the one fix in this entire plan that specifically requires a real device/simulator with a screen reader to verify, since it's an accessibility-tooling-dependent behavior, not something a snapshot test catches.
- For the 4 screens: trigger an actual load failure (e.g. temporarily disconnect network or point at a bad API URL) and confirm each of the 4 screens now shows the `LoadError` UI with a working Retry button, rather than whatever it showed before.

---

## Phase 5 — Add a skip-link to web's AppShell

**File:** `apps/web/components/AppShell.tsx`

1. Give the existing `<main>` element (line 278) an `id="main-content"` and `tabIndex={-1}` (so it can receive programmatic focus from the skip-link without becoming part of the normal tab order otherwise): `<main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-3 py-4 md:px-5 md:py-5">{children}</main>`.
2. Add a skip-link as the very first focusable element in the component's render tree (before the nav/header), visually hidden until focused, using Tailwind's existing `sr-only`/`focus:not-sr-only` utilities (already active per Phase 0, no config change needed):
   ```tsx
   <a
     href="#main-content"
     className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg"
   >
     Skip to main content
   </a>
   ```
   Place this as the first child inside the component's outermost returned element (check the exact JSX root — Phase 0's read covered lines 260-285, which is near the end of the component; read lines 1-40 of `AppShell.tsx` to find the actual outermost wrapping element before inserting, since the skip-link must be the first focusable element in DOM order, not just textually first in a sub-section).

**Verification:**
- `cd apps/web && npx tsc --noEmit` clean.
- Live check: load any page, press Tab once as the very first keyboard action — the skip-link should become visible, styled distinctly (focus ring/background), positioned near the top-left. Press Enter and confirm focus moves to `<main>` (verify via browser devtools' Accessibility tree or by confirming subsequent Tab presses continue from inside the page content, not back at the nav).
- Re-run the Accessibility evidence's original check (grep for `sr-only|skip` in `AppShell.tsx`) to confirm the new link is present and correctly scoped.

---

## Final Phase — Full Regression Checklist

Run once, after all 5 phases land, before considering this refine pass complete:

1. **#3 aesthetic (keep)**: `grep -rn "bg-\(red\|blue\|green\|yellow\)-[0-9]\|#[0-9a-fA-F]\{3,6\}" apps/web/app apps/web/components --include="*.tsx"` outside the `globals.css` print block should still return zero matches (excluding the 3 justified dynamic-width `style={{width: ...}}` instances already on file from the original audit).
2. **#5 unobtrusive (keep)**: confirm no new continuous/looping animation was introduced — none of the 5 phases above touch animation, so this should be trivially true; spot-check the dashboard and the 4 mobile screens touched in Phase 4b for any stray new loading-spinner behavior beyond what `LoadError`/`Skeleton` already provide.
3. **#6 honest (keep)**: re-read the new Phase 1 copy on both platforms — confirm the new permission-label phrasing doesn't accidentally overstate or soften what's actually denied (e.g. don't phrase it as "coming soon" when it's a permission gate, not a missing feature).
4. **#7 long-lasting (keep)**: no visual-trend concern — this phase touches no visual language, only copy/bundling/accessibility.
5. **Web accessibility primitives (keep)**: confirm `AppShell.tsx`, `Button.tsx`, `Input.tsx`, `Select.tsx`, `Table.tsx` still pass the same checks as the original audit (ARIA landmarks present, `focus-visible` ring intact) — only `AppShell.tsx` was touched (Phase 5), and only additively; diff it against its pre-Phase-5 state to confirm nothing else changed.
6. **Mobile touch targets / pressed state (keep)**: confirm `primitives.tsx`'s `Input` change (Phase 4a) didn't alter `TOUCH_TARGET` sizing or any other prop — diff the file to confirm the only change is the new `accessibilityLabel` line.
7. **Shared-component architecture (keep)**: confirm no phase added a new parallel component system — Phase 1's two new label-map files are plain data/lookup modules, not components; Phase 4b only adds call sites to the *existing* `LoadError`, never modifies it.
8. Full typecheck across all touched packages: `apps/web`, `apps/mobile` (and `packages/shared` if anything there was touched, which this plan does not call for).
9. Full test suites: `apps/web/npm test`, `apps/mobile/npm test`. (This plan does not touch `apps/api`, so no API suite run is required, though running it costs nothing if time permits.)
10. Final live walkthrough: the 5 live checks named in each phase above, done in one sitting, on both a web browser and an Expo-run mobile instance.
