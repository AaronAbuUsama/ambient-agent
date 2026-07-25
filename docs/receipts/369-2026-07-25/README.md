# Receipt — node #369: the setup lock records its owner and reclaims itself when that owner is gone

**Issue:** [#369](https://github.com/AaronAbuUsama/ambient-agent/issues/369) ·
**PR:** [#387](https://github.com/AaronAbuUsama/ambient-agent/pull/387) ·
**branch:** `worktree-369-setup-lock` ·
**proven head:** `da972c32b7494c2b1a5ac3f06ffadabf3414df8c` ·
**base:** `origin/main` `60eae01`
**Date (UTC):** 2026-07-25 · **Surface:** backend

Every run below is against a **scratch data directory** under `$TMPDIR`. `~/.ambient-agent` was
never read, written, or copied — no `whatsapp/` store was touched, and this machine has none.

## Run identifiers

| identifier | value |
|---|---|
| nonce (this run) | `369-36dc37d4b0` |
| proven commit | `da972c32b7494c2b1a5ac3f06ffadabf3414df8c` |
| scratch root | `$TMPDIR/ambient-agent-369-36dc37d4b0-ABTJ` |
| run A — the setup that was killed | pid **91523**, attempt `e6944cf1-d4cd-4d5c-9be8-e7230787d10b` |
| run A — the setup that reclaimed and proceeded | pid **91749**, attempt `f1ff9a51-9483-4044-b94c-5ec44d0aeca4` |
| run B — the live setup | pid **91795**, attempt `2383435c-db05-4481-80e5-04bfe00d6ee0` |
| run B — the refused second attempt | pid **91855**, exit status 1 |
| UTC window | 13:25:34Z – 13:25:38Z |

The nonce was shown absent at this head, on disk, and under `~/.ambient-agent` **before** the run
([`artifacts/tier0-nonce-absence.txt`](artifacts/tier0-nonce-absence.txt)). It enters through the
scratch data directory the setup installs into, and comes out the other side inside that
installation's durable credential record ([`tier4-readback.txt`](artifacts/tier4-readback.txt) §5)
— it travelled the setup path, it was not printed beside it.

The **attempt identifier** is the run-time uuid `acquireSetupLock` mints and records in the lock.
It is what shows the reclaimed lock names the second run (`f1ff9a51…`) and not the killed one
(`e6944cf1…`).

## Tier table

| tier | verdict | what was run | evidence |
|---|---|---|---|
| 1 mechanical | **PROVEN** | `pnpm run typecheck && pnpm test` — typecheck clean, 83 files, **832 passed**, 4 skipped | [`tier1-typecheck-and-suite.txt`](artifacts/tier1-typecheck-and-suite.txt) |
| 1 mechanical (the node's own tests) | **PROVEN** | 7 tests, covering reclaim-after-death and refuse-while-live by name | [`tier1-setup-lock-tests.txt`](artifacts/tier1-setup-lock-tests.txt) |
| 2 integrated | **N/A** | — | No agent behaviour changes: nothing in the Brain, Speaker, Scribe, or any Surface path is touched. The contract records this tier as N/A. |
| 3 live (branch) | **PROVEN** | both runs the contract names, as real OS processes running the committed head | [`tier3-both-runs.txt`](artifacts/tier3-both-runs.txt) |
| 4 readback | **PROVEN** | the lock's recorded owner before and after the reclaim, with exact ids | [`tier4-readback.txt`](artifacts/tier4-readback.txt) |
| 5 observed | **N/A** | — | No model traffic; no collector observes filesystem locks. The contract records this tier as N/A. |

## Tier 3 — the two runs

Both are in [`tier3-both-runs.txt`](artifacts/tier3-both-runs.txt), verbatim. They are real
processes running the shipped `installPreparedManagedData`, not a test double: the lock is taken by
the real setup routine at the real moment, and `kill -9` lands on the process **the lock itself
names** — its pid is read back out of the lock file and signalled.

**Run A — killed after the lock is taken; a fresh setup proceeds.**

```
=== A2 — readback BEFORE the kill: who does the lock say holds it? ===
{ "pid": 91523, "host": "Abdullahs-MacBook-Pro.local",
  "startedAt": "2026-07-25T13:25:34.285Z", "attempt": "e6944cf1-d4cd-4d5c-9be8-e7230787d10b" }
the lock names pid 91523; that process is alive: yes

=== A3 — kill -9 the setup the lock names ===
pid 91523 alive after the kill: no
the lock it left behind still exists: yes
it still names the killed pid 91523: yes
the managed data directory was never created: absent, as expected

=== A5 — readback AFTER the reclaim: the lock now names the second run ===
{ "pid": 91749, "host": "Abdullahs-MacBook-Pro.local",
  "startedAt": "2026-07-25T13:25:36.374Z", "attempt": "f1ff9a51-9483-4044-b94c-5ec44d0aeca4" }
the killed run was pid 91523; the lock now names pid 91749

=== A6 — let the reclaiming setup finish ===
SETUP PROCEEDED: created=true state=ready
the lock is released: yes
installed tree: application.sqlite config.json credentials flue.sqlite logs whatsapp
```

On `origin/main` that second run cannot start at all: the killed run's lock refuses it, with a
message telling a human to remove the lock by hand.

**Run B — a live setup is left running and a second is attempted.**

```
=== B2 — readback while it is live ===
{ "pid": 91795, "host": "Abdullahs-MacBook-Pro.local",
  "startedAt": "2026-07-25T13:25:37.081Z", "attempt": "2383435c-db05-4481-80e5-04bfe00d6ee0" }

=== B3 — a second setup is attempted against the same root ===
SETUP REFUSED: Setup is already in progress for …/concurrent/managed
  (pid 91795 on Abdullahs-MacBook-Pro.local, started 2026-07-25T13:25:37.081Z,
   attempt 2383435c-db05-4481-80e5-04bfe00d6ee0);
  wait for it to finish or clear the lock after confirming it stopped.
second attempt exit status: 1 (non-zero = refused)

=== B4 — the refused attempt changed nothing ===
the live setup is still pid 91795, alive: yes

=== B5 — let the live setup finish normally ===
SETUP PROCEEDED: created=true state=ready
```

The refusal names the live owner by pid, host, start time, and attempt. The live setup then
finished normally, so the refusal cost it nothing.

## Tier 4 — readback

Full output in [`tier4-readback.txt`](artifacts/tier4-readback.txt). The contract asks that the
lock's recorded owner match the killed process before reclaim and the new process after:

| | pid | attempt uuid |
|---|---|---|
| before reclaim | **91523** — the killed process | `e6944cf1-d4cd-4d5c-9be8-e7230787d10b` |
| after reclaim | **91749** — the process that proceeded | `f1ff9a51-9483-4044-b94c-5ec44d0aeca4` |

The same readback also shows (§4) the killed attempt's **staging tree** absent after the reclaim.
An earlier run of this same proof, at head `7ce4aed`'s predecessor, showed it *present* — a real
defect the readback caught: the tree is keyed by an attempt uuid no later run ever names, so
nothing would ever have swept it. Fixed in `7ce4aed`, and this readback is the confirmation.

## Acceptance criteria

| criterion | met | where |
|---|---|---|
| The lock records its owner: process id, host, and start time | yes | `installation.ts` — `SetupLockOwnerSchema` and the `owner` record `acquireSetupLock` writes; readback §2–3 |
| A lock whose owner is gone is treated as stale and reclaimed automatically | yes | `ownerGone` + the reclaim branch; tier 3 run A |
| A genuinely concurrent second setup is still refused loudly | yes | the refusal branch; tier 3 run B |
| Reclaim keys on owner liveness, not elapsed time | yes | `ownerGone` reads `process.kill(pid, 0)` and the recorded host only — no duration is computed anywhere; `startedAt` is recorded and reported, never compared |

## Chain of evidence

Three independent observations converge on this one run: the tier-3 terminal capture (what the
processes did), the tier-4 filesystem readback (what the lock durably recorded, by exact pid and
attempt uuid), and the installed data directory carrying the nonce `369-36dc37d4b0` in its
credential record (that setup actually *completed*, rather than merely releasing a lock). The pids
and attempt uuids are identical across the terminal capture and the lock readback, and none of them
existed before 13:25:34Z.

## Irreversible footprint

None outside `$TMPDIR`. Two scratch installations were created under
`$TMPDIR/ambient-agent-369-36dc37d4b0-ABTJ`, and one `SIGKILL` was sent — to a process this run
started. No message was sent, no external record written, nothing under `~/.ambient-agent` read or
changed (this machine has no such directory), and no `whatsapp/` store was copied.

## Redaction

Nothing is masked because nothing sensitive exists here: the harness stages fixture credential
values (`scratch-access`, `scratch-refresh`, the repo's own `fakeGitHubAppTriples`) that are
literals in `packages/test-support`, never real secrets. Hostname and pids are shown deliberately —
they are the evidence.

## Reproducing this

From the repo root, at this head:

```bash
docs/receipts/369-2026-07-25/artifacts/run-proof.sh "369-$(openssl rand -hex 5)"
```

- [`artifacts/run-proof.sh`](artifacts/run-proof.sh) — the two runs, in order, with the readbacks.
- [`artifacts/setup-lock-proof.ts`](artifacts/setup-lock-proof.ts) — a real setup that can be held
  mid-flight, so the kill lands while the lock is genuinely taken.
