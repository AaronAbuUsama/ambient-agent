# Issue 418 live terminal-recovery proof

Proof window: `2026-07-27T14:48:07Z`–`2026-07-27T14:53:45Z`

Exact merged and deployed head: `a7f9f9fc5b7c82de5f36122c1262cf2d686d8e03`

Runtime-minted correlation: `e47d616d-6b26-4d75-bccf-712bba39adc3`

This receipt records the supervised live proof for
[issue #418](https://github.com/AaronAbuUsama/ambient-agent/issues/418).
The product path passed tiers 1–5. The original tier-5 wording incorrectly
required a correlated Braintrust transport observation, but the installed
observer only forwards Flue run/operation/turn/tool/task/compaction events.
Issue #418 and parent map #409 were corrected on 2026-07-27 so WhatsApp
transport lifecycle observation is proven by structured runtime/operator logs
and the durable terminal-receipt ledger. Braintrust remains the observation
surface for Flue activity and the independent evaluation map #424.

## Tier table

| Tier | Verdict | Evidence |
|---|---|---|
| 1 mechanical | **PROVEN** | Exact reviewed head `6a29672cff1ca20864b2787401f0c362ff6bb4f5` passed typecheck, lint, 41/41 focused WhatsApp runtime tests, 964 ordinary tests with 4 skips, build, and Node 22/24 CI before merging as `a7f9f9f` |
| 2 integrated | **PROVEN** | The focused terminal suite covers the parked-stream boundary, cleanup, exactly-once exit, recoverable backoff, durable receipt, restart recovery, supersession, and shutdown deadlines |
| 3 live | **PROVEN** | A real phone-side linked-device revocation produced `device_removed`, one correlated `agent.offline`, guided exit, re-pair through `ambient-agent repair whatsapp`, and a correlated `agent.online` on the replacement session |
| 4 readback | **PROVEN** | SQLite row `e47d616d-6b26-4d75-bccf-712bba39adc3` contains observed, acknowledged, and announced timestamps; application DB quick-check is `ok`; config SHA is unchanged; retained application counts did not decrease |
| 5 observed | **PROVEN** | Structured logs contain one correlated offline event, guided exit and recovered online event; the durable receipt records observed, acknowledged and announced timestamps; every replacement process failed closed until repair and the repaired runtime remained active |

## Timeline

| UTC | Observation |
|---|---|
| Before `14:48:07` | `whatsapp_terminal_receipts` count was `0`; runtime was healthy and WhatsApp online |
| `14:48:07` | Provider emitted `device_removed`; runtime recorded `logged_out_remote`, correlation `e47d616d-6b26-4d75-bccf-712bba39adc3`, one offline event, guided repair output, and exited status 1 |
| `14:48:11`–`14:48:46` | systemd attempted six restarts; every replacement process failed closed on the missing/unusable store rather than becoming a zombie |
| `14:48:46` | Operator stopped the service after the durable receipt was read back |
| approximately `14:51` | `ambient-agent repair whatsapp` validated the scanned QR and replaced only the managed WhatsApp store |
| `14:52:12` | Operator started the repaired service |
| `14:52:19` | Both managed chats connected; `agent.online` carried the same correlation and original terminal receipt |
| `14:53:43` | Durable receipt was marked announced |
| `14:53:45` | A transient recoverable `connection_lost` returned online without tearing down the runtime |

## Artifacts

- [Mechanical and integrated proof](artifacts/01-mechanical-and-integrated.txt)
- [Live terminal and recovery chain](artifacts/02-live-terminal-chain.txt)
- [Durable readback and preservation](artifacts/03-readback.txt)
- [Observed-tier proof and boundary diagnosis](artifacts/04-observed.txt)

## Chain of evidence

The same runtime-minted correlation appears in the terminal SQLite receipt,
the structured offline event, the guided exit, the recovered boot record, and
the structured online event. The receipt timestamps independently record
observation at `14:48:07.948Z`, acknowledgement at `14:52:19.659Z`, and
announcement at `14:53:43.499Z`.

## Irreversible footprint

- The operator revoked the old linked WhatsApp device, invalidating that
  provider session.
- Repair created and promoted one replacement WhatsApp provider store and one
  replacement linked-device session.
- One durable terminal receipt row was added to `application.sqlite`.
- systemd recorded six failed restart attempts before the operator stop.
- No application history, managed configuration, managed secrets, email, or
  external message was deleted or created by the proof.

## Redaction

The QR, phone/account identifier, managed-chat identifiers, credentials, and
provider-store contents are deliberately absent. Exact non-sensitive
correlation IDs, commit hashes, timestamps, counts, and file hashes are
retained.
