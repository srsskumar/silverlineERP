#!/usr/bin/env bash
# Verifies the local-only QA site is up and talking to itself, not the
# public origin. Run on the VM after silverline-deploy-qa.
set -euo pipefail
echo "==> checking QA site responds on loopback"
curl -fsS http://127.0.0.1:8081/ -o /dev/null
echo "==> checking the baked API origin matches the QA site's own origin"
# Note: curl can confirm the API origin was baked into a reachable JS chunk,
# but cannot verify a real browser's CSP behavior — that requires an actual
# browser test, which is what this QA build unblocks.
CHUNK=$(curl -fsS http://127.0.0.1:8081/ | grep -o '/_next/static/chunks/[^"]*\.js' | head -1)
if [ -z "$CHUNK" ]; then
  echo "FAIL: no JS chunk reference found in the served page" >&2
  exit 1
fi
BUNDLE_REF=$(curl -fsS "http://127.0.0.1:8081$CHUNK" | grep -o 'http://127\.0\.0\.1:8081[^"]*' | head -1 || true)
if [ -z "$BUNDLE_REF" ]; then
  echo "FAIL: no reference to http://127.0.0.1:8081 found in that chunk -- try another chunk reference, or note that curl cannot verify the browser-side CSP story at all and this check only confirms the origin string was baked in somewhere reachable" >&2
  exit 1
fi
echo "==> checking the API proxy on the QA site answers"
curl -fsS http://127.0.0.1:8081/health -o /dev/null
echo "OK"
