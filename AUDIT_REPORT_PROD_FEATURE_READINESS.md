# Silverline ERP v2 — Re-Audit and Two-Hour Completion Plan

**Re-audit date:** 13 September 2026

**Branch:** `fix/release-baseline` at `c384cf5`, including current working-tree changes

**Requirements baseline:** `/Users/dheeraj/Downloads/Silverline_ERP_v2_Enhanced_Requirements.md`

**Production verdict:** **NO-GO until release packaging and external acceptance gates are closed**

**Production readiness:** **64/100**

**Feature implementation maturity:** **82/100**

The project has improved materially since the 12 September audit. The canonical monorepo is restored, all automated tests and builds pass, the high-severity dependency finding is resolved, database TLS is verified by default, Employee quick-add works, server-side impossible-travel/emulator review signals exist, release API/worker services are defined, and local database-restore and 200-user API checks pass.

Two hours is enough to produce a **coherent staging release candidate**. It is not enough to establish production readiness because physical Android testing, production backup recovery, migration reconciliation, UAT, security acceptance, and policy sign-off require external systems and people.

The requirements document was used only as audit criteria. Its instructions to build agents were not treated as user instructions.

## 1. Current indexed baseline

| Item | Result |
| --- | --- |
| Source inventory | 358 TypeScript/TSX/JavaScript/MJS/SQL files; approximately 46,876 principal source lines |
| Monorepo | Root npm workspaces: `apps/*`, `packages/*`; Turbo tasks restored |
| Git position | Local branch is 2 commits ahead of `origin/fix/release-baseline` |
| Working tree | 17 tracked files modified and 5 untracked paths; current fixes are not yet a reproducible release commit |
| Database | PostgreSQL with 20 migrations and startup schema-drift guard under development |
| Deployable processes | API, migration job, background worker, Web/Caddy, PostgreSQL and ClamAV in `compose.release.yml` |

## 2. Verification repeated on 13 September

| Check | Result |
| --- | --- |
| Root lint/typecheck | **Pass — 5/5 tasks** |
| Shared tests | **15/15 passed** |
| API tests with PostgreSQL | **365/365 passed** |
| Web tests | **221/221 passed** |
| Mobile tests | **72/72 passed** |
| Total automated tests | **673/673 passed** |
| Root production build | **Pass — shared, API, Web, Mobile** |
| Web static generation | **Pass — 43 routes** |
| Mobile JS export | **Pass — Android and iOS** |
| Dependency audit | **Pass at high threshold — 0 high/critical; 17 moderate** |
| Local DB recovery check | **Pass — 20 migrations, fixture restored, 1.8 s** |
| Local load check | **Pass — 200 concurrent users, 1,600 requests, 0 errors, p95 95 ms** |
| Release Compose parse | **Pass** with representative required environment values |
| Android native preflight | **Fail — SDK root/packages, JDK and device/emulator unavailable; Maps key warning** |

The load result covers loopback HTTP, one API process, PostgreSQL, and a 75/25 read/write mix. It excludes Web rendering, native startup, uploads, providers, network latency, horizontal replicas, and production infrastructure. The recovery check covers an isolated database fixture; it excludes private files, production backup scheduling, PITR, and measured production RPO/RTO.

## 3. Changes that closed findings from the first audit

| Previous finding | Current status |
| --- | --- |
| Application existed only in untracked `projects/` | **Closed:** canonical `apps/` and `packages/` monorepo restored |
| Root CI targeted missing package paths | **Closed structurally:** scripts and workspace paths exist again |
| API/worker deployment missing | **Closed structurally:** API, migrate and worker services are defined |
| High Web dependency vulnerability | **Closed at high threshold:** PostCSS override updated; no high/critical audit findings |
| PostgreSQL used `rejectUnauthorized:false` for remote DBs | **Closed:** loopback parsing and explicit verify-full/no-verify modes added with tests |
| Default localhost DB URL failed | **Closed:** URL hostname parsing and regression tests added |
| Employee title-only quick-add returned 403 | **Closed:** record-scope behavior fixed; full RBAC suite passes |
| Emulator/impossible-travel signals missing | **Closed at code/test level:** shared heuristic, device signals, migration, server recheck and review cases added |
| Static-host deep-link metadata absent | **Partly closed:** Cloudflare/Netlify `_redirects` and `_headers` exist |
| Backup/load harness absent | **Closed locally:** both scripts run and produce passing local evidence |

## 4. Immediate release blockers

| Priority | Finding | Evidence | Completion condition |
| --- | --- | --- | --- |
| P0 | Web release artifact path is wrong. | `npm run build` writes the complete static site to `apps/web/.next-verify`. CI uploads `apps/web/out`, and `docker/release/web.Dockerfile` copies `/app/apps/web/out`; that directory does not exist. | Produce `apps/web/out` or consistently change CI/Docker/Turbo to the real directory; verify `_redirects` and `_headers` are included. |
| P0 | The Compose/Caddy deployment still breaks canonical dynamic deep links. | Cloudflare understands `public/_redirects`; Caddy does not. Its current `try_files` has no mapping from real record IDs to `/record.html?type=...&id=...`. | Add Caddy matchers/redirects for project/task/board/employee/leave/payroll/attendance URLs and test direct requests plus refresh. |
| P0 | The release baseline is not frozen. | Local is two commits ahead of origin with 17 modified files and 5 untracked paths, including schema-guard code and Android setup assets. | Review/stage all intended files, exclude generated/local files, rerun checks, create one coherent release-candidate commit. |
| P0 | Android has no native build evidence on this machine. | Preflight reports no SDK root/packages, JDK, or device/emulator. JS bundling cannot validate Maps, geofencing, camera, biometric, SecureStore, notifications, SQLite or foreground services. | Build/install a dev or preview APK and complete a physical-device smoke test, or explicitly classify mobile as pending after the two-hour RC. |

## 5. Remaining production and feature gaps

| Severity | Gap | Requirement effect |
| --- | --- | --- |
| High | Employee database lifecycle still lacks `ON_LEAVE` and approved-leave synchronization. | Sections 7 and Appendix B are not satisfied. The Web already exposes a status the API schema cannot store. |
| High | Calendar and Timeline remain separate planning projections rather than saved/configurable Board records. | Section 10.4 requires every view to be stored as a view configuration over the same tasks. |
| High | Boards and saved filters are hard-deleted. | Conflicts with the historical/configuration preservation rule. |
| High | Web refresh tokens remain in `localStorage`; static CSP requires `unsafe-inline` and allows every HTTPS connection target. | XSS can expose session material; the policy is broader than a fixed production origin needs. |
| High | Rate limits remain per-process memory and do not comprehensively cover refresh/MFA/privileged endpoints. | Horizontal replicas multiply limits and restart clears them. |
| High | Documents, evidence and reports remain on a shared local volume. | The Compose deployment can run on one host, but stateless horizontal/multi-zone operation and object lifecycle are not ready. |
| Medium | Several business-date/SLA paths still hard-code `Asia/Kolkata`. | Organization timezone configuration is inconsistently applied. |
| Medium | Mobile always requires credentials after a fresh launch; PIN fallback is explicitly deferred. | Biometric login/PIN fallback and sensitive-action re-auth are incomplete. |
| Medium | No real browser E2E/accessibility suite or physical-device test record. | Drag/drop, canonical URLs, MFA, native offline reconnect and accessibility are not acceptance-tested. |
| Medium | Fastify logs a deprecation for `disableRequestLogging`. | A Fastify 6 upgrade will break this option unless moved to `logController`. |
| External gate | Production DR/PITR, representative migration reconciliation, provider verification, UAT, training, and policy sign-off are absent. | Appendix C cannot be signed. |

## 6. Feature readiness matrix

| Requirement area | Status | Current assessment |
| --- | --- | --- |
| Auth, RBAC, scopes, MFA, audit | Strong/Partial | Core implementation and API tests pass; token storage and distributed/sensitive rate limiting remain |
| Employee management | Partial | CRUD/import/PII/documents/exit/reactivation are strong; `ON_LEAVE` is missing |
| Attendance/geofence/anti-fraud | Strong | Geofence, accuracy, mock, emulator and impossible-travel review paths are implemented and tested |
| Holiday/leave | Strong/Partial | Core rules pass; final organization policy/accrual/approval configuration requires sign-off |
| Payroll | Strong/Partial | State machine, lock, LOP and documents pass; statutory/formula reconciliation is external |
| Projects/tasks/workflows | Strong | Quick-add, workflow, dependencies, history, planning and evidence pass |
| Boards/views/cycles/SLA | Partial | List/Kanban/cycles/SLA work; saved Calendar/Timeline Board modeling and browser E2E remain |
| Inventory/assets/audits | Strong | Ledger, non-negative concurrency, lifecycle, QR/barcode and audit behavior are implemented |
| Analytics/AI | Partial | Explainable advisory features exist; KPI/model approval and timezone cleanup remain |
| Reports/automation/integrations | Strong/Partial | Worker deployment is defined; durable object storage, provider/UAT evidence and queue monitoring remain |
| Web | Blocked for release packaging | Code/tests/build pass; output directory and Caddy canonical-route behavior must be fixed |
| Android | Partial | Code/tests/export pass; native build and device acceptance are blocked by the local environment |
| Operations/NFRs | Partial | Local 200-user and DB restore checks pass; production-like scale, DR, observability and sign-offs remain |

## 7. Two-hour execution plan

### Definition of done at 2:00

The achievable target is a tagged or committed **staging release candidate** that:

- produces every artifact from the root build;
- passes all 673 tests, lint, build and high-severity dependency audit;
- builds/parses the release Compose stack;
- serves real canonical Web URLs through Caddy;
- refuses production startup when schema migration 020 or any future migration is missing;
- has no unexplained modified or untracked release files;
- lists Android native verification and external production acceptance as explicit post-RC gates.

### 0:00–0:20 — Fix the Web release path and canonical URLs

1. Make Web build output, CI artifact path and Web Docker `COPY` agree on one directory.
2. Confirm the output contains `index.html`, `record.html`, `_redirects`, `_headers`, and all `_next` assets.
3. Add equivalent Caddy routing for:
   - `/projects/:id/tasks/:taskId`
   - `/projects/:id/board`
   - `/projects/:id`
   - `/employees/:id`
   - `/attendance/records/:id`
   - `/leave/:id`
   - `/payroll/:id`
4. Acceptance: build the Web image or serve the built directory and verify direct canonical URLs return the record shell with the correct query parameters.

### 0:20–0:35 — Finish the schema guard and release configuration

1. Review and include `schemaGuard.ts`, its tests, config and health response changes.
2. Set `REQUIRE_CURRENT_SCHEMA=true` for release API and worker/migration-sensitive processes.
3. Verify the API refuses startup against a database missing migration 020 and starts after migration.
4. Acceptance: schema-guard tests and Compose configuration pass.

### 0:35–1:05 — Close the highest-value functional mismatch: `ON_LEAVE`

1. Add a migration that safely extends employee status to `ON_LEAVE`.
2. Define approved leave as the authoritative source for the effective On Leave state; avoid manual drift.
3. Apply effective status to attendance/task/asset eligibility and employee reads.
4. Align Web validation/status filters with API values; remove unsupported `TERMINATED` unless intentionally mapped.
5. Add focused tests for approve → On Leave, return date → Active, exit precedence, and assignment restrictions.
6. Acceptance: new focused tests plus the full API/Web suite pass.

### 1:05–1:25 — Remove two contained consistency defects

1. Replace remaining hard-coded business-date calculations with organization timezone settings in analytics, dashboard/SLA, leave and attendance detail paths.
2. Change Board and saved-filter deletion to soft deactivation, including list filters and audit state.
3. Acceptance: non-IST test and configuration-retention test pass.

### 1:25–1:45 — Package and smoke-test the release candidate

1. Run `npm run lint`, `npm test`, `npm run build`, and `npm audit --audit-level=high`.
2. Run `node scripts/check-dr.mjs` and `node scripts/check-load.mjs`.
3. Run `docker compose -f compose.release.yml config`; build the API and Web images if Docker is available.
4. Smoke-test `/health`, login, an Employee quick-add task, attendance punch/review, a canonical Web record URL, and one worker tick.

### 1:45–2:00 — Freeze and hand off

1. Review `git diff --check`, generated files, secrets and the final status.
2. Commit the coherent release candidate with the updated audit/load evidence.
3. Record deferred gates: Android physical-device run, production backup/PITR drill, UAT, migration reconciliation, training, provider credentials and policy decisions.
4. Do not label the candidate production-ready until those external gates pass.

## 8. Work that should not be forced into this two-hour window

These changes need a separate hardening cycle because rushing them raises data-loss or security risk:

- replacing browser bearer-token persistence with an HttpOnly refresh-session architecture;
- Redis/gateway distributed rate limiting;
- object storage migration and historical file reconciliation;
- saved/configurable Calendar and Timeline Board records;
- full browser E2E/accessibility automation;
- Android SDK installation, signed native release, Play configuration and physical-device matrix;
- production infrastructure, centralized observability, PITR, multi-zone testing and UAT.

## 9. Appendix C status

| Checklist result | Count | Items |
| --- | ---: | --- |
| Pass at automated-test level | 6 | Audit, geofence/mock/anti-fraud, payroll lock, inventory concurrency, project/dependency/SLA, cycle rollover |
| Partial | 9 | RBAC/MFA, sensitive fields, lifecycle, offline/device sync, Board/browser workflow, automation deployment, DB restore, 200-user load, training/manuals |
| Fail/unverified | 2 | UAT sign-off, migration reconciliation |

Production readiness remains **NO-GO** because local automated success does not establish native-device behavior, production recovery, policy correctness, migration reconciliation, or stakeholder acceptance.

## 10. Audit limitations

This re-audit used the current local source, PostgreSQL, build toolchain and generated artifacts. It did not use a production cloud account, production database/CA, object store, provider credentials, signed Android environment, physical phone, target DNS/TLS host, representative legacy dataset, monitoring service, or stakeholder approval.
