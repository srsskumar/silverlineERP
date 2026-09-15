#!/usr/bin/env bash
# Deploy both apps to production.
#
# Run from the repo root: Vercel's root directory is apps/api and apps/web
# respectively, so the CLI must be pointed at each project by id rather than
# invoked from inside the workspace.
#
# If a deployment comes back BLOCKED, it is the account's daily deployment
# cap rather than the build — check with:
#   vercel ls silverline-api --prod
set -euo pipefail
ORG=team_7OwtRsWDOIXIEYhpkIvsItUI
API=prj_EO16yIr6JfxvmowOUibOdlfWQxjv
WEB=prj_QzBoJ2UHCVksFjQKw52NAvmtSnYe

echo "Deploying the API…"
VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$API npx vercel deploy --prod --yes
echo "Deploying the web app…"
VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$WEB npx vercel deploy --prod --yes
