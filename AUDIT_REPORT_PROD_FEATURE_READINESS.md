# Silverline ERP v2 — Production and Feature Readiness Audit

**Audit date:** 12 September 2026  
**Audited revision:** `main` at `0ca6766`, including the current uncommitted working tree  
**Requirements baseline:** `/Users/dheeraj/Downloads/Silverline_ERP_v2_Enhanced_Requirements.md`  
**Verdict:** **NO-GO for production**  
**Production readiness:** **32/100**  
**Feature implementation maturity:** **74/100**

The application contains substantial working functionality across the API, Web, and Android clients. The current repository state cannot produce that application from a clean checkout, the active CI and deployment definitions target deleted paths, and several required production controls have no verification evidence. Those release blockers override the relatively strong functional coverage.

The requirements document was treated only as the audit baseline. Its Section 26 instructions for coding agents were not executed as instructions from the user.

## 1. Scope and method

The audit indexed the full current source tree, build/deployment configuration, migrations, tests, generated builds, documentation, Git state, and dependency manifests. Generated dependencies and build output were excluded from source-line counts.

| Area | Current implementation |
| --- | --- |
| API | Fastify, TypeScript, PostgreSQL, 19 SQL migrations, background worker |
| Web | Next.js 15 static client application, React, TanStack Query |
| Mobile | Expo/React Native Android/iOS client with SQLite outbox and SecureStore |
| Current source inventory | 347 TypeScript/TSX/JavaScript/SQL files; approximately 38,960 lines in the principal source roots |
| Tests | API integration/contract tests, Web unit/contract tests, Mobile Node tests |
| Deployment assets | API Dockerfile and Vercel entry; no current Web host routing/security configuration; no current worker deployment definition |

Readiness labels used below:

- **Ready:** implemented and supported by relevant automated evidence.
- **Partial:** material implementation exists, with a functional gap or missing operational/end-to-end proof.
- **Missing:** required capability or evidence was not found.
- **Blocked:** another release problem prevents meaningful production use.

The numeric scores are evidence-weighted audit judgments, not a percentage of source lines or requirements sentences.

## 2. Executive findings

### 2.1 Release-blocking findings

| ID | Severity | Finding | Evidence and impact | Required release gate |
| --- | --- | --- | --- | --- |
| R-01 | Critical | The working application is not in the committed repository state. | Git reports the tracked root monorepo (`apps/`, `packages/shared`, root `package.json`, deployment files, operations docs/scripts) as deleted, while the whole active application is untracked under `projects/`. A clean checkout of `main` cannot reproduce the code audited here. | Choose the canonical layout, add it to Git, remove the obsolete layout deliberately, and prove a clean-clone install/build/test. |
| R-02 | Critical | CI is structurally broken for the current tree. | [`.github/workflows/ci.yml`](.github/workflows/ci.yml#L30) runs root scripts from the deleted root `package.json` and uploads `apps/*` artifacts at lines 39–41, while active packages live under `projects/*`. | Replace CI paths/scripts, run migrations against an isolated PostgreSQL service, build all deliverables, scan dependencies, and retain the correct artifacts. |
| R-03 | Critical | Current deployment definitions cannot deliver the complete system. | [`projects/api/Dockerfile`](projects/api/Dockerfile#L8) copies and builds deleted `apps/api` and `packages/shared` paths. Vercel only defines the HTTP API; the required background worker in [`projects/api/src/jobs.ts`](projects/api/src/jobs.ts#L5) has no deployment/process definition. Scheduled reports, automation, provider jobs, SLA notifications, and webhook deliveries therefore lack a runnable production worker. | Build the API image from the canonical layout; deploy API and worker as distinct supervised processes; add migration/release jobs and health/readiness checks. |
| R-04 | Critical | Static Web deployment cannot resolve real dynamic record URLs. | [`projects/web/next.config.js`](projects/web/next.config.js#L12) exports static files. Each dynamic route generates only `__placeholder__`, for example [`projects/web/app/projects/[id]/page.tsx`](projects/web/app/projects/[id]/page.tsx#L10). The build contains placeholder HTML only, and no `_redirects`, middleware, host rewrite, or equivalent fallback exists. Deep links such as `/projects/<real-id>` will 404 on a static host. | Add and test the Cloudflare/host SPA fallback or use a deployment mode that serves dynamic routes. Verify direct navigation and refresh for every dynamic route. |
| R-05 | Critical | Disaster recovery and scale acceptance evidence is absent from the current deliverable. | Requirements Appendix C mandates a successful restore drill and a 200+ concurrent field-user test. The corresponding root backup/load scripts are deleted in the current worktree, and no drill result, performance result, SLO dashboard, or capacity baseline is present. | Execute and retain a restore drill with measured RPO/RTO; run a production-like 200+ user load test with headroom and latency/error thresholds. |
| R-06 | High | Web production dependencies contain a high-severity vulnerability. | `npm audit --audit-level=high` for `projects/web` reports 1 high and 3 moderate vulnerabilities; the high advisory is in the PostCSS path used by the installed Next.js version. The suggested automated fix crosses a Next major version, so it needs controlled remediation and regression testing. | Upgrade/override to non-vulnerable versions, rebuild, rerun all Web tests, and require a passing high-severity audit in CI. |
| R-07 | High | Browser refresh tokens are exposed to JavaScript and no Web security-header policy is defined. | [`projects/web/lib/apiClient.ts`](projects/web/lib/apiClient.ts#L67) persists access and refresh tokens in `localStorage`. No CSP, HSTS, frame-ancestor, MIME-sniffing, or referrer-policy configuration was found for the static host. Any successful XSS can steal the long-lived session material. | Move the refresh session to a hardened design, preferably Secure/HttpOnly/SameSite cookies with rotation, and deploy/test an explicit CSP and security headers. |
| R-08 | High | PostgreSQL TLS identity verification is disabled. | [`projects/api/src/database/db.ts`](projects/api/src/database/db.ts#L15) uses `rejectUnauthorized: false` for every URL it considers remote. This encrypts traffic without authenticating the server certificate. | Use CA-validated TLS and make TLS mode explicit per environment. Add a startup/test check for production configuration. |

### 2.2 Major correctness and completeness findings

| ID | Severity | Finding | Evidence and impact | Required action |
| --- | --- | --- | --- | --- |
| F-01 | High | Employee quick-add is denied despite the role contract and requirement. | The full API suite has one failure: [`projects/api/test/rbac.test.ts`](projects/api/test/rbac.test.ts#L488) expects an Employee to create a title-only task and receives 403. [`projects/api/src/common/recordScope.ts`](projects/api/src/common/recordScope.ts#L22) grants project access through an already-visible task; a scoped employee has no visible task in a new project and cannot create the first one. | Define the intended employee/project scope for capture and fix the authorization rule and regression test. |
| F-02 | High | Employee lifecycle lacks `ON_LEAVE`. | The requirement defines Active, On Leave, Suspended, and Exited with approved-leave synchronization. [`002_s1.sql`](projects/api/src/database/migrations/002_s1.sql#L61) allows only `DRAFT`, `ACTIVE`, `SUSPENDED`, and `EXITED`; no synchronization to approved leave was found. | Add a compatible lifecycle/read-model strategy, migration, transition rules, assignment restrictions, and tests. |
| F-03 | High | Advanced anti-fraud controls are incomplete. | Attendance evaluates GPS accuracy, geofence position, and the client-provided `mock_location` flag. No implementation was found for emulator/developer-setting signals, suspicious jumps, or impossible-travel detection required by Section 9.3. | Add device-signal collection where supported and server-side temporal/location anomaly checks that create review signals. |
| F-04 | High | Board view modeling does not meet the multi-view requirement. | [`006_s5.sql`](projects/api/src/database/migrations/006_s5.sql#L13) permits only `LIST` and `KANBAN` Board records. Calendar and Timeline exist in a separate planning screen, so they cannot be added/configured as saved Board views as specified. | Extend saved view configuration to Calendar/Timeline and ensure all filters/configuration are stored per view over the same Task data. |
| F-05 | High | Configuration records are hard-deleted. | [`projects/api/src/modules/s5/routes.ts`](projects/api/src/modules/s5/routes.ts#L804) deletes boards and line 1040 deletes saved filters. This conflicts with the no-hard-delete/historical-reference rule for configuration. Several schema relationships also cascade-delete business children. | Add inactive/deleted lifecycle fields, preserve referenced history, and constrain/manual-review destructive database paths. |
| F-06 | High | Rate limiting is not suitable for horizontal production and does not cover all required sensitive flows. | [`projects/api/src/common/rateLimit.ts`](projects/api/src/common/rateLimit.ts#L9) uses per-process memory. Login is protected, but refresh, MFA setup/verification, OTP-sensitive flows, and most privileged mutations have no distinct distributed rate limits. Limits reset on restart and multiply with replicas. | Use a shared store or edge/API-gateway controls; cover login, refresh, OTP/MFA, uploads, exports, and sensitive administration endpoints. |
| F-07 | High | Persistent files are tied to local instance storage. | Employee/task evidence and encrypted report files use local `UPLOADS_DIR`/`REPORTS_DIR`; for example [`projects/api/src/modules/s6/routes.ts`](projects/api/src/modules/s6/routes.ts#L802). This is incompatible with stateless replicas and can make DB registry entries point to files absent from another instance. | Move documents/reports to private encrypted object storage with durable keys, retention, access audit, malware scanning, and lifecycle policies. |
| F-08 | Medium | Default local PostgreSQL URLs are misclassified as remote. | [`projects/api/src/database/db.ts`](projects/api/src/database/db.ts#L9) matches `@localhost` but not the documented `postgresql://localhost/...` form. The default test run consequently forces SSL against local PostgreSQL and fails broadly; adding a username before `@localhost` allows the suite to run. | Parse the URL with `URL`, recognize loopback hostnames correctly, and add unit tests for local/remote/IPv6 URL forms. |
| F-09 | Medium | Organization timezone support is inconsistent. | Attendance and scheduled jobs use organization settings in several paths, but analytics, dashboards, SLA helpers, and some mobile/shared utilities still hard-code `Asia/Kolkata`, including [`analytics/routes.ts`](projects/api/src/modules/analytics/routes.ts#L14) and [`s6/routes.ts`](projects/api/src/modules/s6/routes.ts#L53). | Use the organization timezone for every business date/SLA computation and test non-IST organizations and DST boundaries. |
| F-10 | Medium | Android re-authentication is incomplete. | Mobile stores tokens in SecureStore and supports a foreground biometric gate, but [`projects/mobile/src/auth/AuthContext.tsx`](projects/mobile/src/auth/AuthContext.tsx#L54) does not restore the stored session on a fresh launch. The Mobile README records PIN fallback as deferred. No re-auth gate was found around individual sensitive operations. | Restore/validate sessions safely, implement the selected PIN/device-credential policy, and require step-up for sensitive actions. |
| F-11 | Medium | Operational observability is too limited for the availability target. | The API provides structured request logs, a DB-backed health check, and in-memory route counters. No distributed tracing, centralized error/crash integration, durable metrics, alert definitions, worker-liveness signal, queue-lag monitoring, or SLO/error-budget evidence was found. | Add centralized logs/metrics/traces, alerting, worker/queue health, dashboards, and on-call runbooks tied to the 99.5% target. |
| F-12 | Medium | Release hardening and governance evidence is incomplete. | No current feature-flag framework, production-like E2E browser suite, automated accessibility suite, device instrumentation suite, security test report, migration reconciliation, UAT sign-off, or training/manual delivery record was found. | Complete the hardening work and store signed/repeatable evidence with the release. |

## 3. Positive controls and implemented strengths

The audit found meaningful engineering controls that should be retained:

- Production startup rejects weak/default JWT and AES keys and a missing database URL in [`projects/api/src/config.ts`](projects/api/src/config.ts#L58).
- Authentication includes short access tokens, rotating refresh-token families, refresh reuse revocation, account lockout, MFA setup/verification, device/session revocation, and production MFA enforcement for privileged roles.
- PII uses authenticated AES-256-GCM encryption, ordinary reads/exports apply permission-based masking, and security-sensitive mutations are audited.
- PostgreSQL migrations define organization scoping, optimistic versions, unique constraints, payroll state/lock rules, task workflow data, automation events, report jobs, and planning policies.
- Attendance records immutable raw events, stable decision codes, idempotency, circle/polygon geofences, poor-accuracy review, mock-location review, outside-fence exceptions, and payroll-lock guards.
- Task management includes configurable workflows, transition validation, dependencies/cycle detection, reassignment reasons/history, evidence, labels, mentions, comments, checklists, saved filters, WIP limits, cycles/rollover, optimistic drag/drop rollback, Calendar/Timeline projections, SLA events, and automation authority checks.
- Inventory is ledger-derived and locks the item row before posting, rejects negative stock, computes low-stock state, enforces asset lifecycle/employee eligibility, and supports QR/barcode physical audits.
- Analytics provides operational metrics, workload, cycle velocity, burndown, advisory risk with model version/timestamp/confidence/factors, insufficient-data behavior, review cases, and user feedback.
- Mobile uses SecureStore for tokens/keys and an encrypted SQLite outbox with operation IDs, sequences, retry/idempotency/conflict handling, visible sync states, background registration, camera watermark burn-in, and QR/barcode scanning.
- Automation/webhooks include permission checks, audit records, HMAC signing, retry handling, authority revalidation, and private-network SSRF defenses.

## 4. Feature readiness against the v2 requirements

| Requirement area | Status | Implemented evidence | Material gaps before acceptance |
| --- | --- | --- | --- |
| Roles, scopes, RBAC, MFA, sessions | Partial | Ten seeded roles, custom roles, scoped grants, record-scope middleware, rotating sessions, privileged-role MFA, lockout, audit | Quick-add scope defect; distributed/sensitive rate limits; production end-to-end MFA and permission-matrix evidence |
| Employee master and lifecycle | Partial | CRUD/import preview+commit, uniqueness, hierarchy checks, encrypted/masked PII, documents, exit/reactivation controls, read-only mobile profile | `ON_LEAVE` missing; approved-leave synchronization missing; local rather than object document storage |
| Attendance and geofencing | Partial | Immutable events, idempotency, circle/polygon checks, accuracy/mock/outside review, evidence metadata, exceptions, locks | Impossible travel/jump/emulator controls; production device/location tests; remaining hard-coded timezone paths |
| Holidays and weather | Partial | Generic/local holidays, precedence logic, provider gateway and advisory UI | Final provider/policy decision and verified admin/automatic activation behavior |
| Leave | Partial | Configurable types, ledger balances, overlap/attendance guards, approval chain, self-approval guard, mobile decision | Organization-owned approval/accrual/carry-forward policy is not fully productized or signed off |
| Payroll | Partial | Required state machine, LOP calculation, lock/authorized reopen, versioned payslip documents, CSV/XLSX/PDF operations | Final statutory/formula/rounding policy; production reconciliation; stronger proof that every mandatory employee-day is complete |
| Projects and tasks | Partial, strong | Lifecycle, close guard, workflow graphs, nested tasks, dependencies, reassignment history, planning, evidence, quick-add UI | Employee quick-add authorization defect; configuration deletion; full human-readable activity UX and E2E proof |
| Views, filters, cycles, SLA | Partial, strong | List/Kanban, separate Calendar/Timeline, saved filters, WIP, cycle rollover/velocity, SLA escalation and automation triggers | Calendar/Timeline not stored as Board view records; browser drag/drop/deep-link E2E; organization timezone consistency |
| Inventory, assets, physical audit | Ready at API-test level | Ledger quantities, concurrency lock, non-negative stock, low-stock result, invoice fields, asset state machine, QR audits, offline mobile audit | Production device testing, durable evidence/object storage, operations UAT |
| Analytics and AI guardrails | Partial | KPI/workload/burndown/cycle metrics, explainable advisory result, insufficient-data response, feedback and review cases | KPI owner sign-off, geography/team comparison completeness, approved thresholds, monitoring/retraining process, production data validation |
| Reporting and exports | Partial | Scoped CSV/XLSX/PDF, async large reports, schedules, encrypted files, permission recheck at download | Worker deployment; durable object storage; retention cleanup; finance/statutory adapter sign-off |
| Automation, notifications, integrations | Partial | Rules, events, executions, permission scope, audit, inbox, push/provider queues, webhook HMAC/retry/SSRF protections | No production worker process; provider credentials/adapters and payment choice unresolved; operational queue monitoring absent |
| Android offline/security | Partial | Encrypted resumable outbox, conflict/retry cases, background task, token vault, biometric foreground lock, revocation wipe hook, evidence/scanner flows | Fresh-launch biometric/session behavior, PIN policy, sensitive-action step-up, real APK/AAB/device/partial-connectivity/cold-start validation |
| Web UX and accessibility | Partial | Responsive app shell, permission-aware navigation, command palette, quick add, explicit loading/error/empty patterns in core views | Broken static deep links; refresh-token exposure; no browser E2E, automated accessibility audit, or measured <3 s performance |
| Production NFRs and operations | Missing/Blocked | DB health, production logs, simple metrics, config validation | Clean release, correct CI/CD, 200+ load proof, 99.5% monitoring, backups/PITR/restore drill, capacity/latency evidence, runbooks, staged rollout |

## 5. Appendix C readiness checklist

| Required checklist item | Audit result | Evidence/gap |
| --- | --- | --- |
| RBAC and MFA verified | Partial | Extensive API coverage and implementation; one RBAC quick-add failure and no production E2E verification |
| Sensitive fields masked and encrypted | Partial | Code/tests present; production storage, key rotation, and full access-audit acceptance still needed |
| Audit trail for critical mutations | Pass at automated-test level | Audit helpers and route tests cover major mutation paths |
| Employee lifecycle restrictions | Partial | Exit restrictions exist; `ON_LEAVE` lifecycle/synchronization is absent |
| Geofence and mock-location controls | Partial | Geofence/accuracy/mock flag tests exist; advanced anti-fraud signals do not |
| Offline duplicate/retry/conflict sync | Partial | Mobile tests pass; no real-device partial-connectivity test record |
| Payroll lock and override | Pass at automated-test level | State/lock/override tests are present and pass |
| Inventory non-negative concurrency | Pass at automated-test level | Row locking and concurrency test coverage are present |
| Project close/dependency/SLA | Pass at automated-test level | API rules and tests are present |
| Board workflow, drag/drop, automation moves | Partial | Server and helper tests exist; no real browser E2E suite |
| Automation execution audited and scoped | Partial | Implementation/tests exist; production worker is not deployable from current definitions |
| Cycle rollover | Pass at automated-test level | API close/rollover implementation and tests are present |
| Backup restored in DR drill | Fail | No current drill artifact; backup/restore scripts are deleted in the working deliverable |
| 200+ concurrent field-user test | Fail | No runnable current load harness/result or acceptance thresholds |
| UAT sign-off | Fail | No sign-off artifact |
| Migration reconciliation | Fail | No reconciliation/sign-off artifact |
| Training/manuals delivered | Fail | Package READMEs are developer notes; no end-user/operations training delivery evidence |

Checklist outcome: **5 pass at automated-test level, 7 partial, 5 fail**. None of the automated passes substitutes for production/UAT sign-off where the requirement calls for it.

## 6. Validation executed

| Package/check | Result |
| --- | --- |
| Web TypeScript lint | Pass |
| Web tests | **207/207 passed** across 12 files |
| Web production static export | Pass; 43 routes generated, but only placeholder variants exist for dynamic paths |
| Web dependency audit | Fail: 1 high, 3 moderate |
| Mobile typecheck | Pass |
| Mobile tests | **58/58 passed** |
| Mobile Expo bundle export | Pass for Android and iOS JavaScript bundles |
| Mobile dependency audit | No high; 17 moderate |
| API typecheck/build | Pass |
| API default test command | Fail broadly because the documented no-user localhost URL is incorrectly forced to SSL |
| API suite with an explicit `user@localhost` test URL | **319/320 passed**; Employee quick-add expected 201 and received 403 |
| API dependency audit | No high; 2 moderate |

The mobile export is a bundling smoke test. It is not an APK/AAB build, Play signing check, Android 9 compatibility run, cold-start benchmark, or physical-device acceptance test. The Web tests are unit/contract-oriented and do not exercise browser navigation, drag/drop, accessibility, or static-host routing. The API suite uses a real local PostgreSQL database and gives the strongest current behavioral evidence.

## 7. Production readiness scorecard

| Dimension | Score | Reason |
| --- | ---: | --- |
| Reproducible source and release | 0/15 | Active source untracked; committed application paths deleted |
| Security and privacy | 8/15 | Strong application controls, offset by high Web CVE, localStorage refresh token, DB TLS verification, and rate-limit gaps |
| Reliability and operability | 3/15 | Local storage/cache/rate limits, missing worker deployment and production observability |
| Data safety and recovery | 2/15 | Migrations/transactions are strong; no current backup/PITR/restore proof |
| Performance and scalability | 2/15 | Pagination and bounded queries exist; no 200+ load proof and several per-instance components |
| Automated quality evidence | 12/20 | Large passing suite and builds; one API failure, broken default test URL, no browser/device/performance/security E2E |
| Deployment, UAT, migration, training | 5/20 | Developer notes exist; actual pipeline, UAT, reconciliation, DR, and training gates are incomplete |
| **Total** | **32/100** | **Production NO-GO** |

## 8. Ordered remediation plan

### P0 — establish a releasable baseline

1. Reconcile Git into one canonical monorepo. Commit the active source and manifests, remove obsolete paths intentionally, and verify from a fresh clone.
2. Replace CI so it installs each canonical package, starts/migrates isolated PostgreSQL, runs all checks, audits dependencies, builds Web/API/mobile artifacts, and uploads the paths actually produced.
3. Repair API container/release definitions and add an independently supervised worker. Add safe, one-shot migration execution and rollback/forward-fix procedures.
4. Fix Web production routing for all dynamic IDs and verify real URL refreshes on the target host.
5. Remediate the high Web dependency vulnerability and deploy security headers/token hardening.
6. Replace insecure DB TLS handling, local persistent files, and per-process security/rate-limit state with production-suitable services/configuration.
7. Define backup/PITR, execute a restore drill, and run the 200+ concurrent user test with recorded acceptance thresholds.

### P1 — close contractual feature gaps

1. Fix Employee quick-add record scope and pass all 320 API tests.
2. Implement/synchronize `ON_LEAVE` and add lifecycle, assignment, attendance, and reporting tests.
3. Add suspicious-jump/impossible-travel/emulator/developer-setting review signals where the platform supports them.
4. Store Calendar and Timeline as configurable saved view records and remove hard deletion of configuration.
5. Use the organization timezone in all business-date and SLA paths.
6. Complete Android session restoration, re-authentication, PIN/device-fallback decision, and remote-wipe/device scenarios.
7. Add production-like Web E2E coverage for login/MFA, dynamic deep links, Kanban drag/drop/rollback, automation-triggered transitions, permissions, and critical payroll/attendance workflows.

### P2 — finish operational acceptance

1. Resolve and sign the policy decisions in requirements Table 19: payroll/statutory formulas, leave/accrual/approvals, geofence tolerance, weather activation, retention/legal basis, RPO/RTO, integrations, AI thresholds, geography master data, cycles, WIP, and workflow templates.
2. Complete migration dry run and reconciliation, representative UAT, accessibility audit, Android 9+/current-device matrix, latest-two-browser matrix, <3 s Web and <2 s Android cold-start benchmarks.
3. Add centralized logs/metrics/traces, crash reporting, worker/queue alerts, dashboards, on-call/runbooks, retention cleanup, and release rollback procedures.
4. Deliver end-user/admin/operations manuals and retain signed go-live approvals.

## 9. Go-live exit criteria

Do not approve production until all of the following are true:

- A clean checkout at the release tag installs, migrates, tests, and builds solely through CI.
- All API, Web, and Mobile automated checks pass; dependency audits have no unaccepted high/critical findings.
- API, worker, Web, database, object storage, secrets, and monitoring are deployed in a production-like UAT environment.
- Real dynamic Web URLs refresh successfully; Android install/signing/device/offline scenarios pass.
- Security review covers MFA, session/token handling, RBAC/scopes, uploads, SSRF/webhooks, injection, secrets, TLS, and data retention.
- The 200+ user load test, backup restore drill, migration reconciliation, UAT, and training are completed with retained evidence.
- Every unresolved Table 19 policy has a named owner, approved value, configuration, and acceptance test.

## 10. Audit limitations

This is a source, build, dependency, and local integration-test audit. No production cloud account, target static host, managed database TLS chain, object store, provider account, signing key, physical Android fleet, monitoring system, representative migration dataset, or stakeholder sign-off was available. Items requiring those systems are marked Partial, Missing, or Fail rather than assumed complete.
