# Receipt — node #364, control plane: one process, two ports, token-gated

**Head proven:** `bf8ed595e9200db5ae8ffeaedfa7c9a4e12e13d6` (branch `worktree-364-control-plane`, tree clean).
**Run window (UTC):** 2026-07-25T13:13:52Z → 2026-07-25T13:22:45Z.
**Nonce:** `n364-f184786f33ec` — minted for this run, carried as the data directory's own name
(`~/.ambient-agent-n364-f184786f33ec`), so every path-bearing line in the boot-failure report the control
plane serves names *this* run and no earlier one.
**Binary under proof:** `dist/cli/main.js`, built from that head by `pnpm run build`; every live run
invokes it as an operator would, never a test harness.

## Tier table

| tier | verdict | evidence |
|---|---|---|
| 1 mechanical | **PROVEN** | `pnpm run typecheck && pnpm test` → typecheck clean, **832 passed / 4 skipped / 0 failed**, exit 0, at `bf8ed59` — [`02-tier1-mechanical.txt`](artifacts/02-tier1-mechanical.txt). The contract's named test, verbatim: *"keeps serving and exposes the failure when the runtime boot throws"* — [`02b-tier1-named-test.txt`](artifacts/02b-tier1-named-test.txt) |
| 2 integrated | **N/A** | no agent behaviour changes in this node |
| 3 live (control plane, branch) | **PROVEN** | five runs of the built binary against real data directories — [`03`](artifacts/03-tier3-unconfigured.txt) unconfigured · [`04`](artifacts/04-tier3-install.txt) install · [`05`](artifacts/05-tier3-broken-credential.txt) broken credential · [`06`](artifacts/06-tier3-second-process.txt) second process refused · [`08`](artifacts/08-tier3-two-ports-one-process.txt) two ports, one pid · [`10`](artifacts/10-tier3-token-survives-restart.txt) token survives restart |
| 4 readback | **PROVEN** | token present in exactly one file (`credentials/control-plane.json`, mode 0600) and in no log file, for both installations — [`07-tier4-readback.txt`](artifacts/07-tier4-readback.txt) |
| 5 observed | **N/A** | no model traffic in this node |

## Baseline — the nonce appears nowhere first

[`01-baseline-nonce-absent.txt`](artifacts/01-baseline-nonce-absent.txt): `git grep` over the committed
head returns nothing, `grep -r` over the built `dist/` returns 0 matches in every file, and the data
directory does not exist.

## What each live run shows

**Run A — no configuration present** ([`03`](artifacts/03-tier3-unconfigured.txt)).
`ambient-agent --data-dir $D --control-port 47474` against a directory that does not exist: the control
plane binds and stays up, `/api/status` with no `Authorization` header returns `401` with
`WWW-Authenticate: Bearer`, and with the token returns

```json
{"dataDirectory":"…/.ambient-agent-n364-f184786f33ec","installation":"absent",
 "runtime":{"phase":"not-configured","detail":"Ambient Agent is not configured. Run ambient-agent init."}}
```

`ls -d $D` still reports *No such file or directory*: an unconfigured control plane deliberately does not
create the data directory, because `inspectManagedData` would then classify it `incomplete` and
`ambient-agent init` would refuse to install into it.

**Run B — a real installation** ([`04`](artifacts/04-tier3-install.txt)). `init` builds one, headlessly,
with the repo's own `tests/fixtures/packed-runtime.mjs` standing in for whatsappd, `@octokit/rest`, e2b
and the ChatGPT device endpoints — the same stand-ins `tests/packaging/packed-cli.test.ts` uses to reach a
real data directory without a pairing ceremony. The `whatsapp/` store was never copied. Nothing in the
node under proof is stubbed. Note what the listing shows: `init` does **not** mint `control-plane.json`.

**Run C — a deliberately broken credential** ([`05`](artifacts/05-tier3-broken-credential.txt)).
`credentials/model-api-key.json` is replaced with a key issued for `anthropic` while `model.provider` is
`openai`. The control plane binds, mints and persists its token, attempts the boot, captures the failure,
and keeps serving:

```json
{"dataDirectory":"…/.ambient-agent-n364-f184786f33ec","installation":"ready",
 "runtime":{"phase":"failed",
  "detail":"The managed API key at …/.ambient-agent-n364-f184786f33ec/credentials/model-api-key.json was issued for anthropic, but model.provider is openai. Run ambient-agent config --model-provider openai and paste a key for that provider.",
  "at":"2026-07-25T13:19:04.875Z"}}
```

The same run shows `401` without a token, `401` with a wrong token, `404` for an authorized unknown route
(the gate runs before routing), and — 24 seconds after the boot failed — the process still alive and
still answering.

**Run D — a second process** ([`06`](artifacts/06-tier3-second-process.txt)). While run C holds the
directory, a second invocation on a *different* control-plane port is refused before anything binds:
`Another ambient-agent runtime (pid 70963) is already using …`, exit 1, with the first process untouched.

**Run E — two ports, one process** ([`08`](artifacts/08-tier3-two-ports-one-process.txt)). A fresh
installation whose runtime port is 50987. `lsof -a -p <pid> -iTCP -sTCP:LISTEN` shows one pid holding two
listening sockets — `127.0.0.1:47474` (control plane) and `*:50987` (the Flue runtime) — with
`/api/status` reporting `runtime.phase: "running"` and the runtime's own `/health` reporting
`{"state":"healthy","whatsapp":{"phase":"online"}}`. Full terminal capture:
[`09-runE-terminal.txt`](artifacts/09-runE-terminal.txt).

**Run F — the token is minted once** ([`10`](artifacts/10-tier3-token-survives-restart.txt)). Restarting
on the same data directory leaves the stored token's SHA-256 unchanged
(`7e61421e…cabf798`), and a request carrying the *pre-restart* token answers `200`.

## Exact identifiers

| what | value |
|---|---|
| head | `bf8ed595e9200db5ae8ffeaedfa7c9a4e12e13d6` |
| nonce | `n364-f184786f33ec` |
| run C token | sha256 `24bae3144f221d8e7b88f3bb00eb35547b48c48a5098d9a7d48fe7317eca3db7`, 43 chars (32 random bytes, base64url) |
| run E/F token | sha256 `7e61421e03cbffedac134fa45645794a649dbd50e851f75b85bcfb206cabf798`, 43 chars |
| run C boot failure | `at` = `2026-07-25T13:19:04.875Z` |
| run E runtime | `runtimeId` `Gb49NiZXg472uqCAfKUKIC`, ports 47474 (control plane) + 50987 (runtime), pid 76831 |
| run D refused | pid 70963 held the lock; the second process exited 1 |

## Chain of evidence

The nonce is the data directory's name, so it is carried by the *behaviour* and not merely emitted
beside it: the path only reaches the served JSON by travelling `--data-dir` → `managedPaths()` →
`readModelApiKeyOrFail`'s message → the captured `RuntimeBoot.failed.detail` → the HTTP response. Three
independent surfaces name it for the same run — the process's terminal output
([`05`](artifacts/05-tier3-broken-credential.txt)), the HTTP response body, and the on-disk
credential/lock files ([`07`](artifacts/07-tier4-readback.txt)) — and the baseline
([`01`](artifacts/01-baseline-nonce-absent.txt)) shows it in none of them beforehand.

Tier 4 corroborates tier 3 on the token: the value the control plane accepted over HTTP in run F is the
value stored in `credentials/control-plane.json` (same SHA-256 before and after the restart), and
`grep -rlF` over the whole data directory returns that one file and no log file.

Tier 1's readback check is the same assertion run against a fresh temporary installation
(`generates the token once, persists it, and keeps it out of stdout and the log files`), so the property
holds under the suite as well as in the live run.

## What this run does not prove

- Run C's `logs/ambient-agent.1.log` is **0 bytes** — the boot fails before the runtime logs anything —
  so the token's absence from it is true but vacuous. Run E's log file is non-empty (224 bytes, 1 line
  at capture) and carries the same absence, which is the non-vacuous form of the check.
- Run E's terminal capture contains a Flue `OperationFailedError` —
  `Unexpected network request in packed runtime fixture: https://chatgpt.com/backend-api/codex/responses`.
  That is the fixture refusing a real model call, not a product defect and not in this node's scope; the
  runtime still reports `state: "healthy"` and the control plane still reports `phase: "running"`.
- Tier 3 was run on the developer machine against the built head, not on the rig. The contract scopes
  tier 3 to the control-plane surface on the branch, which is what was run.

## Irreversible footprint

None outside a scratch directory. Two throwaway managed installations under a temporary `$HOME`
(`~/.ambient-agent-n364-f184786f33ec` and `…-boot`), both discarded with the scratch directory; no
message was sent, no GitHub mutation made, no model call issued (the fixture refuses them), and the
`whatsapp/` session store was never copied. Both bearer tokens minted during the run are throwaway and
are recorded here only as SHA-256.

## Redaction

Token values are masked **at capture** — the artifacts were written through a filter, never edited
afterwards — and each token is identified by its SHA-256, which is what the server itself compares, so
the identifier pins the exact secret without disclosing it. The `sk-ant-…` string in
[`05`](artifacts/05-tier3-broken-credential.txt) is a fabricated marker written by the proof to create
the corruption; it is not a credential.
