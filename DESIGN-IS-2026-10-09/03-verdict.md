# 03 — Verdict

**REFINE.** Total score is 21/30 — at or above the ≥20 REFINE threshold, and no individual principle scored 0 (the three lowest, innovative/understandable/environmentally-friendly, each scored 1/3). The foundational systems — the token/color/type scales, the accessibility primitives, the honesty of the copy, the shared-component architecture itself — are sound on both platforms and were built with real discipline. What's wrong is a short list of specific, fixable items, not structural rot: this is iteration, not a rebuild.

This full-app picture is notably healthier than the prior, narrower audit of the survey module alone (which scored 18/30 and called for a REDESIGN of that module's internal structure specifically). That finding still stands for survey's own internals, which this audit did not re-litigate in depth — but the rest of the app, which makes up the vast majority of both platforms' surface area, was disciplined the whole time. The user's request to "rebuild the UI" for a best, interactive, user-friendly experience is better served by fixing the five items below — all of which are concrete, scoped, and testable — than by a ground-up rewrite that would risk the real strengths already in place (honest copy, zero dark patterns, a working accessible chrome, a clean token system) for no proven gain.

## Top 5 moves

1. **#4 understandable — Strip raw permission-code jargon from user-facing text, both platforms.** Replace `"needs the `employee.read` permission"`-style messages with plain-English equivalents via a small permission-code → label map. Evidence: `apps/web/components/Forbidden.tsx:25`, `apps/mobile/app/employees.tsx:87`, `apps/mobile/app/documents.tsx:98`, `apps/mobile/app/approvals.tsx:150` — same issue, same fix, on both platforms.

2. **#9/#10 environmentally friendly / as-little-as-possible — Delete two confirmed-dead dependencies.** `apps/web/package.json:9` (`@mapbox/mapbox-gl-draw`, zero imports anywhere) and `apps/mobile/package.json:35,40` (`react-native-reanimated` + `react-native-worklets`, zero animation calls anywhere in app code). Pure removal, zero functional loss, immediate install/bundle-size win on both platforms.

3. **#9 environmentally friendly — Code-split the dashboard's KanbanBoard.** `apps/web/app/dashboard/page.tsx:8` statically imports the `@dnd-kit`-based board; `apps/web/app/attendance/page.tsx:33-34` already shows the correct pattern (`next/dynamic(..., { ssr: false })`) for exactly this kind of heavy, not-always-needed component — copy it.

4. **#8 thorough — Close mobile's two accessibility/error gaps.** `apps/mobile/src/ui/primitives.tsx:323-328`: wire `Input`'s visible label to the `TextInput` via `accessibilityLabel` (currently a plain sibling `<Text>`, unannounced to screen readers — a real bug, not a style nit). Separately, give mobile an error-display component with the same richness as web's `ErrorCard` (currently only `Input`'s error prop + a generic `Banner`).

5. **#2 useful (accessibility) — Add a skip-link to web's `AppShell`.** None exists anywhere in the app (`apps/web/components/AppShell.tsx:278`'s `<main>` is reachable only by tabbing through the full nav/header) — a small, standard addition with an outsized benefit for keyboard users who load every page.

## Keep (already strong, do not touch in this pass)

- **#3 aesthetic (3/3)** — the token/color/type-scale systems on both platforms. Regression check: re-grep for raw hex/Tailwind-palette classes outside `globals.css`'s print block after any UI changes; should still return zero.
- **#5 unobtrusive (3/3)** — zero continuous/idle animation on either platform's home/dashboard. Regression check: no new `Animated.`/`useAnimatedStyle`/CSS keyframe-on-mount should appear outside explicit user-triggered transitions.
- **#6 honest (3/3)** — zero inflations, zero dark patterns, consequence-disclosing confirm dialogs. Regression check: any new destructive-action confirm copy should name the real consequence, as `BoardClient.tsx:499` already does.
- **#7 long-lasting (3/3)** — no dated trend markers. Regression check: none specific; a visual-trend check is subjective and doesn't need an automated gate.
- **Web accessibility primitives** (`AppShell.tsx`, `Button.tsx`, `Input.tsx`, `Select.tsx`, `Table.tsx`) — ARIA landmarks, focus-visible ring, semantic HTML, keyboard reachability all confirmed correct, matching the prior audit's findings. Do not modify these files' accessibility wiring; only add the skip-link (move 5) alongside them.
- **Mobile touch-target sizing** (44-50pt consistently across `Button`/`Input`/`ListRow`) and the **mobile-specific "pressed" state** on `Button`/`ListRow` — both correct, platform-appropriate patterns.
- **The shared-component architecture itself** on both platforms (`components/v2/Workbench` built atop `components/ui/*`/`AppShell` on web; 100% `primitives.tsx` adoption on mobile) — this is the thing making the rest of the "keep" list possible; nothing here calls for restructuring it.
