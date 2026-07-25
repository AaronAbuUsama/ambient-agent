# Receipt — node #365, expand the managed configuration store to hold secrets

- **Node:** #365 · surface **backend** · branch `agent/coder/issue-365`
- **Proven head:** `986f89a5eec9390209d7760ad2a283108606bc87` (base `eb5c8b6`, which carries #364 and #369)
- **Runtime bundle built from that head:** `dist/server.mjs` sha256 `926e3f1930f5186f4f57d6f335918c5ef4b9dfbe0eec1894119fd2d7e2de5141`
- **Rig:** `capxul-vps`, systemd `ambient-agent.service`, port 3737
- **Nonce (minted for this run):** `TST-365-store-da17dc00ce5a`

An earlier run proved head `446fc8c`. The independent review then found a real leak in `readSecret`
(see §6), so that head was superseded and **every tier was re-run from scratch against `986f89a`**,
with a fresh nonce. Only the `986f89a` run is reported below; the first run's numbers are not reused.

## Tier table

| tier | contract | verdict | evidence |
|---|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green, with round-trip and malformed-row tests per secret kind | **PASS** | §1 |
| 2 integrated | N/A | — | — |
| 3 live (control plane, branch) | runtime boots unchanged with the expanded store present, proving the expansion is inert | **PASS** | §3 |
| 4 readback | each secret kind written and read back at its exact expected shape; the run's log files contain no secret material | **PASS** | §4 |
| 5 observed | N/A | — | — |

## 0. Nonce absence, before the run — 2026-07-25T15:29:50Z

```
$ git grep -c TST-365-store-da17dc00ce5a -- .                                            → 0 matches in repo
$ ssh capxul-vps "grep -rl 'TST-365-store-da17dc00ce5a' ~/.ambient-agent/logs/ | wc -l"  → 0
$ ssh capxul-vps "strings ~/.ambient-agent/managed-config.sqlite | grep -c 'TST-…'"      → 0
```

The nonce is minted per run and never taken from the issue or an earlier receipt, so its absence
before the run is real and not an artifact of a value this repo already carries.

## 1. Tier 1 — mechanical · 2026-07-25T15:28:13Z → 15:29:29Z

Run against the exact committed head with a clean tree (`git status --short` empty).

```
$ git rev-parse HEAD
986f89a5eec9390209d7760ad2a283108606bc87
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  84 passed | 1 skipped (85)
      Tests  865 passed | 4 skipped (869)
   Duration  69.63s
```

`tests/installation/managed-config-store.test.ts` carries, per secret kind, a round-trip test and a
malformed-value test, driven off an exhaustive `Record<ManagedSecretKind, …>` fixture table — adding a
kind without a fixture fails to compile — plus a pinned list of the eight kind names. Beyond the
per-kind pairs: a stored row corrupted to invalid JSON is refused **without quoting the bytes it choked
on**; a stored row corrupted to valid-but-wrong JSON is refused on read; a refusal never carries the
value (asserted over the whole thrown object, not just its message); rotation serves the new value;
every kind survives a close and reopen; an unknown kind is rejected on both paths; a ChatGPT expiry that
could not survive the round trip is refused; the database file is owner-only on both create and reopen.

The leak test was verified **non-vacuous**: with the `JSON.parse` guard reverted, it fails with
`SyntaxError: Unexpected token 'o', "nonce-4d4de"... is not valid JSON` — the leak itself.

## 2. Deploy — 2026-07-25T15:30:21Z → 15:31:21Z

Baseline recorded before anything was overwritten:

| | before | after deploy | after rollback |
|---|---|---|---|
| package | `ambient-agent-0.4.0-cc88362.tgz` | `ambient-agent-0.4.0-986f89a.tgz` | `ambient-agent-0.4.0-cc88362.tgz` |
| `dist/server.mjs` sha256 | `ceb85c00e7eb…` | `926e3f1930f5…` | `ceb85c00e7eb…` |
| MainPID | 1848879 | 3378957 | restarted 15:34 |

Backups taken at `20260725T151547Z`: `application.sqlite`, `flue.sqlite`, `managed-config.sqlite`,
`whatsapp.tgz` (all under `~/backups/`).

## 3. Tier 3 — live, branch · 2026-07-25T15:31:21Z

The deployed bundle hash matches the local build of the proven head exactly, so the box is running this
branch and nothing else.

```
$ sha256sum ~/.local/npm-global/lib/node_modules/ambient-agent/dist/server.mjs
926e3f1930f5186f4f57d6f335918c5ef4b9dfbe0eec1894119fd2d7e2de5141

$ systemctl show ambient-agent -p MainPID -p ActiveEnterTimestamp
MainPID=3378957
ActiveEnterTimestamp=Sat 2026-07-25 15:31:21 UTC
```

The first poll, 9s after the restart, honestly reported `ok:false, state:"starting",
whatsapp:"starting"` — recorded here rather than dropped. The runtime reached healthy and stayed there
across six consecutive polls:

```
15:31:30Z {"ok":false,"runtime":{"state":"starting","whatsapp":{"phase":"starting"}}}
15:31:47Z {"…","ok":true,"runtimeId":"jQDCA0ofejoze5MWDSSe1x","runtime":{"state":"healthy","whatsapp":{"phase":"online"}}}
15:31:58Z {"ok":true,…"state":"healthy","whatsapp":{"phase":"online"}}
15:32:08Z {"ok":true,…"state":"healthy","whatsapp":{"phase":"online"}}
15:32:18Z {"ok":true,…"state":"healthy","whatsapp":{"phase":"online"}}
15:32:28Z {"ok":true,…"state":"healthy","whatsapp":{"phase":"online"}}
15:32:38Z {"ok":true,…"state":"healthy","whatsapp":{"phase":"online"}}
```

`/health` is not trusted alone (#312), so the WhatsApp stream was confirmed from the journal:

```
$ journalctl -u ambient-agent --since "2026-07-25 15:31:15" --until "15:33:00" -o cat
[flue] Server listening on http://localhost:3737
{"time":1784993491032,"subsystem":"whatsapp","operatorEvent":"agent.online",
 "detail":"managed chat connected","botIds":["22942602729@s.whatsapp.net"],
 "chatTarget":"120363410063306573@g.us, 120363428464069244@g.us","msg":"Speaker WhatsApp online"}
```

**The expansion is present and inert.** The live store, created by the booting runtime, now carries the
new table with no rows — nothing writes it, because no reader has moved (that is #366/#367):

```
$ node -e '…sqlite_master…' ~/.ambient-agent/managed-config.sqlite
tables: managed_configuration managed_secret
secret rows: 0

$ ls -la ~/.ambient-agent/managed-config.sqlite
-rw------- 1 abuusama abuusama 16384 Jul 25 15:31   (0644 before this build — see §5)
```

## 4. Tier 4 — readback · 2026-07-25T15:33:47Z → 15:33:48Z

Run **on the rig**, from a git worktree pinned to the proven head `986f89a`, with
`node_modules/@ambient-agent/*` re-pointed at that worktree's own packages so the code under test is the
head's and not the deploy clone's. Harness: [`tier4-readback.mts`](./tier4-readback.mts).

```
$ node --experimental-transform-types docs/receipts/365-2026-07-25/tier4-readback.mts \
      /tmp/365-store/managed-config.sqlite TST-365-store-da17dc00ce5a

store: /tmp/365-store/managed-config.sqlite  mode: 0600
kind                  written           read-back  shape                                                            sha256-16
github-app:coder      34b1f3f653739983  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion               34b1f3f653739983
github-app:reviewer   34b1f3f653739983  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion               34b1f3f653739983
github-app:planner    9113ed8df1de43fa  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion,webhookSecret 9113ed8df1de43fa
chatgpt-oauth         317f04d4381d9c38  IDENTICAL  access,expires,refresh,type                                      317f04d4381d9c38
model-api-key         023d622738adf81c  IDENTICAL  apiKey,kind,provider,schemaVersion                               023d622738adf81c
e2b                   8ce6f8a038bade67  IDENTICAL  apiKey,kind,schemaVersion                                        8ce6f8a038bade67
braintrust            61e100e90c6f7b87  IDENTICAL  apiKey,kind,schemaVersion                                        61e100e90c6f7b87
control-plane         cc4406e029a52645  IDENTICAL  kind,schemaVersion,token                                         cc4406e029a52645
stored kinds: braintrust chatgpt-oauth control-plane e2b github-app:coder github-app:planner github-app:reviewer model-api-key
refusal text carries the nonce: no — message: The braintrust secret is malformed.
braintrust row after the refused write: UNCHANGED 61e100e90c6f7b87
TIER 4 READBACK: PASS
```

All eight kinds round-trip byte-identically (written digest == read-back digest) at the exact key shape
their file readers validate. The harness prints digests, never values. The two GitHub App rows share a
digest because they are the same fixture written under two kinds — which is itself the point: they are
stored and retrieved independently.

**The nonce as a stored secret, then hunted through the logs.** It was written verbatim as the value of
the scratch secret (`braintrust.apiKey`) and appears in the store it was written to — and in no log:

```
=== positive control: the nonce IS in the store it was written to ===
$ strings /tmp/365-store/managed-config.sqlite | grep -c TST-365-store-da17dc00ce5a   → 6

=== every log file the run produced ===
$ find ~/.ambient-agent/logs -newermt "2026-07-25 15:29:50" -type f | wc -l           → 1
$ grep -rl "TST-365-store-da17dc00ce5a" ~/.ambient-agent/logs/ | wc -l                → 0
$ journalctl -u ambient-agent --since "15:29:50" -o cat | grep -c "TST-365-…"         → 0

=== other secret material from the run ===
$ journalctl … | grep -cE "BEGIN RSA PRIVATE KEY|-access|-refresh|-hook"              → 0
$ grep -rlE "BEGIN RSA PRIVATE KEY" ~/.ambient-agent/logs/ | wc -l                    → 0
```

The refusal path is checked directly rather than inferred: a malformed write carrying the nonce is
refused with `The braintrust secret is malformed.` and neither the message nor the stack contains it —
which is why every secret path uses `v.safeParse` and a hand-written message instead of `v.parse`, whose
`ValiError` embeds the received input, and why the row's `JSON.parse` is guarded the same way.

## 5. Finding fixed during the run

The live `managed-config.sqlite` was mode **0644**. Harmless while it held only configuration; not
harmless for a file that as of this node is designed to hold secrets. The store now creates its database
at 0600 and chmods on open, which also tightens a database an earlier config-only build left behind —
the live file went 0644 → 0600 and stayed 0600 through the rollback.

## 6. What the independent review changed

The review of head `446fc8c` found, and both reviewers reproduced, a real breach of this node's own
negative criterion: `readSecret` decoded the stored row with a bare `JSON.parse`, and V8's `SyntaxError`
quotes the opening characters of the source it choked on. A torn write that left a secret at the start
of the row put that secret into the failure text. Also found: `ChatGptOAuthCredentialSchema` accepted a
non-finite `expires`, which `JSON.stringify` writes as `null` — the store would acknowledge a write it
could never read back, and the reader that actually loads that file
(`validateChatGptOAuthCredential`) already requires a finite number. Both are fixed in `986f89a`, with
tests, and every tier was re-run against that head.

## Chain of evidence

Tiers 3 and 4 converge on the same head: the bundle the rig ran (`926e3f19…`) was built from `986f89a`,
and the tier-4 harness ran on that same box from a worktree pinned to `986f89a` with its own packages
linked. One nonce, `TST-365-store-da17dc00ce5a`, was shown absent from the repo, the rig's logs and the
live store before the run (§0); present six times in the store it was written to (§4); and absent from
every log file and journal record the run produced (§4). Tier 1's per-kind fixture table and tier 4's
per-kind digests cover the same eight kinds from opposite ends — schema and durable bytes.

**What this does not prove:** no reader has moved onto the store, so nothing proves the store can
*serve* a secret to the runtime — that is #366, and the point of this node is precisely that it cannot
yet. Nothing here proves the migration off the files (#367) or any UI (#381). Tier 4's write path was
driven by a committed harness, not by an operator through a UI, because no UI exists to drive. The
transactional-write criterion is proven only to the extent that a single upsert in a transaction is
atomic and a refused write leaves the previous row intact; no test simulates a crash mid-commit.

## Irreversible footprint

- `capxul-vps`: `ambient-agent.service` restarted three times across the two runs (15:16:49, 15:31:21,
  15:34 rollback) and is back on its recorded baseline package `ambient-agent-0.4.0-cc88362.tgz` /
  `ceb85c00e7eb…`, healthy, WhatsApp online.
- `~/backups/*-20260725T151547Z*` written (application, flue, managed-config, whatsapp).
- `~/.ambient-agent/managed-config.sqlite` permanently changed: mode 0644 → 0600, and it now carries an
  empty `managed_secret` table that the rolled-back build ignores.
- Branch builds `ambient-agent-0.4.0-446fc8c.tgz` and `-986f89a.tgz` remain on the box, uninstalled.
- The scratch stores under `/tmp/365-store` and the proof worktree `~/365-proof` were removed after
  capture.
- No WhatsApp message was sent, no GitHub artifact was authored by the runtime, and no real credential
  was read, written, or displayed at any point.
