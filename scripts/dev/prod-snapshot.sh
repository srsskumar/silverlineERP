#!/usr/bin/env bash
# A local copy of production to dry-run a migration against.
#
# Every migration in this project is rehearsed on production-shaped data
# before it touches production, and the dump behind that rehearsal is thirty-odd
# megabytes over the network from ap-south-1 — two to three minutes each time,
# paid again for every attempt at a migration that needed three.
#
# So the dump is cached and reused until it goes stale. Pass --fresh to force a
# new one; the age is deliberately short, because a stale rehearsal is worse
# than a slow one.
#
#   scripts/dev/prod-snapshot.sh [scratch-db-name] [--fresh]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH="${1:-silverline_dryrun}"
CACHE="${TMPDIR:-/tmp}/silverline-prod-snapshot.sql"
MAX_AGE_MIN=180

[ "${2:-}" = "--fresh" ] && rm -f "$CACHE"

DB="$(grep '^DATABASE_URL' "$ROOT/apps/api/.env" | cut -d= -f2-)"
[ -n "$DB" ] || { echo "no DATABASE_URL in apps/api/.env" >&2; exit 1; }

if [ -f "$CACHE" ] && [ -z "$(find "$CACHE" -mmin +$MAX_AGE_MIN)" ]; then
  echo "==> reusing snapshot from $(( ( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || stat -c %Y "$CACHE") ) / 60 )) minutes ago"
else
  echo "==> dumping production (cached for ${MAX_AGE_MIN}m)"
  PGSSLMODE=require pg_dump "$DB" --schema=public --no-owner --no-privileges -f "$CACHE"
fi

echo "==> rebuilding $SCRATCH"
dropdb --if-exists "$SCRATCH"
createdb "$SCRATCH"
psql -q -d "$SCRATCH" -f "$CACHE" 2>&1 | grep -c '^ERROR' | xargs -I{} echo "    restore errors: {}"
echo "==> ready: postgresql://localhost:5432/$SCRATCH?sslmode=disable"
