# Receipt — node #364, control plane: one process, two ports, token-gated

**Head proven:** `bd05abf1d31c4749e5676982f5d7396d908e086c` (branch `worktree-364-control-plane`, tree
clean). **Run window (UTC):** tier 1 at 2026-07-25T13:37Z–13:43Z; tiers 3 and 4 at
2026-07-25T13:48:31Z–13:49:01Z.

**Nonce:** `n364-a0be3694c292` — minted for this run, carried as the data directory's own name
(`~/.ambient-agent-n364-a0be3694c292`), so every path-bearing line of the boot-failure report the
control plane serves names *this* run and no earlier one.

**Binary under proof:** `dist/cli/main.js`, built from that head by `pnpm run build`. Every live run
invokes it the way an operator does, never through a test harness. The whole tier-3/4 sequence is one
script, committed beside this file: [`artifacts/live-proof.sh`](artifacts/live-proof.sh).

## Tier table

| tier | verdict | evidence |
|---|---|---|
| 1 mechanical | **PROVEN** | `pnpm run typecheck && pnpm test` → typecheck clean, **833 passed / 4 skipped / 0 failed**, exit 0 — [`02-tier1-mechanical.txt`](artifacts/02-tier1-mechanical.txt), which also lists the contract's named test by name: *"keeps serving and exposes the failure when the runtime boot throws"* |
| 2 integrated | **N/A** | no agent behaviour changes in this node |
| 3 live (control plane, branch) | **PROVEN** | five runs of the built binary against real data directories — [`03`](artifacts/03-tier3-unconfigured.txt) unconfigured · [`04`](artifacts/04-tier3-install.txt) install · [`05`](artifacts/05-tier3-broken-credential.txt) broken credential · [`06`](artifacts/06-tier3-second-process.txt) second process refused · [`08`](artifacts/08-tier3-two-ports-one-process.txt) two ports, one pid · [`10`](artifacts/10-tier3-token-survives-restart.txt) token survives restart |
| 4 readback | **PROVEN** | the token is in exactly one file (`credentials/control-plane.json`, mode 0600) and in no log file, for both installations — [`07-tier4-readback.txt`](artifacts/07-tier4-readback.txt) |
| 5 observed | **N/A** | no model traffic in this node |

## Baseline — the nonce appears nowhere first

[`01-baseline-nonce-absent.txt`](artifacts/01-baseline-nonce-absent.txt): `git grep` over the committed
head returns nothing, `grep -r` over the built `dist/` returns 0 matches in every file, and the data
directory does not exist.

## What each live run shows

**Run A — no configuration present** ([`03`](artifacts/03-tier3-unconfigured.txt)).
`ambient-agent --data-dir $D --control-port 47474` against a directory that does not exist: the control
plane binds and stays up (`ps` at the end of the exchange), `/api/status` with no `Authorization` header
and with a guessed one both return `401` + `WWW-Authenticate: Bearer`. Stdout here is a pipe, not a
terminal, so the process-lifetime token is **withheld** — the process says where the token went instead.
`ls -d $D` still reports *No such file or directory*: an unconfigured control plane deliberately does not
create the data directory, because `inspectManagedData` would then classify it `incomplete` and
`ambient-agent init` would refuse to install into it.

**Run B — a real installation** ([`04`](artifacts/04-tier3-install.txt)). `init` builds one, headlessly,
with the repo's own `tests/fixtures/packed-runtime.mjs` standing in for whatsappd, `@octokit/rest`, e2b
and the ChatGPT device endpoints — the same stand-ins `tests/packaging/packed-cli.test.ts` uses to reach
a real data directory without a pairing ceremony. The `whatsapp/` store is created fresh and never
copied. Nothing in the node under proof is stubbed. Note what the listing shows: `init` does **not** mint
`control-plane.json`; the control plane does, on its first boot.

**Run C — a deliberately broken credential** ([`05`](artifacts/05-tier3-broken-credential.txt)).
`credentials/model-api-key.json` is replaced with a key issued for `anthropic` while `model.provider` is
`openai`. The control plane binds, mints and persists its token, attempts the boot, captures the failure,
and keeps serving:

```json
{"dataDirectory":"…/.ambient-agent-n364-a0be3694c292","installation":"ready",
 "runtime":{"phase":"failed",
  "detail":"The managed API key at …/.ambient-agent-n364-a0be3694c292/credentials/model-api-key.json was issued for anthropic, but model.provider is openai. Run ambient-agent config --model-provider openai and paste a key for that provider.",
  "at":"2026-07-25T13:48:34.265Z"}}
```

The same run shows `401` with no token, `401` with a wrong token, `401` for the raw token sent without
the `Bearer` scheme, and `404` for an authorized unknown route — the gate runs before routing, so there
is no unauthenticated corner. Twenty-two seconds after the boot failed the process is still alive and
still answering.

**Run D — a second process** ([`06`](artifacts/06-tier3-second-process.txt)). While run C holds the
directory, a second invocation on a *different* control-plane port is refused before anything binds:
`Another ambient-agent runtime (pid 61438) is already using …`, exit 1. The pid in the message is the pid
in `runtime.lock` and the pid of the live run-C process; run C is untouched afterwards.

**Run E — two ports, one process** ([`08`](artifacts/08-tier3-two-ports-one-process.txt)). A fresh
installation with runtime port 52354. `lsof -a -p <pid> -iTCP -sTCP:LISTEN` shows **one pid holding two
listening sockets** — `127.0.0.1:47474` (control plane) and `*:52354` (the Flue runtime) — with
`/api/status` reporting `runtime.phase: "running"` and the runtime's own `/health` reporting
`{"state":"healthy","whatsapp":{"phase":"online"}}`. Full terminal capture:
[`09-runE-terminal.txt`](artifacts/09-runE-terminal.txt).

**Run F — the token is minted once** ([`10`](artifacts/10-tier3-token-survives-restart.txt)). Restarting
on the same data directory leaves the stored token's SHA-256 unchanged, and a request carrying the
*pre-restart* token answers `200`.

## Exact identifiers

| what | value |
|---|---|
| head | `bd05abf1d31c4749e5676982f5d7396d908e086c` |
| nonce | `n364-a0be3694c292` |
| run C token | sha256 `d2449676f6659995ff41cf3bdf7a1a6996e8871f5dab3c83f9ac4c43e60cc2ee`, 43 chars (32 random bytes, base64url) |
| run E/F token | sha256 `ba4fdd4cc4c41ffe35db30a3056b925aa4ac9368c43946f58caa19b12d41c161`, 43 chars |
| run C boot failure | `at` = `2026-07-25T13:48:34.265Z` |
| run D refusal | `runtime.lock` held pid 61438; the second process exited 1 |
| run E | pid 62506, ports 47474 (control plane) + 52354 (runtime), `runtimeId` `rqI1FGadcC-tJydyu3hqRP` |
| tier 1 | 84 test files (83 passed, 1 skipped), 837 tests (833 passed, 4 skipped) |

## Chain of evidence

The nonce is carried by the *behaviour*, not emitted beside it: the data directory's name only reaches
the served JSON by travelling `--data-dir` → `managedPaths()` → `readModelApiKeyOrFail`'s message → the
captured `RuntimeBoot.failed.detail` → the HTTP response body. Three independent surfaces name it for
the same run — the process's terminal output ([`05`](artifacts/05-tier3-broken-credential.txt)), the HTTP
response, and the on-disk credential and lock files ([`06`](artifacts/06-tier3-second-process.txt),
[`07`](artifacts/07-tier4-readback.txt)) — and the baseline shows it in none of them beforehand.

Tier 4 corroborates tier 3 on the token: the value the control plane accepted over HTTP in run F is the
value stored in `credentials/control-plane.json` (identical SHA-256 before and after the restart), and
`grep -rlF` across the whole data directory returns that one file and no log file. Run D's refusal is
corroborated three ways: the pid in `runtime.lock`, the pid in the refusal message, and the live pid of
run C are the same number.

Tier 1 asserts the same properties against fresh temporary installations, so they hold under the suite as
well as in the live run.

## A harness defect this proof caught

An earlier attempt backgrounded each control plane as `( cd …; node … ) &` and stopped it with
`kill $!` — which kills the *subshell*, leaving the node process bound. The next run then died on
`EADDRINUSE`, and the run after that found a dead pid in `runtime.lock`, reclaimed it, and started
happily. Read carelessly, that transcript would have looked like a passing single-instance test; it was
in fact three runs of nothing. `live-proof.sh` now `exec`s the binary so `$!` is the process itself, and
two guards make the failure loud: `bound()` aborts unless the capture contains `Control plane listening
on`, and `stop()` aborts unless the port has actually gone quiet. Ours, not the product's — repaired and
rerun rather than reported as a finding.

## What this run does not prove

- Run C's `logs/ambient-agent.1.log` is **0 bytes** — the boot fails before the runtime logs anything —
  so the token's absence from it, while true, is vacuous. Run E's log file is non-empty (224 bytes) and
  carries the same absence, which is the non-vacuous form of the check.
- The *other* half of the first-run token branch — that the token **is** printed when a human is at the
  terminal, and that the printed value authenticates — is asserted at tier 1 only
  (`tests/managed/control-plane.test.ts`, "reports not configured rather than erroring…" with
  `interactive: true`). Allocating a pty from a scripted run proved to be a flaky harness rather than
  better evidence, so it was dropped instead of faked.
- Run E's terminal capture contains a Flue `OperationFailedError` —
  `Unexpected network request in packed runtime fixture: https://chatgpt.com/backend-api/codex/responses`.
  That is the fixture refusing a real model call, not a product defect and not in this node's scope; the
  runtime still reports `state: "healthy"` and the control plane still reports `phase: "running"`.
- Tier 3 ran on the developer machine against the built head, not on the rig. The contract scopes tier 3
  for this node to the control-plane surface on the branch, which is what was run.

## Irreversible footprint

None outside a scratch directory. Two throwaway managed installations under a temporary `$HOME`
(`.ambient-agent-n364-a0be3694c292` and `…-boot`), discarded with the scratch directory. No message was
sent, no GitHub mutation made, no model call issued (the fixture refuses them), and the `whatsapp/`
session store was never copied. Both bearer tokens minted during the run are throwaway and appear here
only as SHA-256.

## Redaction

Token values are masked **at capture** — the artifacts were written through a filter, never edited
afterwards — and each token is identified by its SHA-256, which is what the server itself compares, so
the identifier pins the exact secret without disclosing it. The `sk-ant-…` string in
[`05`](artifacts/05-tier3-broken-credential.txt) is a fabricated marker the proof writes to create the
corruption; it is not a credential.
