#!/usr/bin/env bash
# Run ClamAV for the API on this host, in Docker, on loopback only.
#
# Every upload is scanned before it is stored (apps/api/src/common/
# fileSafety.ts), and without a scanner the API fails closed: a 503 on every
# evidence photo, employee document and import. The VM ran for a week that
# way, because nothing installed a scanner and nothing said one was missing.
#
# Idempotent: run it again after a reboot or to pick up a newer image. The
# signature database lives in the named volume and survives the container.
# The API reads MALWARE_SCANNER_HOST=127.0.0.1 and MALWARE_SCANNER_PORT=3310
# from /etc/silverline/api.env.
#
# clamd takes a few minutes on first start to download signatures; until it
# listens, uploads still get the 503. `docker logs silverline-clamav` shows
# when it is ready.
set -euo pipefail

docker pull clamav/clamav:stable
docker rm -f silverline-clamav >/dev/null 2>&1 || true
docker run -d --name silverline-clamav --restart unless-stopped \
  -p 127.0.0.1:3310:3310 \
  -v silverline-clamav-db:/var/lib/clamav \
  clamav/clamav:stable
echo "==> silverline-clamav started; waiting for clamd"
for _ in $(seq 1 60); do
  if docker exec silverline-clamav clamdscan --ping 1 >/dev/null 2>&1; then
    echo "==> clamd is answering on 127.0.0.1:3310"
    exit 0
  fi
  sleep 10
done
echo "!! clamd not answering after 10 minutes; see: docker logs silverline-clamav"
exit 1
