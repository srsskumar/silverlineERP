# Owner Decisions Batch (2026-10-01) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the six owner-approved changes from the 2026-10-01 decisions batch: grant `holiday.read` to staff roles, enable local-origin browser QA, make document purge a soft flag instead of a hard delete, crew-gate daily survey returns like GCPs, make the stage row (not the linked task) govern a task-linked survey stage, and document the confirmed survey billing lifecycle.

**Architecture:** Six independent, serially-committable changes against the existing Fastify API (`apps/api`), the shared domain package (`packages/shared`), and VM ops scripts (`scripts/vm`). No new subsystems; each task extends an existing route, migration sequence, or ops script in place, following the file's own established patterns (the RBAC-grant migration pattern from 097/098/100/112, the `workAuthority`/`authorityCovers` crew-gate pattern from SV-002, the `mutate()` audit pattern used by every write route).

**Tech Stack:** TypeScript (Fastify API, Next.js static-export web), PostgreSQL migrations, Vitest, nginx on the VM.

**Spec:** `C:\Users\Admin\.claude\projects\C--Users-Admin-desktop-silverline-ERP\memory\owner-decisions-2026-10-01.md` (the owner's answers); background in `docs/qa/2026-09-24/overnight-report.md`, `docs/qa/2026-09-24/owner-policy-batch.md` (item 6), `docs/qa/2026-09-24/findings-survey-deep.md` (SV-001/SV-014), `docs/qa/2026-09-24/findings-survey-gaps.md` (SG-D1/D2/D3), `docs/REQUIREMENTS_LAND_SURVEY.md`.

## Global Constraints

- Every migration is idempotent (`ON CONFLICT DO NOTHING` / re-runnable) and numbered the next free integer after `112` — use `113` and `114` (this plan reserves both; do not let the two tasks race on the same number).
- Every write route keeps using the existing `mutate()` audit wrapper; no route loses its audit trail.
- `packages/shared` is fixed in the same commit as any migration that also needs a source-level permission/behavior change, per the repo's own 097/098/100/112 precedent (a source change never reaches an already-seeded deployment on its own).
- SV-001 (stage-completion authority) and the HTTPS/email-SMS/APK infra items are explicitly **out of scope** — do not touch `describe.skip` in `survey-authority.test.ts`'s `"completing a stage"` block, and do not start on domain/TLS/provider/APK work.
- One commit per task, TDD (failing test first), full relevant test file(s) green before moving to the next task.

## Review Focus

- A purged-then-reselected document must not resurrect itself or double-count in `due-for-purge`/`/documents` once flagged (Task 3) — the flag must be excluded from every list/read path a hard delete used to remove it from, not just the purge route's own re-selection.
- A team leader or PM filing a return for a village they are *not* actually posted to/managing must still be refused even though they can see the programme (Task 4) — reuse `workAuthority`, don't just check `villageOr404`.
- The SG-D3 fix (Task 5) touches BOQ milestone billing eligibility, not just display — a task-linked village whose task says "Done" but whose stage row says otherwise must now bill (or not) off the stage row, and the existing billing tests for that path must be updated to the new expectation, not left asserting the old one.
- `holiday.read` for `AUDITOR` and other seed-created (not migration-created) roles must be verified against a full migrate+seed build, not just `migrate()` alone, or the test gives a false pass on a role that does not exist yet at migration time (Task 1).
- The local-QA nginx/build addition (Task 2) must bind to loopback only (`127.0.0.1:8081`), never a public-facing address, so it cannot become a second, unpatched way to reach the API from the internet.

---

### Task 1: Grant `holiday.read` to staff roles

**Files:**
- Modify: `packages/shared/src/s1.ts:56-76` (`S1_ROLE_GRANTS`)
- Create: `apps/api/src/database/migrations/113_holiday_read_for_staff.sql`
- Test: `apps/api/test/fresh-database.test.ts`

**Interfaces:**
- Consumes: `S1_PERMISSIONS.HOLIDAY_READ` (`packages/shared/src/s1.ts:23`, value `"holiday.read"`), existing `roles`/`role_permissions`/`permissions` tables.
- Produces: nothing new consumed by later tasks — this is a leaf change.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/fresh-database.test.ts`, in the same `describe` block as the existing `097`/`098`/`100` migration tests (model on the `100` test at line 116):

```ts
it("grants holiday.read to the staff roles created by migration alone (113)", async () => {
  // SALES_BD_EXECUTIVE and BID_TENDER_MANAGER are created by
  // 031_commercial_permissions.sql, so this half of 113's grant is not a
  // no-op here and can be checked right after migrate(), the same shape as
  // 100's own check (fd4a046).
  const granted = await pool.query(
    `SELECT r.code AS role_code
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE r.code IN ('SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER') AND r.org_id IS NULL
        AND rp.permission_code = 'holiday.read'
      ORDER BY r.code`,
  );
  expect(granted.rows.map(r => r.role_code)).toEqual(["BID_TENDER_MANAGER", "SALES_BD_EXECUTIVE"]);
});

it("grants holiday.read to every staff role once fully seeded (113, owner decision 2026-10-01 #1)", async () => {
  // EMPLOYEE, PROJECT_MANAGER, TEAM_LEAD, PAYROLL_OFFICER, INVENTORY_MANAGER
  // and AUDITOR only exist once seedDatabase() runs (same as 097's own
  // AUDITOR check), so this is checked after a full build.
  const granted = await pool.query(
    `SELECT r.code AS role_code
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE r.code IN ('EMPLOYEE', 'PROJECT_MANAGER', 'TEAM_LEAD', 'PAYROLL_OFFICER',
                        'INVENTORY_MANAGER', 'AUDITOR', 'SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER')
        AND r.org_id IS NULL AND rp.permission_code = 'holiday.read'`,
  );
  expect(granted.rows).toHaveLength(8);
});
```

Both tests go inside the existing `describe` that already builds `migrate()`-only and `migrate()+seedDatabase()` pools for 097/098/100/112 — reuse that setup, do not open a new pool.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=api -- fresh-database.test.ts -t "holiday.read"`
Expected: FAIL — both queries return 0/fewer rows than expected (the grant does not exist yet).

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/113_holiday_read_for_staff.sql`:

```sql
-- Grant holiday.read to staff roles (owner decision 2026-10-01 #1).
--
-- PROJECT_MANAGER, TEAM_LEAD and EMPLOYEE hold leave.request but not
-- holiday.read, so they cannot see the calendar their own leave request is
-- checked against (MA-015). SALES_BD_EXECUTIVE, BID_TENDER_MANAGER,
-- INVENTORY_MANAGER, PAYROLL_OFFICER and AUDITOR do not hold leave.request
-- in this codebase, but the holiday calendar is read-only and
-- non-confidential, and the owner approved treating them as staff for this
-- one permission (docs/qa/2026-09-24/owner-policy-batch.md item 6).
--
-- packages/shared/src/s1.ts (S1_ROLE_GRANTS) is fixed in the same commit,
-- but per 097/098/100/112's own precedent a source change never reaches an
-- already-seeded deployment on its own, so the grant is applied here too.
-- The permissions-catalog insert is defensive: holiday.read already exists
-- on any database that has ever been seeded.

INSERT INTO permissions (code, description, module) VALUES
  ('holiday.read', 'See the organisation holiday calendar', 'holidays')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'holiday.read'
FROM roles r
WHERE r.code IN ('PROJECT_MANAGER', 'TEAM_LEAD', 'EMPLOYEE',
                  'SALES_BD_EXECUTIVE', 'BID_TENDER_MANAGER', 'INVENTORY_MANAGER',
                  'PAYROLL_OFFICER', 'AUDITOR')
  AND r.org_id IS NULL
ON CONFLICT (role_id, permission_code) DO NOTHING;
```

- [ ] **Step 4: Fix the source so a fresh seed matches**

In `packages/shared/src/s1.ts`, change `S1_ROLE_GRANTS` (lines 56-76):

```ts
  PROJECT_MANAGER: [
    S1_PERMISSIONS.EMPLOYEE_READ,
    S1_PERMISSIONS.ORG_UNITS_READ,
    S1_PERMISSIONS.DOCUMENT_READ,
    S1_PERMISSIONS.HOLIDAY_READ,
  ],
  TEAM_LEAD: [
    S1_PERMISSIONS.EMPLOYEE_READ,
    S1_PERMISSIONS.ORG_UNITS_READ,
    S1_PERMISSIONS.DOCUMENT_READ,
    S1_PERMISSIONS.HOLIDAY_READ,
  ],
  // PRD §4: PAYROLL_OFFICER is payroll-only and INVENTORY_MANAGER has no
  // business perms (no inventory module yet) -- holiday.read added for both
  // by owner decision 2026-10-01 #1; neither holds employee codes.
  PAYROLL_OFFICER: [S1_PERMISSIONS.HOLIDAY_READ],
  INVENTORY_MANAGER: [S1_PERMISSIONS.HOLIDAY_READ],
  EMPLOYEE: [S1_PERMISSIONS.HOLIDAY_READ],
  CLIENT_VIEWER: [],
  // ORG_UNITS_READ alongside EMPLOYEE_READ, same as every other role below
  // that reads employees (HR_MANAGER/PROJECT_MANAGER/TEAM_LEAD) -- without it
  // the district filter on /employees 403s for an auditor (P-002).
  AUDITOR: [S1_PERMISSIONS.EMPLOYEE_READ, S1_PERMISSIONS.ORG_UNITS_READ, S1_PERMISSIONS.HOLIDAY_READ],
 SALES_BD_EXECUTIVE:[S1_PERMISSIONS.HOLIDAY_READ], BID_TENDER_MANAGER:[S1_PERMISSIONS.HOLIDAY_READ], GOVT_OBSERVER:[],
```

(`GOVT_OBSERVER` and `CLIENT_VIEWER` are deliberately left out — they are external/observer roles, not staff, and were not named in the owner's decision.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=api -- fresh-database.test.ts -t "holiday.read"`
Expected: PASS, both tests.

- [ ] **Step 6: Run the full s1 and fresh-database suites**

Run: `npm run test --workspace=api -- s1.test.ts fresh-database.test.ts`
Expected: all PASS (no role elsewhere asserts the *absence* of `holiday.read` for these roles — confirm by reading any failure, not by assuming).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/s1.ts apps/api/src/database/migrations/113_holiday_read_for_staff.sql apps/api/test/fresh-database.test.ts
git commit -m "feat(rbac): grant holiday.read to staff roles (owner decision 2026-10-01 #1)"
```

---

### Task 2: Local-origin web build for browser QA

**Files:**
- Create: `scripts/vm/nginx-silverline-qa.conf`
- Create: `scripts/vm/silverline-deploy-qa`
- Modify: `docs/DEPLOY_VERCEL.md` is unrelated — instead modify `docs/qa/2026-09-24/findings-survey-deep.md`'s note (line 6) is historical QA output, leave it; add a short new doc `docs/QA_LOCAL_BROWSER.md` explaining the mechanism.

**Interfaces:**
- Consumes: the existing production `scripts/vm/nginx-silverline.conf` and `scripts/vm/silverline-deploy` as the pattern to follow; the API already running on `127.0.0.1:3101` (unchanged, shared with production).
- Produces: a second, loopback-only nginx site at `http://127.0.0.1:8081` serving a web build whose `NEXT_PUBLIC_API_URL` is baked to that same origin, so a local browser (Playwright or similar) loading `http://127.0.0.1:8081/` and the API calls its JS makes are same-origin — no CSP relaxation needed, and the production site (`nginx-silverline.conf`, public IP, `NEXT_PUBLIC_API_URL=http://34.131.134.217`) is untouched.

This task is ops/infra: there is no automated test runner for nginx config on this repo, so verification is a scripted curl check instead of a unit test. Follow the same step shape (write, verify-fails, "implement", verify-passes, commit) using that check.

- [ ] **Step 1: Write the verification check (expected to fail first)**

Create `scripts/vm/check-qa-site.sh`:

```bash
#!/usr/bin/env bash
# Verifies the local-only QA site is up and talking to itself, not the
# public origin. Run on the VM after silverline-deploy-qa.
set -euo pipefail
echo "==> checking QA site responds on loopback"
curl -fsS http://127.0.0.1:8081/ -o /dev/null
echo "==> checking the baked API origin matches the QA site's own origin"
BUNDLE_REF=$(curl -fsS http://127.0.0.1:8081/ | grep -o 'http://127\.0\.0\.1:8081[^"]*' | head -1 || true)
if [ -z "$BUNDLE_REF" ]; then
  echo "FAIL: no reference to http://127.0.0.1:8081 found in the served page" >&2
  exit 1
fi
echo "==> checking the API proxy on the QA site answers"
curl -fsS http://127.0.0.1:8081/health -o /dev/null
echo "OK"
```

- [ ] **Step 2: Run it against the current (pre-change) VM state to confirm it fails**

Run (on the VM, or skip with a comment if this plan is being executed off-VM — note that explicitly rather than silently skipping): `bash scripts/vm/check-qa-site.sh`
Expected: FAIL — connection refused on `127.0.0.1:8081` (nothing listens there yet).

- [ ] **Step 3: Write the QA nginx site**

Create `scripts/vm/nginx-silverline-qa.conf`, modeled on `scripts/vm/nginx-silverline.conf` but loopback-only and on a distinct port, pointing at a separate release tree:

```nginx
# Loopback-only QA site for browser-driven survey/web testing
# (owner decision 2026-10-01 #3). Never bind this to a public address: it
# exists so a browser loaded from 127.0.0.1 is the same origin the bundled
# JS calls, which is what the production CSP's connect-src 'self' needs --
# the public site's bundle is baked to http://34.131.134.217 instead, which
# is why loading it from 127.0.0.1 failed every call under the real CSP.
server {
    listen 127.0.0.1:8081;
    server_name _;

    root /opt/silverline-web-qa/current;
    index index.html;
    absolute_redirect off;
    client_max_body_size 10m;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    set $csp "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' https://tile.openstreetmap.org; worker-src 'self' blob:; manifest-src 'self'";
    add_header Content-Security-Policy $csp always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=()" always;

    location /api/ {
        proxy_pass http://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3101/health;
        access_log off;
    }

    location /_next/static/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location ~ ^/_(headers|redirects)$ { return 404; }

    location / {
        add_header Cache-Control "no-cache" always;
        add_header Content-Security-Policy $csp always;
        try_files $uri $uri.html $uri/index.html =404;
    }
}
```

- [ ] **Step 4: Write the QA build/deploy script**

Create `scripts/vm/silverline-deploy-qa` (executable), which builds web only against the existing already-built API and installs the QA nginx site, without touching the production release or the production site file:

```bash
#!/usr/bin/env bash
# Rebuilds the web app for local-origin browser QA and serves it on
# 127.0.0.1:8081, proxying to the same API the production site uses. Does
# not touch /opt/silverline-web/current or the production nginx site.
#
# Run after a normal `sudo silverline-deploy` so the API is already up to
# date; this script only rebuilds the static web export.
set -euo pipefail
cd /opt/silverline

QA_ORIGIN="http://127.0.0.1:8081"
echo "==> building web for QA (API origin: $QA_ORIGIN)"
sudo -u dev-thor env NEXT_VERIFY_BUILD=1 NEXT_PUBLIC_API_URL="$QA_ORIGIN" npm run build --workspace=web

WEB_RELEASES=/opt/silverline-web-qa/releases
RELEASE="$WEB_RELEASES/$(date -u +%Y%m%dT%H%M%SZ)"
echo "==> staging QA web release $RELEASE"
mkdir -p "$WEB_RELEASES"
cp -a /opt/silverline/apps/web/.next-verify "$RELEASE"
rm -f "$RELEASE/_headers" "$RELEASE/_redirects"
ln -sfn "$RELEASE" /opt/silverline-web-qa/current

echo "==> installing the QA nginx site"
SITE=/etc/nginx/sites-available/silverline-qa
if ! cmp -s /opt/silverline/scripts/vm/nginx-silverline-qa.conf "$SITE" 2>/dev/null; then
  cp -f "$SITE" "$SITE.bak" 2>/dev/null || true
  install -m 644 /opt/silverline/scripts/vm/nginx-silverline-qa.conf "$SITE"
  ln -sfn "$SITE" /etc/nginx/sites-enabled/silverline-qa
  if ! nginx -t 2>&1; then
    echo "QA nginx config failed nginx -t; restoring previous" >&2
    [ -f "$SITE.bak" ] && install -m 644 "$SITE.bak" "$SITE"
    exit 1
  fi
  systemctl reload nginx
fi
echo "==> QA site ready at http://127.0.0.1:8081"
```

- [ ] **Step 5: Run the check again to verify it passes**

Run: `bash scripts/vm/check-qa-site.sh`
Expected: PASS, all three checks.

- [ ] **Step 6: Document it**

Create `docs/QA_LOCAL_BROWSER.md`:

```markdown
# Local-origin browser QA

The production site's CSP (`connect-src 'self'`) blocks every API call when
the page is loaded from an origin other than the one its bundle was built
against. The web bundle is built with `NEXT_PUBLIC_API_URL` baked in at
build time (`scripts/vm/silverline-deploy`), currently
`http://34.131.134.217` — so loading the production site from `127.0.0.1`
fails every call, not because 127.0.0.1 is special, but because it is not
the origin the bundle calls.

`scripts/vm/silverline-deploy-qa` builds a second copy of the web app with
`NEXT_PUBLIC_API_URL=http://127.0.0.1:8081` and serves it from nginx on
`127.0.0.1:8081` only (never a public address), proxying `/api/` to the
same API the production site uses. A browser that loads
`http://127.0.0.1:8081/` is on the same origin its bundle calls, so the
unmodified production CSP already allows every request — no relaxation.

Run `sudo silverline-deploy` first (API + production web), then
`sudo bash scripts/vm/silverline-deploy-qa`, then point a local browser
driver at `http://127.0.0.1:8081/`. Verify with
`bash scripts/vm/check-qa-site.sh`.

This reuses the live QA fixtures (`QA-` prefix) like every other probe —
it is not a separate database.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/vm/nginx-silverline-qa.conf scripts/vm/silverline-deploy-qa scripts/vm/check-qa-site.sh docs/QA_LOCAL_BROWSER.md
chmod +x scripts/vm/silverline-deploy-qa scripts/vm/check-qa-site.sh
git commit -m "feat(qa): serve a loopback-only web build so browser QA is same-origin (owner decision 2026-10-01 #3)"
```

---

### Task 3: Purge flags a document for later deletion instead of deleting it

**Files:**
- Create: `apps/api/src/database/migrations/114_document_pending_deletion.sql`
- Modify: `apps/api/src/modules/documents/routes.ts:60-69` (`SELECT`), `:167-200` (list), `:209-239` (renewals), `:241-260` (get by id), `:499-559` (due-for-purge), `:572-658` (purge)
- Test: `apps/api/test/catalogue/documents.test.ts` (extend the existing `"due-for-purge report and explicit purge"` describe block, line 368)

**Interfaces:**
- Consumes: existing `mutate()`, `fail()`, `documentPurgeSchema` (`packages/shared/src/documents.ts:482-487`, unchanged).
- Produces: `documents.pending_deletion` (boolean), `pending_deletion_at`, `pending_deletion_reason`, `pending_deletion_by` columns — not consumed by any other task in this plan.

Design: the observable API contract stays identical to today (a purged id still 404s on every read path, still disappears from every list) — only the storage changes from `DELETE` to an `UPDATE ... SET pending_deletion = true`, so a later, separate job can do the real deletion. This keeps every existing test passing unchanged; only one new test is added to prove the row survives underneath the flag.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/catalogue/documents.test.ts`, inside the `"due-for-purge report and explicit purge"` describe block, right after the `"purges the selection once every item qualifies..."` test (after line 465):

```ts
it("flags the row for later deletion rather than deleting it (owner decision 2026-10-01 #4)", async () => {
  const doc = await orgDoc({ expires_on: dayOffset(-365 * 4) });
  const r = await post(w.admin, "/api/v1/documents/purge",
    { ids: [doc.id], reason: "Flag for later deletion" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);

  // Gone from every ordinary read path, same as a hard delete looked from
  // the outside...
  expect((await get(w.admin, `/api/v1/documents/${doc.id}`)).status).toBe(404);
  const list = await get(w.admin, "/api/v1/documents");
  expect(list.data.map((d: any) => d.id)).not.toContain(doc.id);

  // ...but the row itself is still there, flagged, for a later deletion
  // step to act on.
  const row = (await w.pool.query(
    "SELECT pending_deletion, pending_deletion_reason, pending_deletion_by FROM documents WHERE id = $1",
    [doc.id],
  )).rows[0];
  expect(row.pending_deletion).toBe(true);
  expect(row.pending_deletion_reason).toBe("Flag for later deletion");
  expect(row.pending_deletion_by).toBe(w.adminId);
});

it("excludes an already-flagged document from a fresh due-for-purge report", async () => {
  const doc = await orgDoc({ expires_on: dayOffset(-365 * 4) });
  await post(w.admin, "/api/v1/documents/purge", { ids: [doc.id], reason: "First flag" });
  const due = await get(w.admin, "/api/v1/documents/due-for-purge");
  expect(due.data.map((d: any) => d.id)).not.toContain(doc.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=api -- documents.test.ts -t "owner decision 2026-10-01"`
Expected: FAIL — `column "pending_deletion" does not exist`.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/114_document_pending_deletion.sql`:

```sql
-- Purge flags a document register row for later deletion instead of
-- deleting it immediately (owner decision 2026-10-01 #4, superseding the
-- fix-round-1 "register row only" ruling in documents/routes.ts).
--
-- Actual deletion is a separate, later step that does not exist yet; this
-- migration only adds the flag purge now sets.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS pending_deletion boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_deletion_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_deletion_reason text,
  ADD COLUMN IF NOT EXISTS pending_deletion_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS documents_pending_deletion_idx
  ON documents (org_id) WHERE pending_deletion;
```

- [ ] **Step 4: Exclude flagged rows from every read path**

In `apps/api/src/modules/documents/routes.ts`:

Line 181 (list): change
```ts
      `${SELECT} WHERE ${where} ORDER BY d.expires_on NULLS LAST, d.created_at DESC`, values)).rows;
```
to add the exclusion into `where` before the query runs — at line 173, change the initial clause:
```ts
    let where = 'd.org_id = $1 AND NOT d.pending_deletion';
```

Line 215 (renewals):
```ts
    const rows = (await pool.query(`${SELECT} WHERE d.org_id = $1 AND NOT d.pending_deletion`, [u.orgId])).rows;
```

Line 245 (get by id):
```ts
      `${SELECT} WHERE d.id = $1 AND d.org_id = $2 AND NOT d.pending_deletion`, [id, u.orgId])).rows[0];
```

Line 503 (due-for-purge):
```ts
    const rows = (await pool.query(`${SELECT} WHERE d.org_id = $1 AND NOT d.pending_deletion`, [u.orgId])).rows;
```

- [ ] **Step 5: Make purge flag instead of delete**

In the `POST /api/v1/documents/purge` handler (`apps/api/src/modules/documents/routes.ts:572-658`):

Change the lookup SELECT at line 576-583 to also exclude already-flagged rows (so a second purge of an already-flagged id falls into the existing `skipped` path unchanged):
```ts
      const rows = (await db.query(
        `SELECT d.id, d.title, d.legal_hold, d.issued_on, d.expires_on,
                d.owner_type, d.owner_id, d.source_type, d.source_id,
                t.retention_years, t.code AS type_code, t.basis,
                (SELECT id FROM documents s WHERE s.supersedes_id = d.id) AS successor_id
           FROM documents d JOIN document_types t ON t.id = d.type_id
          WHERE d.id = ANY($1::uuid[]) AND d.org_id = $2 AND NOT d.pending_deletion FOR UPDATE OF d`,
        [ids, u.orgId])).rows;
```

Change the write at line 649-651 from a delete to a flag:
```ts
      if (purged.length > 0) {
        await db.query(
          `UPDATE documents SET pending_deletion = true, pending_deletion_at = now(),
             pending_deletion_reason = $2, pending_deletion_by = $3
           WHERE id = ANY($1::uuid[])`,
          [rows.map(r => r.id), input.reason, u.id]);
      }
```

Update the doc comment at lines 621-624 (`// Carried straight into the audit row below ... purge removes only the register row -- never the source content`) to:
```ts
        // Carried straight into the audit row below (§46.6.3; owner
        // decision 2026-10-01 #4 supersedes the earlier "register row
        // only" ruling -- purge now flags the row for a later deletion
        // step rather than deleting it, but never touches the source
        // content either way), so the audit trail is what has to let
        // anyone later reconstruct exactly what was flagged and where its
        // content lives.
```

- [ ] **Step 6: Run the full documents test file**

Run: `npm run test --workspace=api -- documents.test.ts`
Expected: PASS — every pre-existing purge test (404-after-purge, already-purged no-op, cross-org, audit payload) still passes unchanged, plus the two new tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/database/migrations/114_document_pending_deletion.sql apps/api/src/modules/documents/routes.ts apps/api/test/catalogue/documents.test.ts
git commit -m "fix(documents): purge flags a document for later deletion instead of deleting it (owner decision 2026-10-01 #4)"
```

---

### Task 4: Crew-gate daily survey returns

**Files:**
- Modify: `apps/api/src/modules/survey/routes.ts:729-740` (add a return-specific crew-check helper), `:2461-2465` (POST /survey/entries), `:2701-2713` (PATCH /survey/entries/:id)
- Test: `apps/api/test/catalogue/survey-authority.test.ts`

**Interfaces:**
- Consumes: `workAuthority()` and `authorityCovers()` (`apps/api/src/modules/survey/routes.ts:607-658`, unchanged — this task only adds callers).
- Produces: nothing consumed by later tasks.

SG-D2 (owner decision #6, "no separate permission for amending") needs no code change: `PATCH /survey/entries/:id` already gates a past-day amendment on `survey.manage` (line 2716-2721) and a same-day amendment on `survey.enter` alone; the owner's answer confirms this existing split stays and no `survey.amend` permission is added. This task only adds a short doc-comment note confirming that, so the decision is traceable in the code.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/catalogue/survey-authority.test.ts`, after the `describe.skip("completing a stage", ...)` block (after line 214) and before `describe("recording a control point", ...)`. Reuses the `crew`/`manager`/`bystander`/`otherCrew`/`vecCrew`/`teamLead`/`ownPm`/`scopedPm`/`elsewherePm` fixtures already built in `beforeAll`:

```ts
// workDate() takes a Date, not an offset -- this mirrors the local `day`
// helper survey-billing.test.ts already defines for the same reason
// (fixture.ts has no "N days back" export).
const daysAgo = (n: number) => {
  const d = new Date(`${workDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const fileReturn = (h: Headers, village: string, date: string) =>
  post(h, "/api/v1/survey/entries",
    { survey_village_id: village, entry_date: date, teams_deployed: 1, dgps_base: 1 });

describe("filing a daily return (SV-014/SG-D1, owner decision 2026-10-01 #5)", () => {
  it("is allowed for the crew member assigned to the village", async () => {
    const r = await fileReturn(crew.headers, villageA, daysAgo(1));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
  it("is allowed for that crew member's reporting manager", async () => {
    const r = await fileReturn(manager.headers, villageA, daysAgo(2));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
  it("is allowed for a team leader, the project's PM and an admin", async () => {
    let offset = 3;
    for (const h of [teamLead.headers, ownPm.headers, scopedPm.headers, w.admin]) {
      const r = await fileReturn(h, villageA, daysAgo(offset++));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });
  it("is refused for a surveyor on the programme who is not on the crew", async () => {
    const r = await fileReturn(bystander.headers, villageA, daysAgo(10));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
  });
  it("is refused for another village's crew member", async () => {
    const r = await fileReturn(otherCrew.headers, villageA, daysAgo(11));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
  });
  it("is refused for a project manager of some other project", async () => {
    const r = await fileReturn(elsewherePm.headers, villageA, daysAgo(12));
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
  });
});

// Amending uses PATCH with If-Match, the same shape as the GCP edit test
// above (line 240-251) -- a freshly-created entry is always version 1.
const amend = (h: Headers, entryId: string, payload: unknown) =>
  send("PATCH", { ...h, "if-match": "1" } as Headers, `/api/v1/survey/entries/${entryId}`, payload);

describe("amending a daily return (SG-D1 extends to amendment too)", () => {
  // Distinct days on villageA so neither entry collides with the other, or
  // with the entries the filing describe block above already recorded on
  // villageA at daysAgo(1)..daysAgo(12).
  it("is refused for a bystander, regardless of the day (crew-gate runs before the day check)", async () => {
    const filed = await fileReturn(crew.headers, villageA, daysAgo(30));
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const r = await amend(bystander.headers, filed.data.id, { teams_deployed: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("NOT_YOUR_VILLAGE");
  });
  it("is allowed for the crew member who filed it, same day", async () => {
    // Same-day only: an earlier day would also need survey.manage
    // (PAST_DAY_AMENDMENT), which is a separate, pre-existing check this
    // test is not exercising.
    const filed = await fileReturn(crew.headers, villageA, workDate());
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const r = await amend(crew.headers, filed.data.id, { teams_deployed: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=api -- survey-authority.test.ts -t "daily return"`
Expected: FAIL — every "refused" case currently returns 201/200 because no crew gate exists yet on these two routes.

- [ ] **Step 3: Add the return-specific crew-check helper**

In `apps/api/src/modules/survey/routes.ts`, right after `requireOwnCrew` (after line 740):

```ts
  const RETURN_NOT_ASSIGNED_REASON =
    'You are not on this village’s crew. A daily return is filed or amended by '
    + 'the crew on the village, their reporting manager, a team leader, the '
    + 'project manager or an administrator.';

  /** The same five-person authority as requireOwnCrew, worded for a return. */
  async function requireCrewForReturn(
    db: Pool | PoolClient,
    u: { orgId: string; id: string; permissions: string[]; roles?: string[] },
    villageId: string,
  ) {
    if (!authorityCovers(await workAuthority(db, u, villageId), null)) {
      fail('NOT_YOUR_VILLAGE', RETURN_NOT_ASSIGNED_REASON, 403);
    }
  }
```

- [ ] **Step 4: Call it from POST /survey/entries**

At `apps/api/src/modules/survey/routes.ts:2464`, right after `const village = await villageOr404(db, u.orgId, input.survey_village_id, u);`, add:
```ts
      await requireCrewForReturn(db, u, input.survey_village_id);
```

- [ ] **Step 5: Call it from PATCH /survey/entries/:id**

At `apps/api/src/modules/survey/routes.ts:2712`, right after `await villageOr404(db, u.orgId, String(row.survey_village_id), u);`, add:
```ts
        await requireCrewForReturn(db, u, String(row.survey_village_id));
```

- [ ] **Step 6: Note the SG-D2 decision in the existing comment**

At `apps/api/src/modules/survey/routes.ts:2695-2700` (the doc comment above the `PATCH` handler), append one sentence:
```ts
   * (Owner decision 2026-10-01 #6: amending stays on this same gate -- no
   * separate survey.amend permission is added.)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test --workspace=api -- survey-authority.test.ts`
Expected: PASS, every test in the file (including the pre-existing GCP tests, unaffected).

- [ ] **Step 8: Run the full survey suite for regressions**

Run: `npm run test --workspace=api -- survey-ladder.test.ts survey-operations.test.ts survey-adversarial.test.ts survey-deep-fixes.test.ts`
Expected: PASS. If any fixture elsewhere files a return as a bystander/non-crew user relying on the old open behavior, fix that fixture to file as crew (do not weaken the new gate to make an unrelated fixture pass).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/survey/routes.ts apps/api/test/catalogue/survey-authority.test.ts
git commit -m "fix(survey): crew-gate filing and amending a daily return, like GCPs (owner decision 2026-10-01 #5/#6; SV-014/SG-D1)"
```

---

### Task 5: The stage row governs a task-linked survey stage

**Files:**
- Modify: `packages/shared/src/survey.ts:1408-1425` (`resolveStage`)
- Modify: `apps/api/src/modules/survey/routes.ts:1501-1517` (stage-blocked-by check), `:3168-3186` (`stageStatesOf`)
- Modify: `apps/api/src/modules/billing/routes.ts:815-858` (BOQ measured-quantity CTE)
- Test: `packages/shared/src/survey.test.ts:485-536`, `apps/api/test/catalogue/survey-billing.test.ts:399-455`

**Interfaces:**
- Consumes: `LinkedStage`/`ResolvedStage` types (`packages/shared/src/survey.ts:1375-1395`, unchanged shape — only `resolveStage`'s behavior changes).
- Produces: `resolveStage()` now always returns `source: 'STAGE'`; callers that only passed `linked`/`taskStatus` without the `own*` fields (the two routes.ts call sites) must be fixed to pass the row's own state directly instead, since this task removes `resolveStage`'s task-reading branch.

This is the highest-blast-radius task in the batch: it changes BOQ milestone billing eligibility (which village-stage completions count as billable), not just a dashboard number. Read `docs/qa/2026-09-24/findings-survey-gaps.md`'s SG-D3 note and the full `billing/routes.ts:788-814` comment before touching this.

- [ ] **Step 1: Write the failing tests in packages/shared**

In `packages/shared/src/survey.test.ts`, replace the two tests that assert task-wins behavior (lines 495-517) with tests asserting stage-wins behavior:

```ts
  it('reads a linked stage from its own columns, not the task (owner decision 2026-10-01 #7)', () => {
    // SG-D3: the stage row governs even when a task is linked. The task's
    // own status must not override it, or the dashboard and the internal
    // screens disagree again (SG-009).
    const r = resolveStage({
      stageCode: 'GROUND_TRUTHING', linked: true,
      taskStatus: 'DONE',
      taskStartedAt: '2026-09-02T06:00:00Z', taskCompletedAt: '2026-09-11T14:00:00Z',
      ownState: 'IN_PROGRESS', ownStartedOn: '2026-09-02', ownCompletedOn: null,
    });
    expect(r).toMatchObject({
      state: 'IN_PROGRESS', startedOn: '2026-09-02', completedOn: null, source: 'STAGE',
    });
  });

  it('reports NOT_STARTED for a linked stage with no own state, same as an unlinked one', () => {
    expect(resolveStage({ stageCode: 'X', linked: true, taskStatus: 'DONE' }).state)
      .toBe('NOT_STARTED');
  });
```

Update the two tests at lines 524-536 (`resolveStages` feeding `villageState`) to pass `ownState` instead of relying on `taskStatus`:
```ts
  it('feeds the village state from the stage rows, so a linked village completes when its stages do', () => {
    const stages = resolveStages(STAGE_CODES.map(code => ({
      stageCode: code, linked: true, taskStatus: 'TO_DO', ownState: 'COMPLETED',
    })));
    expect(villageState(village({ stages }), STAGE_CODES)).toBe('COMPLETED');
  });

  it('keeps a village open while one stage is still blocked, regardless of its task', () => {
    const stages = resolveStages(STAGE_CODES.map((code, i) => ({
      stageCode: code, linked: true, taskStatus: 'DONE',
      ownState: i === 0 ? 'ON_HOLD' : 'COMPLETED',
    })));
    expect(villageState(village({ stages }), STAGE_CODES)).toBe('IN_PROGRESS');
  });
```

Leave the `'reads an unlinked stage from its own columns'` test (lines 485-493) and the `stageStateFromTask`/`isOutOfScope` tests (lines 461-483) untouched — `stageStateFromTask` itself is not removed, only `resolveStage`'s use of it.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=@silverline/shared -- survey.test.ts -t "owner decision 2026-10-01"`
Expected: FAIL — `resolveStage` still returns the task-derived state.

- [ ] **Step 3: Simplify `resolveStage`**

In `packages/shared/src/survey.ts`, replace lines 1400-1425:

```ts
/**
 * One stage's state: always the stage row's own columns (owner decision
 * 2026-10-01 #7, SG-D3). A linked task is informational only -- its status
 * does not override the stage's own state, so the dashboard (which always
 * read the row) and the internal screens (which used to prefer the task)
 * can no longer disagree (SG-009).
 */
export function resolveStage(stage: LinkedStage): ResolvedStage {
  return {
    stageCode: stage.stageCode,
    state: stage.ownState ?? 'NOT_STARTED',
    startedOn: day(stage.ownStartedOn),
    completedOn: day(stage.ownCompletedOn),
    source: 'STAGE',
  };
}
```

Leave `LinkedStage`/`ResolvedStage`/`stageStateFromTask` types and function as-is (do not delete `stageStateFromTask` — it is a small, independently testable mapping that stays correct even though `resolveStage` no longer calls it; removing it would be scope creep beyond the owner's decision).

- [ ] **Step 4: Run the shared package tests**

Run: `npm run test --workspace=@silverline/shared -- survey.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Fix the two API call sites that only passed task fields**

In `apps/api/src/modules/survey/routes.ts`, the stage-blocked-by check (around line 1501-1517): the SQL already selects `vs.state` directly (line 1504's `vs.state`), so simplify the loop to stop deferring to the task and drop the now-unused join:

Change the query at lines 1503-1508:
```ts
          const current = (await db.query(
            `SELECT s.code, vs.state
             FROM survey_village_stages vs
             JOIN survey_stages s ON s.id = vs.stage_id
             WHERE vs.survey_village_id = $1`, [id])).rows;
```
and the loop at lines 1509-1516:
```ts
          const states: Record<string, StageState> = {};
          for (const row of current) {
            states[String(row.code)] = row.state as StageState;
          }
```

In `stageStatesOf` (`apps/api/src/modules/survey/routes.ts:3168-3186`), update the doc comment and simplify the same way:
```ts
  /**
   * A village's stage states, read from the stage rows directly (owner
   * decision 2026-10-01 #7, SG-D3): a linked task's status is
   * informational only and never overrides the stage's own state.
   */
  async function stageStatesOf(
    db: Pool | PoolClient, villageId: string,
  ): Promise<Record<string, StageState>> {
    const rows = (await db.query(
      `SELECT s.code, vs.state
         FROM survey_village_stages vs
         JOIN survey_stages s ON s.id = vs.stage_id
        WHERE vs.survey_village_id = $1`, [villageId])).rows;
    const out: Record<string, StageState> = {};
    for (const row of rows) out[String(row.code)] = row.state as StageState;
    return out;
  }
```

- [ ] **Step 6: Fix the village-listing call site's input (no behavior change needed, just confirm it still compiles)**

`apps/api/src/modules/survey/routes.ts:318-327` already passes `ownState`/`ownStartedOn`/`ownCompletedOn` alongside the task fields on every call — this now resolves correctly with no edit needed. Run `npm run typecheck --workspace=api` to confirm.

- [ ] **Step 7: Rewrite the two billing tests that assert the old task-governs behavior**

`apps/api/test/catalogue/survey-billing.test.ts` already has exactly the scenario this decision reverses, in `describe("billing only what is finished", ...)`. The route under test is `GET /api/v1/projects/:id/measured-proposal` (`apps/api/src/modules/billing/routes.ts:752`), reached in this file through the `proposal(projectId, periodTo?)` helper (line 101-103); `complete(villageId, stageCode, on)` (line 358-363) sets a stage row directly via the `/stage` API; `stageId()`/`measureId()` (lines 86-96) look up ids; `w.adminId` (exposed on `CatalogueWorld`, `fixture.ts:119`) is the actor for raw inserts.

Replace the test `"counts a stage the task board finished, not just one set by hand"` (lines 399-424) with:

```ts
  it("does not bill a stage the task board finished if its own row disagrees (owner decision 2026-10-01 #7, SG-D3)", async () => {
    // Before this decision the task governed and this billed 320. Now the
    // stage row governs: NOT_STARTED on the row means not billable, no
    // matter what the linked task's board says.
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(6), 320);

    const task = await w.pool.query(
      `INSERT INTO tasks(org_id, project_id, title, status, actual_end_at, created_by)
       VALUES($1,$2,'Ground truthing','DONE',$3::date,$4) RETURNING id`,
      [w.orgId, projectId, day(4), w.adminId]);
    await w.pool.query(
      `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state, task_id)
       VALUES($1,$2,$3,'NOT_STARTED',$4)
       ON CONFLICT (survey_village_id, stage_id)
       DO UPDATE SET task_id = EXCLUDED.task_id`,
      [w.orgId, v, await stageId("GROUND_TRUTHING"), task.rows[0].id]);

    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });
    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(0);
  });
```

Replace the test `"leaves out a task finished without an end date, and says how much"` (lines 426-455) with:

```ts
  it("leaves out a stage completed with no date, and says how much (owner decision 2026-10-01 #7 moves this from the task's dating to the stage row's own)", async () => {
    const { programmeId, projectId, boqItemId } = await programme();
    const v = await village(programmeId);
    await record(v, day(4), 275);

    // The stage row itself says COMPLETED, with no completed_on -- the
    // undated case now lives on the row, not on a linked task's end date.
    await w.pool.query(
      `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state, completed_on)
       VALUES($1,$2,$3,'COMPLETED',NULL)
       ON CONFLICT (survey_village_id, stage_id)
       DO UPDATE SET state = 'COMPLETED', completed_on = NULL`,
      [w.orgId, v, await stageId("GROUND_TRUTHING")]);

    await link(projectId, {
      boq_item_id: boqItemId, measure_id: await measureId(),
      stage_id: await stageId("GROUND_TRUTHING"),
    });

    const r = await proposal(projectId);
    expect(r.data.lines[0].cumulativeQuantity).toBe(0);
    expect(r.data.lines[0].undated_villages).toBe(1);
    expect(r.data.lines[0].undated_quantity).toBe(275);
    expect(r.data.lines[0].flags).toContain("UNDATED_COMPLETIONS");
  });
```

Leave every other test in the file untouched, including `"counts a village once it has completed the gating stage"` (uses `complete()`, i.e. the stage row directly — already matches the new rule) and `"counts everything when no stage gates the line"`.

- [ ] **Step 8: Run to verify failure**

Run: `npm run test --workspace=api -- survey-billing.test.ts`
Expected: FAIL on both rewritten tests — today's code still bills off the task (`DONE`) for the first, and does not treat the stage-row-only completion as undated for the second (it still looks for a linked task before considering a row "finished").

- [ ] **Step 9: Fix the BOQ measured-quantity CTE**

In `apps/api/src/modules/billing/routes.ts`, replace lines 820-839:

```ts
           LEFT JOIN LATERAL (
             WITH counted AS (
               SELECT e.survey_village_id,
                      ev.quantity,
                      (vs.state = 'COMPLETED') AS finished,
                      vs.completed_on AS finished_on
                 FROM survey_entries e
                 JOIN survey_entry_values ev
                   ON ev.entry_id = e.id AND ev.measure_id = l.measure_id
                 JOIN survey_villages sv ON sv.id = e.survey_village_id
                 JOIN survey_projects sp ON sp.id = sv.survey_project_id
                 LEFT JOIN survey_village_stages vs
                   ON vs.survey_village_id = sv.id AND vs.stage_id = l.stage_id
                WHERE e.org_id = l.org_id
                  AND sp.project_id = b.project_id
                  AND e.entry_date <= $3::date
             )
```

Update the comment at lines 788-801 to match:
```ts
      /*
       * Every line's measured total, in one pass.
       *
       * This was a query per BOQ line. A BOQ runs to tens of lines rather
       * than thousands so it was never going to fall over, but a round trip
       * per line is a shape that only gets worse, and the stage gate is the
       * one thing that differs per line -- which a lateral handles without
       * giving any of it up.
       *
       * A stage is complete when its own row says COMPLETED (owner decision
       * 2026-10-01 #7, SG-D3) -- a linked task's status no longer overrides
       * it, so a village whose board shows the task Done but whose stage
       * row disagrees is not billed until the stage row itself is updated.
       *
       * Dates come out in UTC because that is the date the screens show --
       * a bill that disagrees with the stage date on the village page would
       * be a second thing to reconcile, which is the problem this feature
       * exists to remove.
       */
```

- [ ] **Step 10: Run to verify it passes, then the full billing suite**

Run: `npm run test --workspace=api -- survey-billing.test.ts`
Expected: PASS, both rewritten tests and every other test in the file.

Run: `npm run test --workspace=api -- billing`
Expected: PASS across every billing test file. Read any remaining failure carefully — a fixture elsewhere that relied on a linked task's `DONE` status to make a village billable (stage row itself left `NOT_STARTED`/`IN_PROGRESS`) needs its stage row's own state set to match, since that fixture was exercising behavior the owner has now explicitly reversed.

- [ ] **Step 11: Run the full survey + billing + shared suites**

Run: `npm run test --workspace=@silverline/shared && npm run test --workspace=api -- survey billing`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/survey.ts packages/shared/src/survey.test.ts apps/api/src/modules/survey/routes.ts apps/api/src/modules/billing/routes.ts apps/api/test/catalogue/
git commit -m "fix(survey): the stage row governs a task-linked stage, not the task (owner decision 2026-10-01 #7; SG-D3/SG-009)"
```

---

### Task 6: Document the confirmed survey billing lifecycle

**Files:**
- Modify: `docs/REQUIREMENTS_LAND_SURVEY.md` (add a lifecycle section; insert near the existing billing/milestone requirements — search the file for `§59.7` or `billing` to place it correctly)
- Modify: `packages/shared/src/survey.ts:2164-2240` (add one comment line; no behavior change)

**Interfaces:**
- Consumes: `BILLING_STATUSES`, `BILLING_TRANSITIONS`, `BILLING_REVERSAL_TARGET` (`packages/shared/src/survey.ts:2164,2221-2225,2240` — already implement exactly this lifecycle; confirmed, not changed).

No behavior changes here — `BILLING_TRANSITIONS` (`SUBMITTED → APPROVED/REJECTED/PAID`, `APPROVED → PAID/REJECTED/SUBMITTED`, `REJECTED → SUBMITTED`, `PAID → []`) and `BILLING_REVERSAL_TARGET = 'APPROVED'` already match the owner's confirmation exactly. This task only closes the open gap noted in `docs/qa/2026-09-24/overnight-report.md` item 8 ("the requirements doc doesn't define it") by writing the confirmed lifecycle into the requirements doc and pointing the code at it.

- [ ] **Step 1: Add the lifecycle section to the requirements doc**

In `docs/REQUIREMENTS_LAND_SURVEY.md`, add (placed near the existing billing/milestone section — grep the file for `§59.7` first and insert directly after that section so it sits with the other billing requirements):

```markdown
### §59.7.2 Survey billing claim lifecycle (owner decision 2026-10-01 #8)

Confirmed, closing the gap this document previously left open:

    SUBMITTED -> APPROVED | REJECTED | PAID
    APPROVED  -> PAID | REJECTED | SUBMITTED
    REJECTED  -> SUBMITTED
    PAID      -> (terminal; only an admin reversal moves it, back to APPROVED)

An admin may reverse a PAID claim, which returns it to APPROVED -- the
department accepted the work; only the payment is being undone. Reversing
further back to SUBMITTED is not a one-step admin action; a REJECTED claim
is resubmitted (SUBMITTED) by the normal claim flow.

Implemented in `packages/shared/src/survey.ts` (`BILLING_STATUSES`,
`BILLING_TRANSITIONS`, `BILLING_REVERSAL_TARGET`).
```

- [ ] **Step 2: Point the code at the confirmation**

In `packages/shared/src/survey.ts`, above the `BILLING_TRANSITIONS` constant (around line 2220), add one line to the existing comment (or a new one-line comment if none exists there) noting: `// Confirmed as the spec (owner decision 2026-10-01 #8); see docs/REQUIREMENTS_LAND_SURVEY.md §59.7.2.`

- [ ] **Step 3: Run the shared test suite to confirm no behavior changed**

Run: `npm run test --workspace=@silverline/shared -- survey.test.ts`
Expected: PASS, unchanged — this task is additive documentation only.

- [ ] **Step 4: Commit**

```bash
git add docs/REQUIREMENTS_LAND_SURVEY.md packages/shared/src/survey.ts
git commit -m "docs(survey): record the confirmed billing claim lifecycle in the requirements (owner decision 2026-10-01 #8)"
```
