# Receipt — node #369: the setup lock records its owner and reclaims itself when that owner is gone

**Issue:** [#369](https://github.com/AaronAbuUsama/ambient-agent/issues/369) ·
**branch:** `worktree-369-setup-lock` ·
**proven head:** `7ce4aeda0f2240a7e973c97cf77d62f1f30db390` ·
**base:** `origin/main` `60eae01`
**Date (UTC):** 2026-07-25 · **Surface:** backend

Every run below is against a **scratch data directory** under `$TMPDIR`. `~/.ambient-agent` was
never read, written, or copied — no `whatsapp/` store was touched, and this machine has none.

## Run identifiers

| identifier | value |
|---|---|
| nonce (this run) | `369-dbf4867db7` |
| proven commit | `7ce4aeda0f2240a7e973c97cf77d62f1f30db390` |
| scratch root | `$TMPDIR/ambient-agent-369-dbf4867db7-i5Xf` |
| run A — killed setup | pid **69170**, attempt `62654be8-be41-45ca-997d-5cdec4763b46` |
| run A — setup that reclaimed and proceeded | pid **69333**, attempt `3d55f25c-995a-42b8-9367-88c550ef8b8e` |
| run B — live setup | pid **69372**, attempt `5424e1c5-624c-42e0-b2c5-ca8346cb99c7` |
| run B — refused second attempt | pid 69405, exit status 1 |
| UTC window | 13:18:30Z – 13:18:34Z |

The nonce was shown absent at this head, on disk, and under `~/.ambient-agent` before the run
([`artifacts/tier4-readback.txt`](artifacts/tier4-readback.txt) §1). It enters through the scratch
data directory the setup installs into, and comes out the other side inside that installation's
durable credential record (§5) — it travelled the setup path, it was not printed beside it.

The **attempt identifier** is the run-time uuid `acquireSetupLock` mints and records in the lock;
it is what shows the reclaimed lock names the second run (`3d55f25c…`) and not the killed one
(`62654be8…`).

## Tier table

| tier | verdict | what was run | evidence |
|---|---|---|---|
| 1 mechanical | **PROVEN** | `pnpm run typecheck && pnpm test` — 83 files, **832 passed**, 4 skipped, typecheck clean | [`tier1-typecheck-and-suite.txt`](artifacts/tier1-typecheck-and-suite.txt) |
| 1 mechanical (the node's own tests) | **PROVEN** | 7 tests covering reclaim-after-death and refuse-while-live | [`tier1-setup-lock-tests.txt`](artifacts/tier1-setup-lock-tests.txt) |
| 2 integrated | **N/A** | — | No agent behaviour changes: nothing in the Brain, Speaker, Scribe, or any Surface path is touched. |
| 3 live (branch) | **PROVEN** | both runs the contract names, as real OS processes running the committed head | [`tier3-both-runs.txt`](artifacts/tier3-both-runs.txt) |
| 4 readback | **PROVEN** | the lock's recorded owner before and after the reclaim, with exact ids | [`tier4-readback.txt`](artifacts/tier4-readback.txt) |
| 5 observed | **N/A** | — | No model traffic and no collector for filesystem locks. |

## Tier 3 — the two runs, verbatim

Both are in [`tier3-both-runs.txt`](artifacts/tier3-both-runs.txt). They are real processes running
the shipped `installPreparedManagedData`, not a test double: the lock is taken by the real setup
routine at the real moment, and `kill -9` lands on the process the lock itself names.

**Run A — killed after the lock is taken; a fresh setup proceeds.**

```
=== A2 — readback BEFORE the kill ===
{ "pid": 69170, "host": "Abdullahs-MacBook-Pro.local",
  "startedAt": "2026-07-25T13:18:31.072Z", "attempt": "62654be8-be41-45ca-997d-5cdec4763b46" }

=== A3 — kill -9 the setup the lock names ===
pid 69170 alive after the kill: no
the lock it left behind still exists: yes
it still names the killed pid 69170: yes

=== A5 — readback AFTER the reclaim ===
{ "pid": 69333, "host": "Abdullahs-MacBook-Pro.local",
  "startedAt": "2026-07-25T13:18:32.962Z", "attempt": "3d55f25c-995a-42b8-9367-88c550ef8b8e" }

=== A6 ===
SETUP PROCEEDED: created=true state=ready
```

Before this change that second run could not start at all: the killed run's lock refused it, with
a message telling a human to remove the lock by hand.

**Run B — a live setup is left running and a second is attempted.**

```
=== B3 — a second setup is attempted against the same root ===
SETUP REFUSED: Setup is already in progress for …/concurrent/managed
  (pid 69372 on Abdullahs-MacBook-Pro.local, started 2026-07-25T13:18:33.702Z,
   attempt 5424e1c5-624c-42e0-b2c5-ca8346cb99c7);
  wait for it to finish or clear the lock after confirming it stopped.
second attempt exit status: 1

=== B4 — the refused attempt changed nothing ===
the live setup is still pid 69372, alive: yes
```

The refusal names the live owner by pid, host, start time, and attempt. The live setup then
finished normally (`created=true state=ready`), so the refusal cost it nothing.

## Tier 4 — readback

Full output in [`tier4-readback.txt`](artifacts/tier4-readback.txt). The contract asks that the
lock's recorded owner match the killed process before reclaim and the new process after:

| | pid | attempt |
|---|---|---|
| before reclaim | **69170** — the killed process | `62654be8-be41-45ca-997d-5cdec4763b46` |
| after reclaim | **69333** — the process that proceeded | `3d55f25c-995a-42b8-9367-88c550ef8b8e` |

The same readback also caught a defect (§4 of that file): the killed attempt's **staging tree**
survived the reclaim, keyed by an attempt uuid no later run ever names. It is now swept by the
reclaim, and the readback shows it absent.

## Acceptance criteria

| criterion | met | where |
|---|---|---|
| The lock records its owner: process id, host, and start time | yes | `installation.ts` `SetupLockOwnerSchema` / `acquireSetupLock`; readback §2–3 |
| A lock whose owner is gone is treated as stale and reclaimed automatically | yes | `ownerGone` + the reclaim branch; tier 3 run A |
| A genuinely concurrent second setup is still refused loudly | yes | the refusal branch; tier 3 run B |
| Reclaim keys on owner liveness, not elapsed time | yes | `ownerGone` reads `process.kill(pid, 0)` and the host only — no duration enters the decision anywhere |

## Chain of evidence

Three independent observations converge on the same run: the tier-3 terminal capture (what the
processes did), the tier-4 filesystem readback (what the lock durably recorded, by exact pid and
attempt uuid), and the installed data directory carrying the nonce `369-dbf4867db7` in its
credential record (that the setup actually completed, rather than merely releasing a lock). The
pids and attempt uuids in the terminal capture and in the lock readback are the same values, and
none of them existed before 13:18:30Z.

## Irreversible footprint

None outside `$TMPDIR`. Two scratch installations were created under
`$TMPDIR/ambient-agent-369-dbf4867db7-i5Xf` and one process was killed with `SIGKILL` — its own.
No message was sent, no external record written, nothing under `~/.ambient-agent` read or changed
(this machine has no such directory), and no `whatsapp/` store was copied.

## Redaction

Nothing is masked because nothing sensitive exists here: the harness stages fixture credential
values (`scratch-access`, `scratch-refresh`, the `fakeGitHubAppTriples` keys) that are literals in
the repo's own test support, never real secrets. Hostname and pids are shown deliberately — they
are the evidence.

## Reproducing this

From the repo root, at this head:

```bash
docs/receipts/369-2026-07-25/artifacts/run-proof.sh "369-$(openssl rand -hex 5)"
```

- [`artifacts/run-proof.sh`](artifacts/run-proof.sh) — the two runs, in order, with the readbacks.
- [`artifacts/setup-lock-proof.ts`](artifacts/setup-lock-proof.ts) — a real setup that can be held
  mid-flight, so the kill lands while the lock is genuinely taken.
