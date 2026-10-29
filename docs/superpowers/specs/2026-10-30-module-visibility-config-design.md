# Admin-managed module and tab visibility — design

**Owner ask (2026-10-30):** "Add a configuration module where admin can set the
visibility of the tabs/modules for each employee/role. Mostly by role, but should
be able to manage at employee level as well; add filter and option to bulk
edit/update."

## Intent

An administrator decides which modules each person sees in the web navigation,
the mobile bottom tabs and the mobile More screen. Roles carry the defaults;
individual employees can be adjusted, singly or in bulk. The people doing field
work should see only what they need; office roles should not have to scroll
past screens they never open.

## What exists today (build on it, do not duplicate)

- `MODULE_CATALOG` (`packages/shared/src/modules.ts`): the one list of modules,
  each with a `code`, label, group and the permission it is named after.
  Mobile bottom tabs map to module codes (`TAB_MODULE_CODES`); the More screen
  is built from the catalog (`apps/mobile/src/modulesLauncher.ts`).
- Role-level visibility: table `role_module_visibility (org_id, role_code,
  module_code, visible)` (migration 090); `GET/PUT /api/v1/admin/module-visibility`
  (`apps/api/src/modules/admin/routes.ts`, guard `admin.configure`); the sign-in
  response (`/api/v1/auth/me`) carries `modules: Record<code, boolean>` computed
  as: a role override wins, else "visible iff the role holds the module's
  permission (and `requires`/`anyOf`)", OR-ed across the user's roles. A super
  administrator (`mfaFloorRole`) can never be hidden (`ROLE_MUST_SEE_ALL`).
- Web admin component `apps/web/components/ModuleVisibility.tsx` (role × module
  matrix) mounted on `/admin`.
- Mobile honours `me.modules` for tabs and More. **Web does not**: `AppShell`
  filters `NAV_GROUPS` with `navItemVisible(session.permissions, item)` only
  (`apps/web/lib/landing.ts:11`). This is a defect in the existing feature.
- Invariant: `MODULE_VISIBILITY_IS_NOT_A_PERMISSION` — visibility changes only
  what clients render; every route keeps its permission and scope checks.

## Goals

1. Employee-level overrides on top of role visibility, with precedence
   employee override > role override > permission default.
2. A Configuration screen with two views — Roles (the existing matrix) and
   Employees (filterable list, per-person editing, bulk apply).
3. Both clients honour the resulting map: fix the web navigation gap.
4. Nothing about access changes: hiding is cosmetic; permissions remain the guard.

## Non-goals

- Per-screen or per-field visibility inside a module.
- Reordering or renaming modules; new modules.
- Changing what a role is *permitted* to do (that is the roles screen).
- Hiding anything from a super administrator.

## Anti-goals (a failure even if it "works")

- A hidden module becoming inaccessible to someone who holds the permission
  (visibility leaking into authorisation), or the reverse: a "show" switch
  granting a screen the person's role cannot use.
- An admin locking *themselves* out of Configuration.
- Bulk update applying to people outside the filter the admin was looking at.
- Cross-organisation reads or writes.

## Decisions taken

### Data

- New table `user_module_visibility (org_id uuid, user_id uuid → users, module_code
  varchar(64), visible boolean NOT NULL, updated_at, updated_by, PRIMARY KEY
  (org_id, user_id, module_code))`, mirroring `role_module_visibility`. Keyed by
  **user** (the thing that signs in). The link is `users.employee_id` (nullable):
  the Employees view is rooted on **users of the organisation**, with the employee's
  number, name, designation and district joined when there is one. Accounts with
  no employee record (the seeded `admin`, any login created without a linked
  employee) still appear, labelled "no employee record", and are editable —
  they sign in too. Employees without a login do not appear: there is nothing to
  show them.
- No row = defer to the role result. A row is an explicit show or hide.
- Migration numbered after the current latest (118 → 119), registered in
  `src/database/migrate.ts`, added to `test/tables.ts`.

### Resolution (one function, shared by `/auth/me` and the admin screen)

For a user and module: if a user row exists → its value; else the existing
role-level result (role override OR permission default, OR-ed across roles).
Super administrators: always visible, and a user-level hide for one is refused
with the existing `ROLE_MUST_SEE_ALL` code. The `configuration` module can never
be hidden — at role or user level — for anyone holding `admin.configure`
(ordinary ADMIN is not a floor role), so an administrator cannot lock themselves
out of the screen that undoes a mistake. Modules the user has no permission
for are reported as not visible regardless of rows (the client will not render
them; the API would refuse the routes anyway).

### API (all under `admin.configure`, organisation-scoped, audited through `mutate`)

- `GET /api/v1/admin/module-visibility` — unchanged (roles view).
- `GET /api/v1/admin/module-visibility/users?role_code=&district_id=&status=&q=&cursor=&limit=` —
  pages of the organisation's users: `user_id, username, employee_id, emp_no, name,
  designation, district, roles[], employee_status`, plus `modules: {code: {visible,
  source: 'user'|'role'|'default'}}`. Filters: `role_code` (any of the user's
  roles), `district_id` (the employee's district, as the employee list already
  filters), `status` (employee status, `ACTIVE` by default; `ALL` to include
  exited people and accounts with no employee record), `q` (name, username or
  employee number). There is no project filter: the system has no general
  project-membership table, and a filter that only worked for survey staff would
  mislead. Paging follows the shared `cursorPageQuerySchema` (max 100 per page).
- `PUT /api/v1/admin/module-visibility/users` — body `{ user_ids: uuid[] (1..500),
  changes: [{ module_code, visible: boolean | null }] (1..catalog size) }`. `null`
  clears the user row (back to role). Validates every module code against
  `MODULE_CODES`, every user against the org, refuses hides for super
  administrators, and writes in one transaction. Returns the count of users
  updated. Single-employee edits use the same route with one id. One audit event
  (`admin.user_module_visibility`) per call carrying the ids and changes.
- `GET /api/v1/auth/me` — `modules` now includes user rows in the resolution.
  Shape unchanged, so mobile needs no change.

### Web

- New page `/configuration` (nav group "Administration", permission
  `admin.configure`) with two tabs: **Roles** (move `ModuleVisibility.tsx` here,
  keep it on `/admin` as a link only) and **Employees**.
- Employees tab: filter bar (role, unit, designation, status, project, search);
  table with one row per employee and one column per module showing the
  resolved state and its source (role/default vs person override marked);
  row click opens an editor with a three-state control per module (show,
  hide, follow role); header checkboxes select rows; "Bulk update" opens the
  same three-state editor applied to all selected rows; selection is limited to
  the rows currently loaded under the filter, never "everything matching".
- Built with the shared `Workbench`/`Panel`/`Collection` primitives, as the
  repo convention requires.
- `AppShell` filters nav items by `session.modules[code]` **and** the existing
  permission check (the `code` comes from `MODULE_CATALOG`; nav items gain a
  `module` field or are matched by href as today in `landing.ts`). `/security`
  and `/configuration` (for admins) are never hidden. The web `Session` type gains
  the `modules` field the API already sends.
- `landingRoute` (where a fresh sign-in lands) skips hidden modules too, so nobody
  lands on a page their navigation does not show. `canOpen`/`RequireDestination`
  are **not** changed: a bookmarked or deep-linked hidden page still opens for
  someone who holds the permission. That is the "hiding is cosmetic" rule applied
  to the client, and the test asserts it in that direction.

### Mobile

- No change in behaviour: it already reads `me.modules`. The new `configuration`
  catalog code is added to `WEB_ONLY_CODES` in `modulesLauncher.ts` (one line, as
  the nav↔catalog lock-step test requires every catalog entry to be accounted
  for); the More screen does not list it. No external-link row is built.

### Tests (regression first)

- API: resolution precedence (user > role > default; super admin unhideable;
  no-permission stays hidden); the bulk route (filter → selection → apply;
  cross-org user refused; invalid module 404; 500-id cap); `/auth/me` reflects a
  user row; the existing invariant test still passes (hidden ≠ forbidden).
- Web: `AppShell` hides a nav item whose module is false in `session.modules`
  even when the permission is held; the Employees tab's three-state editor
  sends `null` for "follow role"; bulk update sends exactly the selected ids.
- Shared: resolution helper unit tests if the function lives in shared.

## Constraints

- One shared schema for the PUT body in `packages/shared` (API validates, web
  form uses it); no raw permission codes in UI text (`permissionLabels`).
- Record scope is not a concern here: the screen is `admin.configure` only.
- No new dependencies. Works on the static web export (`/record`-style
  deep links not needed).
- Audit rows for every write; PII never in logs.

## Left to the builder

- Exact column layout and whether modules are grouped under their catalog
  group headings in the employee table.
- Page size for the employee list (the existing cursor paging default).
- Whether the resolution helper lives in `packages/shared` or `apps/api/src/common`.
- Loading/empty/error states, following the shared components.

## Calls I made (for the owner to check)

- Visibility is stored per **user** and shown per employee; employees with no
  login are listed read-only.
- Precedence: person beats role; "follow role" clears the person's row.
- Bulk update works on the rows selected under the current filter, capped at
  500 per call, never on "all matching".
- Fixing the web navigation to honour visibility is in scope, since the owner's
  ask presumes the setting applies to what users see on both clients.
- The Employees view lists every login of the organisation, including the few
  admin accounts with no employee record; employees who never had a login are not
  listed.
- Filters are role, district, employee status and search. No project or
  designation filter: there is no general project membership to filter on, and
  designation can be found with search.
- Sign-in landing skips hidden modules; direct links to hidden pages still open.
