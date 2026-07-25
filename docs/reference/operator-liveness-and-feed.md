# Honest liveness and the operator feed

The two things #374 defines and **#377** (Overview) and **#382** (Logs) consume: the **liveness
vocabulary** — what an operator is told about the WhatsApp connection — and the **operator feed** —
the process's log records, subscribable in-process and streamed to a browser.

Neither node builds its own transport. Liveness rides the observation seam
(`docs/reference/observation-seam.md`); the feed has its own endpoint because log records are a
sequence, not a current value.

Settled by `docs/research/whatsapp-liveness.md` (#373). Motivating incident: #312.

## The stated bound

> **A dead WhatsApp stream is reflected in the reported phase within 65 seconds, and within one
> event-loop tick when the stream terminates explicitly.**

`WHATSAPP_LIVENESS_BOUND_MS = 65_000` in `packages/installation/src/observation.ts`, and on the wire
as `liveness.boundMs` so a consumer never hard-codes it.

What the tests assert is **this layer's zero** — that a transport change never announced at all is
already reported on the next read (`tests/speaker/whatsapp-runtime.test.ts`). The 35 s/30 s half is
baileys' own and no fake session can exercise it; that half is what the live tier on the rig proves.

It is baileys' bound, not one this repository chose:

| failure mode | mechanism | latency |
|---|---|---|
| stream error (`conflict: replaced`, 515, 401, 440), `CB:failure`, `xmlstreamend` | `end()` called inline, emitting `connection.update {connection:'close'}` | same tick |
| silent network death, no FIN | baileys keep-alive: gives up at `keepAliveIntervalMs + 5000` = 35 s, evaluated on a 30 s interval | ≤ 65 s after the last received byte |

**This layer adds zero.** `session.status` is a synchronous getter over the same variable the push
stream carries, and the observation seam's `refreshWith` reads it at *observation* time — so there
is no poll interval, no cache, and no staleness to add to the number above. Quoting 65 s is what
makes the claim falsifiable; a rounder number would not be the real bound.

## The liveness vocabulary

```ts
interface WhatsAppLiveness {
  readonly phase: "disabled" | "starting" | "pairing" | "online" | "degraded" | "failed" | "stopped";
  readonly reason?: string;   // whatsappd's closed FaultReason, or the runtime's own error
  readonly since: number;     // epoch ms this phase was entered
  readonly retryAt?: number;  // whatsappd's nextRetryAt while degraded — an honest countdown
  readonly retryAttempt?: number; // "attempt 7" is a wedged loop; "attempt 1" is a blip
  readonly terminal?: true;   // whatsappd will not leave this phase unaided — read `reason` for why
  readonly accountJid?: string;
  readonly chatTarget?: string;
  readonly boundMs: number;   // WHATSAPP_LIVENESS_BOUND_MS
}
```

Read it from the `whatsapp` observation channel as `value.liveness` — over `GET /api/observe`, in
the `snapshot` and in every `delta`. `observedAt` is not repeated here: the seam's `Observation`
wrapper already carries it.

`degraded` is the new phase. It means *the transport is down and whatsappd is retrying on its own*,
which before #374 had no way to be said at all — the six phases could only report how far startup
got, so a dead stream had to borrow whichever startup phase happened to be last, and `online` was
usually it.

### What each phase means to an operator

| phase | what to say | what to do |
|---|---|---|
| `disabled` | the runtime has not started WhatsApp yet | wait; it is the instant between the HTTP bind and the deferred start |
| `starting` | connecting, syncing history, or wiring up | wait |
| `pairing` | waiting for a QR scan or pairing code | scan it (`setup` channel carries the material) |
| `online` | connected **and** booted — messages will be answered | nothing |
| `degraded` | the socket is gone; whatsappd is backing off | wait until `retryAt`; escalate if it does not clear |
| `failed` | terminal (`terminal: true`) or the runtime fiber failed | read `reason`: `logged_out_remote` means re-pair, `suspended` means re-pairing will not help |
| `stopped` | the operator stopped it | start it |

### The mapping

whatsappd's connection phase → the reported phase. Total over its closed union.

| `session.status.phase` | reported | note |
|---|---|---|
| `disconnected` | `starting` | after boot, `degraded` — see the overrides below |
| `connecting` | `starting` | after boot, `degraded` — see the overrides below |
| `pairing` | `pairing` | |
| `authenticated` | `starting` | **not** online — whatsappd refuses every send in this arm |
| `online` | `online` | subject to the floor below |
| `backing_off` | `degraded` | `reason`, `retryAt`, `retryAttempt` carried |
| `logged_out` | `failed` | `terminal: true` |
| `suspended` | `failed` | `terminal: true` |
| anything else | `degraded` | an arm this build does not know is a connection it cannot vouch for |

Two overrides, both deliberate:

- **The runtime owns `disabled` / `stopped` / `failed`.** The transport cannot express "never
  started" or "the operator stopped it", so when the runtime's own record says one of those it
  wins — otherwise a stopped runtime whose last-seen transport was backing off would read
  `degraded` forever.
- **After boot, anything short of an online transport is `degraded`, never `starting`.** whatsappd's
  outage cycle alternates `backing_off → connecting → backing_off`, and `connecting` maps to
  `starting` — so without this an hours-old process would flap between `failed` and `starting`
  through an outage and claim to be booting. `starting` after boot is not a thing: it is a
  reconnection, which is a degraded connection. (This rule is #374's own; the research settled the
  transport→phase table, not the relation between the two sources.)
- **The transport may report worse, never better.** whatsappd says `online` the moment the socket
  is sendable, which is before history sync has drained and the participation port is wired.
  Reporting `healthy` there would replace #312's lie with its mirror image: a coworker that answers
  `/health` with "yes" while it still cannot answer a message. The startup record is a **floor on
  readiness**, the transport is a **ceiling on connectivity**, and what is reported is the lower.

### One source, every reporter

`whatsappLiveness()` is the only derivation in the process. Everything that reports liveness reads
what it returns:

| reporter | how it reads it |
|---|---|
| `/health` (`apps/runtime/src/app.ts`) | `bridgeHealth(runtimeId, getWhatsAppRuntimeStatus())` |
| the bridge route (`installBridgeRoute`) | `getWhatsAppRuntimeStatus` |
| `bridgeHealth` (`bridge-contract.ts`) | the status handed to it |
| `bridgePairing` (`bridge-contract.ts`) | deliberately **not** the phase — it keys on `accountJid`, so a paired account with a degraded socket still reads `paired`. "Is it paired" and "is it connected" are different questions |
| `ambientRuntimeHealth` (`runtime-health.ts`) | the phase; `degraded` → `state: "failed"` |
| `probeAmbientRuntimeHealth` (CLI-side parser of `/health`) | accepts `degraded` as a valid phase |
| `ambient-agent doctor` (`inspection.ts`), `smoke` (`smoke.ts`), the renderer (`rendering.ts`) | the probed phase |
| the control plane, `GET /api/observe` | the `whatsapp` channel's `liveness` |

`getWhatsAppRuntimeStatus()` returns the runtime's startup record **with its phase replaced by the
derived one**, which is why nothing downstream had to be rewritten: they were all reading one
field, so making that field honest was the whole fix.

`AmbientRuntimeState` did not grow a member. `degraded` folds into `failed` there, because that
union has four values and none of them means "retrying" — and the one thing that must never happen
is a down transport reading `healthy` or `starting`. The unfolded phase is one field over.

## The operator feed

`packages/engine/src/logging/operator-feed.ts`, delivered at `GET /api/logs`.

A third sink on the root logger's `multistream`, alongside the console and the rotating files. What
a browser watches is therefore the *same* record stream the console and the files get, not a second
narration of the same run.

```ts
interface OperatorFeedRecord extends OperatorLogRecord { readonly seq: number }

interface OperatorFeed {
  recent: (after?: number) => { records: readonly OperatorFeedRecord[]; gap: boolean };
  subscribe: (observer: (record: OperatorFeedRecord) => void) => () => void;
}
```

`seq` is monotonic for the life of the process. `OPERATOR_FEED_RETAINED = 500` records are held,
oldest evicted first, whether or not anybody is subscribed.

### `GET /api/logs`

Server-sent events, behind the same bearer gate as every other control-plane path.

```
event: snapshot
data: {"records":[{...,"seq":41},{...,"seq":42}],"gap":false}

event: delta
data: {"level":40,"operatorEvent":"agent.degraded","detail":"WhatsApp degraded: connection_lost","seq":43}

event: gap
data: {"dropped":12,"resumeAfter":40}
```

- `?after=<seq>` resumes a reconnecting client from where it left off. `resumeAfter` on a `gap` is
  the last `seq` actually delivered, so a client re-reads from there. `gap: true` on a snapshot
  means one of two things, and both mean "you do not have a complete narrative": the cursor is
  older than the ring still reaches, or it is *ahead* of anything this process has produced — which
  is what a cursor from a previous process looks like, because `seq` restarts at 0 on every boot.
  Either way, the log files under `logs/` hold the rest.
- **A slow client is dropped, never buffered.** `response.write` returns false once the socket's
  buffer is full and Node will keep accumulating in memory from there, which is how a browser on a
  bad connection would grow the runtime's heap without bound. So when the socket needs to drain the
  record is skipped and counted, and the count is confessed on the socket's `drain` — not on the
  next record, which during an outage may never come, leaving the client watching keepalives and
  looking healthy while it misses the only records that mattered. The client re-reads what it
  missed with `?after=`.
- **An absent client costs nothing.** Publication assigns to a ring and iterates a possibly empty
  subscriber set. Nothing is awaited, nothing queues, and a throwing subscriber is isolated.
- `: keepalive` every 15 s, on an unref'd interval.

Records reach the feed *after* the root's redaction, so credential-shaped fields are already
censored. It still carries message text: treat it as privileged, exactly like `/api/observe`.

### The operator vocabulary

`OperatorEvent` in `packages/engine/src/logging/operator-reporter.ts` is the published union — an
event that is emitted but missing from it still reaches the feed, it just renders unstyled.

| event | when | glyph |
|---|---|---|
| `agent.online` | boot completed, or the transport recovered | `◆` |
| `agent.degraded` | the reported phase became `degraded` | `⚠` |
| `agent.offline` | the transport went terminal (`logged_out`/`suspended`), or the runtime fiber failed | `○` |
| `chat.received` | a managed-chat message arrived | `←` |
| `agent.processing` | the Speaker took a Window | `▶` |
| `agent.say` | the Speaker sent a message | `→` |
| `agent.react` | the Speaker reacted | `☺` |
| `agent.settled_silent` | the Speaker chose not to answer | `—` |
| `agent.final` | a final answer | `◇` |
| `agent.completed` | a turn finished | `✓` |
| `agent.retrying` | a dispatch is being retried | `↻` |
| `agent.directive_processing` | a Brain directive is being handled | `▶` |
| `agent.directive_failed` | a Brain directive failed | `×` |
| `agent.failed` | a turn failed | `×` |

Only *changes* in the reported phase are narrated, and the dedupe advances only when a line is
actually emitted: whatsappd's outage cycle is `backing_off → connecting → backing_off`, so treating
the un-narrated middle as "reported" would make every retry look like a change and put one
`agent.degraded` line on the feed per backoff tick — burying the transition that matters.

Pairing is deliberately absent from the feed: pairing material rides the `setup` observation channel
precisely so a QR or a pairing code never lands in a log file.

## Known gap

A terminal transport fault is now **reported** honestly, but the runtime fiber still parks rather
than exiting: the Coalescer's event queue is unbounded and never shut down, so `Stream.fromQueue`
never ends (`docs/research/whatsapp-liveness.md` §1). The process therefore lives on with a dead
transport, saying `failed`. Tearing the fiber down on `isTerminal` — from the same subscription
that feeds liveness — is a separate behavioural change (it ends in `process.exit`) and is not part
of #374's acceptance criteria.
