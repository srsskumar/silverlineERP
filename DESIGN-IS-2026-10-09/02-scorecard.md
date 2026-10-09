# 02 — Scorecard

1. Good design is innovative — Score: 1/3
   Evidence: standard ERP CRUD/list/form conventions throughout (01-evidence.md structural section); no claim or evidence of a pattern not seen in peer products, nor of wholesale copying either.
   Justification: imitates category conventions with minor variation — neither a negative (nothing copied wholesale) nor a positive (nothing advances the form). This audit's evidence wasn't built to surface innovation either way; 1 reflects "ordinary, sound, unglamorous" rather than penalizing a working tool for not being novel.

2. Good design makes a product useful — Score: 2/3
   Evidence: primary CRUD flows complete cleanly through the shared kit on both platforms (structural evidence); no decoy actions or unprompted interruptions found (weight/friction evidence); but real adjacent-surface friction exists — the un-split KanbanBoard bundle loads unconditionally on the dashboard, and the missing skip-link adds unnecessary steps for keyboard users on every page.
   Justification: primary task completes, but confirmed friction on an adjacent surface (not the primary task itself) matches the "adjacent surface adds steps" anchor, not the clean 3.

3. Good design is aesthetic — Score: 3/3
   Evidence: zero raw-hex/palette-class leakage outside one isolated, justified `@media print` block (web); one justified hex exception (mobile); deliberate, fully-populated type and color scales on both platforms; only 3 one-off inline styles found across the three largest pages checked, all justified dynamic values (01-evidence.md Visual section).
   Justification: single visible system, no orphan styles — meets the 3/3 anchor exactly. (The prior narrower audit's 1/3 was specific to the survey module's old internal structure, not representative of the app as a whole; this full-app view shows the rest of the app was disciplined all along.)

4. Good design makes a product understandable — Score: 1/3
   Evidence: raw permission-code jargon ("employee.read", "document.read", "approval.read") leaks into user-facing 403/empty-state text on both platforms (Copy & Honesty evidence); unexplained domain abbreviations ("RA", "BOQ") on first use in billing.
   Justification: 2+ unclear labels/jargon present across confirmed instances — matches the 1/3 anchor precisely.

5. Good design is unobtrusive — Score: 3/3
   Evidence: zero continuous/idle animation found on either platform's home/dashboard screens (Weight & Friction evidence); clean, consistent chrome with no decorative excess noted anywhere in evidence gathering.
   Justification: chrome recedes, content is the figure — meets the 3/3 anchor.

6. Good design is honest — Score: 3/3
   Evidence: zero marketing inflations found; zero dark patterns found; multiple destructive/important actions checked on both platforms (approve/reject/withdraw, deactivate/reactivate, remove-board) with labels matching behavior in every case; the one near-miss (`BoardClient.tsx:499` "Remove" labeling an archive, not a delete) is corrected in the same confirm-dialog moment, not a broken promise.
   Justification: every claim checked maps to actual behavior; the single imprecise verb is self-corrected before the action commits, not a genuine inflation or mismatch — meets 3/3 rather than the "≤1 minor inflation" 2/3 tier.

7. Good design is long-lasting — Score: 3/3
   Evidence: no dated trend markers found anywhere in evidence gathering (no skeuomorphism, fad gradients, glassmorphism, or trend typography noted); consistent, restrained visual language throughout.
   Justification: same score as the prior audit gave this principle, for the same reason — nothing here would read as a specific year's trend three years from now.

8. Good design is thorough down to the last detail — Score: 2/3
   Evidence: web has full, deliberate state coverage (loading/empty/error/disabled/focus/success/invalid, all with dedicated components or variants); mobile has most of these but lacks a dedicated error-display component matching web's `ErrorCard` richness (only `Input`'s error prop + generic `Banner`) and has no explicit focus-state styling.
   Justification: one state (error display) is confirmed rough/underdeveloped on mobile relative to web's equivalent — matches "1 state missing or rough," not the clean 3/3 web alone would earn.

9. Good design is environmentally friendly — Score: 1/3
   Evidence: a confirmed dead dependency on web (`@mapbox/mapbox-gl-draw`, zero imports anywhere) plus an un-split `dnd-kit`/`KanbanBoard` bundle loading unconditionally on the dashboard; a confirmed fully-unused `react-native-reanimated`/`worklets` pair on mobile (zero animation calls anywhere in app code, pure native-module startup cost). Both platforms otherwise lean: zero idle animation, dark mode honored via complete palettes on both.
   Justification: real, confirmed dead/unsplit weight on both platforms outweighs the otherwise-good motion discipline — this is concrete bundle-weight waste, not a hypothetical, so it doesn't earn the "lean, motion gated" 2/3 tier.

10. Good design is as little design as possible — Score: 2/3
    Evidence: the two dead dependencies above (mapbox-gl-draw on web, reanimated/worklets on mobile) are themselves literally-removable elements with zero functional loss if deleted.
    Justification: exactly 2 confirmed-removable elements — matches the "≤2 removable" 2/3 anchor exactly, no more and no less than what the evidence supports.

**Total: 21/30**
