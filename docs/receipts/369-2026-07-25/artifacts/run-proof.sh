#!/usr/bin/env bash
# Tier-3 + tier-4 proof for #369, run from the repo root:
#
#   docs/receipts/369-2026-07-25/artifacts/run-proof.sh <nonce>
#
# Run A: a setup is killed after the lock is taken; a fresh setup reclaims it and proceeds.
# Run B: a live setup is left running and a second is attempted, and is refused.
#
# The process killed in run A is the one the lock itself names — the recorded owner is read back
# from the lock file and signalled by pid, so the kill lands on the setup that holds it and not
# on some wrapper around it.
#
# Every root is a scratch directory under $TMPDIR named for the nonce. ~/.ambient-agent is never
# read, written, or copied — in particular no whatsapp/ store is ever touched.
set -uo pipefail

NONCE="${1:?usage: run-proof.sh <nonce>}"
HARNESS="docs/receipts/369-2026-07-25/artifacts/setup-lock-proof.ts"
TSX="./node_modules/.bin/tsx"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ambient-agent-${NONCE}-XXXX")"

say() { printf '\n=== %s ===\n' "$*"; }
lock_of() { printf '%s/.%s.setup.lock' "$(dirname "$1")" "$(basename "$1")"; }
owner_pid() { sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$(lock_of "$1")"; }
alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }
# Bounded so a hang fails loudly instead of waiting forever.
await() {
  local deadline=$((SECONDS + 60))
  until grep -q "$1" "$2" 2>/dev/null; do
    ((SECONDS < deadline)) || { printf 'TIMED OUT waiting for %s\n' "$1"; cat "$2"; exit 1; }
    sleep 0.2
  done
}

printf 'proof run for #369 — nonce %s\nhead %s\nscratch %s\nUTC start %s\n' \
  "$NONCE" "$(git rev-parse HEAD)" "$SCRATCH" "$(date -u +%FT%TZ)"

# ---------------------------------------------------------------- Run A
A_ROOT="$SCRATCH/killed/managed"
say "A1 — start a setup and let it take the lock"
"$TSX" "$HARNESS" hold "$A_ROOT" "$NONCE" >"$SCRATCH/a1.log" 2>&1 &
await "holding the lock" "$SCRATCH/a1.log"
cat "$SCRATCH/a1.log"

say "A2 — readback BEFORE the kill: who does the lock say holds it?"
cat "$(lock_of "$A_ROOT")"
A_OWNER="$(owner_pid "$A_ROOT")"
printf 'the lock names pid %s; that process is alive: %s\n' "$A_OWNER" "$(alive "$A_OWNER")"

say "A3 — kill -9 the setup the lock names (the closed tab / dropped connection / crash)"
kill -9 "$A_OWNER"
sleep 1
printf 'pid %s alive after the kill: %s\n' "$A_OWNER" "$(alive "$A_OWNER")"
printf 'the lock it left behind still exists: '; test -f "$(lock_of "$A_ROOT")" && echo yes || echo no
printf 'it still names the killed pid %s: ' "$A_OWNER"; test "$(owner_pid "$A_ROOT")" = "$A_OWNER" && echo yes || echo no
printf 'the managed data directory was never created: '; test -e "$A_ROOT" && echo EXISTS || echo "absent, as expected"

say "A4 — a fresh setup on the same root: it must reclaim the stale lock and proceed"
"$TSX" "$HARNESS" hold "$A_ROOT" "$NONCE" >"$SCRATCH/a2.log" 2>&1 &
A2_JOB=$!
await "holding the lock" "$SCRATCH/a2.log"
cat "$SCRATCH/a2.log"

say "A5 — readback AFTER the reclaim: the lock now names the second run"
cat "$(lock_of "$A_ROOT")"
printf 'the killed run was pid %s; the lock now names pid %s\n' "$A_OWNER" "$(owner_pid "$A_ROOT")"

say "A6 — let the reclaiming setup finish"
touch "${A_ROOT}.go"
wait "$A2_JOB"; A2_STATUS=$?
cat "$SCRATCH/a2.log"
printf 'exit status: %s\n' "$A2_STATUS"
printf 'the lock is released: '; test -e "$(lock_of "$A_ROOT")" && echo "STILL PRESENT" || echo yes
printf 'installed tree: '; ls "$A_ROOT"

# ---------------------------------------------------------------- Run B
B_ROOT="$SCRATCH/concurrent/managed"
say "B1 — a live setup takes the lock and stays running"
"$TSX" "$HARNESS" hold "$B_ROOT" "$NONCE" >"$SCRATCH/b1.log" 2>&1 &
B_JOB=$!
await "holding the lock" "$SCRATCH/b1.log"
cat "$SCRATCH/b1.log"
B_OWNER="$(owner_pid "$B_ROOT")"
printf 'the live setup is pid %s, alive: %s\n' "$B_OWNER" "$(alive "$B_OWNER")"

say "B2 — readback while it is live"
cat "$(lock_of "$B_ROOT")"

say "B3 — a second setup is attempted against the same root"
"$TSX" "$HARNESS" run "$B_ROOT" "$NONCE"; B2_STATUS=$?
printf 'second attempt exit status: %s (non-zero = refused)\n' "$B2_STATUS"

say "B4 — the refused attempt changed nothing: the live owner still holds the lock"
cat "$(lock_of "$B_ROOT")"
printf 'the live setup is still pid %s, alive: %s\n' "$B_OWNER" "$(alive "$B_OWNER")"

say "B5 — let the live setup finish normally"
touch "${B_ROOT}.go"
wait "$B_JOB"; B_STATUS=$?
cat "$SCRATCH/b1.log"
printf 'exit status: %s\n' "$B_STATUS"
printf 'installed tree: '; ls "$B_ROOT"

printf '\nUTC end %s\nscratch left at %s\n' "$(date -u +%FT%TZ)" "$SCRATCH"
