# Receipt — node #386, retained-state observation seam

Captured 2026-07-25 against `node-386-observation-seam`, on `main` @ `eb5c8b6`.
Surface: **backend**. Tiers 2 and 5 are N/A by the node's contract.

| tier | verdict | evidence |
|---|---|---|
| 1 mechanical | captured | `pnpm run typecheck && pnpm test` — 856 passed, 4 skipped, 85 files |
| 2 integrated | N/A | no agent behaviour changes |
| 3 live (control plane, branch) | captured | `transcript-a.txt`, `transcript-b.txt`, `transcript-c.txt`, `process-output.txt` |
| 4 readback | captured | greps below |
| 5 observed | N/A | no model traffic |

---

## Tier 1 — mechanical

```
$ pnpm run typecheck
> tsc --noEmit
(clean)

$ pnpm test
 Test Files  85 passed | 1 skipped (86)
      Tests  856 passed | 4 skipped (860)
```

The two tests the contract names by hand, plus the rest of the acceptance criteria:

| criterion | test |
|---|---|
| late subscriber receives current state, no replay | `tests/managed/observation.test.ts` — "gives a subscriber that attaches after the publication the current value, with no replay" |
| producer proceeds with zero subscribers | `tests/managed/observation.test.ts` — "does not stop, block, or back up the producer when nobody is subscribed", and "keeps the producer running when an observer throws" |
| disconnect/reconnect recovers full state | `tests/managed/observation.test.ts` — "recovers full current state when a subscriber disconnects and reconnects" |
| stale vs legitimately idle | `tests/managed/observation.test.ts` — "tells a value that went stale from one that is legitimately idle", "pushes the staleness transition to subscribers, not only to readers" |
| pull is not a shadow | `tests/managed/observation.test.ts` — "projects a live source at read time instead of shadowing it with a cached copy" |
| liveness after auth settles (the #373 incident) | `tests/speaker/whatsapp-runtime.test.ts` — "reports a transport transition that happens after authentication settles" |
| terminal write deleted, material retained | `tests/speaker/whatsapp-runtime.test.ts` — "captures pairing for HTTP polling, retains it off the terminal, and exposes synchronized chats" |
| SSE snapshot, deltas (including a channel created after connect), gate, reconnect, no observer leak on hangup | `tests/managed/control-plane.test.ts` — five new cases |
| pairing/device settle, and a failure that never retracts a completed pairing | `tests/managed/observation.test.ts` — three new cases |

---

## Tier 3 — live, against a running process

Run **locally**, not on the rig: the rig takes only merged, CI-green commits, three teammates share
one systemd service on that box, and this node touches the WhatsApp session path — proving it
against the owner's only paired session is the #311 failure mode. The contract asks for "a running
process", and this is one.

A real `dist/cli/main.js` (built from this branch) on a fresh managed installation at
`/tmp/386-proof/managed`, control plane on `127.0.0.1:4747`, pid **37930**. The WhatsApp store was
empty, so the runtime connected to WhatsApp for real and began issuing pairing QRs — a genuine
producer running on its own clock. Nothing was ever paired and the live session store was never
touched (WA-SH).

### The nonce

Minted at run time and published to the `instance` channel **before the port bound**, then read back
by clients that connected afterwards. It cannot have pre-existed the run.

```
$ curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/api/status
{"instance":{"id":"zj3dBB6RABA3_23EYLteFg","startedAt":"2026-07-25T15:21:21.520Z","pid":37930},
 "dataDirectory":"/tmp/386-proof/managed","installation":"ready","runtime":{"phase":"running"}}
```

### A client attaches mid-flight and renders correct state — `transcript-a.txt`

Attached at 15:22:06Z, **43 seconds after** the first QR was published at `at: 1784992883480`
(15:21:23Z) — `observedAt` 1784992926859 minus `at` 1784992883480. Its first frame is a `snapshot` carrying the current QR, `revision: 4` on the
`whatsapp` channel and `revision: 1` on `setup` — not a replay of the four publications it missed.

```
event: snapshot
data: {"instance":{...,"revision":1},"runtime":{"value":{"phase":"running"},"revision":2},
       "whatsapp":{"value":{"status":{"phase":"pairing",...},"transport":{"phase":"pairing"}},"revision":4},
       "setup":{"value":{"pairing":{"kind":"awaiting_scan","qr":"...","expiresAt":1784992943480,
                "rotations":0},"device":{"kind":"idle"}},"revision":1,"freshUntil":1784992943480}}
event: delta   ×6
```

Then six deltas over the next 50 s: `rotations` 0 → 1 → 2 as the client re-issued the QR, each one
carrying a new `freshUntil`. `transport` is present on every `whatsapp` frame — that is
`session.status`, read at observation time.

### It is killed and reattached, and recovers — `transcript-b.txt`

Client A hung up at 15:22:56Z. **No client was attached for the next 63 seconds.** Client B attached
at 15:23:59Z:

| channel | client A's last view | client B's snapshot |
|---|---|---|
| `instance` | `zj3dBB6RABA3_23EYLteFg`, rev 1 | `zj3dBB6RABA3_23EYLteFg`, rev 1 — same run |
| `whatsapp` | rev 6 | rev **14** |
| `setup` | rev 3, `rotations: 2` | rev **6**, `rotations: 5` |

One snapshot, zero deltas at connect. The reconnecting client recovered everything it missed without
a single event being replayed, and the revision gap told it that it had missed something.

### The producer continued throughout — `process-output.txt`, `transcript-c.txt`

The revision jump above happened entirely with **zero subscribers attached**: the WhatsApp client
kept rotating QRs (rotations 2 → 5) while nobody was listening. `transcript-c.txt` picks the same
process up again at `whatsapp` rev 18 / `setup` rev 7 and watches it run on to rev 24 / rev 10.

### The terminal write is gone, live

Pairing was live for the whole capture, and the process's own stdout+stderr contains **none** of it:

```
$ grep -c "wa.me/settings/linked_devices" process-output.txt   → 0
$ grep -ci "pairing code" process-output.txt                    → 0
$ wc -l process-output.txt                                      → 53
```

### The gate covers the new route

```
$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:4747/api/observe                      → 401
$ curl -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" .../api/observe        → 401
```

### Not shown live

A **stale** transition. whatsappd kept rotating the QR for the whole capture window, which is the
healthy case; forcing the unrenewed case would have meant severing the process's network mid-run.
Staleness is proven at tier 1 by two tests, one for the read-time verdict and one for the pushed
delta, plus the idle-never-stale case.

---

## Tier 4 — readback

### No remaining terminal writes for observation output in `apps/runtime`

```
$ grep -rn "process\.stdout\.write|process\.stderr\.write|console\.(log|info|warn|error)|renderQr" apps/runtime/src
apps/runtime/src/app.ts:75                       console.warn  — GitHub App slug resolution failed
apps/runtime/src/app.ts:113                      console.warn  — reviewer App identity unprovisioned
apps/runtime/src/host/bridge-route.ts:78         console.error — chat enumeration failed
apps/runtime/src/host/bridge-route.ts:107        console.error — GitHub delivery failed
apps/runtime/src/host/authorization-reload.ts:46 process.stderr.write — SIGHUP reload failed
apps/runtime/src/host/whatsapp-runtime.ts:654    process.stderr.write — logged_out repair instruction, on the exit path
```

Zero of these are observation output; all six are error reporting. `whatsapp-runtime.ts:654` is the
last thing that can reach an operator before `process.exit(1)` takes the control plane down with the
runtime, and the same terminal failure is *also* published to the `whatsapp` channel (`phase:
"failed"`, `:646`) for anyone still attached.

`renderQr` has no remaining caller in `apps/runtime`. It survives only in `apps/cli/src/prompts.ts`,
where an operator running `init` at a TTY is a legitimate observer — and that path now publishes to
the seam as well.

The deleted lines, `apps/runtime/src/host/whatsapp-runtime.ts:480-485` on `eb5c8b6` (`:479` is
the `setRuntimeStatus` call, which was kept):

```ts
if (pairing.qr !== undefined) {
  renderQr(pairing.qr);
} else if (pairing.code !== undefined) {
  process.stdout.write(`WhatsApp pairing code: ${pairing.code}\n`);
}
```

### `session.status` is read, not shadowed

```
$ grep -rn "session\.status" apps packages --include='*.ts'
packages/installation/src/whatsapp-account.ts:400        transport: () => session.status,   ← the only read
packages/installation/src/whatsapp-account.ts:69         (doc comment)
apps/runtime/src/host/whatsapp-runtime.ts:434            (doc comment)
packages/installation/src/observation.ts:32,269          (doc comments)
```

On `eb5c8b6` this grep returned **nothing** — that was the finding of #373. The single read is a
live getter with no cache in front of it, reached from
`whatsapp-runtime.ts:438` via `refreshWith`, which runs on every `snapshot()` — so both the pull
(`/health`, `/api/status`) and the push (every SSE delta) project the transport's current state
rather than a field written once during authentication.

The long-lived subscription that replaces the one torn down at `whatsapp-account.ts:335`:

```
packages/installation/src/whatsapp-account.ts:401-402  observeTransport
apps/runtime/src/host/whatsapp-runtime.ts:442-444      registered before authenticate, released only in a finalizer
```
