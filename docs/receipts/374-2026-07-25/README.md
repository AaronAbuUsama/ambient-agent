# Receipt — node #374, tier 1

**Node:** #374 — honest WhatsApp liveness, and an operator feed a browser can watch
**Branch:** `node/374-honest-liveness-operator-feed`
**Proof head:** `aac51c5af94a8f1ee1c306c4adab86f256b0b824` (clean tree, nothing uncommitted)
**Surface:** backend — evidence form is command + result
**Run nonce:** `a357479ff20e622e`
**Window (UTC):** 2026-07-25T17:01:30Z → 2026-07-25T17:02:52Z

This receipt reports **only this run**. An earlier tier-1 run at `b1cdc92` is superseded: the
independent review changed production code, so every tier was re-run from scratch against the new
head with a fresh nonce, rebased onto current `main` so the proof head equals what merges.

The nonce was minted at run time and shown absent from the repository before the run
(`grep -rn a357479ff20e622e . --exclude-dir=node_modules --exclude-dir=.git` → exit 1, no match),
so `tier1-typecheck-and-test.txt` — whose first line carries it alongside the head sha and the start
timestamp — is this run's log and not a replay of an earlier one.

> The superseded receipt's evidence file was named `.log` and was silently swallowed by
> `.gitignore:22 (*.log)`, so it never reached the PR. Caught in review. This one is `.txt` and
> `git check-ignore` confirms it is tracked.

## Tier table

| tier | verdict | evidence |
|---|---|---|
| 1 mechanical — `pnpm run typecheck && pnpm test` green, including a test that a killed stream flips the reported phase within the stated bound | **PASS** | `tier1-typecheck-and-test.txt` |
| 2 integrated | **N/A** per the node's contract | — |
| 3 live (WhatsApp, post-merge on the rig) | **NOT PROVEN** | orchestrator's, post-merge; runbook in the PR body |
| 4 readback | **NOT PROVEN** | orchestrator's, post-merge |
| 5 observed (Braintrust `co-worker`) | **NOT PROVEN** | orchestrator's, post-merge |

Tiers 3–5 are the orchestrator's by the node's contract and are not reachable from a branch — this
teammate is barred from `capxul-vps`. Nothing in this receipt speaks for them.

## Tier 1, in full

```
$ pnpm run typecheck
typecheck-exit=0

$ pnpm test
 Test Files  86 passed | 1 skipped (87)
      Tests  913 passed | 4 skipped (917)
test-exit=0
```

### The bound test the contract names

`tests/speaker/whatsapp-runtime.test.ts` → *"flips the reported phase within the stated bound when
the stream is killed, and recovers when it returns"*.

It severs a live stream after authentication has settled, records the wall-clock instant, waits for
the reported phase to become `degraded`, and asserts the elapsed time is less than
`WHATSAPP_LIVENESS_BOUND_MS` (65 000) — the constant that is also the wire field `liveness.boundMs`
and the number stated in the PR body. It then asserts `/health`'s `ok` went false, that the operator
feed narrated `agent.degraded`, and that the stream recovers to `online` unaided.

Alongside it, *"reports a transport change that was never announced, on the next read"* is the test
for the **mechanism** behind the bound: the transport's status is mutated with no `onStatus`
emission at all — no subscriber runs, the channel publishes nothing — and the next read already
reports `degraded`. That is this layer's contribution to the bound being zero, and it is what the
65 s rests on.

### Non-vacuity

Assertions that cannot fail are not proof. Two deliberate regressions, each reverted immediately:

**1. The mapping.** `REPORTED_PHASE.backing_off` changed from `"degraded"` to `"online"`:

```
AssertionError: expected 'online' to be 'degraded' // Object.is equality
Expected: "degraded"
Received: "online"
      Tests  1 failed | 36 skipped (37)
```

It fails with exactly #312's symptom — a dead stream still reading `online` — on the **assertion**,
not on an opaque timeout.

**2. The `since` defect the review found.** The transport handler's publish was restored to its
pre-review form (`whatsAppObservationOf(status, undefined)`, a second transport-blind derivation):

```
× holds `since` at the moment the phase was entered, across the whole outage
AssertionError: expected 1784999023317 to be 1784999023291
```

`since` moved 26 ms across a backoff cycle it should have held — the "degraded for 0 seconds"
symptom, reproduced and caught. Note the transport handler is the site the test pins; the
`setRuntimeStatus` site was fixed by the same reasoning but its inputs happen to agree in practice,
so reverting that one alone does not fail the test.

Both edits were reverted; the proof head is unchanged (`git status --porcelain` empty at `aac51c5`).

Every time-dependent assertion carries an explicit 4 s budget — comfortably clear of the flip, which
is same-tick — so a loaded runner cannot turn a real regression into a timeout nor a pass into a
flake. (Same lesson as PR #394 on `a7cedb1`.)

## What tier 1 does and does not prove

**Proves:** the derivation is total over whatsappd's connection union and reports an unknown future
arm as `degraded` rather than as fine; a severed transport moves the reported phase off `online` on
the next read, whether or not the change was announced; `since` holds across a whole backoff cycle;
an outage is narrated once rather than once per retry; a transport whose getter throws reports
`degraded` instead of the last healthy answer; `/health`, the bridge contract, the CLI parser and
the observation channel all report that one derivation; the operator feed is subscribable
in-process, streams to an HTTP client, resumes a reconnecting client from its `seq`, reports a
cursor from a previous process as a gap, stays bounded with nobody attached, isolates a throwing
subscriber, and drops rather than buffers for a client whose socket needs to drain.

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
