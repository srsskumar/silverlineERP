# Admin-managed module visibility (roles + employees) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator hide or show modules per role and per employee, with filters and bulk update, and make both clients honour the result.

**Architecture:** One resolution function in `packages/shared` decides a user's module map from three layers (user row > role row > permission default); `/auth/me` and the admin screen both call it. A new `user_module_visibility` table mirrors the existing role table. Two admin routes (list users with resolved modules; bulk set/clear) feed a new `/configuration` web page with Roles and Employees tabs. The web shell and landing route start reading `session.modules`; mobile already does.

**Tech Stack:** Fastify + pg (API), zod 4 shared schemas, Next 16 static export + React Query + the repo's `v2` primitives (web), Expo (mobile: one constant), vitest 4 / node:test.

**Spec:** `docs/superpowers/specs/2026-10-30-module-visibility-config-design.md`

## Global Constraints

- Visibility is display only: no route gains or loses a permission or scope check (`MODULE_VISIBILITY_IS_NOT_A_PERMISSION` and `test/catalogue/module-visibility.test.ts` must stay green).
- Precedence: user row > role row > permission default (OR-ed across the user's roles); super administrators (`mfaFloorRole`) are always visible; the `configuration` module can never be hidden for anyone holding `admin.configure`.
- Storage keyed by `user_id`; the Employees view lists the organisation's users with employee fields LEFT JOINed through `users.employee_id`.
- Filters: `role_code`, `district_id`, `status` (employee status, default `ACTIVE`, `ALL` allowed), `q`; paging via `cursorPageQuerySchema` (max 100). Bulk PUT: 1–500 `user_ids`, 1–catalog-size `changes`, one transaction, one audit event.
- One zod schema per request body in `packages/shared/src/modules.ts`, consumed by API and web.
- UI uses the shared `v2` primitives (`Workbench`, `Panel`, `Collection`, `MutationForm`, `Can`) and `permissionLabels`; no raw permission codes in copy.
- Migration numbered `119_user_module_visibility.sql`, registered in `src/database/migrate.ts`, listed in `test/tables.ts`.
- Catalog and `nav.ts` stay in lock-step (`apps/web/tests/module-catalog.test.ts`); every new catalog code is either a web nav destination and `WEB_ONLY_CODES` on mobile, or a built mobile route.
- Gate after each task: `npm run lint && npm test && npm run build` with only `TEST_DATABASE_URL` exported for the API.

## Review Focus

1. A user with two roles where one role hides a module and the other shows it must still see it (OR across roles), but a user row hiding it wins over both — pinned in Task 1 step 1 (`resolveModuleVisibility` cases) and Task 1 step 5 (`/auth/me`).
2. Bulk PUT with a `user_id` from another organisation must change nothing and answer 404, not skip silently — Task 2 step 3.
3. An admin hiding `configuration` for the ADMIN role, or for their own user, must be refused (`ROLE_MUST_SEE_ALL`) so the screen cannot lock itself — Task 2 step 3.
4. A role whose module is hidden must disappear from the web sidebar and never be the landing page, while a direct visit to that page still opens for a permission holder — Task 3 step 1.
5. The Employees table's bulk action must send exactly the selected ids and `null` for "follow role", never an "all matching" flag — Task 4 step 3.

---

### Task 1: Resolution function, table, and `/auth/me`

**Files:**
- Modify: `packages/shared/src/modules.ts` (append `resolveModuleVisibility`, types)
- Create: `packages/shared/src/modules.test.ts`
- Create: `apps/api/src/database/migrations/119_user_module_visibility.sql`
- Modify: `apps/api/src/database/migrate.ts` (register after `118_auth_rate_hits`), `apps/api/test/tables.ts:22` (add `user_module_visibility` beside `role_module_visibility`)
- Modify: `apps/api/src/modules/auth/routes.ts:498-535` (replace the inline loop with the shared function; add the user-row query)
- Test: `apps/api/test/catalogue/module-visibility.test.ts` (new describe)

**Interfaces:**
- Consumes: `MODULE_CATALOG`, `ModuleCatalogEntry` (existing).
- Produces, in `packages/shared/src/modules.ts`:
  ```ts
  export type VisibilitySource = 'user' | 'role' | 'default';
  export interface ResolvedModule { visible: boolean; source: VisibilitySource }
  export function resolveModuleVisibility(input: {
    roles: readonly string[];                       // the user's role codes
    heldByRole: ReadonlyMap<string, ReadonlySet<string>>; // role code -> permission codes
    roleOverrides: ReadonlyMap<string, boolean>;    // `${roleCode}:${moduleCode}` -> visible
    userOverrides: ReadonlyMap<string, boolean>;    // moduleCode -> visible
    superAdmin: boolean;                            // any role is an mfaFloorRole
  }): Record<string, ResolvedModule>;               // one entry per MODULE_CATALOG code
  ```
  Rules: `superAdmin` → every module `{visible:true, source:'default'}`; else user row → `{visible, source:'user'}`; else OR across roles of (role row ?? permission default), source `'role'` if any role row decided it, else `'default'`. Permission default = existing `/me` logic (named permission or `anyOf`, and every `requires`).
- Table `user_module_visibility(org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, module_code varchar(64) NOT NULL, visible boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users(id), PRIMARY KEY (org_id, user_id, module_code))` + `idx_user_module_visibility_org (org_id)`.

- [ ] **Step 1: Write the failing shared tests** in `packages/shared/src/modules.test.ts`:
  - "a user row wins over a role row and over the permission default" — roles `['EMPLOYEE']`, heldByRole EMPLOYEE has `task.read`, roleOverrides `EMPLOYEE:my-work → true`, userOverrides `my-work → false` ⇒ `my-work` is `{visible:false, source:'user'}`.
  - "two roles: visible if either shows it" — roleOverrides `A:my-work → false`, B holds `task.read` ⇒ `{visible:true, source:'role'}`.
  - "a super administrator sees everything, whatever the rows say" — userOverrides `my-work → false`, superAdmin true ⇒ visible true.
  - "no row and no permission is hidden with source default" — `dashboard` with no `dashboard.read` ⇒ `{visible:false, source:'default'}`.
  - "security needs no permission" ⇒ visible true, source default.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/modules.test.ts` — Expected: FAIL, `resolveModuleVisibility` is not exported.
- [ ] **Step 3: Implement `resolveModuleVisibility`** in `modules.ts` (below `MODULE_VISIBILITY_IS_NOT_A_PERMISSION`), copying the permission-default rule from `/me` verbatim.
- [ ] **Step 4: Run** the shared test — Expected: 5 passed. Then `npm run build --workspace=@silverline/shared`.
- [ ] **Step 5: Write the failing API test** in `test/catalogue/module-visibility.test.ts`, new `describe("a person's own row")`:
  - "hides a module for one user that the role still shows": `createUser(w.pool, orgId, {username, roles:['EMPLOYEE']})`, insert a row `(org, user, 'my-work', false)` directly with `w.pool`, `signIn(username)`, `GET /api/v1/auth/me` ⇒ `modules['my-work'] === false`; a second EMPLOYEE user with no row ⇒ `true`.
- [ ] **Step 6: Run** `test/catalogue/module-visibility.test.ts` — Expected: FAIL, the insert fails (`relation "user_module_visibility" does not exist`).
- [ ] **Step 7: Add the migration**, register it, add the table to `test/tables.ts`; in `/auth/me` query `SELECT module_code, visible FROM user_module_visibility WHERE org_id=$1 AND user_id=$2`, build the three maps, call `resolveModuleVisibility`, and send `modules` as `Record<code, boolean>` (`visible` only — the shape mobile reads). `superAdmin = user.roles.some(mfaFloorRole)`.
- [ ] **Step 8: Run** the module-visibility test file and `test/catalogue/ut-auth.test.ts` — Expected: all pass, including the existing invariant tests.
- [ ] **Step 9: Commit** `feat(shared,api): user-level module visibility resolved in one place`.

---

### Task 2: Admin routes — list users with resolved modules; bulk set/clear

**Files:**
- Modify: `packages/shared/src/modules.ts` (schemas), `packages/shared/src/modules.test.ts`
- Modify: `apps/api/src/modules/admin/routes.ts:362-410` (after the role PUT)
- Modify (the `configuration` module, so the guard below has something to guard and every gate stays green): `packages/shared/src/modules.ts` (catalog entry `{ code: 'configuration', label: 'Configuration', group: 'Organisation', permission: 'admin.configure' }` placed after `admin-import-templates`), `apps/web/lib/nav.ts:164` (`{ href: '/configuration', label: 'Configuration', permission: 'admin.configure', icon: SlidersHorizontal }` in the same position), `apps/mobile/src/modulesLauncher.ts:59-62` (`"configuration"` in `WEB_ONLY_CODES`) and `apps/mobile/test/module-launcher.test.ts:65` (assert it)
- Test: `apps/api/test/catalogue/module-visibility.test.ts`; `apps/web/tests/module-catalog.test.ts` must stay green

**Interfaces:**
- Consumes: `resolveModuleVisibility`, table from Task 1; `mutate`, `parse`, `fail`, `guard`, `mfaFloorRole` (existing in admin routes); `cursorPageQuerySchema` from `packages/shared/src/pagination.ts`.
- Produces, in `packages/shared/src/modules.ts`:
  ```ts
  export const userModuleVisibilityQuerySchema = cursorPageQuerySchema.extend({
    role_code: z.string().min(1).max(100).optional(),
    district_id: z.string().guid().optional(),
    status: z.enum([...EMPLOYEE_STATUSES, 'ALL']).default('ACTIVE'),
    q: z.string().trim().min(1).max(200).optional(),
  });
  export const userModuleVisibilityUpdateSchema = z.object({
    user_ids: z.array(z.string().guid()).min(1).max(500),
    changes: z.array(z.object({ module_code: z.string().min(1).max(64), visible: z.boolean().nullable() })).min(1).max(MODULE_CODES.length),
  });
  ```
  Routes (guard `admin.configure`):
  - `GET /api/v1/admin/module-visibility/users` → `{ data: UserVisibilityRow[], next_cursor: string|null }` with `UserVisibilityRow = { user_id, username, employee_id, emp_no, name, designation, district_id, district, employee_status, roles: string[], modules: Record<code, ResolvedModule> }`. `status='ALL'` includes users with no employee row; otherwise `e.status = $status`. `q` matches `username`, `first_name || ' ' || last_name`, `emp_no` (ILIKE). Order by `username`, cursor = `(username, user_id)`.
  - `PUT /api/v1/admin/module-visibility/users` → `{ data: { updated: number } }`; 404 `NOT_FOUND` for an unknown module code or a user outside the org (nothing written); 422 `ROLE_MUST_SEE_ALL` when a change hides a module for a super administrator, or hides `configuration` for a user holding `admin.configure`; `visible:null` deletes the row; audit action `admin.user_module_visibility`, entity `user`.
  - Extend the existing role PUT: hiding `configuration` for a role that holds `admin.configure` → 422 `ROLE_MUST_SEE_ALL`.

- [ ] **Step 1: Shared schema tests** in `modules.test.ts`: `userModuleVisibilityUpdateSchema` rejects 0 ids, 501 ids, an empty `changes`, a non-guid id; accepts `visible: null`. Query schema defaults `status` to `'ACTIVE'` and accepts `'ALL'`.
- [ ] **Step 2: Run** — Expected: FAIL, schemas not exported. Implement them; run — Expected: pass; rebuild shared.
- [ ] **Step 3: Write the failing API tests** (same file, `describe("the employees view")`), using `createUser` for two EMPLOYEE users and one HR_MANAGER, one with an `employeeId` whose `district_id` is set:
  - "lists the organisation's logins with resolved modules and their source" — GET with no filters ⇒ rows include the three; each row's `modules['my-work']` has `visible` and `source`.
  - "filters by role, district and search" — `role_code=HR_MANAGER` ⇒ only that user; `district_id` ⇒ only the placed employee; `q=<emp_no>` ⇒ that one.
  - "status ALL includes accounts with no employee record" — the seeded `admin` appears only with `status=ALL`.
  - "bulk-hides a module for the selected users and clears it again" — PUT `{user_ids:[a,b], changes:[{module_code:'my-work', visible:false}]}` ⇒ `updated: 2`; GET shows `source:'user', visible:false` for both and `source` unchanged for the third; `signIn(a)` → `/auth/me` `modules['my-work'] === false`; PUT with `visible:null` ⇒ rows gone, `/auth/me` true again.
  - "refuses a user from another organisation, writing nothing" — a user id created in a second org (fixture `buildWorld` exposes the org; otherwise insert a second org + user via `w.pool`) ⇒ 404 and the in-org user in the same call is unchanged.
  - "refuses an unknown module" ⇒ 404.
  - "never hides configuration for an administrator, by user or by role" — PUT for `w.admin`'s user id `{module_code:'configuration', visible:false}` ⇒ 422 `ROLE_MUST_SEE_ALL`; role PUT `{role_code:'ADMIN', module_code:'configuration', visible:false}` ⇒ 422. (Uses the `configuration` catalog code added in step 5 of this task.)
  - "needs admin.configure" — EMPLOYEE headers ⇒ ≥401 on both routes.
- [ ] **Step 4: Run** the file — Expected: FAIL with 404 on the new routes.
- [ ] **Step 5: Add the `configuration` module** to the catalog, `nav.ts` and mobile `WEB_ONLY_CODES` (Files above); run `cd apps/web && npx vitest run tests/module-catalog.test.ts` and `cd apps/mobile && npx tsx --test test/module-launcher.test.ts` — Expected: both pass. Then **implement the two routes and the role-PUT guard** in `admin/routes.ts`. One SQL for the list: users `u` LEFT JOIN employees `e ON e.id = u.employee_id` LEFT JOIN org_units `d ON d.id = e.district_id`, roles via `user_roles`/`roles` aggregated with `array_agg`; then one query each for `role_permissions`, `role_module_visibility` (for the roles on the page) and `user_module_visibility` (for the user ids on the page); resolve per row with `resolveModuleVisibility`.
- [ ] **Step 6: Run** the file — Expected: all pass. Run `npm run lint --workspace=apps/api`.
- [ ] **Step 7: Commit** `feat(api): employees view and bulk update for module visibility`.

---

### Task 3: Web shell and landing honour visibility

**Files:**
- Modify: `apps/web/components/AuthProvider.tsx:24-30` (`modules?: Record<string, boolean>` on `Session`), `apps/web/lib/apiClient.ts:594-606` (same on the `/me` response type)
- Modify: `apps/web/lib/landing.ts` (new `moduleVisible` + `visibleNavItems`; `landingRoute` takes the session), `apps/web/components/AppShell.tsx:129-132`
- Test: `apps/web/tests/rbac-navigation.test.ts` (extend), `apps/web/tests/module-catalog.test.ts` (unchanged, must stay green)

**Interfaces:**
- Produces, in `apps/web/lib/landing.ts`:
  ```ts
  export type NavSession = { permissions: string[] | undefined; modules?: Record<string, boolean> };
  /** Hidden only when the session's module map says false; absent map or absent code = visible. */
  export function moduleVisible(modules: Record<string, boolean> | undefined, item: NavItem): boolean;
  export function navItemShown(session: NavSession, item: NavItem): boolean; // navItemVisible && moduleVisible, except hrefs '/security' and '/configuration' which skip the module check
  export function landingRoute(session: NavSession): string;                 // first navItemShown destination, else '/security'
  ```
  `canOpen`/`destination` unchanged. The item→code link is `MODULE_CATALOG_BY_CODE` via the catalog index: nav order equals catalog order (lock-step test), so `codeForItem(item)` = `MODULE_CATALOG[navIndex].code`; expose `navItemCode(href): string | undefined` in `landing.ts`.
- `landingRoute` callers (grep `landingRoute(`) pass `session` instead of `session.permissions`.

- [ ] **Step 1: Write the failing web tests** in `tests/rbac-navigation.test.ts`:
  - "hides a module the session's map switches off even when the permission is held" — `navItemShown({permissions:['task.read'], modules:{'my-work':false}}, myWorkItem)` false; with `modules:{}` true; with `modules: undefined` true.
  - "never hides Security or Configuration by the map" — `modules:{security:false, configuration:false}` ⇒ both shown (configuration also needs `admin.configure`).
  - "lands on the first module the person will actually see" — permissions for dashboard+my-work, `modules:{dashboard:false}` ⇒ `landingRoute` is `/my-work`.
  - "canOpen ignores the map" — `canOpen(['task.read'], '/my-work')` true regardless of modules.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run tests/rbac-navigation.test.ts` — Expected: FAIL (`navItemShown` undefined).
- [ ] **Step 3: Implement `moduleVisible`, `navItemShown`, `navItemCode`, new `landingRoute`** in `landing.ts`; add `modules` to the web `Session`/me types; in `AppShell.tsx` replace `navItemVisible(session.permissions, item)` with `navItemShown(session, item)`; update every `landingRoute(` caller.
- [ ] **Step 4: Run** `cd apps/web && npm run lint && npx vitest run` — Expected: tsc + eslint clean, all tests pass (992 + new).
- [ ] **Step 5: Commit** `feat(web): navigation and landing honour module visibility`.

---

### Task 4: `/configuration` page — Roles and Employees tabs

**Files:**
- Create: `apps/web/app/configuration/page.tsx` (tabs: Roles → `<ModuleVisibility/>`; Employees → `<EmployeeModuleVisibility/>`), wrapped in the app's page gate the other admin pages use (`RequireDestination`/`Can` for `admin.configure`).
- Create: `apps/web/components/EmployeeModuleVisibility.tsx` (filter bar, table, row editor, bulk editor)
- Create: `apps/web/components/ModuleVisibilityEditor.tsx` (three-state control per module: Show / Hide / Follow role; used by both single and bulk edit; emits `changes: {module_code, visible: boolean|null}[]`)
- Modify: `apps/web/app/admin/page.tsx:5` (replace the mounted `<ModuleVisibility/>` with a `Link` to `/configuration`)
- Test: `apps/web/tests/module-visibility-editor.test.ts` (pure helper), `apps/web/tests-dom/employee-module-visibility.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/v1/admin/module-visibility/users` (Task 2 shapes), `userModuleVisibilityUpdateSchema` for the PUT body, `MODULE_CATALOG` for columns.
- Produces: pure helper in `ModuleVisibilityEditor.tsx`: `export function editorChanges(state: Record<string, 'show'|'hide'|'follow'|'mixed'>): Array<{module_code: string; visible: boolean | null}>` — `'mixed'` (bulk, selection disagrees) emits nothing for that module; `'follow'` emits `null`.

- [ ] **Step 1: Write the failing helper test** `tests/module-visibility-editor.test.ts`: `editorChanges({ 'my-work':'hide', inbox:'follow', projects:'mixed', reports:'show' })` ⇒ `[{module_code:'my-work', visible:false},{module_code:'inbox', visible:null},{module_code:'reports', visible:true}]` (order of input keys).
- [ ] **Step 2: Run** — Expected: FAIL. Implement; run — Expected: pass.
- [ ] **Step 3: Write the failing DOM test** `tests-dom/employee-module-visibility.test.tsx`, mocking `apiRequestRaw`/`apiRequest` as `tests-dom/*` already do (see `approval-policies.test.tsx` for the fetch-stub pattern):
  - "shows one row per login with the resolved state and marks person overrides" — two rows from a stubbed GET; the cell for a `source:'user'` module carries the text "person" (badge) and a `source:'role'` cell does not.
  - "bulk update sends exactly the selected ids and null for follow-role" — select rows 1 and 2 via their checkboxes, open Bulk update, set `my-work` to Hide and `inbox` to Follow role, submit ⇒ the PUT body equals `{ user_ids:[id1,id2], changes:[{module_code:'my-work',visible:false},{module_code:'inbox',visible:null}] }`.
  - "filter changes refetch with the query string" — choosing role `HR_MANAGER` and typing `q` ⇒ GET url contains `role_code=HR_MANAGER` and `q=`.
- [ ] **Step 4: Run** — Expected: FAIL (component missing).
- [ ] **Step 5: Build the components and page** with `Panel`/`Collection`/`MutationForm` from `components/v2`, `NativeSelect`, `Badge`, `Button`, `useToast`, `messageOf` as `ModuleVisibility.tsx` uses them; filters: role (from the roles GET already used by the Roles tab), district (`/api/v1/org-units?type=DISTRICT` or the picker the employees page uses — reuse it), status (`ACTIVE|SUSPENDED|EXITED|DRAFT|ALL`), search; "Load more" for `next_cursor`; selection state is a `Set<user_id>` cleared when filters change; the bulk editor is disabled with zero selected.
- [ ] **Step 6: Run** `cd apps/web && npm run lint && npx vitest run` — Expected: clean and green. `npm run build --workspace=apps/web` — Expected: `.next-verify/configuration.html` exists.
- [ ] **Step 7: Commit** `feat(web): configuration page with role matrix and per-employee visibility`.

---

### Task 5: Docs, gate, hand-off

**Files:**
- Modify: `docs/DEV_PLAN.md` (decision 2026-10-30: visibility per role and per employee; precedence; still not a permission), `docs/V2_COMPLETION.md` (one line under the admin section), `docs/SILVERLINE_BUSINESS_TEST_CATALOGUE.md` only if `npm run catalogue` reports the new test IDs are expected there (follow its output).

- [ ] **Step 1: Full gate** from the repo root with only `TEST_DATABASE_URL` exported: `npm run lint && npm test && npm run build && npm run catalogue && npm audit --omit=dev --audit-level=critical` — Expected: all green.
- [ ] **Step 2: Docs** as above; commit `docs: module visibility per employee (decision 2026-10-30)`.
- [ ] **Step 3: Hand-off** — the branch stays unmerged until the owner says so (their instruction 2026-10-30); the production migration `119` must be applied before that deploy (`DATABASE_URL=<prod> npx tsx src/database/migrate.ts` from `apps/api`).
