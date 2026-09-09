# Silverline ERP — $5/mo Lean Plan: Hosting, Mobile Choice, MVP + Sprints

Assumptions: **5,000 registered users, ~200-300 concurrent peak** (field check-in bursts morning/evening).
If you mean 5,000 *concurrent*, $5/mo is not feasible — say so now, because that needs ~$80-150/mo minimum.

## 1. The $5/mo Hosting Truth

Yes, it fits — but only as **1 VPS + free tiers**, not AWS/GCP managed services. And two costs sit *outside* infra:

| Cost | Amount | Verdict |
|------|--------|---------|
| Apple Developer Program | $99/year (~$8.25/mo) | Mandatory for iOS. Cannot fit inside $5. Budget it separately. |
| Google Play | $25 one-time | Fine, pay once. |
| SMS OTP (Twilio/MSG91) | ~$0.01-0.02/SMS | 5k users × OTP = blows budget. **Avoid SMS.** Use TOTP authenticator + FCM push (free). |
| Infra (VPS + Pages + R2 + DNS) | ~$4.50-5/mo | Fits (below). |

### Recommended setup: 1× Hetzner CX22 + Cloudflare free

| Piece | Where | Cost |
|-------|-------|------|
| API + PostgreSQL + job worker (single Docker Compose) | Hetzner CX22: 2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB transfer (~€4.35-4.49/mo) | ~$4.60/mo |
| Web frontend (static export) | Cloudflare Pages free (500 builds/mo, 20k files) | $0 |
| File/evidence storage | Cloudflare R2 free: 10 GB, 1M writes / 10M reads per mo, zero egress | $0 |
| DNS + CDN + TLS + DDoS | Cloudflare free | $0 |
| Push notifications | Firebase FCM free | $0 |
| Backups | pg_dump nightly → R2 (same 10 GB bucket) | $0 |
| **Total infra** | | **~$4.60/mo** |

Free fallback: Oracle Cloud Always Free (2 OCPU / 12 GB ARM + 200 GB disk + 10 TB egress, $0). Bigger box, but capacity is hard to grab and Oracle quietly halved it in mid-2026 — use only as backup/dev, not primary prod.

### Why 5k users fits on one box (the math)

Field ERP is bursty, not sustained. 5,000 users × ~25 API calls/day ≈ 125k req/day ≈ **1.5 req/sec average, ~15-25 req/sec peak**. A single Node + Postgres on 2 vCPU handles 100-300 req/sec for simple CRUD. The risks are (a) morning check-in thundering herd, (b) uncompressed photo uploads, (c) missing indexes. Mitigations are in Section 3.

### Lean-stack cuts vs ARCHITECTURE.md (required to survive on 1 box)

1. **No Redis.** Use Postgres for sessions (or stateless JWT), `pg-boss`/`pgmq` for the job queue, in-process Node EventEmitter for domain events. Add Redis only when the box proves insufficient.
2. **No Kubernetes, no managed DB.** Single Docker Compose: `api + postgres + pgbouncer`. Deploy with Dokploy/Coolify (free, self-hosted) or plain Compose + GitHub Actions SSH.
3. **Backend: keep NestJS *or* drop to Fastify/Hono-lite.** NestJS runs fine on 4 GB, but if your team is small, one Fastify service with modules-per-folder is lighter to operate. Either way: one process, stateless, 2 replicas via PM2/cluster.
4. **Frontend: static export, not SSR-per-request.** Next.js `output: export` → Cloudflare Pages. Admin dashboards fetch via API client. This takes all web rendering load off the VPS.
5. **Photos: compress on-device (≤200 KB) before upload, background upload.** Direct-to-R2 via presigned URLs so the VPS never proxies bytes.
6. **Postgres on the same box** with: PgBouncer (pool 20-50), `pg_trgm + tsvector` for search (no Elasticsearch), nightly `pg_dump` + WAL to R2, one read-replica only if analytics slows prod (later).

## 2. Mobile: Yes, React Native (Expo) — Not Flutter, Not Native ×2

You need Android + iOS with a tiny team and a React web app. Decision: **Expo React Native (TypeScript)**.

| Factor | Expo React Native (recommended) | Flutter | Native ×2 (Kotlin + Swift) |
|--------|----------------------------------|---------|----------------------------|
| Team/skill | Same TS as web+API. Share `packages/shared` (Zod schemas, API client, RBAC types, offline sync logic). One team ships web+mobile. | New language (Dart). Separate hiring, zero code-share with web. | Two teams. Dead on arrival at your budget. |
| Speed to MVP | Fastest: Expo Router, NativeWind (Tailwind), EAS builds + OTA updates (skip store review for JS fixes). | Fast UI, but you rewrite everything. | Slowest. |
| Offline-first | Works: `expo-sqlite` (drizzle/w WatermelonDB) + WorkManager-style background sync + idempotency keys. Well-trodden. | Slightly better SQLite story, irrelevant at your scale. | Best, but cost kills it. |
| Camera/GPS/biometrics | `expo-camera`, `expo-location`, `expo-local-authentication` — all cover watermark + mock-location flags. | Same via plugins. | Same. |
| Risk | Heavy maps/animations slightly less smooth than Flutter. Non-issue for forms/check-in app. | — | — |

**Structure:** `apps/mobile (Expo)` + `apps/web (Next.js)` + `apps/api` + `packages/shared` (types, Zod, API client, permission constants). OTA via `expo-updates` (free tier is enough for 5k).

## 3. What To Build First (MVP cuts — be ruthless)

The v2.0 spec is ~5 phases. For $5/mo + 5k users, ship a **field-pilot MVP** first, gate everything else behind flags:

**IN (MVP):** Auth + MFA(web) + biometric(mobile) → Org/District/Mandal/Village master → Employee CRUD + exit → Attendance check-in/out + geo-fence + exceptions → Leave request/approve + balances → Projects + Tasks (List + Kanban only) + comments/mentions → Boards minimal → Dashboard (My Work + attendance summary) → offline queue + sync states → audit log → R2 evidence uploads.

**OUT (post-MVP flags OFF):** Payroll runs/payslips, Inventory/Assets, Cycles/Sprints, Calendar/Timeline views, Automation Engine, Webhooks, AI predictions, Custom Fields, Saved Filters sharing, accounting/payment integrations, multi-workspace. Build the schema columns for them (cheap) but not the logic/UI.

Why this order: you cannot test payroll/inventory until attendance + employee master + project workflow are stable in the field. Every failed ERP pilot I have seen inverted this.

## 4. Sprint Plan (2-week sprints, 2-3 devs, ~16 weeks to pilot)

Team assumption: 1 backend + 1 web/mobile (Expo+Next share TS) + you on UAT/masters. If solo, ×1.6 time.

| Sprint | Goal | Ship (demo-able) | Exit criteria |
|--------|------|------------------|---------------|
| S0 (wk 1-2) Infra + contracts | VPS + Pages + R2 + CI live; `packages/shared` types; auth + RBAC (9 seed roles) + audit middleware | Login works web+mobile skeleton; push-to-main auto-deploys | MFA on web, biometric stub on mobile, audit row per mutation |
| S1 (wk 3-4) Org + Employee | Location hierarchy + employee CRUD + exit lifecycle + document vault (R2 presigned) + bulk import staging | Admin creates village → employee → exit blocks login | BR-01/02/03 tests pass; Aadhaar/bank masked + encrypted |
| S2 (wk 5-6) Attendance + Geo | Check-in/out API + geofence eval + mock-location flags + duplicate-suppress + offline queue (Room/SQLite + idempotency keys) | Phone in airplane mode → check-in queued → syncs once on reconnect | Offline-retry test: exactly-once; accuracy-threshold reject works |
| S3 (wk 7-8) Leave + Holidays | Leave types/balances ledger + approval chain + holiday calendar + mobile approve | TL approves leave on phone; balance decrements | Overlap with attendance blocked or routed to correction |
| S4 (wk 9-10) Projects + Tasks core | Workspace→Project→Task→Subtask, ProjectWorkflow enforcement, quick-add (title-only), assign/reassign with reason, evidence upload | PM creates project → tasks appear on mobile list | Invalid status transition rejected with allowed-next list (incl. drag-drop path) |
| S5 (wk 11-12) Boards + polish | Kanban (drag-drop optimistic + rollback), List filters, comments/@mentions → inbox, My Work queue | Board drag moves card; mention pings inbox | Board-transition tests incl. concurrent reorder conflict |
| S6 (wk 13-14) Dashboards + hardening | Role dashboards, attendance/SLA summaries (no AI yet), PgBouncer + indexes + photo compression + rate limits, backup-restore drill | Dashboard <3s; cold start <2s on reference device | Restore drill passes; 200-concurrent load test passes |
| S7 (wk 15-16) Pilot | 1 district, 50-100 real users, low-bandwidth test, training + manuals, UAT sign-off | Go/no-go for 5k rollout | Pilot SLA: zero silent data loss, sync success >99% |

Post-pilot (in order): Payroll → Inventory/Assets → Cycles + Calendar/Timeline → Automation Engine → Webhooks → AI advisory.

## 5. Your Action List This Week

1. Provision Hetzner CX22 (Singapore or nearest to users) + Cloudflare (Pages + R2 + DNS). Keep Apple $99 and SMS-out as separate budget lines.
2. Freeze the MVP scope above — do not let payroll/inventory creep into S0-S5.
3. Scaffold the monorepo (`apps/api, apps/web, apps/mobile, packages/shared`) with shared Zod schemas first — this is your API contract.
4. Collect real masters now (village/mandal codes, leave policy, geo-fence tolerances) — they block S1/S2 harder than code does.
5. Decide: NestJS (structure) vs Fastify-lite (ops simplicity) — either is fine; do not run both.
