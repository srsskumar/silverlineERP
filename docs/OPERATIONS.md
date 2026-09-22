# Operations and release runbook

## The live deployment: one VM

Production runs on a single GCP VM, `dev-thor` (34.131.134.217), plain HTTP on port 80. Everything the server needs is in `scripts/vm/` and is installed by the deploy script, so the server can be rebuilt from the repository:

| Piece | How it runs | Source |
| --- | --- | --- |
| API | `silverline-api.service`: `node dist/main.js` in `/opt/silverline/apps/api`, listening on 127.0.0.1:3101 only | `scripts/vm/silverline-api.service` |
| Configuration | `/etc/silverline/api.env`, root-only, outside the tree so `rsync --delete` never touches it | written once by hand |
| Web | Static export served by nginx from `/opt/silverline-web/current`, a symlink to one of the last five builds in `/opt/silverline-web/releases/` | `scripts/vm/nginx-silverline.conf` |
| Worker | `silverline-worker.timer`, one pass about every five minutes, calling `/api/v1/jobs/run` with `CRON_SECRET`. Enabled. | `scripts/vm/silverline-worker.*` |
| Database | Supabase PostgreSQL (`DATABASE_URL` in `api.env`) | — |
| Uploads | Stored encrypted in the database. `/var/lib/silverline/uploads` is only the read fallback for files from before that change. | — |
| Malware scanner | ClamAV in Docker (`silverline-clamav`, 127.0.0.1:3310, restart unless-stopped). The API fails every upload closed without it. | `scripts/vm/silverline-clamav.sh` |

nginx is the only public door: it serves the web, proxies `/api/` and `/health`, sets the security headers, and redirects canonical record URLs (`/projects/<id>` and the rest) to `/record?type=&id=`, the one page the static export can serve for any id.

**Deploy** — from a workstation, ship the committed tree (see the header of `scripts/vm/silverline-deploy` for the exact commands, including the Windows form), then `sudo silverline-deploy` on the VM. It builds, refuses to restart while migrations are pending, restarts the API, then switches the web symlink and installs the nginx site (only if `nginx -t` accepts it).

**Migrations** are a deliberate step, never a side effect of a deploy. Back up first — the VM has no PostgreSQL client, so use the image:

```sh
set -a; . /etc/silverline/api.env; set +a
docker run --rm -v /var/backups/silverline:/out -e PGURL="$DATABASE_URL" postgres:16 \
  sh -c 'pg_dump --format=custom --no-owner "$PGURL" > /out/pre-migrate-$(date -u +%Y%m%dT%H%M%SZ).dump'
cd /opt/silverline/apps/api && sudo -u dev-thor env DATABASE_URL="$DATABASE_URL" npx tsx src/database/migrate.ts
```

**Roll back the web** by pointing the symlink at the previous release: `sudo ln -sfn /opt/silverline-web/releases/<previous> /opt/silverline-web/current`. The API has no release history on the VM; roll it back by deploying the previous commit.

**Look at it** with `systemctl status silverline-api`, `journalctl -u silverline-api -f`, `systemctl list-timers silverline-worker.timer`, and `curl http://127.0.0.1/health`.

Not done yet, and needed before this is more than a pilot: TLS (it needs a domain), a scheduled off-machine backup of the database, and a second environment to try releases on.

The rest of this document describes the Compose release below, which is the self-hosted alternative, and procedures that apply to both.

## Release configuration (Compose alternative)

`compose.release.yml` supplies PostgreSQL, the API, a migration service, the background worker, ClamAV, and a Caddy web/TLS edge. It is a single-host deployment template, not a highly available production topology. Keep database, ClamAV and private storage ports off the public network.

Prepare an untracked release environment file with `POSTGRES_PASSWORD`, `RELEASE_DATABASE_URL` (database host `db`), `JWT_SECRET`, `ENCRYPTION_KEY`, `SEED_ADMIN_PASSWORD`, and `PUBLIC_HOST`. Use independent generated secrets. The web API URL is compiled into its static export; changing the public host requires rebuilding web and mobile artifacts. Configure DNS and inbound ports 80/443 for Caddy's certificate issuance.

```sh
docker compose --env-file .env.release -f compose.release.yml build
docker compose --env-file .env.release -f compose.release.yml up -d
docker compose --env-file .env.release -f compose.release.yml run --rm api node apps/api/dist/database/seed.js
```

The API/worker wait for successful migrations. ClamAV signature initialization can take several minutes; production file uploads fail closed if scanning is unavailable. Do not enable `PUSH_ENABLED` until the Expo project, credentials and device tokens have been verified. Webhooks require configured HTTPS subscriptions; creation and actions are audited. No live provider delivery is performed by the local test suite.

The worker command outside Docker is `npm run worker --workspace=apps/api`. Run at least one worker. PostgreSQL advisory locking coordinates multiple worker processes; inspect execution/delivery errors in Administration/Automation and the database when troubleshooting. Retry attempts are bounded and retain failure details.

## Monitoring and incidents

`GET /health` checks database connectivity. Production API logs include request ID, route pattern, status and duration; request bodies, authorization headers and SQL error details are excluded. `GET /api/v1/operations/metrics` requires organization-wide `admin.configure` and reports process-local request/error/latency counters and pool state. Scrape it into the deployment's monitoring system and alert on elevated 5xx responses, database waiting connections, failed worker jobs, storage capacity and backup age.

For an incorrect business record, use its documented correction/reopen workflow and retain the reason. Do not edit locked payroll or delete ledger/audit records directly. Revoke compromised users/devices, rotate exposed credentials, and preserve relevant request IDs and audit events. Revocation blocks subsequent API access; an offline device receives a wipe instruction when it reconnects. It cannot be remotely erased while disconnected.

## Encrypted database backup and restore

Install PostgreSQL client tools matching the server. Set `DATABASE_URL`, a separate 64-hex `BACKUP_KEY`, and `BACKUP_DIR`, then run:

```sh
node scripts/backup.mjs
```

The script streams a custom-format `pg_dump` into AES-256-GCM encryption and restricts local file permissions. Store the backup key separately. Copy completed backups to another fault domain and monitor completion/size. Database dumps alone do not include uploaded files: separately snapshot and replicate the private-files volume, preserve its `ENCRYPTION_KEY`, and reconcile file checksums with document/report metadata. Coordinate the database and file snapshots during a maintenance window or through a consistent managed snapshot facility. Configure managed PostgreSQL WAL archiving/PITR for the agreed recovery point target; the supplied dump script does not implement PITR.

Create a fresh, empty recovery database with a name ending in `_restore`. Set `RESTORE_DATABASE_URL` and the original `BACKUP_KEY`, then run:

```sh
node scripts/restore.mjs /path/to/completed-backup.pg.enc
```

The restore script verifies the authentication tag before restoring and refuses a populated target. Recover private files and the application encryption key, run pending migrations, verify row counts and document checksums, and exercise authentication, payroll, inventory and downloads. Record restore duration and recovered timestamp. Promote the recovered deployment only after reconciliation. Rehearse this procedure regularly; do not infer the required RPO/RTO from a successful local dump.

## Upgrade, migration and rollback

Back up the database and private files before an upgrade. Use a dedicated staging deployment with representative anonymized data. Run migrations, permission checks and business acceptance tests there first. SQL migrations are ordered and append-only. Roll back application artifacts only when the previous version remains compatible with the new schema; otherwise restore into a separate environment and reconcile writes before promotion.

Legacy uploads created before encryption was introduced may still exist in plaintext. Migrate them with `scripts/encrypt-legacy-files.mjs` under a maintenance window, then verify checksums and recovery. Never change encryption keys without a reviewed re-encryption procedure.

## Business and device acceptance

Use the source requirement's sections 23 and 27 for sign-off. Required field checks include real-device camera watermark readability, GPS accuracy/mock-location handling, biometric/PIN fallback, cold start, dark mode, offline capture → app restart → reconnect, duplicate retry, conflict recovery, notifications and device revocation/wipe. Verify permissions with separate employee, HR, payroll, inventory, PM/TL, client and auditor accounts.

Operations/Finance must approve payroll formulas, leave policy, geographic master codes, GPS tolerance, escalation rules, retention, external SMS/weather/accounting providers and AI review policy. Test representative employee exit, payroll lock, stock race, dependency blocking, project close, automation rejection and cycle rollover cases. Record load-test results, migration reconciliation, training completion and UAT approval before go-live.
