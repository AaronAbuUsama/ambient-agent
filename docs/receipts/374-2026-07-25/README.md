# Receipt — node #374, tier 1

**Node:** #374 — honest WhatsApp liveness, and an operator feed a browser can watch
**Branch:** `node/374-honest-liveness-operator-feed`
**Proof head:** `b1cdc92aa7393a6ddc516fef17b74d481f39de2f` (clean tree, nothing uncommitted)
**Surface:** backend — evidence form is command + result
**Run nonce:** `2f3b8bf3321f9c0f`
**Window (UTC):** 2026-07-25T16:34:06Z → 2026-07-25T16:35:29Z

The nonce was minted at run time and shown absent from the repository before the run
(`grep -rn 2f3b8bf3321f9c0f . --exclude-dir=node_modules --exclude-dir=.git` → exit 1, no
match), so `tier1-typecheck-and-test.log` — whose first line carries it alongside the head sha
and the start timestamp — is this run's log and not a replay of an earlier one.

## Tier table

| tier | verdict | evidence |
|---|---|---|
| 1 mechanical — `pnpm run typecheck && pnpm test` green, including a test that a killed stream flips the reported phase within the stated bound | **PASS** | `tier1-typecheck-and-test.log` — this file |
| 2 integrated | **N/A** per the node's contract | — |
| 3 live (WhatsApp, post-merge on the rig) | **NOT PROVEN** | orchestrator's, post-merge; runbook in the PR body |
| 4 readback | **NOT PROVEN** | orchestrator's, post-merge |
| 5 observed (Braintrust `co-worker`) | **NOT PROVEN** | orchestrator's, post-merge |

Tiers 3–5 are the orchestrator's by the node's contract and are not reachable from a branch —
this teammate is barred from `capxul-vps`. Nothing in this receipt speaks for them.

## Tier 1, in full

```
$ pnpm run typecheck
typecheck-exit=0

$ pnpm test
 Test Files  86 passed | 1 skipped (87)
      Tests  900 passed | 4 skipped (904)
   Duration  59.83s
test-exit=0
```

### The bound test the contract names

```
$ pnpm vp test run tests/speaker/whatsapp-runtime.test.ts -t "stated bound" --reporter=verbose
 ✓ tests/speaker/whatsapp-runtime.test.ts > runtime pairing and bridge control
   > flips the reported phase within the stated bound when the stream is killed, and recovers when it returns 76ms
 Test Files  1 passed (1)
      Tests  1 passed | 32 skipped (33)
```

It severs a live stream after authentication has settled, records the wall-clock instant, waits
for the reported phase to become `degraded`, and asserts the elapsed time is less than
`WHATSAPP_LIVENESS_BOUND_MS` (65 000) — the constant that is also the wire field `liveness.boundMs`
and the number stated in the PR body. It then asserts `/health`'s `ok` went false, that the
operator feed narrated `agent.degraded`, and that the stream recovers to `online` unaided.

### Non-vacuity

An assertion that cannot fail is not a proof. The mapping was deliberately broken —
`REPORTED_PHASE.backing_off` changed from `"degraded"` to `"online"` — and the test was rerun:

```
 × flips the reported phase within the stated bound when the stream is killed, and recovers when it returns 4084ms
AssertionError: expected 'online' to be 'degraded' // Object.is equality
Expected: "degraded"
Received: "online"
      Tests  1 failed | 32 skipped (33)
```

It fails with exactly #312's symptom — a dead stream still reading `online` — and it fails on the
**assertion** after exhausting its explicit 4 s budget, not on an opaque timeout. The edit was
reverted; the proof head is unchanged (`git status --porcelain` empty at `b1cdc92`).

The 4 s budget is deliberate and stated: comfortably clear of the flip, which is same-tick, so a
loaded runner cannot turn a real regression into a timeout nor a pass into a flake. (Same lesson as
PR #394 on `a7cedb1`.)

## What tier 1 does and does not prove

**Proves:** the derivation is total over whatsappd's connection union; a severed transport moves the
reported phase off `online` in the same tick; `/health`, the bridge contract, the CLI parser and the
observation channel all report that one derivation; the operator feed is subscribable in-process,
streams to an HTTP client, resumes a reconnecting client from its `seq`, stays bounded with nobody
attached, and isolates a throwing subscriber.

**Does not prove:** the 65 s half of the bound. That is baileys' keep-alive detecting a silent
socket death (35 s no-data threshold on a 30 s tick), which is upstream behaviour a fake session
cannot honestly simulate; it is derived from baileys source in `docs/research/whatsapp-liveness.md`
§"Stated bound" and is what tier 3 on the rig exercises for real.

## Chain of evidence

This repository has no corroborating tier for tier 1 — a mechanical tier is the observation itself.
The log carries the run nonce, the exact proof head, and the UTC window on its first line, and the
nonce was shown absent from the tree beforehand, so the artifact cannot be a re-attached earlier run.

## Irreversible footprint

None. Tier 1 ran entirely against temporary directories under `$TMPDIR` and fake WhatsApp sessions;
no message was sent, no external record created, and the rig was not touched.
