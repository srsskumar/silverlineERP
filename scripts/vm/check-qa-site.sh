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
# The first chunk index.html references is usually Next's webpack runtime,
# not the one carrying NEXT_PUBLIC_API_URL, so every referenced chunk is
# checked and the first one containing the origin passes. `|| true` keeps a
# grep no-match from killing the script under `set -e` before it can say FAIL.
API_ORIGIN='http://127.0.0.1:8081'
CHUNKS=$(curl -fsS http://127.0.0.1:8081/ | grep -o '/_next/static/chunks/[^"]*\.js' | sort -u || true)
if [ -z "$CHUNKS" ]; then
  echo "FAIL: no JS chunk reference found in the served page" >&2
  exit 1
fi
FOUND_IN=""
for CHUNK in $CHUNKS; do
  BODY=$(curl -fsS "http://127.0.0.1:8081$CHUNK" || true)
  if grep -qF "$API_ORIGIN" <<<"$BODY"; then
    FOUND_IN="$CHUNK"
    break
  fi
done
if [ -z "$FOUND_IN" ]; then
  echo "FAIL: no reference to $API_ORIGIN found in any of the $(wc -w <<<"$CHUNKS") JS chunks the served page references -- note that curl cannot verify the browser-side CSP story at all; this check only confirms the origin string was baked in somewhere reachable" >&2
  exit 1
fi
echo "    found in $FOUND_IN"
echo "==> checking the API proxy on the QA site answers"
curl -fsS http://127.0.0.1:8081/health -o /dev/null
echo "OK"
