# 00 — Scope

## What is being audited

The entire Silverline ERP product surface: the Next.js web app (`apps/web`, 70 `page.tsx` routes) and the Expo/React Native mobile app (`apps/mobile`, 35 screens). Full-app audit, requested after a prior narrower audit (`DESIGN-IS-2026-10-03/`) covered only the survey module on web.

## Primary user and task

Multi-role construction/land-survey ERP for an Indian organisation (Silverline). Roles span: SUPER_ADMIN/ADMIN (org-wide config), PROJECT_MANAGER, TEAM_LEAD, field crew/EMPLOYEE (survey data entry, attendance, daily returns — often on a phone, sometimes in poor network conditions in the field), HR_MANAGER, PAYROLL_OFFICER, INVENTORY_MANAGER, AUDITOR (read-only, PII-masked), CLIENT_VIEWER and GOVT_OBSERVER (progress-only external readers).

Primary task is role-dependent: field staff need fast, reliable data entry and lookup on mobile under real-world conditions (interruptions, connectivity gaps); office/admin staff need dense, accurate management screens on web (projects, finance, procurement, HR, reporting). There is no single "primary task" — this is a working tool for many distinct jobs, not a consumer app with one golden path.

## Constraints

- Live production app, recently redeployed against a fresh database — real organisational usage is expected to begin, so changes must not break existing flows or data contracts.
- Web: Next.js + Tailwind, with an existing semantic color-token system (`globals.css`/`tailwind.config.js`) already scored 3/3 on honesty and long-lasting in the prior audit — preserve, don't replace.
- Web has an existing shared component system (`components/v2/Workbench.tsx` and siblings: `Panel`, `Collection`, `MutationForm`, `Can`) used by most pages for CRUD/list/form patterns.
- Mobile has its own shared primitives (`src/ui/primitives.tsx`, 564 lines: `Screen`, `Card`, `Button`, `Input`, `ListRow`, `Badge`, etc.) used across most screens.
- The prior survey-module audit's root cause was specifically a page built *without* using the shared system (a 3,877-line bespoke file) — strong signal that bespoke/one-off screens, not the shared systems themselves, are where problems concentrate. This audit should triage shared-system-based vs. bespoke screens early and weight effort accordingly rather than auditing all 105 screens with equal depth.
- No reference designs or competitors specified by the owner; working from first principles (Rams) and internal consistency.

## Why this shape

70 web pages + 35 mobile screens is too large to audit page-by-page at equal depth without burning enormous effort on screens that are structurally identical (built from the same shared components) and therefore share the same strengths/weaknesses. The plan: triage first (which screens are shared-system vs. bespoke), then concentrate the five evidence-gathering passes on the shared systems themselves (fix once, benefits everywhere) plus the bespoke outliers (where the prior audit's pattern predicts the real problems live).
