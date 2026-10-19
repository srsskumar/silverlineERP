# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Silverline ERP: a multi-tenant construction/land-survey ERP for an Indian organization. One Fastify API backs both a Next.js web app and an Expo/React Native mobile app, sharing one PostgreSQL database and one `@silverline/shared` package of zod schemas/business logic. Roles range from field crew (mobile, often in poor network conditions) to admin/finance/HR (web, dense management screens). The full product contract is `Silverline_ERP_v2_Enhanced_Requirements.docx`; `docs/V2_COMPLETION.md` tracks implemented behavior and remaining acceptance work. Superseded decisions (e.g. geo-fencing, removed 2026-09-22 — see below) live only in `docs/DEV_PLAN.md` and must not be reintroduced from the older requirements text.

**`ARCHITECTURE.md` is the original target design, not the current code** — it says so at its own top, with a table mapping each claim (NestJS, Kotlin/Jetpack Compose Android, Kubernetes, server-rendered Next.js) to what's actually there (Fastify+raw `pg`, Expo RN, one VM + systemd + Supabase, static Next export). Read that disclaimer table before trusting anything else in that file; its domain-model/business-rules sections are still the intent. For how the system actually runs, use `README.md` and `docs/OPERATIONS.md`.

## Workspaces

npm workspaces, orchestrated by Turbo (`turbo.json`): `apps/api`, `apps/web`, `apps/mobile`, `packages/shared`. `packages/shared` builds first (`tsc`, emits `dist/`) — API, web and mobile all import `@silverline/shared` from its build output, not source, so after editing shared code you must rebuild it (`npm run build --workspace=@silverline/shared`) before a dependent app's typecheck/test/dev picks up the change. Mobile's `prestart`/`prebuild`/`preios`/`pretest` scripts already do this for you; web and API do not auto-rebuild it.

## Commands

Local setup (Node 22+, PostgreSQL 16 required — `.nvmrc` pins 20 but engines require `>=20 <24`; this repo's own shell hook sets Node 22 + JDK 17 on `cd` into it):

```sh
npm ci
cp .env.example .env        # fill in DB creds, ENCRYPTION_KEY (openssl rand -hex 32), JWT_SECRET
docker compose up -d
npm run db:migrate
npm run db:seed             # SEED_ADMIN_PASSWORD env var sets the initial admin password
npm run dev:api             # API on :3101
npm run dev:web             # web on :3002, separate terminal
npm run dev:mobile          # Expo; EXPO_PUBLIC_API_URL must point at a reachable API (Android emulator: http://10.0.2.2:3101)
```

Root-level (runs across all workspaces via Turbo):

```sh
npm run build      # shared -> api (incl. SQL migrations) -> static web export (apps/web/out) -> mobile JS bundles (apps/mobile/dist)
npm test           # all workspaces
npm run lint        # all workspaces (tsc --noEmit everywhere; web also runs eslint)
npm run check       # lint + test + catalogue + build -- the full gate, same as CI
npm run catalogue   # scripts/catalogue-coverage.mjs -- cross-checks docs/SILVERLINE_BUSINESS_TEST_CATALOGUE.md's test IDs against what actually exists; --json for machine output
npm run db:migrate / npm run db:seed
```

Per-workspace (from repo root, `--workspace=apps/X`, or `cd` into the workspace first):

- **apps/api**: `npm test` = `vitest run` (add a path to run one file/dir, e.g. `vitest run test/catalogue/s1.test.ts`; vitest's own `-t "name"` filters by test name). `npm run lint` = `tsc --noEmit`. `npm run migrate` / `npm run seed` run directly against `DATABASE_URL`. `npm run test:survey` runs just the survey-module catalogue suite. Tests require `TEST_DATABASE_URL` pointing at a database named `*_test` or `test_*` (the test helper rejects any other name) and deliberately do **not** load `.env` — migrations run automatically as part of the test setup.
- **apps/web**: `npm test` = `vitest run` (same per-file targeting). `npm run lint` = `tsc --noEmit && eslint .`. `npm run build` sets `NEXT_VERIFY_BUILD=1` and produces a static export at `apps/web/out`.
- **apps/mobile**: `npm test` = `tsx --test test/*.test.ts` (Node's built-in test runner, not vitest/jest — target one file by passing its path instead of the glob). `npm run typecheck`/`lint` = `tsc --noEmit`. `npm run android` / `npm run ios` = `expo run:android` / `expo run:ios` against a connected device/emulator/simulator; `npm run check:android` sanity-checks the Android SDK/JDK/device setup before that. `npm run build` = `expo export` for both platforms (JS bundle only — **not** an APK/IPA; EAS builds need `apps/mobile/eas.json` configured separately). **Expo has changed significantly since model training — `apps/mobile/AGENTS.md` requires reading the versioned docs at https://docs.expo.dev/versions/v57.0.0/ for whatever Expo/RN API you're about to touch before writing code.**
- **packages/shared**: `npm run build` = `tsc`. `npm test` = `vitest run`. Most business-rule/validation logic (zod schemas, money/date/India-specific formatting, RBAC helpers) lives here specifically so API, web and mobile validate identically — check here first before assuming a rule needs implementing per-platform.

## Architecture notes that span files

- **One zod schema, three consumers.** Request/response contracts live in `packages/shared/src/*.ts` (e.g. `s1.ts`, `s4.ts`, `v2.ts`, `p1.ts` — module-coded, not always named after the feature). API routes `.parse()`/`.safeParse()` them server-side; both web and mobile forms build client-side validation and request bodies from the *same* schema. A recurring real bug class in this codebase's QA history is a client-side schema/form drifting from the server schema (e.g. a field present in one but not the other, or a `PATCH` schema missing a field the create schema has) — when adding or editing any form, check the shared schema first and verify both the web and mobile forms (if both exist) actually match it, not just one.
- **No geo-fencing** (owner decision 2026-09-22, `docs/DEV_PLAN.md`): a punch is accepted with or without a position; the position is stored as evidence; anti-fraud review (mock-location, impossible-travel, clock-skew) still applies independently. `ARCHITECTURE.md`'s Geo-Fence module box and the requirements doc's §9 fencing text are both superseded — do not reintroduce fence geometry/validation.
- **Permission model**: role → permission codes (e.g. `attendance.punch`, `attendance.decide`, `employee.read`) plus a separate *record scope* (self/team/geo/project) enforced per-route via `enforceRecordScope`-style helpers in `apps/api/src/common`. A route can be permission-correct but scope-incorrect or vice versa — both checks matter independently, and QA history shows bugs concentrated where only one was tested. Raw permission codes must never leak into user-facing text on either client; `apps/web/lib/permissionLabels.ts` (and mobile's equivalent) maps codes to plain-English labels — extend that map rather than interpolating a raw code into a message.
- **Shared component systems, not per-screen one-offs.** Web: `apps/web/components/v2/Workbench.tsx` and siblings (`Panel`, `Collection`, `MutationForm`, `Can`) drive most CRUD/list/form screens. Mobile: `apps/mobile/src/ui/primitives.tsx` (`Screen`, `Card`, `Button`, `Input`, `ListRow`, `Badge`, etc.) is used by nearly every screen. This repo's own audit history found that bugs and inconsistency concentrate in screens built *without* these shared systems (bespoke one-offs), not in the systems themselves — when fixing a UI issue, prefer extending the shared component over patching one screen, and be suspicious of any screen that isn't using it.
- **Mobile module launcher**: `apps/mobile/src/modulesLauncher.ts` is pure data-in/data-out logic (no RN runtime dependency, tested with `node:test`) deciding what the More-tab shows per role, driven by `MODULE_CATALOG` in `packages/shared/src/modules.ts`. A catalog entry with no matching key in `BUILT_MODULE_ROUTES` renders as "Coming soon" — check this map before assuming a module has no mobile screen.
- **Static web + dynamic deep links**: `apps/web` builds as a static export (`NEXT_VERIFY_BUILD=1`, output in `out/`); individual records resolve through `/record?type=&id=` rather than per-record server routes, since there's no server to render them dynamically. Host-level rewrites (Cloudflare `_redirects`/`_headers`, or Caddy matchers in `docker/`) must map real record URLs to that pattern — a host config that only knows static-file routing will break deep links.
- **Mobile offline sync queue** persists mutations locally before sending, keyed by a stable operation key retained across retries (idempotency, not just offline support — a retried mutation with the same key must produce exactly one server-side effect). Conflicts/rejections surface under More → Sync queue. Signing into the same account resumes its encrypted local queue; a remote wipe destroys the local encryption key.
- **Background jobs**: `apps/api/src/jobs.ts` is a plain polling loop (`runJobs` every 5s, retry-on-throw) run as a separate process/worker — not BullMQ/Redis despite what `ARCHITECTURE.md`'s diagram shows. Scheduled reports, automation rules and webhook/push delivery run through this worker, not inline in request handlers.
- **Payroll** is a strict state machine: `OPEN → VALIDATING → CALCULATED → REVIEW → APPROVED → LOCKED`. Reopening requires an authorized user and a reason; recalculation retains prior payslip revisions rather than overwriting them — don't design a payroll change that skips a state or mutates a locked/approved run in place.
- **PII** (Aadhaar, PAN, bank details, phone) is encrypted at rest and masked in all output unless the caller holds the specific unmasking permission; it must never appear in logs. `apps/api/src/common` has the masking/encryption helpers — reuse them rather than re-deriving masking logic per module.

## QA process convention

`docs/qa/<date>/findings-*.md` files are this project's long-running audit trail: each row is `ID | severity | area | ... | repro | expected | actual | status (OPEN/FIXED/VERIFIED/DECISION/CLOSED) | commit`. `docs/SILVERLINE_BUSINESS_TEST_CATALOGUE.md` is the test *specification* (not executable code) that `npm run catalogue` checks coverage against — a row marked `RETIRED` (e.g. the old geo-fence tests) means the requirement was deliberately withdrawn, not forgotten. When fixing a bug found during review, follow the established pattern visible throughout git history and these findings docs: reproduce it with a failing (RED) test first, fix, confirm the full relevant suite is green, and record it. `DESIGN-IS-*` directories are UI/UX audit rounds (scope → evidence → scorecard → verdict → implementation plan) — check the latest one's verdict before assuming a design concern hasn't already been triaged.

## Mobile toolchain on this machine

Android SDK is at `~/Library/Android/sdk` (not on `ANDROID_HOME`/`PATH` by default in a non-interactive shell — export both plus `platform-tools`/`emulator` before using `adb`/`emulator`). An AVD named `silverline_api36` exists. Xcode + iOS simulators are installed; a simulator named "Silverline iPhone" exists alongside the stock device list. Node 22 and JDK 17 come from Homebrew (`/opt/homebrew/opt/node@22/bin`, `/opt/homebrew/opt/openjdk@17`) and are only auto-added to `PATH` by this repo's own interactive-shell `chpwd` hook — a non-interactive tool invocation must export them explicitly.
