# Receipt — node #386, retained-state observation seam

**Proof head: `f757224`** (`node-386-observation-seam`), rebased onto `main` @ `21a2905`.
Surface: **backend**. Captured 2026-07-25.

Everything below comes from one run against that head. An earlier receipt reported a run at
`e302b4a`, before the review fixes added the `isolate()` guards in `read()` and in
`subscribeToAllObservations`; that evidence was reached at a superseded head and has been discarded
rather than carried forward. No transcript here was edited.

`f757224` is the last commit that touches code. The only commit after it is the one carrying this
receipt, whose diff is `docs/receipts/386-2026-07-25/` and nothing else — so the branch head that
merges and the head that was proved are the same code:

```
$ git diff --stat f757224 HEAD
 docs/receipts/386-2026-07-25/RECEIPT.md         | …
 docs/receipts/386-2026-07-25/process-output.txt | …
 docs/receipts/386-2026-07-25/transcript-{a,b,c}.txt | …
 5 files changed
```

| tier | verdict | what it showed |
|---|---|---|
| 1 mechanical | **PASS** | `pnpm run typecheck` clean; `pnpm test` 886 passed, 4 skipped, 86 files |
| 2 integrated | **N/A** | no agent behaviour changes |
| 3 live (control plane, branch) | **PASS** | a client attached 19 s late and rendered current state from its snapshot with zero replay; it hung up, the producer rotated pairing material five more times unattended, and a second client recovered all of it from one snapshot. A dead stream and a stale QR were both observed live |
| 4 readback | **PASS** | no terminal writes for observation output remain in `apps/runtime`; `session.status` goes from **zero** reads on `21a2905` to one live read |
| 5 observed | **N/A** | no model traffic |

---

## Tier 1 — mechanical · PASS

```
$ pnpm run typecheck
> tsc --noEmit
(clean)

$ pnpm test
 Test Files  85 passed | 1 skipped (86)
      Tests  886 passed | 4 skipped (890)
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
| terminal write deleted, both branches, material retained | `tests/speaker/whatsapp-runtime.test.ts` — "captures pairing for HTTP polling, retains it off the terminal, and exposes synchronized chats" |
| SSE snapshot, deltas (including a channel created after connect), gate, reconnect, no observer leak on hangup | `tests/managed/control-plane.test.ts` — five cases |
| pairing/device settle, and a failure that never retracts a completed pairing | `tests/managed/observation.test.ts` — three cases |

---

## Tier 3 — live, against a running process · PASS

Run **locally**, not on the rig: the rig takes only merged, CI-green commits, three teammates share
one systemd service on that box, and this node touches the WhatsApp session path — proving it
against the owner's only paired session is the #311 failure mode. The contract asks for "a running
process", and this is one.

A real `dist/cli/main.js`, built from `f757224`, on a fresh managed installation at
`/tmp/386-proof2/managed`, control plane on `127.0.0.1:4747`, **pid 60088**. The WhatsApp store was
empty, so the runtime connected to WhatsApp for real and began issuing pairing QRs — a genuine
producer running on its own clock, not a fixture. Nothing was ever paired; the live session store
was never opened, moved, or modified (WA-SH).

### The nonce

Minted at run time and published to the `instance` channel **before the port bound**, then read back
by every client that connected afterwards. It cannot have pre-existed the run.

```
$ curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4747/api/status
{"instance":{"id":"hdoPm8mSlrYnqJVHFAhopw","startedAt":"2026-07-25T15:58:28.874Z","pid":60088},
 "dataDirectory":"/tmp/386-proof2/managed","installation":"ready","runtime":{"phase":"running"}}
```

### A client attaches mid-flight and renders correct state — `transcript-a.txt`

Attached 15:58:49Z. Its snapshot was taken at `observedAt: 1784995129843`, against a QR published at
`at: 1784995110789` — **19.1 seconds earlier**, to nobody. That value reached it as a snapshot at
`revision: 4` on `whatsapp` and `revision: 1` on `setup`; the four publications it was not present
for were **not** replayed.

```
snapshot:
   instance  rev=1   stale=False  id=hdoPm8mSlrYnqJVHFAhopw
   runtime   rev=2   stale=False  {"phase":"running"}
   whatsapp  rev=4   stale=False  phase=pairing  transport={'phase': 'pairing'}
   setup     rev=1   stale=False  pairing=awaiting_scan rotations=0
delta   whatsapp  rev=5  …
delta   whatsapp  rev=6  …
delta   setup     rev=2  stale=False  pairing=awaiting_scan rotations=1
```

Deltas follow for the life of the connection. `transport` is present on every `whatsapp` frame —
that is `session.status`, read at observation time.

### It is killed and reattached, and recovers — `transcript-b.txt`

Client A hung up at 15:59:39Z. **No client was attached for the next 75 seconds.** Client B attached
at 16:00:54Z:

| channel | client A's last view | client B's snapshot |
|---|---|---|
| `instance` | `hdoPm8mSlrYnqJVHFAhopw`, rev 1 | `hdoPm8mSlrYnqJVHFAhopw`, rev 1 — same run |
| `whatsapp` | rev 6 | rev **14** |
| `setup` | rev 2, `rotations: 1` | rev **6**, `rotations: 5` |

One snapshot event, zero deltas at connect. The reconnecting client recovered everything it had
missed without a single event being replayed, and the revision gap told it that it had missed
something at all.

### The producer continued throughout

The jump above happened entirely with **zero subscribers attached**: the WhatsApp client kept
rotating QRs, 1 → 5, while nobody was listening. Nothing stopped, blocked, or backed up.

### A dead stream, and a QR that went stale — `transcript-c.txt`

The third client caught the transport actually failing, which the tests can only simulate:

```
snapshot   setup rev=6  stale=False  rotations=5
delta      setup     rev=7   stale=True   pairing=awaiting_scan rotations=5
delta      whatsapp  rev=15  transport={'phase': 'backing_off', 'reason': 'connection_lost',
                                        'retryAttempt': 0, 'nextRetryAt': 1784995272189}
delta      whatsapp  rev=16  transport={'phase': 'connecting', 'retryAttempt': 1}
delta      whatsapp  rev=17  transport={'phase': 'pairing'}
delta      setup     rev=8   stale=False  pairing=awaiting_scan rotations=6
```

Three things this shows that nothing else in the receipt does:

1. **Stale, live.** The connection dropped, the QR was not renewed by its `freshUntil`, and the
   channel pushed `stale: true` — with `revision` bumped 6 → 7, so a client deduping on revision
   receives it. That is the fix from the review round, observed working.
2. **The #373 nest, closed.** `whatsapp.status.phase` stayed `pairing` throughout — the runtime's own
   startup phase cannot express a transport failure, which is exactly why `/health` once said
   `online` for ten minutes. The `transport` projection moved: `backing_off` with whatsappd's closed
   `FaultReason` (`connection_lost`), its `retryAttempt` and its `nextRetryAt`, then `connecting`,
   then back. This is #374's raw material, arriving honestly.
3. **Renewal clears staleness** rather than latching it: rev 8, `stale: false`, `rotations: 6`.

### The terminal write is gone, live

Pairing was live for the whole capture, and the process's own stdout+stderr contains none of it:

```
$ grep -c "wa.me/settings/linked_devices" process-output.txt   → 0
$ grep -ci "pairing code" process-output.txt                    → 0
$ wc -l < process-output.txt                                    → 53
```

### The gate covers the new route

```
$ curl -o /dev/null -w "%{http_code}"                        .../api/observe  → 401
$ curl -o /dev/null -w "%{http_code}" -H "Bearer wrong"      .../api/observe  → 401
$ curl -I -o /dev/null -w "%{http_code}" -H "Bearer $TOKEN"  .../api/observe  → 200 (headers only, no subscription held)
```

---

## Tier 4 — readback · PASS

### No remaining terminal writes for observation output in `apps/runtime`

```
$ grep -rnE "process\.(stdout|stderr)\.write|console\.(log|info|warn|error)|renderQr" apps/runtime/src
apps/runtime/src/app.ts:75                       console.warn  — GitHub App slug resolution failed
apps/runtime/src/app.ts:113                      console.warn  — reviewer App identity unprovisioned
apps/runtime/src/host/authorization-reload.ts:46 process.stderr.write — SIGHUP reload failed
apps/runtime/src/host/bridge-route.ts:78         console.error — chat enumeration failed
apps/runtime/src/host/bridge-route.ts:107        console.error — GitHub delivery failed
apps/runtime/src/host/whatsapp-runtime.ts:673    process.stderr.write — logged_out repair instruction, on the exit path
```

Zero of these are observation output; all six are error reporting. `whatsapp-runtime.ts:673` is the
last thing that can reach an operator before `process.exit(1)` takes the control plane down with the
runtime, and the same failure is *also* published to the `whatsapp` channel (`phase: "failed"`,
`:661`) for anyone still attached.

`renderQr` has no remaining caller in `apps/runtime`. It survives only in `apps/cli/src/prompts.ts`,
where an operator running `init` at a TTY is a legitimate observer — and that path now publishes to
the seam as well.

The deleted lines, `apps/runtime/src/host/whatsapp-runtime.ts:480-485` on `21a2905` (`:479` is the
`setRuntimeStatus` call, which was kept):

```ts
if (pairing.qr !== undefined) {
  renderQr(pairing.qr);
} else if (pairing.code !== undefined) {
  // Pairing UX, not a log record: the user must see the code, and it must not land in log files.
  process.stdout.write(`WhatsApp pairing code: ${pairing.code}\n`);
}
```

Both branches are exercised by the tier-1 pairing test, which asserts stdout stays clean for each.

### `session.status` is read, not shadowed

```
$ git grep -n "session\.status" 21a2905 -- apps packages
(no hits)

$ grep -rn "session\.status" apps packages --include='*.ts'
packages/installation/src/whatsapp-account.ts:400        transport: () => session.status,   ← the only read
packages/installation/src/whatsapp-account.ts:69         (doc comment)
apps/runtime/src/host/whatsapp-runtime.ts:434            (doc comment)
packages/installation/src/observation.ts:32, :302        (doc comments)
```

Zero reads on the merge base — that was the finding of #373 — and one now. It is a live getter with
no cache in front of it, reached from `whatsapp-runtime.ts:438` via `refreshWith`, which runs on
every `snapshot()`. So both the pull (`/health`, `/api/status`) and the push (every SSE delta)
project the transport's current state rather than a field written once during authentication.

The long-lived subscription that replaces the one torn down at `whatsapp-account.ts:335` on
`eb5c8b6`:

```
packages/installation/src/whatsapp-account.ts:401-402   observeTransport
apps/runtime/src/host/whatsapp-runtime.ts:451-453       registered before authenticate
apps/runtime/src/host/whatsapp-runtime.ts:492-500       released in a finalizer, which also drops the
                                                        projection so a stopped runtime reports no transport
```
