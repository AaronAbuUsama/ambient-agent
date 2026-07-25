# Receipt — node #365, expand the managed configuration store to hold secrets

- **Node:** #365 · surface **backend** · branch `agent/coder/issue-365`
- **Proven head:** `446fc8c270354bded958dc898d415c720c6dc4e8` (base `eb5c8b6`, which carries #364 and #369)
- **Runtime bundle built from that head:** `dist/server.mjs` sha256 `7fa1bf260027b292e828d8801e8a60e573f3e95cbd26d26cf31b3f0949d1c679`
- **Rig:** `capxul-vps`, systemd `ambient-agent.service`, port 3737
- **Nonce (minted for this run):** `TST-365-store-d931e8796420`

## Tier table

| tier | contract | verdict | evidence |
|---|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green, with round-trip and malformed-row tests per secret kind | **PASS** | §1 |
| 2 integrated | N/A | — | — |
| 3 live (control plane, branch) | runtime boots unchanged with the expanded store present, proving the expansion is inert | **PASS** | §3 |
| 4 readback | each secret kind written and read back at its exact expected shape; the run's log files contain no secret material | **PASS** | §4 |
| 5 observed | N/A | — | — |

## 0. Nonce absence, before the run — 2026-07-25T15:13:14Z

```
$ git grep -c TST-365-store-d931e8796420 -- .          → 0 matches in repo
$ ssh capxul-vps "grep -rl 'TST-365-store-d931e8796420' ~/.ambient-agent/logs/ | wc -l"   → 0
$ ssh capxul-vps "strings ~/.ambient-agent/managed-config.sqlite | grep -c 'TST-…'"       → 0
```

The nonce is minted per run and never taken from the issue or an earlier receipt, so its absence
before the run is real and not an artifact of a value this repo already carries.

## 1. Tier 1 — mechanical · 2026-07-25T15:13:27Z → 15:14:56Z

Run against the exact committed head with a clean tree (`git status --short` empty).

```
$ git rev-parse HEAD
446fc8c270354bded958dc898d415c720c6dc4e8
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  84 passed | 1 skipped (85)
      Tests  861 passed | 4 skipped (865)
   Duration  82.79s
```

`tests/installation/managed-config-store.test.ts` carries, per secret kind, a round-trip test and a
malformed-value test, driven off an exhaustive `Record<ManagedSecretKind, …>` fixture table — adding a
kind without a fixture fails to compile. Plus: a hand-corrupted stored row is refused on read; a
refusal never carries the value; an unknown kind is rejected rather than stored unvalidated; the
database file is owner-only.

## 2. Deploy — 2026-07-25T15:15:47Z → 15:16:57Z

Baseline recorded before anything was overwritten:

| | before | after deploy | after rollback |
|---|---|---|---|
| package | `ambient-agent-0.4.0-cc88362.tgz` | `ambient-agent-0.4.0-446fc8c.tgz` | `ambient-agent-0.4.0-cc88362.tgz` |
| `dist/server.mjs` sha256 | `ceb85c00e7eb…` | `7fa1bf260027…` | `ceb85c00e7eb…` |
| MainPID | 1848879 | 3360792 | restarted 15:19 |

Backups taken at `20260725T151547Z`: `application.sqlite`, `flue.sqlite`, `managed-config.sqlite`,
`whatsapp.tgz` (all under `~/backups/`).

## 3. Tier 3 — live, branch · 2026-07-25T15:16:49Z

The deployed bundle hash matches the local build of the proven head exactly, so the box is running
this branch and nothing else.

```
$ sha256sum ~/.local/npm-global/lib/node_modules/ambient-agent/dist/server.mjs
7fa1bf260027b292e828d8801e8a60e573f3e95cbd26d26cf31b3f0949d1c679

$ systemctl show ambient-agent -p MainPID -p ActiveEnterTimestamp
MainPID=3360792
ActiveEnterTimestamp=Sat 2026-07-25 15:16:49 UTC

$ curl -s localhost:3737/health
{"authentication":"chatgpt-oauth","model":"openai-codex/gpt-5.6-luna",
 "models":["openai-codex/gpt-5.6-luna"],"provider":"openai-codex","ok":true,
 "runtimeId":"jQDCA0ofejoze5MWDSSe1x","runtime":{"state":"healthy","whatsapp":{"phase":"online"}}}
```

`/health` is not trusted alone (#312), so the WhatsApp stream was confirmed from the journal and the
process's live sockets:

```
$ journalctl -u ambient-agent --since "2026-07-25 15:16:40" -o cat
[flue] Server listening on http://localhost:3737
{"subsystem":"whatsapp","operatorEvent":"agent.online","detail":"managed chat connected",
 "botIds":["22942602729@s.whatsapp.net"],
 "chatTarget":"120363410063306573@g.us, 120363428464069244@g.us","msg":"Speaker WhatsApp online"}
$ ss -tnp | grep -c 3360792   → 14
```

**The expansion is present and inert.** The live store, created by the booting runtime, now carries the
new table with no rows — nothing writes it, because no reader has moved (that is #366/#367):

```
$ node -e '…sqlite_master…' ~/.ambient-agent/managed-config.sqlite
managed_configuration managed_secret
secret rows: 0

$ ls -la ~/.ambient-agent/managed-config.sqlite
-rw------- 1 abuusama abuusama 16384 Jul 25 15:16   (0644 before this build — see §5)
```

## 4. Tier 4 — readback · 2026-07-25T15:18:31Z → 15:18:32Z

Run **on the rig**, from a git worktree pinned to the proven head `446fc8c`, with
`node_modules/@ambient-agent/*` re-pointed at that worktree's own packages so the code under test is
the head's and not the deploy clone's. Harness: [`tier4-readback.mts`](./tier4-readback.mts).

```
$ node --experimental-transform-types docs/receipts/365-2026-07-25/tier4-readback.mts \
      /tmp/365-store/managed-config.sqlite TST-365-store-d931e8796420

store: /tmp/365-store/managed-config.sqlite  mode: 0600
kind                  written           read-back  shape                                              sha256-16
github-app:coder      34b1f3f653739983  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion              34b1f3f653739983
github-app:reviewer   34b1f3f653739983  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion              34b1f3f653739983
github-app:planner    2c7f1789af03ce3b  IDENTICAL  appId,installationId,kind,privateKey,schemaVersion,webhookSecret 2c7f1789af03ce3b
chatgpt-oauth         32893fc6ea80eb6a  IDENTICAL  access,expires,refresh,type                                     32893fc6ea80eb6a
model-api-key         2eb36d4134381961  IDENTICAL  apiKey,kind,provider,schemaVersion                              2eb36d4134381961
e2b                   2c1132949f6b7ed0  IDENTICAL  apiKey,kind,schemaVersion                                       2c1132949f6b7ed0
braintrust            0b271a372bc1b2c0  IDENTICAL  apiKey,kind,schemaVersion                                       0b271a372bc1b2c0
control-plane         d639ddd910fbd823  IDENTICAL  kind,schemaVersion,token                                        d639ddd910fbd823
stored kinds: braintrust chatgpt-oauth control-plane e2b github-app:coder github-app:planner github-app:reviewer model-api-key
refusal text carries the nonce: no — message: The braintrust secret is malformed.
braintrust row after the refused write: UNCHANGED 0b271a372bc1b2c0
TIER 4 READBACK: PASS
```

All eight kinds round-trip byte-identically (written digest == read-back digest) at the exact key shape
their file readers validate. The harness prints digests, never values.

**The nonce as a stored secret, then hunted through the logs.** It was written verbatim as the value of
the scratch secret (`braintrust.apiKey`) and appears in the store it was written to — and in no log:

```
=== positive control: the nonce IS in the store it was written to ===
$ strings /tmp/365-store/managed-config.sqlite | grep -c TST-365-store-d931e8796420   → 6

=== every log file the run produced ===
$ find ~/.ambient-agent/logs -newermt "2026-07-25 15:15:00" -type f | wc -l           → 1
$ grep -rl "TST-365-store-d931e8796420" ~/.ambient-agent/logs/ | wc -l                → 0
$ journalctl -u ambient-agent --since "15:15:00" -o cat | grep -c "TST-365-…"         → 0

=== other secret material from the run ===
$ journalctl … | grep -cE "BEGIN RSA PRIVATE KEY|hook|-access|-refresh"               → 0
$ grep -rlE "BEGIN RSA PRIVATE KEY" ~/.ambient-agent/logs/ | wc -l                    → 0
```

The refusal path is checked directly rather than inferred: a malformed write carrying the nonce is
refused with `The braintrust secret is malformed.` and neither the message nor the stack contains it —
which is why every secret path uses `v.safeParse` and a hand-written message instead of `v.parse`,
whose `ValiError` embeds the received input.

## 5. Finding fixed during the run

The live `managed-config.sqlite` was mode **0644**. Harmless while it held only configuration; not
harmless for a file that as of this node is designed to hold secrets. The store now chmods its own
database to 0600 on open, which also tightens a database an earlier config-only build left behind — the
live file went 0644 → 0600 at the 15:16:49 boot and stayed 0600 through the rollback.

## Chain of evidence

Tiers 3 and 4 converge on the same head: the bundle the rig ran (`7fa1bf26…`) was built from `446fc8c`,
and the tier-4 harness ran on that same box from a worktree pinned to `446fc8c` with its own packages
linked. One nonce, `TST-365-store-d931e8796420`, was shown absent from the repo, the rig's logs and the
live store before the run (§0); present six times in the store it was written to (§4); and absent from
every log file and journal record the run produced (§4). Tier 1's per-kind fixture table and tier 4's
per-kind digests cover the same eight kinds, from opposite ends — schema and durable bytes.

**What this does not prove:** no reader has moved onto the store, so nothing proves the store can
*serve* a secret to the runtime — that is #366, and the point of this node is precisely that it cannot
yet. Nothing here proves the migration off the files (#367) or any UI (#381). Tier 4's write path was
driven by a harness, not by an operator through a UI, because no UI exists to drive.

## Irreversible footprint

- `capxul-vps`: `ambient-agent.service` restarted twice (15:16:49 deploy, 15:19 rollback) and is back on
  its recorded baseline package `ambient-agent-0.4.0-cc88362.tgz` / `ceb85c00e7eb…`, healthy, WhatsApp
  online. The branch build `ambient-agent-0.4.0-446fc8c.tgz` remains on the box, uninstalled.
- `~/backups/*-20260725T151547Z*` written (application, flue, managed-config, whatsapp).
- `~/.ambient-agent/managed-config.sqlite` permanently changed: mode 0644 → 0600, and it now carries an
  empty `managed_secret` table that the rolled-back build ignores.
- The scratch store `/tmp/365-store` and the proof worktree `~/365-proof` were removed after capture.
- No WhatsApp message was sent, no GitHub artifact was authored by the runtime, and no real credential
  was read, written, or displayed at any point.
