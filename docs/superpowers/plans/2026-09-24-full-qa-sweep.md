# Full QA Sweep → Fix → Sync → Deploy → APK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every bug fix inside a task follows superpowers:systematic-debugging (root cause first) and superpowers:test-driven-development (failing test first). No "done" claim without superpowers:verification-before-completion evidence.

**Goal:** Put every web and mobile module through an adversarial pass, fix what breaks, close the parity gaps between web and mobile, ship to git and the dev-thor VM, and build the Android APK on the laptop as the final step.

**Architecture:** The fix tasks can't be written until the sweep finds the bugs, so the plan runs as a pipeline. First we build a coverage and parity matrix. Next we seed deterministic QA- data. Then two domain lanes work in parallel, each breaking its modules and fixing what it finds with TDD. After that come the parity work, integration checks, a whole-branch review, one full-suite run on merged main, the deploy, and finally the APK build. Findings live in a single ledger so nothing is lost if a session dies.

**Tech Stack:** Turborepo monorepo. `apps/api` (Node/TS, vitest, Postgres/Supabase PG17), `apps/web` (Next.js, vitest), `apps/mobile` (Expo/React Native, `tsx --test`), `packages/shared`. VM rigs: `~/sl-wt.sh <slot a–g>` (isolated test DBs) and `~/sl-e2e` (Playwright + chromium, per-role crawlers, `.admin.json` token, `mobile/.qa-users.json`).

**Spec:** The owner's directive of 2026-09-24 (memory `full-qa-sweep-2026-09-24`), `SILVERLINE_BUSINESS_TEST_CATALOGUE.md` (test data baseline, UT-/E2E- IDs, exit criteria) and `Silverline_ERP_v2_Enhanced_Requirements.docx`.

## Global Constraints

- At most 2 agents at a time. Briefs and reports stay ≤300 words. Each agent runs only the tests it touched. The full suite runs once, on merged main, before the deploy.
- Every agent works in its own `C:\Users\Admin\sl-fix\<lane>` worktree and never edits `C:\Users\Admin\desktop\silverline_ERP` directly.
- Commits follow `type(scope): plain-English outcome` with a prose body, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests run on the VM from committed code: `git -C <wt> -c core.autocrlf=false archive HEAD | ssh dev-thor '~/sl-wt.sh <slot> bash -c "..."'`.
- Test data uses the `QA-` prefix. Live data is dummy and can be modified, but take a `pg_dump` (postgres:17 image) before any migration.
- Deploy per memory `ship-to-git-and-vm`: `-c core.autocrlf=false` archive, rsync `--dry-run --itemize-changes` first (read the deletions), protect `apps/api/uploads/`, `exports/` and `artifacts/*.apk`, run long steps under nohup, check `/health` on :3101 and :80.
- Policy questions in `open-decisions-2026-09-22` are not decided by engineers. List them in the ledger as `DECISION` and move on.
- Never install the Android toolchain on the VM (disk is 19 GB). The APK is built on the laptop, last, with nothing else running.
- No new dependencies unless a task justifies one in its report.
- No TLS yet, so browser geolocation is refused. Punch-location findings on web are expected until a domain and certificate exist; log them as `KNOWN-TLS`, not as bugs.

## Review Focus

1. **Cross-tenant and cross-scope access (IDOR):** a lower-role or other-org token calling detail/update endpoints by ID directly must get 403/404, never data. Lane tasks pin this with an API test per module family.
2. **Double-submit and retries:** tapping Save twice, or replaying the same Idempotency-Key, must produce exactly one business effect (catalogue rule). Pinned per write endpoint touched.
3. **UI gate vs API gate mismatch:** web hides a button but the API still accepts the call, or mobile shows an action the API rejects. The parity matrix records both gates, and each mismatch gets a test.
4. **IST date boundaries:** records created at 23:59/00:01 Asia/Kolkata, reversed from/to dates, month-end payroll and leave spans. Tests freeze the clock.
5. **Money and quantity edges:** negative, zero, huge values, more than 2 decimals, a stock quantity of 1 consumed twice concurrently. Totals must round consistently between web, mobile and API.

---

### Task 0: Land mobile wave 3 (in progress)

**Files:** `C:\Users\Admin\sl-fix\mobwork` (inbox, projects, planning, reports) and `C:\Users\Admin\sl-fix\mobops` (asset-movements, analytics, automation, org-locations, org-holidays). Both touch `apps/mobile/src/modulesLauncher.ts`.

- [ ] Wait for both agent reports. Each must show green `npm test` plus `tsc --noEmit` from its VM slot.
- [ ] Code-review each branch (superpowers:requesting-code-review).
- [ ] Merge into main one at a time with `git merge --no-ff`. Resolve the `BUILT_MODULE_ROUTES` conflict by keeping both sets of lines. Never `git stash` mid-merge.
- [ ] Run the mobile tests and typecheck on merged main (slot a), then push. The deploy is deferred to Task 7 (one deploy for the whole programme).

### Task 1: Coverage and parity matrix

**Files:**
- Create: `docs/qa/2026-09-24/coverage.md`
- Create: `docs/qa/2026-09-24/findings.md`, the single findings ledger, with columns `ID | Sev(P0–P3/DECISION/KNOWN-TLS) | Surface(web/mobile/api) | Module | Steps | Expected | Actual | Status | Fix commit`

- [ ] For each web route in `apps/web/app/*` and each nav entry in `apps/web/lib/nav.ts`, list every interactive element from the page source: buttons, links, inputs with their validation, tooltips (`title=`/Tooltip), filters, exports, dialogs. Also record the permission each one needs.
- [ ] For each mobile screen (`apps/mobile/app/*.tsx`, `(tabs)/*`), list the same.
- [ ] Map every API route in `apps/api/src/modules/*` to the web and mobile callers that use it.
- [ ] Parity table: for each module, whether web and mobile have read, create, edit and act, what each gate requires, and the gap. Seed the known gaps from `open-decisions-2026-09-22` (vendor-invoice lines/MSME, PO/GRN/RFQ/requisition/advance/RA-bill/stock creation screens, payment-run execute, expense receipt upload, notification deep links on mobile).
- [ ] Commit both files: `docs(qa): add the coverage and parity matrix for the 2026-09-24 sweep`.

### Task 2: Deterministic QA data seed

**Files:**
- Create: `scripts/qa/seed-qa.mjs`, an idempotent seed run against the live API from `~/sl-e2e` on the VM that looks records up by `QA-` name before creating them.
- Modify: `~/sl-e2e/admin/setup-qa-users.mjs` only if the role list is incomplete.

- [ ] Build the catalogue's test-data baseline: 2 orgs, all 9 roles with one `qa-admin-<role>` user each, 2 districts with District→Mandal→Village→Site chains, active/suspended/exited employees, an active project with workflow plus an inactive project, leave balances, an open payroll period, assets, stock with quantity 1, a lead/client/tender, a PO→GRN→vendor invoice chain, a receivable, an expense, a document, a survey village with GCPs.
- [ ] Run it twice. The second run must create nothing (idempotency).
- [ ] Commit: `test(qa): seed a repeatable QA- dataset covering every module`.

### Task 3 (lane A) and Task 4 (lane B): Adversarial sweep and fix, per domain

Two parallel agents, one worktree each off post-Task-0 main:
- **Lane A** `sl-fix/qa-a`, slot c: Auth/MFA/Security, Admin (users, roles, module visibility), Org (locations, holidays), Employees, Attendance, Leave, Payroll, My-payslip, Audit, Inbox/notifications.
- **Lane B** `sl-fix/qa-b`, slot e: Dashboard, Projects/Planning/My-work, Automation, Analytics/Reports, CRM (leads, clients, tenders), Finance (billing, receivables, payables, expenses, ledgers), Procurement, Inventory/Stock, Assets/movements, Documents, Approvals, Survey.

Each lane follows these steps for every module in its list:
- [ ] **Walk every element** from its section of `coverage.md` on web (Playwright on the VM) and on mobile (API calls the screen makes, plus the pure `*Format.ts` logic), as each relevant role. Check that each tooltip is accurate, each hyperlink resolves (no 404s or dead `href`), each button does what its label says, and that the empty, loading and error states render.
- [ ] **Attack each input:** blank, whitespace, 10k chars, unicode/emoji, `<script>`/`' OR 1=1`, negative/zero/huge/over-precise numbers, reversed dates, IST midnight, a double submit, a replayed Idempotency-Key, an expired token, a direct API call with a lower-role or other-org token, concurrent consumption of a quantity-1 stock item, and a state-machine jump (e.g. approving an already rejected item).
- [ ] **Log** each finding in `findings.md` with severity.
- [ ] **Fix P0 and P1 bugs** as they come, one commit per bug: root-cause per systematic-debugging, a failing vitest/tsx test reproducing it, a minimal fix, green tests. Commit as `fix(<module>): <outcome>`, and record the commit in the ledger.
- [ ] Fix P2 bugs when they are cheap (<30 min). Otherwise leave them `OPEN` with notes.
- [ ] Report ≤300 words: counts by severity, what was fixed, what is open, and any DECISION items.

### Task 5: Gap closure and web↔mobile sync

- [ ] Take the parity gaps from `coverage.md` and rank them by field-user value. Present the ranked list to the owner as a single question for confirmation. Items that are policy calls wait; items that are clearly missing screens proceed.
- [ ] Each confirmed gap gets a short plan of its own (writing-plans), then is built with TDD. Reuse the existing web/mobile patterns (mobile: `BackHeader` + Modal sheet + `*Format.ts` with tests).
- [ ] Mobile must implement notification deep links (known gap) so that inbox items open the right module screen.

### Task 6: Integration verification

- [ ] Check each integration in `docs/PROVIDERS.md` against the live VM: the upload virus scanner (clean → 201, EICAR → 422 `UNSAFE_FILE`), notifications/email/SMS (or their dev sinks), exports (encrypted export round-trip), geocoding, and scheduled jobs (`apps/api/src/modules/jobs`).
- [ ] Check that a change on web shows up in the mobile API response and vice versa (same record, same totals, same status labels via `packages/shared`).
- [ ] Log any failures in the ledger and fix them per Task 3's rules.

### Task 7: Review, merge, full suite, deploy

- [ ] Run a whole-branch code review on `qa-a`, `qa-b` and the gap branches, then fix the Critical/Important review items.
- [ ] Merge them into main one at a time, then run the full suite once on merged main (`npm test` for shared, api, web and mobile on one slot, under nohup, with a log). It must be green. If it isn't, go back to the owning lane.
- [ ] Push to origin.
- [ ] Deploy: `pg_dump` backup, then archive (autocrlf=false), stage in `/tmp/sl-stage`, run the rsync dry-run and read the deletions, rsync for real with the protect filters, run migrations if any (after the backup), run `sudo silverline-deploy` under nohup.
- [ ] Post-deploy: `/health` on :3101 and :80, the `~/sl-e2e` smoke and per-role crawl (no new 4xx/5xx or console errors against the pre-deploy baseline), and one scanner round-trip.
- [ ] Record the deployed commit in `findings.md` and commit the ledger.

### Task 8: Build the QA APK on the laptop (last)

- [ ] Close other heavy processes and make sure `~/.gradle/gradle.properties` has `org.gradle.jvmargs=-Xmx1536m`.
- [ ] In `apps/mobile`: `EXPO_PUBLIC_API_URL=http://34.131.134.217 MOBILE_QA_CLEARTEXT_HOST=34.131.134.217 MOBILE_BUILD_PROFILE=preview npx expo prebuild --platform android --clean --no-install`, then `android/gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a --no-daemon`, run in the background with a log.
- [ ] Verify that the APK exists and check its size and version code. Copy it to `artifacts/` and to the VM `artifacts/` (which is protected from rsync deletes).
- [ ] Report the APK path to the owner, with install notes (cleartext HTTP to the VM IP, QA users from `mobile/.qa-users.json`).

## Exit criteria

These come from the catalogue's exit criteria. Zero open P0/P1 in `findings.md`, every module row in `coverage.md` marked verified on web and mobile (or marked web-only with a reason), a green full suite on the deployed commit, a clean post-deploy crawl for all roles, and an APK built from the deployed commit.
