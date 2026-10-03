# Scope Lock

**Audited:** apps/web (Next.js + Tailwind + Radix/shadcn-style components), live on a local dev server (http://localhost:3100 or similar, started for this audit). Surfaces in scope for this pass:
- Shared chrome: `app/layout.tsx`, nav/shell components, `app/globals.css` (affects every page)
- `app/dashboard/page.tsx` (256 lines)
- `app/survey/page.tsx` (3,877 lines — single monolithic file for the whole survey module UI), plus `app/survey/entry/page.tsx` and `app/survey/setup/page.tsx`

**Primary user:** internal staff at a land-survey & construction contractor — administrators, project/programme managers, team leads, field crew, HR/finance/procurement staff — using this as a daily operational tool, not a consumer product.

**Primary task:**
- Dashboard: see at a glance what needs attention today (projects, tasks, approvals, alerts) and jump to it.
- Survey module: track village-level land-survey progress (stages, GCPs, rover/crew allocation, billing milestones) across potentially hundreds of villages per programme.

**Constraints:**
- Stack is fixed (Next.js, Tailwind, Radix primitives) — no framework change.
- No rebrand mandate; reuse/extend existing design tokens where they exist rather than inventing a new palette from nothing.
- Must remain usable by non-technical field/admin staff, including on tablet widths (not just desktop office use).
- This is one module (survey) of a 32-module ERP — any token/pattern decisions made here should be reusable across the rest of the app, not one-off.

**Reference designs:** none specified by owner. No competitor benchmark given.

**Owner-stated defaults (pending confirmation, acted on unless corrected):** start with dashboard + survey module; visual polish/consistency pass first, flag flow-level UX problems separately rather than restructuring navigation in this pass.
