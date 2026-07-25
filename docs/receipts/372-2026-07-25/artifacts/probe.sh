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
for path in / /chats /repositories /agents /runtime /secrets /logs /chats/120363000 "/chats/120363000@g.us"; do
  curl -s -o /dev/null -w "  GET $path -> %{http_code} %{content_type}\n" "$ORIGIN$path"
done
curl -s -o /dev/null -w "  GET /assets/missing.js -> %{http_code} (a named file that misses is a real 404)\n" "$ORIGIN/assets/missing.js"

echo
echo "== nothing outside the shell directory, and nothing that throws =="
# --path-as-is: curl must not normalise these away before they reach the server.
for escape in /../../etc/passwd.js "/%2e%2e/%2e%2e/etc/passwd.js" /assets/../../secret.js /http:/evil.com/x.js "/%68ttp:/evil.com/x.js" /../web-secrets/token.js; do
  curl -s --path-as-is -o /dev/null -w "  GET $escape -> %{http_code}\n" "$ORIGIN$escape"
done
curl -s -o /dev/null -w "  GET / -> %{http_code} (still serving: none of the above killed the process)\n" "$ORIGIN/"
curl -s -o /dev/null -D - "$ORIGIN/" | grep -i "x-content-type-options\|cache-control" | sed 's/^/  /'

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
