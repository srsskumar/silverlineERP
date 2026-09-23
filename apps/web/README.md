# Silverline Web (`apps/web`) — S6

Next.js 14 (App Router) + React 18 + Tailwind v3 + TanStack Query + React Hook Form + Zod.
Static export served from Cloudflare Pages; the API (`apps/api`) is a separate service.

## Prerequisites

- Node 20+, npm 11 (repo uses npm workspaces; dependencies are installed at the repo root).
- Do **not** run `npm install` / `create-next-app` / `next lint` in this package (no network
  installs, no interactive scaffolding) — another agent owns `packages/shared` + `apps/api`.

## Develop

```bash
# from apps/web
npx next dev        # dev server (default http://localhost:3000)
```

Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL` (defaults to
`http://localhost:3001` when unset).

## Verify (run from `apps/web`)

```bash
npx tsc --noEmit
npx vitest run
npx next build     # must succeed; emits static site to out/
```

## Static-export constraints (Cloudflare Pages — do not break)

- `next.config.js` keeps `output: 'export'` and `images: { unoptimized: true }`.
- No `middleware.ts`, no route handlers (`app/api/*`), no server-side auth — auth is
  client-side only (`components/AuthProvider.tsx` + `lib/apiClient.ts`, tokens in memory with
  a `localStorage` fallback).
- Every page is a client component (`'use client'`); routes that must prerender statically
  export `const dynamic = 'force-static'`. Avoid `useSearchParams` without a Suspense boundary.

## Routes (S0 + S1)

| Route               | Purpose                                              | Permission |
|---------------------|------------------------------------------------------|------------|
| `/login`            | RHF+Zod sign-in; inline errors; lockout notice; MFA redirect | — |
| `/mfa`              | 6-digit TOTP verification                            | — |
| `/dashboard`        | S6 role-template widgets (see S6 routes below; S0 placeholder removed) | auth-only (templates role-gated, 403 inline) |
| `/employees`        | Directory table (masked PII + last4), search/status/district filters, cursor Load more | `employee.read` |
| `/employees/new`    | Create form → detail on success                      | `employee.create` |
| `/employees/[id]`   | Detail card + edit form (If-Match) + documents + exit/reactivate | `employee.read` (+ `employee.update`/`employee.exit`/`employee.reactivate`/`document.upload` for actions) |
| `/employees/import` | CSV file/textarea → preview count → submit → per-row report | `employee.import` |
| `/org/locations`    | district\|mandal\|village\|site tabs, table + create + deactivate | `org.units.read` (+ `org.units.manage` for writes) |
| `/org/holidays`     | Year filter + table + create dialog                  | `holiday.read` (+ `holiday.manage` for writes) |
| `/403`              | Forbidden panel (also used by `RequirePermission`)   | — |
| `/attendance`         | Date-range + status filters, records table (hours + badges), punch map, Load more, collapsible manual PunchPanel | `attendance.read` (punch needs `attendance.punch`) |
| `/attendance/exceptions` | Lookup record by employee+date → file exception / regularize / decide on known exception ids | `attendance.read` (decide needs `attendance.decide`) |
| `/attendance/records/[id]` | Detail: times, hours, events timeline, file-exception + decide entry points | `attendance.read` (+ `attendance.decide`) |
| `/leave`              | Tabs Mine \| Approvals (gated `leave.decide`) \| All (gated `leave.read`), status filter, table + Load more | `leave.request` |
| `/leave/new`          | File form (type + range + reason) → detail on success; idempotent replay → detail with "already filed" notice | `leave.request` |
| `/leave/[id]`         | Header facts + approval chain + DecisionButtons (current approver only) + CancelButton (own PENDING only) | `leave.request` |
| `/leave/balances`     | Year selector + manual employee input + "My balances" (`/employees/me`); admin adjust dialog | `leave.request` (+ `leave.admin` for adjust) |
| `/projects`           | Workspace + status + search filters, table (code/name/status/priority), create link; counts live on detail only | `project.read` (workspace filter needs `workspace.read`; create link needs `project.create`) |
| `/projects/new`       | Create form (workspace + type selects, PM user-UUID optional, dates) → detail on success (starts DRAFT) | `project.create` |
| `/projects/[id]`      | Header facts + counts cards (total/open/done) + PATCH status (If-Match) + close dialog + task list (FilterBar: status/q/assignee-me/labels/sla + saved-filter save/apply, SLA + label columns, QuickAddBar, links to task pages) + Board view link | `project.read` (+ `project.update`/`project.close`/`task.create` for actions) |
| `/projects/[id]/board` | Board selector (default first) + KanbanBoard (DnD across columns → status endpoint; reorder → board-position; WIP badges; 100/column cap + Load more) + "Manage columns" dialog (`board.manage`: rename/WIP/color, add/remove workflow statuses, PUT columns + If-Match, 409 → ConflictDialog) + "New board" dialog + delete | `board.read` (+ `board.manage` for writes) |
| `/projects/[id]/tasks/[taskId]` | Facts + SLA badge + labels row + WorkflowStepper + transition select + assign dialog + edit fields + TaskLabelToggle (attach/detach) + subtasks (+ new-subtask quick-add) + dependencies + evidence + comments | `task.read` (+ `task.transition`/`task.assign`/`task.update`/`task.create`/`task.comment` for actions) |
| `/inbox` | InboxList (type glyph + entity link, mark-read button, read-all, unread-only filter, cursor Load more, polls every 60s) | auth-only |
| `/my-work` | S5 assigned/overdue slices + S6 summary counts + Pending approvals (leave list → `/leave/:id`, exceptions count → `/attendance/exceptions`) + unread-inbox card | `task.read` |
| `/dashboard` | S6 role-template selector (session roles UPPER→lower) + WidgetGrid + scope_note banner + "updated Xs ago" + Refresh; at-a-glance my-work summary | auth-only (templates role-gated, 403 inline) |
| `/reports` | Type-only CSV export (format fixed csv, no filters) → result card (rows + Download) | `report.generate` + per-type read perm |

Plus `not-found.tsx` (404) and `error.tsx` (global error boundary).

Note: `/admin/roles` intentionally skipped in S1 — there is no roles endpoint in
the S0/S1 contract, so a live matrix is impossible. S2 will render it from the
server (`GET /api/v1/roles` or equivalent). Local S1 permission codes live in
`lib/permissions.ts` (`PERMISSIONS` + `hasAnyPermission`/`hasAllPermissions`).

## API contract assumed (built in parallel — verify against `apps/api` when it lands)

- `POST /api/v1/auth/login` `{username,password}` → `200 {access_token, refresh_token, mfa_required?}` / `401 {code,message,...}`
- `POST /api/v1/auth/refresh` `{refresh_token}` → new token pair
- `POST /api/v1/auth/mfa/verify` `{token}` → token pair
- `GET /api/v1/auth/me` → `{user, roles[], permissions[]}`
- `GET /api/v1/audit` → audit events (S1+ UI)
- Error envelope: `{code, message, field_errors[], request_id, retryable}`
- Lockout signal: error `code` `ACCOUNT_LOCKED` (or `TOO_MANY_ATTEMPTS`) on login.
- `Idempotency-Key` (`crypto.randomUUID()`) is attached to all POST/PATCH/PUT/DELETE requests.

## S1 contract assumed (frozen — backend implements the same; verify when it lands)

- `GET /api/v1/org/units?type=&parent_id=&q=&limit=&cursor=` → `{data:[{id,type,code,name,parent_id,status,version}],next_cursor,has_more}`
- `POST /api/v1/org/units` `{type,code,name,parent_id?}` → 201; `GET /:id`; `PATCH {name?,status?}` + `If-Match: version` → 409 on stale
- `GET /api/v1/employees?status=&district_id=&q=&limit=&cursor=` → masked list; `POST /employees {...}` → 201; `GET /:id`; `PATCH` + `If-Match`; `POST /:id/exit {exit_date,reason}`; `POST /:id/reactivate {reason}`; `POST /employees/bulk-import {rows}` → `{imported,failed,errors:[{index,emp_no?,errors[]}]}`; `GET /employees/me`
- `GET+POST /api/v1/employees/:id/documents` (`POST {doc_type,file_name,content_base64}` → `{id,checksum,...}`)
- `GET+POST /api/v1/holidays?year=` (`{date,name,type,scope_type?,scope_id?}`)
- Masked PII: `aadhaar/pan/bank_account/phonepe_number/salary_basic` are null without permission; `*_last4` strings present. Web renders full value when present, `•••• last4` when masked, `—` when absent (`lib/masking.ts`).
- 422 → `field_errors[]` mapped onto RHF fields via `setError` (`lib/form-errors.ts`); 409 version conflicts open `ConflictDialog` with a Reload button.
- Permission codes (dot-style): `org.units.read/manage`, `employee.read/create/update/exit/reactivate/import`, `document.read/upload`, `holiday.read/manage` (see `lib/permissions.ts`; legacy S0 colon codes retained for the dashboard shell).
- Contract assumptions/risks: exact employee field nullability, document-list envelope shape (`[]` vs `{data:[]}` — client tolerates both), holiday `type` vocabulary (free text in UI), and backend timing (endpoints may 404 until the API agent lands — pages surface the error with request ID rather than crashing).

## S2 contract assumed (frozen — backend implements the same; verify when it lands)

- No geo-fencing (decision 2026-09-22): there is no `/geo-fences` screen or endpoint. A punch is accepted with or without a position; the position, when the browser grants it, is stored and shown on the record and the punch map. `GET /api/v1/geo/search?q=` (place lookup, `attendance.read`) is kept in `lib/geo.ts`.
- `POST /api/v1/attendance/events` + REQUIRED `Idempotency-Key` → **201** `{event,record,decision:"ACCEPTED"}` (fresh punch) | **200** `{applied:true,event,record}` (same-key replay — no double count) | **202** `{review:"REQUIRES_REVIEW",code,exception_id,message}` (routed to review; UI shows the code + exception id and the id can be tracked on the exceptions page) | **422** envelope (`EMPLOYEE_INACTIVE`/`FUTURE_PUNCH`/`CHECKOUT_WITHOUT_CHECKIN`/`DUPLICATE_CHECKIN`/`RECORD_CLOSED`/`MISSING_IDEMPOTENCY_KEY`, surfaced inline with the code). The client normalizes by presence of the `decision`/`applied`/`review` keys (`normalizePunchResponse` in `lib/attendance.ts`); `punchEvent` always sends an explicit key (generated per attempt) so retries are safe.
- `GET /api/v1/attendance/records?employee_id=&from=&to=&status=&limit=&cursor=` → cursor page (`{data,next_cursor,has_more}`; bare arrays tolerated); `GET /:id` → record + `events[]` (`normalizeRecordDetail` tolerates `{record,events}`, `{data:{record,events}}` and flat shapes). Status vocabulary `PRESENT|PARTIAL|ABSENT` with a neutral fallback badge for unknowns.
- `POST /api/v1/attendance/exceptions` → 201; `PATCH /:id/decision {decision:APPROVE|REJECT,note?}` + `If-Match` → 200 single transition (409 → `ConflictDialog` + reload).
- `POST /api/v1/attendance/regularize` → 201 (filed exception id feeds the decide queue).
- Permission codes: `attendance.punch/read/decide` (`lib/permissions.ts`).
- **Known S2 gap — no exceptions list endpoint.** The contract has no `GET /attendance/exceptions`, so `/attendance/exceptions` cannot render a server-side queue. It instead works from *known* ids: ids returned by file/regularize actions, `exception_id` from 202 punch responses, or manually pasted ids (+ version for `If-Match`). Triage starts from `/attendance`, linking through to the record detail. A list endpoint is an S3 backend gap — do NOT invent client-side polling of guessed URLs.

## S3 contract assumed (frozen — backend implements the same; verify when it lands)

- `GET /api/v1/leave/types` → `{data:[{id,code,name,is_paid,annual_entitlement,requires_balance}]}`. Codes: `CL`/`SL`/`EL` paid, `LOP` unpaid (no balance check — UI shows "unpaid", never a balance).
- `GET /api/v1/leave/balances?employee_id=&period_year=` → `{data:[{id,employee_id,leave_type_id,leave_code,period_year,opening_balance,credits,consumed,adjustments,current_balance}]}`.
- `POST /api/v1/leave/balances` `{employee_id,leave_type_id,period_year,opening_balance}` → upsert (`leave.admin`).
- `POST /api/v1/leave/requests` `{leave_type_id,from_date,to_date,reason?}` → **201** bare `{id,…,total_days,status,current_approver_id,version}` (fresh) | **200** `{applied:true,request}` (same-key replay — UI navigates to the detail with an "already filed" notice) | **422** envelope (`DATE_RANGE`/`REASON_REQUIRED`/`INSUFFICIENT_BALANCE{available}`/`LEAVE_OVERLAP`/`ATTENDANCE_CONFLICT{conflicting_dates}`/`NO_APPROVER`, each surfaced as a targeted banner). `total_days` is inclusive and server-computed; the form shows a live client-side preview (`inclusiveDays` in `lib/leave.ts`).
- `GET /api/v1/leave/requests?status=&mine=&approver_me=&employee_id=&limit=&cursor=` → cursor page (`{data,next_cursor,has_more}`; bare arrays tolerated). Views map as Mine → `mine=true`, Approvals → `approver_me=true`, All → `employee_id=` passthrough (`buildLeaveListParams`). Statuses `PENDING|APPROVED|REJECTED|CANCELLED` with a neutral fallback badge.
- `GET /api/v1/leave/requests/:id` → bare request + `approval_chain [{step,approver_user_id,status,decided_at,note}]`.
- `POST /api/v1/leave/requests/:id/decision` `{decision:APPROVE|REJECT,note?}` + `If-Match` → 200; `NOT_APPROVER` 403 / `REQUEST_CLOSED` 422 / `NOTE_REQUIRED` 422 on reject / 409 version (opens `ConflictDialog`).
- `POST /api/v1/leave/requests/:id/cancel` `{reason?}` → 200 (own `PENDING` only).
- Permission codes: `leave.request/decide/read/admin` (`lib/permissions.ts`).
- Chain semantics: each approval step records one approver's transition; the request stays `PENDING` with `current_approver_id` pointing at the next approver until the chain resolves to `APPROVED`/`REJECTED` (or the requester `CANCEL`s while pending).
- **No approver names:** the detail endpoint returns approver *user ids* only — there is no users endpoint in the contract, so the timeline and header show short user ids (full id in tooltip) and never invent names.
- Extra error fields (`available`, `conflicting_dates`, `conflicting_ids`) ride on `ApiClientError.details` (`lib/apiClient.ts` preserves non-envelope keys); parsed by `parseInsufficientBalance` / `parseOverlapIds` / `parseAttendanceConflictDates`.
- Balances page has no employee-search endpoint: it accepts a manual employee ID plus a "My balances" shortcut via `GET /employees/me`.
- Contract assumptions/risks: `mine`/`approver_me` flag values (`true` assumed — verify against the API), cursor pagination through the shared `apiClient` envelope unwrap (same tolerance pattern as S1/S2 lists), and "mine" identity on the detail page (request `employee_id` matched against `/employees/me` id with a session-user-id fallback).

## S4 contract assumed (frozen — backend implements the same; verify when it lands)

- Workspaces: `POST /api/v1/workspaces` `{name,description?}` → 201 bare; `GET /api/v1/workspaces` → `{data:[{id,name,description,status}]}`; `GET /:id`. Perms `workspace.read/manage` (`lib/projects.ts`, `lib/query-keys.ts` `workspaces`).
- `GET /api/v1/project-types` → `{data:[{id,code,name,workflow:{statuses[],allowed_transitions{}}}]}` (`lib/query-keys.ts` `projectTypes`). The project detail's `workflow` object is rendered as counts + status control only — no client-side transition matrix is hardcoded; the server owns it.
- Projects: `POST /api/v1/projects` `{workspace_id,code,name,project_type_id?,description?,project_manager_id?,planned_*?,priority?}` → 201 DRAFT; `GET /projects?status=&workspace_id=&q=`; `GET /:id` → `{project,workflow,counts:{total,open,done}}` (flat shapes tolerated); `PATCH` + `If-Match` (status rule server-side; 409 opens `ConflictDialog`); `POST /:id/close {reason?}` → 200 | 422 `PROJECT_HAS_OPEN_TASKS` `{open_count}` (parsed by `parseProjectOpenTasks`, shown inline in `CloseProjectDialog`). Perms `project.create/read/update/close`.
- Tasks: `POST /api/v1/tasks` `{project_id,title,…}` (title-only ok) → 201 `TO_DO`; `GET /tasks?project_id=&assignee_id=&assignee_me=&status=&q=`; `GET /:id` → `{task,subtasks[],dependencies:{blocked_by,blocking},allowed_next[]}`; `PATCH` fields (no status) + `If-Match`; `PATCH /:id/status {status}` → 200 | 422 `INVALID_TRANSITION` `{allowed_next}` / `SUBTASKS_OPEN` / `DEPENDENCY_BLOCKED` `{blocking}` / `USE_STATUS_ENDPOINT`; `POST /:id/assign {assignee_id,reason}` (reason required); dependencies add/remove; evidence upload+list (`{evidence_type,file_name,content_base64}`, 5MB client check + extension allowlist); comments add+list (`{body}` → `{comment,mentioned_usernames[]}`). Task statuses `TO_DO/IN_PROGRESS/IN_REVIEW/DONE/BLOCKED/CANCELLED` (terminal `DONE`/`CANCELLED`); project statuses `DRAFT/ACTIVE/ON_HOLD/COMPLETED_PENDING_CLOSE/CLOSED/CANCELLED` (terminal `CLOSED`/`CANCELLED`). Perms `task.create/read/update/transition/assign/comment` (+ unused `task.reorder`). `PATCH /:id/board-position` is NOT in web S4 (S5).
- List responses tolerate `{data:[]}` and bare arrays; singles tolerate `{data:{…}}` and bare (`normalizeTasksPage`, `normalizeTaskDetail`, `normalizeProjectsPage`, `normalizeProjectDetail`).
- **No users directory (S4 gap).** There is no users endpoint, so assignee / project-manager / approver inputs are plain user-ID (UUID) text fields with UUID-shape validation and helper text ("paste the user ID"). The UI shows short ids with full ids in tooltips and never invents names (same stance as S3 approvers). A users directory/search endpoint is an S5 backend gap — do NOT invent client-side calls to guessed URLs.
- **Override deferred.** `USE_STATUS_ENDPOINT` means the transition needs a privileged override; the override flow is NOT in web S4 — the UI shows "ask your PM to apply the override via the API".
- My Work dashboard is skipped in S4 (needs S6 dashboards) — no placeholder link in the shell.
- Contract assumptions/risks: subtask creation field name (`parent_id` assumed — verify against the API), project `planned_*` field names (`planned_start_date`/`planned_end_date` assumed), dependency edge object layout (lists render id/title/status defensively; removal prefers `edge.id`, see `dependencyEdgeKey`), evidence-list envelope shape (`[]` vs `{data:[]}` — client tolerates both), evidence `evidence_type` vocabulary (free text in UI), and backend timing (endpoints may 404 until the API agent lands — pages surface the error with request ID rather than crashing).

## S5 contract assumed (frozen — backend implements the same; verify when it lands)

- Boards: `POST /api/v1/boards` `{project_id,name,view_type:LIST|KANBAN,column_config?,filter_config?}` → 201 bare; `GET /boards?project_id=` → `{data:[...]}`; `GET /boards/:id` → `{board, columns:[{id,status_code,name,position,wip_limit,color}]}`; `PATCH` + `If-Match` (config only); `PUT /:id/columns {columns:[...]}` + `If-Match`; `DELETE` → 204. Perms `board.read/manage` (`lib/boards.ts`, `lib/query-keys.ts` `boards`/`board`).
- Saved filters (owner-private): `POST /saved-filters {project_id?,name,query_definition}` → 201; `GET /saved-filters?project_id=` → `{data: own (+shared)}`; `PATCH`/`DELETE` own. Perms `filter.read/manage` (`lib/filters.ts`).
- Labels: `POST /labels {project_id?,name,color?}` → 201 (409 `LABEL_EXISTS`); `GET /labels?project_id=` → `{data:[{id,name,color}]}`; `POST /tasks/:id/labels {label_id}` → 201; `DELETE /tasks/:id/labels/:labelId` → 204. Task list/detail items gain `labels:[{id,name,color}]` + `sla_status: ON_SCHEDULE|AT_RISK|OVERDUE`; `GET /tasks` gains `sla=overdue|at_risk|on_schedule` (lowercase) and `label_ids=` (comma-joined). Perms `label.read/manage` (`lib/labels.ts`, `lib/sla.ts`).
- Inbox: `GET /notifications?unread=&limit=&cursor=` → `{data:[{id,type,title,body,entity_type,entity_id,read_at,created_at}]}` (+ `next_cursor`/`has_more`); `PATCH /:id/read` → 200; `POST /notifications/read-all` → 200 `{marked}` (`lib/notifications.ts`).
- No other new endpoints. List/single envelope tolerance as before. Board config never mutates tasks (drag uses existing PATCH status + board-position endpoints).

### S5 saved-filter shape (web-defined, server stores opaque JSON)

`query_definition` is never interpreted by the server. Web shape (`lib/filters.ts` `SavedFilterQuery`):

```json
{ "status": "IN_PROGRESS", "q": "pump", "assignee_me": "true", "label_ids": ["l_1"], "sla": "overdue" }
```

- `labels` is accepted as a read-alias for `label_ids` (older clients); comma-joined strings (`"a,b"`) are split on read.
- Round-trip: `buildFilterQuery` → `filterQueryToDefinition` → `definitionToQuery` → `applySavedFilter` (task-list params). Covered by `tests/s5.test.ts`.

### S5 kanban DnD behavior + rollback

- Columns come from `board.columns` (position-sorted) else fall back to the project workflow statuses (`boardColumnsOrFallback`), so the board renders before any column config exists.
- Drag across columns → `PATCH /tasks/:id/status` (`transitionTask`) with an optimistic move; the pre-move `snapshotGroups` clone is restored on failure. `INVALID_TRANSITION` keeps the rollback, highlights the card (shake-back ring) and shows a toast with the allowed list (error `allowed_next`, else the detail prop).
- Reorder within a column → `PATCH /tasks/:id/board-position {position, board_id?, column_id?}` + `If-Match` (task version); 409 refetches authoritative order (`isConflictError` → invalidate). Other errors roll back to the snapshot.
- WIP badges are display-only (`n/limit`, warn at capacity via `isWipWarn`/`wipTone`) — drops are never blocked.
- Columns cap at 100 visible cards; further pages load via cursor (`limit=100` + "Load more tasks").
- Cards are memoized (`React.memo`).

### S5 inbox polling note

- The inbox page (`InboxList`) and the AppShell badge poll with `refetchInterval: 60_000`.
- The badge probes `GET /notifications?unread=true&limit=1` and shows a "•" dot when `data.length > 0 || has_more` (`unreadDotVisible`/`hasUnreadDot`) — never an exact count.
- Pagination siblings are read from the RAW envelope (`apiRequestRaw` in `lib/apiClient.ts`, additive — existing `apiRequest` behavior untouched) because the standard `{data:...}` unwrap discards `next_cursor`/`has_more`.
- Entity links: `LEAVE*` → `/leave/:id` directly (`inboxEntityHref`); `TASK` rows resolve the project via `getTask` to `/projects/:projectId/tasks/:taskId`.

### S5 assumptions/risks

- `PATCH /tasks/:id/board-position` body shape (`{position, board_id?, column_id?}` + `If-Match` version) is assumed — the frozen contract names the endpoint but not its payload. All usage is isolated in `patchTaskBoardPosition` (`lib/tasks.ts`) so a one-line fix realigns it.
- `PUT /boards/:id/columns` response shape (column list vs board detail) is tolerated both ways in `replaceBoardColumns`.
- Label attach/detach permission is not in the frozen contract — the toggle surfaces 403s inline rather than gating on a guessed code.
- Label `color` hex (`#RRGGBB`) is validated client-side (`labelSchema`); the server re-validates (409 `LABEL_EXISTS` shown inline in `LabelManager`).

## S6 contract assumed (frozen — backend implements the same; verify when it lands)

- `GET /api/v1/dashboards/role/:role` → `{template, generated_at, widgets:[{key,title,value,link?}]}` (+ optional `scope_note`).
  `:role` ∈ `super_admin|admin|hr_manager|project_manager|team_lead|employee|client_viewer|auditor`;
  the caller must hold the role (else 403 — surfaced inline on `/dashboard`, never a shell gate).
  Server caches each template 60s; `generated_at` drives the "updated Xs ago" label
  (`formatGeneratedAt` in `lib/dashboards.ts`). Client mirrors the cadence
  (`DASHBOARD_STALE_TIME 60s`, `DASHBOARD_GC_TIME 5min`).
- Template semantics (`lib/dashboards.ts`): session roles map UPPER→lower
  (`normalizeRole`); the selector lists held templates sorted by `ROLE_PRIORITY`
  (`super_admin,admin,hr_manager,project_manager,team_lead,employee,auditor,client_viewer` —
  `client_viewer` is last on purpose: most restricted, default only when nothing else is held);
  default = first held role (`selectDefaultTemplate`). `TEMPLATE_LABELS` maps role→label.
  `widgetTone(key)` colors cards (`overdue`→danger, `pct|percent|rate|utilization`→info,
  `open|pending|approval`→warning, `done|completed|approved|present`→success, else neutral).
  Invalid widget rows are skipped with a per-widget warning cell — one bad row never kills the grid.
- `GET /api/v1/dashboards/my-work` → `{assigned_open, assigned_overdue:[{id,title,project_id,planned_end_date}], pending_approvals:{leave:[{id,employee_id,from_date,to_date}], exceptions_count}, unread_count}`
  (`normalizeMyWork` tolerates envelope/bare + defaults missing keys; `getMyWork`).
  `/my-work` keeps the S5 task slices and adds the S6 summary counts, pending-approvals leave list
  (links → `/leave/:id`; exceptions count → `/attendance/exceptions`) and the unread-inbox card (→ `/inbox`).
- `POST /api/v1/reports` `{type:employees|attendance|tasks|leave, format:"csv", filters?}` → 201
  `{id,status,rows,download_url}`; `GET <download_url>` → csv file
  (`generateReport` + `downloadReportUrl(id)` → `` `${baseURL}${download_url}` `` absolute for
  `<a href download>` in `lib/reports.ts`). S6 UI is type-only + Generate → result card
  (rows count + Download); **filter support deferred** — `filters` is accepted by the client
  signature but the S6 form sends none.
- Report type→perm mapping (`REPORT_TYPE_META` / `reportTypePermission`): `employees`→`employee.read`,
  `attendance`→`attendance.read`, `tasks`→`task.read`, `leave`→`leave.read`. The `/reports` page gate
  is `report.generate`; each type option is additionally gated per-type (disabled + "needs …" label,
  403s surface inline). New permission codes: `dashboard.read`, `report.generate` (`lib/permissions.ts`);
  new query keys: `dashboard.dashboardRole(role)` (same family as `dashboard.role`), `dashboard.myWork()`,
  `reports.job(id)` (`lib/query-keys.ts`).
- Reports limits: capped at **5000 rows** (`REPORT_ROW_LIMIT`); the download registry is
  **in-memory** (links expire on API restart — re-generate after deploys/restarts).
- Perf/light pass (no new deps): `KanbanCard` was already `React.memo` (S5); S6 memoizes the
  my-work `TaskRow`. Dashboard queries use `staleTime 60s + gcTime 5min`; inbox poll stays 60s;
  images remain `unoptimized`.
- Contract assumptions/risks: exact widget `key` vocabulary (tones fall back to neutral on unknowns),
  `link` values are rendered as internal `next/link` hrefs (assumed app-relative — verify against the API),
  `generated_at` format (ISO assumed — unparseable renders "updated time unknown"), per-type report
  permissions (mapped to the closest read codes — verify against the API), and backend timing
  (endpoints may 404 until the API agent lands — pages surface the error with request ID rather than crashing).

## P1 payroll contract assumed (frozen — backend implements the same; verify when it lands)

Routes: `/payroll` (runs table + status filter + policy card; `payroll.read`),
`/payroll/new` (create; `payroll.generate`), `/payroll/[id]` (detail; `payroll.read`),
`/my-payslip` (own full slip; `payslip.read`). Policy lives as a card atop `/payroll`
(read + edit dialog gated `payroll.configure`) — no separate route. Shell group
`Payroll`: Runs (`payroll.read`), New Run (`payroll.generate`), My Payslip (`payslip.read`).

- `GET+PATCH /api/v1/payroll/policy` `{per_day_divisor, pf_pct}` (`lib/payroll.ts`
  `getPolicy`/`updatePolicy`; `payrollPolicySchema` enforces divisor 1..31 int, pf 0..100).
- `POST /api/v1/payroll/runs` `{period_start, period_end}` → 201 OPEN
  (`payrollPeriodSchema`: start ≤ end, inclusive span ≤ 62d `MAX_PAYROLL_PERIOD_DAYS`;
  `PERIOD_TOO_LONG` / `OVERLAPPING_RUN` 422s surface as targeted banners on `/payroll/new`).
- `GET /api/v1/payroll/runs?status=` → run rows (`normalizeRunsPage` tolerates
  `{data:[]}` and bare arrays); `GET /:id` → run + totals + warnings[]
  (`normalizeRunDetail` tolerates `{run,totals,warnings}` and flat shapes, enveloped or bare).
- State machine (no version / If-Match on transitions — the machine is the guard):
  `POST /:id/calculate` (OPEN → CALCULATED; `NO_ATTENDANCE_DATA` 422 banner),
  `POST /:id/submit-review` (→ REVIEW), `POST /:id/approve {note?}` (→ APPROVED),
  `POST /:id/lock` (→ LOCKED), `POST /:id/reopen {reason}` (LOCKED → APPROVED branch).
  Wrong-state → 422 `RUN_SEALED` whose message names the expected state
  (`parseRunSealedExpected` renders it inline). `nextAction(run)` in `lib/payroll.ts`
  maps each state to `{label, endpoint, perm}` (VALIDATING/unknown → null);
  buttons are perm-gated per action (`payroll.generate` / `payroll.approve` / `payroll.lock`),
  disabled with a "needs …" label when the session lacks the code.
  `RunTimeline` renders the OPEN → VALIDATING → CALCULATED → REVIEW → APPROVED → LOCKED
  stepper with the current step highlighted and the reopen-branch note.
- `GET /:id/payslips` → summary rows `{id,employee_id,emp_no,employee_name,gross,total_deductions,net_pay}`
  (`PayslipTable`; employee cell links to the directory entry).
- `GET /api/v1/payroll/payslips/me?period_start=&period_end=` → full slip
  (`normalizeMyPayslip`; 404 `NO_PAYSLIP` / `NO_EMPLOYEE_LINK` render empty states,
  not error cards). `PayslipPrint` renders earnings/deductions/gross/net with a
  `window.print()` button — **no PDF export in P1, use the browser print dialog
  (Save as PDF)**; print output hides chrome via `print:` Tailwind classes.
- Calc semantics are display-only: working_days = calendar days; COMPLETE = 1 /
  PARTIAL = 0.5; approved paid leave paid; absence/LOP-leave unpaid; pf% on gross.
  Money renders via `inr()` (en-IN, 2dp; "—" when absent).
- Permission codes: `payroll.read/generate/approve/lock/configure`, `payslip.read`
  (`lib/permissions.ts`); query keys: `payroll.policy/runs/run/payslips/myPayslip`
  (`lib/query-keys.ts`, default staleTime — the 60s dashboard cadence does not apply).
- **P1 gap — no admin full-slip endpoint.** The contract exposes full-slip detail
  only for the own slip (`/payslips/me`), so the run page shows summary columns
  and `/my-payslip` covers self-service. An admin "view anyone's full slip"
  endpoint is a P2 backend gap — do NOT invent client-side calls to guessed URLs.
- Contract assumptions/risks: `/api/v1` prefix + runs-list envelope shape
  (`{data:[]}` vs bare — client tolerates both; no cursor pagination assumed),
  warning object layout (`{code,message,employee_id?}` assumed — rows render
  defensively), reopen perm (`payroll.lock` assumed — the sealing authority unseals),
  `VALIDATING` as a server-transitional state (UI shows "in progress", no button),
  and backend timing (endpoints may 404 until the API agent lands — pages surface
  the error with request ID rather than crashing).

## Dev-server discipline (learned 2026-09-08)

- `next.config.js` enables `output: 'export'` ONLY when `NEXT_VERIFY_BUILD=1`
  (baked into `npm run build`). Dev MUST run without export mode: with it on,
  dev 500s every dynamic route whose param is not in `generateStaticParams`
  (all real `[id]` URLs — projects, board, employees, tasks, leave, payroll).
- NEVER run a build while `next dev` is serving: the build reliably breaks the
  running dev's `/_next/static` chunk serving (all chunks 404). Separate
  `.next-verify` distDir did NOT prevent it (suspected watcher-storm from
  `out/` rewrites).
- Verification procedure: stop dev → `npm run build` (flag baked in) →
  start dev → warm every route (page chunks compile lazily and 404 until
  first visit) → curl-spot-check chunks.
- Stale `.next` can also break dev chunk serving on its own: `rm -rf <abs
  path>/apps/web/.next` + restart dev if chunks 404 with no build running.
- Browser tabs hold stale `?v=` chunk URLs across restarts: hard-refresh
  (Cmd/Ctrl+Shift+R) after any dev restart.
