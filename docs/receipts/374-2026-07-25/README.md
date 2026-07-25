# Receipt — node #374, tier 1

**Node:** #374 — honest WhatsApp liveness, and an operator feed a browser can watch
**Branch:** `node/374-honest-liveness-operator-feed`
**Proof head:** `b50cd3a6d2633e3e9a261499e2b8b8618f1fd618`, rebased onto `main` at
`15421b9a92a3e994ad355eb0389ae6631ec5fa8e` (clean tree, nothing uncommitted; `main` is an ancestor)
**Surface:** backend — evidence form is command + result
**Run nonce:** `3cd74d4bd2a52575`
**Window (UTC):** 2026-07-25T17:31:59Z → 2026-07-25T17:33:19Z

This receipt reports **only this run**. Three earlier tier-1 runs are superseded, not amended —
`b1cdc92` (the independent review then changed production code), `aac51c5` (CI on Node 24 then
showed a load-sensitive test needed fixing), and `537e05d` (the branch then had to be rebased onto
#372 and #366). Each time every tier was re-run from scratch against the new head with a fresh
nonce.

The nonce was minted at run time and shown absent from the repository before the run
(`grep -rn 3cd74d4bd2a52575 . --exclude-dir=node_modules --exclude-dir=.git` → exit 1, no match),
so `tier1-typecheck-and-test.txt` — whose first line carries it alongside the head sha, the `main`
sha it sits on, and the start timestamp — is this run's log and not a replay of an earlier one.

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
 Test Files  88 passed | 1 skipped (89)
      Tests  938 passed | 4 skipped (942)
test-exit=0
```

### A first attempt, reported rather than discarded

The first full-suite attempt at this same head (nonce `c2ca45a96b2bae02`, log kept alongside as
`tier1-first-attempt-known-flake.txt`) came back `test-exit=1` on one test:

```
× serializes model credential rotation across independent processes  15056ms
 FAIL  tests/managed/tenant-credentials.test.ts
```

It is recorded here rather than dropped, because a receipt that only shows the passing attempt is
not a receipt. What it is:

- **Not this branch's.** `tests/managed/tenant-credentials.test.ts` is not in this branch's diff
  (`git diff --name-only origin/main...HEAD`), and neither is anything it exercises.
- **The known #369 flake**, which the orchestrator has already triaged and carried into planning as
  untouched. It spawns real subprocesses against a 15 s budget and exhausted it at 15056 ms — a
  scheduling loss under full-suite load, not an assertion.
- **Passes in isolation** at this head (9/9), and passes in isolation with the working tree reset to
  `origin/main`, so it is not made worse by this branch.

The verdict above rests on the second run, which is green end to end. Both logs are committed.

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

Assertions that cannot fail are not proof. Three deliberate regressions, each re-run at *this* head
and each reverted immediately:

**1. The phase mapping.** `REPORTED_PHASE.backing_off` changed from `"degraded"` to `"online"`:

```
AssertionError: expected 'online' to be 'degraded' // Object.is equality
Expected: "degraded"
Received: "online"
      Tests  1 failed | 36 skipped (37)
```

Fails with exactly #312's symptom — a dead stream still reading `online` — on the **assertion**, not
on an opaque timeout.

**2. The `since` defect the review found.** The transport handler's publish restored to its
pre-review form (`whatsAppObservationOf(status, undefined)`, a second transport-blind derivation):

```
× holds `since` at the moment the phase was entered, across the whole outage  132ms
AssertionError: expected 1785000825451 to be 1785000825425
```

`since` moved 26 ms across a backoff cycle it should have held — the "degraded for 0 seconds"
symptom, reproduced and caught.

**3. The staleness announcement.** `notify()` removed from the observation cell's expiry timer:

```
× pushes the staleness transition to subscribers, not only to readers  3ms
AssertionError: expected false to be true
      Tests  1 failed | 23 passed (24)
```

That test and its sibling drive the clock with fake timers on this branch rather than waiting on a
real 20 ms timer — CI on Node 24 exhausted even the 4 s budget PR #394 gave them, and widening a
third time would only relocate the next failure. They now fail in **3 ms** instead of 4010 ms, and
for the right reason. **This supersedes #394's widening deliberately; do not re-widen it.**

All three edits were reverted; the proof head is unchanged (`git status --porcelain` empty at
`b50cd3a`).

Every remaining time-dependent assertion carries an explicit 4 s budget — comfortably clear of the
flip, which is same-tick — so a loaded runner cannot turn a real regression into a timeout nor a
pass into a flake. Where the behaviour under test is a *clock* fact rather than a scheduling one,
the clock is driven instead of raced.

## What the rebase reconciled

- **#372 (`4da219a`) amended #364's gate.** The static shell is now the one unauthenticated surface;
  everything under `/api/` keeps the gate, ahead of API routing. `GET /api/logs` needed no
  special-casing to stay gated — `isApi` matches `/api` and every `/api/` path — but it is pinned by
  a test rather than left to inspection: a no-token `/api/logs` returns a JSON `401` with
  `WWW-Authenticate: Bearer`, which the shell branch cannot produce, so it demonstrably never falls
  through to it.
- **#366 (`15421b9`) moved configuration and secret readers onto `ManagedConfigurationSource`.** The
  only overlap was `control-plane.ts`'s import block, resolved to the seam
  (`withManagedConfigurationSource`). Nothing else this branch touches reads configuration.

## What tier 1 does and does not prove

**Proves:** the derivation is total over whatsappd's connection union and reports an unknown future
arm as `degraded` rather than as fine; a severed transport moves the reported phase off `online` on
the next read, whether or not the change was announced; `since` holds across a whole backoff cycle;
an outage is narrated once rather than once per retry; a transport whose getter throws reports
`degraded` instead of the last healthy answer; `/health`, the bridge contract, the CLI parser and
the observation channel all report that one derivation; the operator feed is subscribable
in-process, streams to an HTTP client behind the bearer gate, resumes a reconnecting client from its
`seq`, reports a cursor from a previous process as a gap, stays bounded with nobody attached,
isolates a throwing subscriber, and drops rather than buffers for a client whose socket needs to
drain.

**Does not prove:** the 65 s half of the bound. That is baileys' keep-alive detecting a silent
socket death (35 s no-data threshold on a 30 s tick), which is upstream behaviour a fake session
cannot honestly simulate; it is derived from baileys source in `docs/research/whatsapp-liveness.md`
§"Stated bound" and is what tier 3 on the rig exercises for real.

## Chain of evidence

This repository has no corroborating tier for tier 1 — a mechanical tier is the observation itself.
Each log carries its own run nonce, the exact proof head, the `main` sha it was rebased onto, and
the UTC window on its first line, and each nonce was shown absent from the tree beforehand, so
neither artifact can be a re-attached earlier run.

## Irreversible footprint

None. Tier 1 ran entirely against temporary directories under `$TMPDIR` and fake WhatsApp sessions;
no message was sent, no external record created, and the rig was not touched.
