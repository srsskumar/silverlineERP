# Dependency majors (vitest 4, next 16, zod 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repo off the three dependency majors whose OSV advisories are held by dated ignores (DEP-2 zod, DEP-3/next, DEP-4 vitest), one upgrade per commit, with the full gate green after each.

**Architecture:** Three independent upgrades, ordered by blast radius: vitest (dev-only, two config files), then next (one app, already async-params and static-export), then zod (30 shared schema files consumed by API, web and mobile). Each task ends with lint, tests, build, the production-critical audit, and a commit; the OSV ignore file and the findings register are updated in the same commit as the upgrade that makes them true.

**Tech Stack:** npm workspaces + Turbo, vitest, Next.js 16 (static export, Turbopack), zod 4 classic API, `@hookform/resolvers` 6, node:test on mobile.

**Spec:** the owner's instruction "Fix zod 4, next 16 and vitest 4 upgrades" plus the open rows DEP-2, DEP-3, DEP-4 in `docs/security/2026-10-28/SECURITY_FINDINGS.md` and the dated entries in `osv-scanner.toml` (expire 2026-12-31).

## Global Constraints

- One upgrade per commit; never leave `main` with a red gate between commits.
- Gate after each task, from the repo root: `npm run lint && npm test && npm run build && npm audit --omit=dev --audit-level=critical` (API tests need `TEST_DATABASE_URL` exported from `.env` and **nothing else** from `.env`; sourcing the whole file leaks `SEED_ADMIN_PASSWORD` and turns admin sign-ins into 401s).
- No behaviour change for users: request validation accepts and rejects exactly what it did before, with the same human messages the tests pin.
- Keep the shared schema as the single source of truth: fix zod usage in `packages/shared` once; API, web and mobile consume its `dist/`. Rebuild shared (`npm run build --workspace=@silverline/shared`) before typechecking dependents.
- Do not touch Expo SDK, React, TypeScript or eslint majors; mobile uses TypeScript 6 already and compiles the shared `dist/`.
- `osv-scanner.toml`: remove an ignore only when the advisory's package is actually gone from `package-lock.json` (`grep -c '"node_modules/<pkg>"' package-lock.json` and the version). DEP-5 (`deepmerge` via `@expo/config`) is out of scope and stays.
- Node engines stay `>=20 <24`; Next 16 needs 20.9+, already satisfied. CI runs Node 22.
- Vite stays pinned by the root override (`7.3.7`); vitest 4 accepts `^6 || ^7`.

## Review Focus

1. A request body that omits an optional field with `.default()` behind a transform — zod 4 returns the default unparsed; any schema where the default was an *input* value that relied on the transform now yields the raw value. Pinned by Task 3 step 5 (grep for multi-line `.transform(…).default(`) and the full API suite.
2. Test fixtures or clients that send UUIDs with non-RFC variant bits (`00000000-0000-…`) — zod 4 `.uuid()` rejects them. Decision rule in Task 3 step 7.
3. Error text shown to users from zod defaults — zod 4 reworded every default (“Invalid input: expected string, received undefined”, “Too small: …”, “Invalid UUID”). `humanise()` must still produce “First name is required”, “Village is not a valid reference”, “Basic salary must be a number”; `errors.test.ts` pins these (Task 3 step 3).
4. `next build` with Turbopack for a static export using `distDir: '.next-verify'`, `next/font/google`, `next/dynamic` — the artefact must still land in `apps/web/out` with the record deep-link pages; Task 2 step 4 checks the output directory and `security-headers.test.ts` stays green.
5. The API test pool: vitest 3 `singleFork` disabled module isolation; the vitest 4 equivalent is `maxWorkers: 1, isolate: false`. If any file depended on a fresh module graph it will leak state into its neighbours — the whole suite in Task 1 step 3 is the check, and the fallback is `isolate: true` with the measured slowdown noted in the config comment.

---

### Task 1: vitest 4 in api, web and shared

**Files:**
- Modify: `apps/api/package.json` (devDependencies.vitest), `apps/web/package.json` (devDependencies.vitest), `packages/shared/package.json` (devDependencies.vitest)
- Modify: `apps/api/vitest.config.ts:7-40` (`poolOptions.forks.singleFork` → top-level `maxWorkers`/`isolate`)
- Modify: `osv-scanner.toml` (remove the six DEP-4 entries once `tinypool`, `@vitest/mocker` 3.x and `vite` <7.3.7 are gone)
- Modify: `docs/security/2026-10-28/SECURITY_FINDINGS.md:40` (DEP-4 row → FIXED)
- Test: whole suites (`apps/api/test`, `apps/web/tests`, `apps/web/tests-dom`, `packages/shared/src/**/*.test.ts`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: vitest `^4.1.12` as the one test runner for the three workspaces; `apps/api/vitest.config.ts` with `pool: "forks", maxWorkers: 1, isolate: false`.

- [ ] **Step 1: Bump the three declarations and install**

```bash
cd /Users/pratyush/Desktop/claude/silverlineERP
npm install --no-audit --no-fund -w apps/api -w apps/web -w packages/shared vitest@^4.1.12
node -p "require('vitest/package.json').version"   # expect 4.1.x
```

- [ ] **Step 2: Run the API suite to see the config rejection**

Run: `cd apps/api && TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' ../../.env | cut -d= -f2-)" npx vitest run test/db-ssl.test.ts`
Expected: FAIL or warning naming `poolOptions` as an unknown/removed option (vitest 4 removed it).

- [ ] **Step 3: Replace `poolOptions` in `apps/api/vitest.config.ts`**

Replace

```ts
    poolOptions: {
      forks: { singleFork: true },
    },
```

with

```ts
    // vitest 4 spelling of the old `poolOptions.forks.singleFork`: one
    // process, shared module graph. See the comment above for why one.
    maxWorkers: 1,
    isolate: false,
```

Keep `pool: "forks"`, `globalSetup`, `env`, timeouts unchanged. Web and shared configs need no change (`projects` with `extends: true` is already the v4 shape).

- [ ] **Step 4: Run every vitest suite**

Run, from the repo root with only `TEST_DATABASE_URL` exported:
`npm test --workspace=packages/shared && npm test --workspace=apps/web && npm test --workspace=apps/api`
Expected: shared 1,056 passed; web 992 passed (both projects); API 89 files, 2,409 passed, 13 skipped, 0 failed. If a file fails only under `isolate: false` and passed before, set `isolate: true`, re-run, and record the wall-time difference in the config comment.

- [ ] **Step 5: Drop the vitest ignores that no longer match**

```bash
for p in tinypool vite @vitest/mocker; do echo "$p: $(grep -c "\"node_modules/$p\"" package-lock.json)"; done
node -p "require('./node_modules/vite/package.json').version"
```

Expected: `tinypool: 0`; `vite` present at `7.3.7`; `@vitest/mocker` present at 4.x. Remove from `osv-scanner.toml` the block headed `# vitest 3 / @vitest/mocker / tinypool / vite` (ids `GHSA-82fw-gwwq-j7x9`, `GHSA-qxg6-89mg-rqv8`, `GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr`, `GHSA-698v-4r3x-3vcv`, `GHSA-r825-w8mm-5pxw`). In `SECURITY_FINDINGS.md` change the DEP-4 row's Remediation to `vitest 4.1 (2026-10-29)` and Status to `FIXED`.

- [ ] **Step 6: Full gate and commit**

Run: `npm run lint && npm run build && npm audit --omit=dev --audit-level=critical` (tests already ran in step 4).
Expected: 5/5 lint, 4/4 build, audit exit 0.

```bash
git add -A
git commit -m "chore(deps): vitest 4 across api, web and shared; drop the DEP-4 OSV ignores"
```

---

### Task 2: Next.js 16 for the web app

**Files:**
- Modify: `apps/web/package.json` (dependencies.next `^16.4.3`)
- Modify: `apps/web/next.config.js` only if `next build` reports a Turbopack incompatibility (none expected: no `webpack` key, no `eslint` key, no `experimental`)
- Modify: `docs/security/2026-10-28/SECURITY_FINDINGS.md:39` (DEP-3 row: add "next 16.4 (2026-10-29)" to Remediation; it is already FIXED via the postcss override)
- Test: `apps/web/tests/security-headers.test.ts`, whole web suites, `npm run build --workspace=apps/web`

**Interfaces:**
- Consumes: vitest 4 from Task 1 (web tests).
- Produces: `next@16.4.x`; the static export still at `apps/web/out`; the root `overrides.next.postcss` entry stays (next 16 still pins its own postcss).

- [ ] **Step 1: Confirm the pre-upgrade build output shape**

Run: `cd apps/web && npm run build && ls out | head && ls out/record* out/employees 2>/dev/null | head`
Expected: `out/` contains `index.html`, `record.html` (or `record/index.html`) and `employees/__placeholder__/…`. Note the exact file list; step 4 compares against it.

- [ ] **Step 2: Upgrade**

```bash
cd /Users/pratyush/Desktop/claude/silverlineERP
npm install --no-audit --no-fund -w apps/web next@^16.4.3
node -p "require('./apps/web/node_modules/next/package.json').version" 2>/dev/null || node -p "require('next/package.json').version"
grep -c '"version": "8.4.31"' package-lock.json   # expect 0: the next.postcss override still applies
```

- [ ] **Step 3: Typecheck and lint**

Run: `cd apps/web && npm run lint`
Expected: `tsc --noEmit` clean (types for `next/link`, `next/navigation`, `next/dynamic`, `next/font/google` unchanged) and eslint clean. Fix any type error in place; do not add `@ts-expect-error`.

- [ ] **Step 4: Build with Turbopack (the new default) and compare the export**

Run: `cd apps/web && npm run build && ls out | head && ls out/employees`
Expected: build succeeds without `--webpack`; the same top-level files as step 1 and `out/employees/__placeholder__`. If Turbopack refuses the config, read the error; only if it names an option Turbopack does not support, switch the script to `"build": "NEXT_VERIFY_BUILD=1 next build --webpack"` and give the reason in the commit message (package.json cannot carry comments).

- [ ] **Step 5: Run the web suites**

Run: `cd apps/web && npx vitest run`
Expected: 992 passed across `logic` and `dom`, including `tests/security-headers.test.ts`.

- [ ] **Step 6: Smoke the export against the record deep-link rewrite**

Run: `grep -n '"source"\|"destination"' apps/web/vercel.json | head -6 && ls apps/web/out/record*`
Expected: the rewrite targets listed in `vercel.json` exist as files in `out/`.

- [ ] **Step 7: Register, gate, commit**

In `SECURITY_FINDINGS.md` DEP-3 Remediation append `; next 16.4 (2026-10-29)`. Then from the root:
`npm run lint && npm test && npm run build && npm audit --omit=dev --audit-level=critical`
Expected: all green.

```bash
git add -A
git commit -m "chore(web): next 16; static export and headers unchanged"
```

---

### Task 3: zod 4 in shared, api, web and mobile

**Files:**
- Modify: `packages/shared/package.json`, `apps/web/package.json`, `apps/mobile/package.json` (dependencies.zod `^4.6.7`); `apps/web/package.json` devDependencies `@hookform/resolvers` `^6.0.2`, dependencies `react-hook-form` `^7.88.0`
- Modify: `packages/shared/src/errors.ts:150-200` (`isZodDefault`, `humanise`)
- Modify: `packages/shared/src/errors.test.ts:13` (`z.ZodTypeAny` → `z.ZodType`)
- Modify: `packages/shared/src/s2.ts:84,89` (`invalid_type_error` → `error`)
- Modify: `packages/shared/src/s4.ts:137` (`z.record(z.array(...))` → `z.record(z.string(), z.array(...))`)
- Modify: `apps/api/src/common/domain.ts:42` (`z.ZodType<T, z.ZodTypeDef, unknown>` → `z.ZodType<T, unknown>`)
- Modify: `apps/api/src/modules/planning/routes.ts:151`, `apps/api/src/modules/integrations/gateway.ts:19` (`z.record(z.unknown())` → `z.record(z.string(), z.unknown())`)
- Modify: `apps/api/src/modules/expenses/routes.ts:429,1030` (`expenseClaimSchema.innerType().pick(...)` → `expenseClaimSchema.pick(...)`)
- Modify: `apps/web/lib/validation.ts` 12 sites (`{ errorMap: () => ({ message: 'X' }) }` → `{ error: 'X' }`)
- Modify: `apps/web/app/employees/import/page.tsx:35`, `apps/web/components/EvidenceList.tsx:73`, `apps/web/components/DocumentList.tsx:62` (`.error.errors[0]` → `.error.issues[0]`)
- Modify: `osv-scanner.toml` (remove `GHSA-mrhx-c7xc-m3w5`), `docs/security/2026-10-28/SECURITY_FINDINGS.md` (DEP-2 → FIXED), `docs/security/2026-10-28/SECURITY_RUNBOOK.md` nothing
- Test: `packages/shared/src/errors.test.ts` (RED first), then every suite in every workspace

**Interfaces:**
- Consumes: Tasks 1 and 2 committed.
- Produces: zod `^4.6.7` hoisted once at the root; `humanise(issue: z.ZodIssue, label: string): string` unchanged in signature; `parse<T>(schema: z.ZodType<T, unknown>, body: unknown): T` in `apps/api/src/common/domain.ts`.

- [ ] **Step 1: Upgrade zod and the form resolver**

```bash
cd /Users/pratyush/Desktop/claude/silverlineERP
npm install --no-audit --no-fund -w packages/shared -w apps/web -w apps/mobile zod@^4.6.7
npm install --no-audit --no-fund -w apps/web @hookform/resolvers@^6.0.2 react-hook-form@^7.88.0
npm ls zod 2>/dev/null | grep -E 'zod@' | sort -u     # expect one line: zod@4.6.x
```

- [ ] **Step 2: Run the shared error tests to see them fail**

Run: `cd packages/shared && npx vitest run src/errors.test.ts`
Expected: FAIL — `z.ZodTypeAny` type error at compile, then messages like "Invalid input: expected string, received undefined" leaking through `humanise` instead of "First name is required".

- [ ] **Step 3: Make `humanise` understand zod 4 issues**

In `packages/shared/src/errors.test.ts:13` change `schema: z.ZodTypeAny` → `schema: z.ZodType`.

In `packages/shared/src/errors.ts`:
- `isZodDefault` regex → `/^(Required|Invalid|Expected |Too small|Too big|Number must |String must |Array must |Date must |Unrecognized key)/`.
- `humanise`:
  - `invalid_type`: the "is required" branch tests `issue.input === undefined || issue.input === null` (zod 4 has no `received`); keep the `expected` branches.
  - replace `case "invalid_string"` with `case "invalid_format"` and switch on `issue.format`: `"uuid"` → `${label} is not a valid reference`, `"email"` → `That is not a valid email address`, `"url"` → `That is not a valid web address`, otherwise `issue.message`.
  - `too_small` / `too_big`: read `issue.origin` where the code read `issue.type` (`"string" | "array" | "number"`); `minimum`/`maximum`/`inclusive` keep their names.
  - `invalid_enum_value` → `invalid_value` (field `values` instead of `options`) if the switch has such a case; `unrecognized_keys` unchanged.
  Type the issue as `z.core.$ZodIssue` only if `z.ZodIssue` lacks the discriminant fields under `tsc`; otherwise keep `z.ZodIssue`.

- [ ] **Step 4: Run the shared tests**

Run: `cd packages/shared && npx vitest run`
Expected: `errors.test.ts` green with the exact strings from Review Focus 3; the other 29 files green. Any other red file is a real zod 4 behaviour change — fix the schema in place (add `.optional()` where `.default()` now applies inside optionals, or `z.record(z.string(), …)`), never the test.

- [ ] **Step 5: Audit `.default()` after `.transform()` across shared and API**

```bash
grep -rnE --include='*.ts' -B2 '\.default\(' packages/shared/src apps/api/src | grep -E 'transform|preprocess|pipe' | cut -c1-160
```
Expected: for each hit, decide: default is an *output*-shaped value → leave; default is an *input*-shaped value → change `.default(x)` to `.prefault(x)`. Record the count in the commit message.

- [ ] **Step 6: Fix the remaining compile breaks**

Apply the edits listed under Files for `s2.ts`, `s4.ts`, `domain.ts`, `planning/routes.ts`, `integrations/gateway.ts`, `expenses/routes.ts`, `apps/web/lib/validation.ts`, the three `.errors[0]` sites. For `s2.ts` use `z.number({ error: (iss) => iss.code === "invalid_type" ? "latitude must be a number" : undefined })` so only the type failure gets the custom text. Then:

```bash
npm run build --workspace=@silverline/shared && npm run lint
```
Expected: 5/5 clean. Fix any further `tsc` error at the site it names, preferring the zod 4 spelling that keeps the old inferred type.

- [ ] **Step 7: Run the API suite and apply the UUID rule**

Run: `cd apps/api && TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' ../../.env | cut -d= -f2-)" npx vitest run`
Expected: 2,409 passed. If failures are only `Invalid UUID` on fixture ids such as `00000000-0000-0000-0000-00000000000x`: fewer than ten fixtures → change the fixtures to RFC 4122 v4 ids (`crypto.randomUUID()` or `xxxxxxxx-xxxx-4xxx-8xxx-…`); otherwise replace `.uuid()` with `.guid()` across `packages/shared/src` and `apps/api/src` with one `sed` and note it in the findings row. Any other failure is a schema behaviour change — fix the schema.

- [ ] **Step 8: Web and mobile**

Run: `cd apps/web && npm run lint && npx vitest run` then `cd ../mobile && npm run typecheck && npm test`
Expected: web clean + 992; mobile clean + 560. Form tests exercise `zodResolver` with resolvers 6.

- [ ] **Step 9: Register, gate, commit**

Remove the `GHSA-mrhx-c7xc-m3w5` block from `osv-scanner.toml`; in `SECURITY_FINDINGS.md` set DEP-2 Remediation `zod 4.6 (2026-10-29)`, Status `FIXED`. Then from the root:
`npm run lint && npm test && npm run build && npm audit --omit=dev --audit-level=critical`
Expected: all green; `npm audit --json | jq .metadata.vulnerabilities` shows no zod entry.

```bash
git add -A
git commit -m "chore(deps): zod 4 across shared, api, web and mobile; humanise speaks zod 4"
```

---

### Task 4: Hand-off

- [ ] **Step 1: Push and watch**

The owner runs `git push origin main` (the classifier blocks it for the agent). Then watch `gh run list --limit 4` for `Verify Silverline` and `Security` on the new head; the OSV job should report 0 new findings with only the DEP-5 ignore left.

- [ ] **Step 2: Note in `SECURITY_TEST_RESULTS.md`**

Append the three gate results (one line each) and the CI run conclusions.
