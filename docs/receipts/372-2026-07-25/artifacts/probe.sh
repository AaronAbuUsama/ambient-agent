#!/usr/bin/env bash
# Tier 4 readback for #372, run against the *installed tarball*, not the working tree.
#   ORIGIN=http://127.0.0.1:4757 TOKEN=... INSTALLED=<dir with dist/web> bash probe.sh
set -u
ORIGIN=${ORIGIN:-http://127.0.0.1:4757}
TOKEN=${TOKEN:?set TOKEN}
INSTALLED=${INSTALLED:?set INSTALLED}

echo "== the /api/ gate is unchanged (#364) =="
curl -s -o /dev/null -w "  GET /api/status   no token  -> %{http_code}\n" "$ORIGIN/api/status"
curl -s -o /dev/null -w "  GET /api/unknown  no token  -> %{http_code}\n" "$ORIGIN/api/unknown"
curl -s -o /dev/null -w "  GET /api/status   token     -> %{http_code}\n" -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/status"
curl -s -o /dev/null -w "  GET /api/unknown  token     -> %{http_code}\n" -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/unknown"

echo
echo "== the static shell is unauthenticated, and every route deep-links =="
for path in / /chats /repositories /agents /runtime /secrets /logs /chats/120363000; do
  curl -s -o /dev/null -w "  GET $path -> %{http_code} %{content_type}\n" "$ORIGIN$path"
done
curl -s -o /dev/null -w "  GET /assets/missing.js -> %{http_code} (a named file that misses is a real 404)\n" "$ORIGIN/assets/missing.js"
curl -s -o /dev/null -w "  GET /../../etc/passwd.js -> %{http_code} (no escape from the shell directory)\n" "$ORIGIN/../../etc/passwd.js"
curl -s -o /dev/null -w "  GET /%2e%2e/%2e%2e/etc/passwd.js -> %{http_code}\n" "$ORIGIN/%2e%2e/%2e%2e/etc/passwd.js"

echo
echo "== the nonce this build was stamped with, read back off the wire =="
curl -s "$ORIGIN/" | grep build-nonce

echo
echo "== the served asset bytes are the installed asset bytes =="
for asset in $(cd "$INSTALLED/dist/web" && ls assets); do
  served=$(curl -s "$ORIGIN/assets/$asset" | shasum -a 256 | cut -d' ' -f1)
  built=$(shasum -a 256 "$INSTALLED/dist/web/assets/$asset" | cut -d' ' -f1)
  [ "$served" = "$built" ] && verdict=match || verdict=MISMATCH
  echo "  $verdict  $served  assets/$asset"
done
served=$(curl -s "$ORIGIN/" | shasum -a 256 | cut -d' ' -f1)
built=$(shasum -a 256 "$INSTALLED/dist/web/index.html" | cut -d' ' -f1)
[ "$served" = "$built" ] && verdict=match || verdict=MISMATCH
echo "  $verdict  $served  index.html"
