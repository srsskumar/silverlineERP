#!/usr/bin/env bash
# Deploy both apps to production.
#
# Run from the repo root: Vercel's root directory is apps/api and apps/web
# respectively, so the CLI must be pointed at each project by id rather than
# invoked from inside the workspace.
#
# A deployment that comes back BLOCKED is not a build failure and not a rate
# limit: it is Vercel refusing a commit whose author it cannot verify as a
# member of the team (blockCode TEAM_ACCESS_REQUIRED). It does not clear on
# its own, so waiting is the one response that never works.
#
# Read the real reason rather than inferring it from the status:
#   curl -s "https://api.vercel.com/v13/deployments/<url>?teamId=$ORG" \
#     -H "Authorization: Bearer $TOKEN" | jq .readyStateReason
#
# The fix is to make the commit author verifiable: connect the GitHub account
# to the Vercel login, invite it to the team, or commit as the team owner.
# This repo takes the last of those, in its local git config.
set -euo pipefail
ORG=team_7OwtRsWDOIXIEYhpkIvsItUI
API=prj_EO16yIr6JfxvmowOUibOdlfWQxjv
WEB=prj_QzBoJ2UHCVksFjQKw52NAvmtSnYe

echo "Deploying the API…"
VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$API npx vercel deploy --prod --yes
echo "Deploying the web app…"
VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$WEB npx vercel deploy --prod --yes
