#!/usr/bin/env bash
# Tier-4 readback for node #366, run ON THE RIG after the merged head is deployed.
#
# Prints which managed secret kinds the store holds, populated by the boot seed — NAMES ONLY.
# The `kind` column is the only thing selected; `secret_json` is never read, so this can be pasted
# into a receipt without breaching SEC-WO.
set -euo pipefail

STORE="${1:-$HOME/.ambient-agent/managed-config.sqlite}"

echo "store: $STORE"
ls -l "$STORE"          # expect mode 0600 — the store holds secrets since #365
echo

echo "populated secret kinds (names only):"
sqlite3 "$STORE" "SELECT kind, updated_at FROM managed_secret ORDER BY kind;"
echo

echo "row count:"
sqlite3 "$STORE" "SELECT COUNT(*) FROM managed_secret;"
echo

# Sanity: the seed must not have written anything that looks like a value into the kind column.
echo "no value-shaped kind names:"
sqlite3 "$STORE" "SELECT COUNT(*) FROM managed_secret WHERE LENGTH(kind) > 32;"
