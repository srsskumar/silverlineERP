# Silverline ERP — Unified Development Plan (Web + Mobile + Backend)

Synthesized from three parallel planners. Source docs: `ARCHITECTURE.md`, `docs/LEAN_PLAN.md`.
Stack lock: `apps/api` (Node, 1 VPS) + `apps/web` (Next.js static export → Cloudflare Pages) + `apps/mobile` (Expo RN, Android+iOS) + `packages/shared` (Zod, API client, RBAC, sync protocol). No Redis/K8s/ES in v1.

## 1. Contracts First (S0) — nothing builds without these

`packages/shared/src/`: `schemas/` (auth, employee, attendance, leave, tasks, geofence — Zod), `api/` (fetch wrapper with JWT attach, 401→refresh→retry, `Idempotency-Key`, error envelope `{code,message,field_errors,request_id,retryable}`), `sync/` (ACCEPTED / ALREADY_APPLIED / REJECTED / CONFLICT / REQUIRES_REVIEW + idempotency + conflict rules), `rbac/` (permission codes, 9 seed roles, `can()`), `workflows/` (allowed-next transition map), `utils/` (IST dates, geo, format). Rule: anything importing `expo-*` or Next stays out of shared.

Backend S0 must also ship: `sessions` + `idempotency_keys` tables, RBAC middleware (endpoint+action+scope+field masking), audit interceptor, cursor pagination convention, `version`/`If-Match` concurrency, seed roles, R2 presigned-upload flow, pg-boss wiring.

## 2. Frontend Requirements (Web)

Routes (all client-guarded, static shell first): `/login`, `/mfa` (TOTP, no SMS) → `/dashboard` (role widgets, one aggregated `GET /dashboards/role/:role` call — never N+1 from client), `/my-work`, `/inbox`, `/employees` (+`/new`, `/[id]`, `/import`, masked PII), `/org/locations`, `/org/holidays`, `/attendance` (+`/exceptions`), `/geo-fences` (admin read), `/leave` (+`/balances`), `/projects` (+`/[id]/list`, `/board`, `/tasks/[taskId]` drawer), `/admin/roles` (read-only), `/admin/audit`. No UI for payroll/inventory/cycles/timeline/automation/AI.

Key components: shadcn-based UI kit + `DataTable` (cursor paginate, virtualize >200 rows), `KanbanBoard` (@dnd-kit, optimistic move + snapshot rollback on 422/409, position write on drop only, 100 cards/column cap), `StatusTransitionSelect` (driven by server `allowed_next[]`), `EvidenceUploader` (presigned PUT direct to R2), `CommentThread` (@mention autocomplete), `⌘K` palette, TanStack Query with key factory (masters 10min stale, queues 30s + 60s inbox poll).

## 3. Frontend Requirements (Mobile, Expo offline-first)

Tabs: Home (My Work + today attendance + sync pill) | Attendance (big check-in/out + accuracy readout + history + exception filing) | Tasks (local search/filter list + detail stepper + QuickAdd title-only) | Leave (balances + request + approvals inbox) | More (read-only profile/docs, settings, help).

Offline: SQLite subset (7 tables: meta, employees/tasks/projects/attendance/leave/notifications cache + `pending_ops` + `upload_sessions`), every mutation gets client UUID + `Idempotency-Key`, states QUEUED→SYNCING→SYNCED/FAILED/CONFLICT/REVIEW with visible chips + SyncQueueSheet, FIFO sync (approvals last), jittered backoff, bulk `POST /sync/batch` (≤50 ops). Critical fields (status, decisions, exit) get manual conflict sheet; non-critical is last-write-wins. Photos: watermark burned on-device, ≤200KB, direct-to-R2, text syncs first.

Device: GPS accuracy gate (>100m blocks or routes to exception), mock-location flag → `REQUIRES_REVIEW`, biometric + PIN fallback with tokens only in SecureStore, FCM payloads carry IDs only (no PII), revoked session → full local purge.

## 4. Backend Requirements (per module, S0→S6)

Build order: **Auth → Org → Employee → (Attendance+Geo ‖ Leave+Holidays ‖ Projects+Tasks) → Boards+Comments → SLA-basic → Dashboards.** S1 `employees.id` gates everything in S2+.

- **Auth/RBAC/Audit:** argon2id, 15m access + rotating 7d refresh families (reuse = revoke), TOTP, lockout, per-mutation audit with scrubbed PII.
- **Org/Employee:** hierarchy CRUD (no reparent/hard-delete in MVP), employee CRUD + exit/reactivate state machine, exit revokes sessions (BR-01), encrypted + masked Aadhaar/PAN/bank, bulk import as async job with row-level report.
- **Attendance/Geo:** server timestamp authoritative (>15min skew → review), duplicate suppression 5-min window → `ALREADY_APPLIED`, accuracy/mock → reject or review, one open check-in per employee, `work_date` derived server-side IST.
- **Leave:** ledger (`opening+credits−consumed+adjustments`, no negatives), approval chain atomic with balance debit, overlap with approved leave rejected / with attendance routed to correction.
- **Projects/Tasks:** workflow-graph enforcement on one endpoint used by UI, drag-drop, and (later) automation; `If-Match: version`, 422 returns `allowed_next[]`; assignee must be ACTIVE + in scope; dependency cycle check (DFS); close blocked on open tasks.
- **Jobs (pg-boss):** notifications, exports, imports, `sla-check` */15min, `dashboard-rollup` hourly, `backup-to-r2` nightly, retention weekly. Idempotent handlers, dead-letter table + alerts.
- **One-box hardening:** PgBouncer txn pooling, scope indexes + tsvector search, rate limits (login 5/min/IP, punches 30/min/user), log PII scrubber + CI grep gate, weekly auto-restore smoke test (S6 gate before pilot).

## 5. Sprint Integration Map (who ships what, per sprint)

| Sprint | Backend | Web | Mobile | Joint exit gate |
|--------|---------|-----|--------|-----------------|
| S0 | Auth/RBAC/audit, shared contracts, Compose+CI, seeds | Login/MFA, shell, guards | EAS channels, login+SecureStore+biometric stub | Login E2E web+mobile, deploy on push |
| S1 | Org + Employee + vault + import job | Locations/holidays/employees UI + masking | Profile/docs read-only, masters cache | Village→employee→exit blocks login |
| S2 | Geo-fence + events/records + exceptions | Attendance tables + exception queue | Check-in/out + queue + accuracy/mock | Airplane-mode: 20 queued → exactly-once |
| S3 | Leave + holidays logic | Request/queue/balances | Leave + approvals inbox | Double-tap leave → 1 server row |
| S4 | Projects/tasks/workflows/assign/evidence | List + quick-add + drawer + transitions | Task list/detail/QuickAdd + deep links | Invalid transition → allowed-next list |
| S5 | Boards + comments/mentions + SLA-basic | Kanban DnD + inbox + My Work + ⌘K | Simplified Kanban + mentions | Concurrent reorder → rollback, no loss |
| S6 | Rollups + limits + backup drill | Dashboards + perf pass | Home dashboard + ≤200KB photos | Dash <3s, 200-burst load, restore passes |
| S7 | Pilot support | Low-bandwidth mode + manuals | Frozen build + TestFlight/internal track | 50–100 users, sync >99%, UAT sign-off |

## 6. Risk Register (top, merged)

1. Morning check-in herd (15–25 rps, one box) → batch sync endpoint, PgBouncer, upsert path, jittered retries, 2× load test S6.
2. Sync duplicates/conflicts → client-UUID idempotency everywhere, dedupe windows, manual-resolution UX for decisions only.
3. RBAC/PII leakage via client → server-side masking as source of truth, per-route+per-button re-checks, masked-query keys per user/role.
4. Static-export + iOS-background limits → design assumes no SSR and no iOS background sync; foreground-first sync, client-gated auth, OTA for JS fixes.
5. Silent backup/data loss → nightly encrypted dumps to R2, weekly auto-restore test, disk-space alerts (40 GB fills fast — evidence never touches VPS disk).
