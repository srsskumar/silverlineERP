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
