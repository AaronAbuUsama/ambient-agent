#!/usr/bin/env bash
# Tier 3 + tier 4 for node #364, verbatim. Run from the repo root after `pnpm run build`:
#
#   NONCE=n364-$(openssl rand -hex 6) OUT=/tmp/364 bash docs/receipts/364-2026-07-25/artifacts/live-proof.sh
#
# It builds two throwaway managed installations under a temporary $HOME, drives the built binary
# exactly as an operator would, and writes one artifact per run into $OUT/artifacts. Token values are
# masked as they are captured, never edited afterwards. The WhatsApp store is created fresh by the
# fixture and never copied from anywhere.
set -u
W=$(pwd)
: "${NONCE:?mint a fresh nonce}"; : "${OUT:?set an output directory}"
CP=${CP:-47474}
mkdir -p "$OUT/artifacts" "$OUT/home"
export HOME="$OUT/home"
D="$HOME/.ambient-agent-$NONCE"           # run A/C: unconfigured, then a broken credential
D2="$HOME/.ambient-agent-$NONCE-boot"     # run E/F: a runtime that actually boots
BIN="$W/dist/cli/main.js"
FIXTURE="$W/tests/fixtures/packed-runtime.mjs"
HEAD=$(git -C "$W" rev-parse HEAD)
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mask() { sed -E 's#(unpersisted until .* exists: ).*#\1<REDACTED — ephemeral, this run only>#'; }
sha() { node -e 'const{createHash}=require("node:crypto");console.log(createHash("sha256").update(process.argv[1]).digest("hex"))' "$1"; }
tokenOf() { node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).token)' "$1"; }
pretty() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})'; }
http() { curl -isS "$@" | sed -e 's/\r$//' -e '/^Date:/d'; }
waitFor() { for _ in $(seq 1 120); do curl -sS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.25; done; return 1; }
# `exec`, so $! is the node process itself and not a subshell wrapping it: killing the wrapper leaves
# the server bound, the next run dies on EADDRINUSE, and the run after that reclaims a stale lock and
# looks like a passing single-instance test. Found by this proof; guarded below so it cannot recur.
control() { ( cd "$HOME"; exec env ${1:+NODE_OPTIONS="--import=$FIXTURE"} node "$BIN" --data-dir "$2" --control-port "$3" ) > "$4" 2>&1 & }
bound() { grep -q "Control plane listening on" "$1" || { echo "PROOF ABORTED — the control plane did not bind. Capture:"; cat "$1"; exit 1; }; }
stop() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; for _ in $(seq 1 40); do curl -sS -o /dev/null "http://127.0.0.1:$CP/api/status" 2>/dev/null || return 0; sleep 0.25; done
         echo "PROOF ABORTED — port $CP still answering after stopping pid $1"; exit 1; }

cat > "$OUT/github-apps.json" <<'JSON'
{"coder":{"appId":"100","installationId":"200","privateKey":"-----BEGIN RSA PRIVATE KEY-----\nproof-coder-key\n-----END RSA PRIVATE KEY-----\n"},
 "reviewer":{"appId":"101","installationId":"201","privateKey":"-----BEGIN RSA PRIVATE KEY-----\nproof-reviewer-key\n-----END RSA PRIVATE KEY-----\n"},
 "planner":{"appId":"102","installationId":"202","privateKey":"-----BEGIN RSA PRIVATE KEY-----\nproof-planner-key\n-----END RSA PRIVATE KEY-----\n"}}
JSON
chmod 600 "$OUT/github-apps.json"

# ---------------------------------------------------------------- baseline: the nonce appears nowhere
{
  echo "# Baseline — the nonce appears nowhere yet, $(utc)"
  echo "nonce: $NONCE"; echo "head:  $HEAD"; echo
  echo "\$ git grep -c $NONCE \$(git rev-parse HEAD) -- ."
  git -C "$W" grep -c "$NONCE" "$HEAD" -- . || echo "(no matches) exit=$?"
  echo; echo "\$ grep -rc $NONCE dist/"
  grep -rc "$NONCE" "$W/dist" || echo "(no matches) exit=$?"
  echo; echo "\$ ls -d \$D   # the data directory must not exist yet"
  ls -d "$D" 2>&1 || true
} > "$OUT/artifacts/01-baseline-nonce-absent.txt"

# ------------------------------------------------------------------------- run A: nothing configured
{
  echo "# Tier 3 (live) — run A: no configuration present"
  echo "# $(utc)   nonce $NONCE   head $HEAD"
  echo "# The nonce is the data directory's own name, so every path-bearing line names this run."
  echo; echo "\$ node dist/cli/main.js --data-dir \$D --control-port $CP  &"
} > "$OUT/artifacts/03-tier3-unconfigured.txt"
control "" "$D" "$CP" "$OUT/runA.raw"
RUN_A=$!
waitFor "http://127.0.0.1:$CP/api/status"; bound "$OUT/runA.raw"
mask < "$OUT/runA.raw" >> "$OUT/artifacts/03-tier3-unconfigured.txt"
{
  echo; echo "# stdout is a pipe here, not a terminal, so the first-run token is withheld — under a"
  echo "# service manager stdout is the journal. The 401s below are what an unauthorized caller sees."
  echo; echo "\$ curl -isS http://127.0.0.1:$CP/api/status                     # no Authorization header"
  http "http://127.0.0.1:$CP/api/status"
  echo; echo "\$ curl -isS -H 'Authorization: Bearer guessed' .../api/status"
  http -H "Authorization: Bearer guessed" "http://127.0.0.1:$CP/api/status"
  echo; echo "\$ ls -d \$D   # an unconfigured control plane must not create the data directory"
  ls -d "$D" 2>&1 || true
  echo; echo "\$ ps -p $RUN_A -o pid=,stat=   # still up"
  ps -p "$RUN_A" -o pid=,stat=
} >> "$OUT/artifacts/03-tier3-unconfigured.txt"
stop "$RUN_A"

# The other half of that branch — the token *is* printed when a human is at the terminal, and the
# printed value authenticates — is asserted at tier 1 (tests/managed/control-plane.test.ts, "reports
# not configured rather than erroring…" with interactive: true). It is not driven here: allocating a
# pty from a scripted run proved to be a flaky harness rather than better evidence.

# ------------------------------------------------------------- run B: build a real installation to use
{
  echo "# Tier 3 (live) — run B: the real managed installation the rest of the run proves against"
  echo "# $(utc)   nonce $NONCE"
  echo "# whatsappd / @octokit/rest / e2b / the ChatGPT device endpoints are the repo's own"
  echo "# tests/fixtures/packed-runtime.mjs stand-ins — the same ones tests/packaging/packed-cli.test.ts"
  echo "# uses to reach a real data directory without a pairing ceremony. The whatsapp/ store is created"
  echo "# fresh and never copied. Nothing in the node under proof is stubbed."
  echo; echo "\$ node dist/cli/main.js --data-dir \$D init --authorize --chat 120363000@g.us --repository owner/repo --github-apps-file <file>"
  NODE_OPTIONS="--import=$FIXTURE" node "$BIN" --data-dir "$D" init --authorize \
    --chat "120363000@g.us" --repository "owner/repo" --github-apps-file "$OUT/github-apps.json" 2>&1
  echo "exit=$?"
  echo; echo "\$ ls \$D/credentials   # note: init does not mint control-plane.json"
  ls "$D/credentials"
} > "$OUT/artifacts/04-tier3-install.txt" 2>&1

# ------------------------------------------------------------- run C: a deliberately broken credential
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const [config, credential] = process.argv.slice(1);
const parsed = JSON.parse(readFileSync(config, "utf8"));
const profile = { id: "gpt-5.4-mini", thinkingLevel: "low" };
parsed.model = { provider: "openai", credential: "api-key",
  profiles: Object.fromEntries(["speaker","scribe","planner","coder","verifier"].map((r) => [r, profile])) };
writeFileSync(config, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
writeFileSync(credential, JSON.stringify({ schemaVersion: 1, kind: "api-key",
  provider: "anthropic", apiKey: "sk-ant-pasted-into-the-wrong-install" }, null, 2) + "\n", { mode: 0o600 });
' "$D/config.json" "$D/credentials/model-api-key.json"
{
  echo "# Tier 3 (live) — run C: deliberately broken credential; the control plane must stay up and report it"
  echo "# $(utc)   nonce $NONCE   head $HEAD"
  echo; echo "\$ cat \$D/credentials/model-api-key.json   # a key issued for a provider this install does not use"
  cat "$D/credentials/model-api-key.json"
  echo; echo "\$ node dist/cli/main.js --data-dir \$D --control-port $CP  &"
} > "$OUT/artifacts/05-tier3-broken-credential.txt" 2>&1
control "" "$D" "$CP" "$OUT/runC.raw"
RUN_C=$!
waitFor "http://127.0.0.1:$CP/api/status"; sleep 2; bound "$OUT/runC.raw"
cat "$OUT/runC.raw" >> "$OUT/artifacts/05-tier3-broken-credential.txt"
TOKEN_C=$(tokenOf "$D/credentials/control-plane.json"); echo "$TOKEN_C" > "$OUT/tokenC"
{
  echo; echo "\$ curl -isS .../api/status                                      # no token"
  http "http://127.0.0.1:$CP/api/status"
  echo; echo "\$ curl -isS -H 'Authorization: Bearer wrong-token' .../api/status"
  http -H "Authorization: Bearer wrong-token" "http://127.0.0.1:$CP/api/status"
  echo; echo "\$ curl -isS -H 'Authorization: <token, without the Bearer scheme>' .../api/status"
  http -H "Authorization: $TOKEN_C" "http://127.0.0.1:$CP/api/status"
  echo; echo "\$ curl -isS -H 'Authorization: Bearer <token>' .../api/unknown   # authorized, unknown route"
  http -H "Authorization: Bearer $TOKEN_C" "http://127.0.0.1:$CP/api/unknown"
  echo; echo "\$ curl -sS -H 'Authorization: Bearer <token>' .../api/status | jq ."
  curl -sS -H "Authorization: Bearer $TOKEN_C" "http://127.0.0.1:$CP/api/status" | pretty
  echo; echo "# 20 seconds later — the boot failed and the control plane is still serving:"
} >> "$OUT/artifacts/05-tier3-broken-credential.txt"
# ------------------------------------------- run D: a second process, while the first still holds the lock
{
  echo "# Tier 3 (live) — run D: a second process on the same data directory, run C (pid $RUN_C) alive"
  echo "# $(utc)   nonce $NONCE"
  echo; echo "\$ cat \$D/runtime.lock"; cat "$D/runtime.lock"
  echo "\$ node dist/cli/main.js --data-dir \$D --control-port $((CP + 1))   # a free, different port"
  ( cd "$HOME" && node "$BIN" --data-dir "$D" --control-port "$((CP + 1))" ) 2>&1
  echo "exit=$?"
  echo; echo "\$ ps -p $RUN_C -o pid=,etime=,stat=   # the first process is untouched"
  ps -p "$RUN_C" -o pid=,etime=,stat=
} > "$OUT/artifacts/06-tier3-second-process.txt" 2>&1
sleep 18
{
  echo "\$ date -u; ps -p $RUN_C -o pid=,etime=,stat=; curl .../api/status | jq -c .runtime"
  utc; ps -p "$RUN_C" -o pid=,etime=,stat=
  curl -sS -H "Authorization: Bearer $TOKEN_C" "http://127.0.0.1:$CP/api/status" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(s).runtime)))'
} >> "$OUT/artifacts/05-tier3-broken-credential.txt" 2>&1
stop "$RUN_C"

# ------------------------------------------------------ run E: one process, two ports, runtime running
RP=$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});')
NODE_OPTIONS="--import=$FIXTURE" node "$BIN" --data-dir "$D2" init --authorize \
  --chat "120363000@g.us" --repository "owner/repo" --github-apps-file "$OUT/github-apps.json" > "$OUT/runE-init.raw" 2>&1
NODE_OPTIONS="--import=$FIXTURE" node "$BIN" --data-dir "$D2" config --port "$RP" > "$OUT/runE-config.raw" 2>&1
{
  echo "# Tier 3 (live) — run E: one process, two ports. The runtime is brought up in the same process."
  echo "# $(utc)   nonce $NONCE   head $HEAD"
  echo "# Fresh install at \$D2 (nonce in the path); runtime port $RP set with 'config --port'."
  echo; echo "\$ node dist/cli/main.js --data-dir \$D2 --control-port $CP  &"
} > "$OUT/artifacts/08-tier3-two-ports-one-process.txt"
control fixture "$D2" "$CP" "$OUT/runE.raw"
RUN_E=$!
waitFor "http://127.0.0.1:$RP/health"; sleep 2; bound "$OUT/runE.raw"
TOKEN_E=$(tokenOf "$D2/credentials/control-plane.json"); echo "$TOKEN_E" > "$OUT/tokenE"
{
  grep -vE '^\{"level"' "$OUT/runE.raw" | head -4
  echo "  ... (the runtime's own log lines elided; full capture in 09-runE-terminal.txt)"
  echo; echo "\$ lsof -nP -a -p $RUN_E -iTCP -sTCP:LISTEN   # ONE pid, TWO listening ports"
  lsof -nP -a -p "$RUN_E" -iTCP -sTCP:LISTEN
  echo; echo "\$ curl -sS -H 'Authorization: Bearer <token>' http://127.0.0.1:$CP/api/status | jq ."
  curl -sS -H "Authorization: Bearer $TOKEN_E" "http://127.0.0.1:$CP/api/status" | pretty
  echo; echo "\$ curl -sS http://127.0.0.1:$RP/health | jq .   # the runtime's own port, same pid"
  curl -sS "http://127.0.0.1:$RP/health" | pretty
} >> "$OUT/artifacts/08-tier3-two-ports-one-process.txt" 2>&1
cp "$OUT/runE.raw" "$OUT/artifacts/09-runE-terminal.txt"

# ------------------------------------------------------------------ tier 4: readback, while E is alive
{
  echo "# Tier 4 (readback) — the token is in the managed configuration store, and in no log file"
  echo "# $(utc)   nonce $NONCE"
  echo "# Token values are masked at capture and identified by SHA-256 — which is what the server itself"
  echo "# compares — so the identifier pins the exact secret without disclosing it."
  for pair in "C:$D:$TOKEN_C" "E:$D2:$TOKEN_E"; do
    RUN=${pair%%:*}; REST=${pair#*:}; DIR=${REST%%:*}; TOK=${REST#*:}
    echo; echo "== run $RUN — $DIR"
    echo "\$ /bin/ls -l \$D/credentials/control-plane.json"
    /bin/ls -l "$DIR/credentials/control-plane.json" | sed -E "s#$DIR#\$D#"
    echo "\$ cat \$D/credentials/control-plane.json"
    sed -E 's/("token": ").*(")/\1<REDACTED>\2/' "$DIR/credentials/control-plane.json"
    echo "   token sha256 = $(sha "$TOK")  length = ${#TOK} chars"
    echo "\$ /bin/ls -l \$D/logs ; wc -lc \$D/logs/*.log"
    /bin/ls -l "$DIR/logs" | sed -E "s#$DIR#\$D#"
    wc -lc "$DIR"/logs/*.log | sed -E "s#$DIR#\$D#"
    printf '$ grep -rlF "<the token>" $D/logs ; echo exit=$?      # 1 = no log file holds the token\n'
    grep -rlF "$TOK" "$DIR/logs" > "$OUT/.g" 2>&1; echo "exit=$? (output: $(tr '\n' ' ' < "$OUT/.g")<none>)"
    printf '$ grep -rlF "<the token>" $D                          # every file under the data directory\n'
    grep -rlF "$TOK" "$DIR" 2>/dev/null | sed -E "s#$DIR#\$D#"
  done
  echo; echo "== the processes' own stdout/stderr =="
  echo "run C: $(grep -cF "$TOKEN_C" "$OUT/runC.raw" || true) occurrences of its token"
  echo "run E: $(grep -cF "$TOKEN_E" "$OUT/runE.raw" || true) occurrences of its token"
  echo; echo "== run E log sample (non-empty: the boot really logged) =="
  head -3 "$D2"/logs/*.log
} > "$OUT/artifacts/07-tier4-readback.txt" 2>&1
rm -f "$OUT/.g"
stop "$RUN_E"

# ------------------------------------------------------------- run F: the token survives a restart
{
  echo "# Tier 3 (live) — run F: the token is generated once and survives a restart"
  echo "# $(utc)   nonce $NONCE"
  echo; echo "\$ sha256 of the token stored before the restart"; sha "$TOKEN_E"
  echo; echo "\$ node dist/cli/main.js --data-dir \$D2 --control-port $CP  &   # second boot, same directory"
} > "$OUT/artifacts/10-tier3-token-survives-restart.txt"
control fixture "$D2" "$CP" "$OUT/runF.raw"
RUN_F=$!
waitFor "http://127.0.0.1:$CP/api/status"; bound "$OUT/runF.raw"
{
  head -2 "$OUT/runF.raw"
  echo; echo "\$ sha256 of the token stored after the restart   # unchanged: minted once, then read back"
  sha "$(tokenOf "$D2/credentials/control-plane.json")"
  echo; echo "\$ curl -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <the pre-restart token>' .../api/status"
  curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_E" "http://127.0.0.1:$CP/api/status"
} >> "$OUT/artifacts/10-tier3-token-survives-restart.txt" 2>&1
stop "$RUN_F"

echo "done — artifacts in $OUT/artifacts"
