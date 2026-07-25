# WhatsApp liveness: what the reported phase tracks, and what it should be derived from

Research for DAG node #373, against the source in this repository and the exact library versions
installed on 2026-07-25. It settles the contract that #374 (honest liveness and the operator feed)
and the `/health` endpoint both implement. Motivating incident: #312.

Primary sources only: this repo's TypeScript, the installed `whatsappd@0.2.1` and `baileys@7.0.0-rc13`
sources under `node_modules`. Nothing here is taken from a write-up or from memory.

## Executive conclusion

The reported WhatsApp phase is **not a connectivity signal at all**. It is a one-shot record of how far
runtime *startup* progressed, written exactly four times in the process lifetime, and after it reaches
`"online"` nothing can ever change it except the runtime fiber terminating. The transport's real state
lives one layer down in `session.status` — a live getter over whatsappd's connection state machine —
and the runtime reads it exactly once, during authentication, and then throws the subscription away.

During the #312 window the transport state was `{ phase: "logged_out", reason: "connection_replaced" }`
within **milliseconds** of the `conflict: replaced` stream error. The 10+ minutes of `online` was not a
detection-latency problem. It was a wiring problem: the honest value was sitting in memory, unread.

The fix is not a new health mechanism. It is to report the value the library already maintains.

## Versions

- `whatsappd@0.2.1` (`package.json:85`), resolved at
  `node_modules/.pnpm/whatsappd@0.2.1_@libsql+client@0.17.4_sharp@0.34.5/node_modules/whatsappd`.
  Bundled, unminified ESM; the shipped bundle retains original comments, so it reads as source.
- `baileys@7.0.0-rc13`, whatsappd's only WhatsApp engine dependency
  (`node_modules/.pnpm/whatsappd@.../node_modules/whatsappd/package.json` → `"baileys": "7.0.0-rc13"`),
  resolved at `node_modules/.pnpm/baileys@7.0.0-rc13_sharp@0.34.5/node_modules/baileys`.

Paths below are abbreviated as `WD/` = the whatsappd package root and `BA/` = the baileys package root.

---

## 1. What sets and clears the reported phase today

### The field

`WhatsAppRuntimeStatus.phase`, a six-value union, at
`packages/installation/src/runtime-health.ts:6-15`:

```ts
export type WhatsAppRuntimePhase = "disabled" | "starting" | "pairing" | "online" | "failed" | "stopped";
```

It is stored in a single process-global slot, `apps/runtime/src/host/whatsapp-runtime.ts:269-275`:

```ts
const WHATSAPP_RUNTIME_STATUS = Symbol.for("ambient-agent.whatsapp-runtime-status");
const runtimeStatus = (): WhatsAppRuntimeStatus => (runtimeGlobal[WHATSAPP_RUNTIME_STATUS] ??= { phase: "disabled" });
const setRuntimeStatus = (status: WhatsAppRuntimeStatus): void => { runtimeGlobal[WHATSAPP_RUNTIME_STATUS] = status; };
export const getWhatsAppRuntimeStatus = (): WhatsAppRuntimeStatus => structuredClone(runtimeStatus());
```

### Every write to it

There are exactly five, all in `apps/runtime/src/host/whatsapp-runtime.ts`:

| line | phase written | trigger |
|---|---|---|
| `:271` | `disabled` | lazy initialization of the global slot |
| `:444` | `starting` | synchronously, at the top of `startWhatsAppRuntime` |
| `:479` | `pairing` | inside the `onPairing` callback, while pairing material is live |
| `:564-569` | `online` | once, immediately after `account.authenticate(...)` resolves and boot sweeps finish |
| `:620` | `failed` | the runtime Effect fiber exited with a failure and `stopping` is false |
| `:635`, `:742` | `stopped` | the fiber exited without failure, or `stop()` was called |

That is the complete set. `grep` confirms no other module calls `setRuntimeStatus`; it is module-private.

The consumers all read this one field: `/health` via `bridgeHealth` (`apps/runtime/src/app.ts:234-238`,
`packages/installation/src/bridge-contract.ts:37-47`), which derives `runtime.state` purely from the
phase (`packages/installation/src/runtime-health.ts:58-69` — `online → healthy`), plus the bridge route
(`app.ts:249`), the CLI smoke gate (`apps/cli/src/smoke.ts:104-108`), and the CLI renderer
(`apps/cli/src/rendering.ts:94`). One lie propagates to all of them.

### Which WhatsApp client events are subscribed to — and which are not

whatsappd exposes a connection-status stream in two shapes: `session.connection` (an
`AsyncIterable<ConnectionEvent>`) and `session.onStatus(handler)` (callback + unsubscribe), documented
at `WD/dist/index.d.mts` in the `WhatsAppSession` interface. The repo subscribes to `onStatus` in
exactly two places, and **both stop mattering the moment the session is online**:

1. `packages/installation/src/whatsapp-account.ts:357-373` — the authentication subscription. It
   forwards pairing progress, resolves the authenticate promise on `isOnline(status)`, and rejects on
   `isTerminal(status)`. Critically, `settle()` calls `unsubscribeStatus()` at `:335`. **From the
   instant the account goes online, this listener is gone.** Every subsequent transition — backing off,
   reconnecting, logged out, suspended — is delivered to nobody.

2. `packages/installation/src/whatsapp-account.ts:229-233` — the archive-ready subscription. It stays
   registered but is a no-op for everything except online:

   ```ts
   const unsubscribeArchiveReady = ... session.onStatus((status) => {
     if (status.phase !== "online") return;
     ...
   })
   ```

Not subscribed, anywhere in the repo: `session.connection`, and any post-authentication consumer of
`onStatus`. Never read, anywhere in the repo: `session.status` (the live getter). Grep for `session.status`
across `packages/` and `apps/` returns no hits.

### Why the fiber did not die either

The obvious fallback — "when the stream dies the runtime crashes and the phase becomes `failed`" — does
not fire, because the runtime's consumption of the session does not observe stream termination. The
Coalescer's event source pushes callback events onto an **unbounded Effect Queue** and exposes
`Stream.fromQueue(queue)` (`packages/engine/src/coalescer/whatsapp.ts:126-169`, esp. `:133`, `:146`,
`:163-167`). When whatsappd closes its channels, the callbacks simply stop arriving; the queue is never
shut down, so `Stream.fromQueue` never ends and `Coalescer.run` parks forever. The fiber stays alive and
idle, indistinguishable from a quiet Saturday. Hence `online`, indefinitely — the 10 minutes in #312 was
only how long the operator waited, not a timeout.

---

## 2. What the client library actually exposes

### The live status getter and the status union

`WD/dist/adapter-19V5lRxH.mjs:1689-1691` — `createSession` returns an object whose `status` is a getter
over the state-machine variable mutated on every transition:

```js
return {
  get status() { return status; },
  connection, inbound, ...
  onStatus: (handler) => connection.on(handler),
```

The variable is written in exactly one place, `apply()` at `WD/dist/adapter-19V5lRxH.mjs:1482-1501`:

```js
async function apply(input) {
  const next = transition(status, input, ctx, Date.now());
  if (next === status) return;
  emit({ type: "transition", from: status.phase, to: next.phase });
  if (next.phase === "logged_out") await store.clear().catch(() => {});
  status = next;
  connection.push(status);
  if (isTerminal(status)) { connection.close(); inbound.close(); ... }
}
```

So `session.status` and the `onStatus` stream are the same value, one pull and one push. There is no
window in which they disagree.

The union (`WD/dist/update-Bi5ZPUjP.d.mts:262-288`) is richer than the repo's six-value phase:

```ts
type Status =
  | { phase: "disconnected" }
  | { phase: "connecting"; retryAttempt?: number }
  | { phase: "pairing"; pairing: PairingState }
  | { phase: "authenticated"; sync: SyncState }
  | { phase: "online" }
  | { phase: "backing_off"; reason: FaultReason; retryAttempt: number; nextRetryAt: number }
  | { phase: "logged_out"; reason: FaultReason }
  | { phase: "suspended"; reason: FaultReason };
```

`isOnline(status)` is `status.phase === "online"`, documented as *"True once the device is genuinely
sendable"* (`WD/dist/adapter-19V5lRxH.mjs:1594-1596`, declaration at `update-Bi5ZPUjP.d.mts:291-292`).
That claim is enforced, not decorative: every outbound operation guards on it and throws
`` `not online (phase: ${status.phase})` `` (`WD/dist/adapter-19V5lRxH.mjs:1677-1687` for `send`,
`markRead`, `setTyping`, `groupMetadata`). The repo already pattern-matches that exact string to classify
delivery failures (`apps/runtime/src/host/whatsapp-runtime.ts:69`) — i.e. the runtime *already trusts*
`session.status` as ground truth for sendability at the moment it fails, while reporting a stale
`online` on `/health`.

### Fault classification

`FaultReason` is a closed union mapped from transport status codes, never from raw payloads
(`WD/dist/update-Bi5ZPUjP.d.mts:195`), and each reason maps to one of three dispositions
(`WD/dist/adapter-19V5lRxH.mjs:7-24`):

```js
const DISPOSITION = {
  restart_required: "retryable", connection_lost: "retryable", timed_out: "retryable",
  service_unavailable: "retryable", unknown: "retryable", intentional: "retryable",
  logged_out_remote: "logged_out", connection_replaced: "logged_out", pairing_rejected: "logged_out",
  credentials_invalid: "suspended", multidevice_mismatch: "suspended", bad_session: "suspended"
};
```

`classifyDisconnect` reads `error.output.statusCode` and maps it
(`WD/dist/adapter-19V5lRxH.mjs:39-67`), including `case DisconnectReason.connectionReplaced: return
"connection_replaced"` at `:62`.

### Dead stream versus healthy idle — the discrimination

This is the crux of the research question, and the library answers it cleanly.

**A healthy idle session** sits at `{ phase: "online" }` and stays there. `transition()` has
`case "online": return state;` (`WD/dist/adapter-19V5lRxH.mjs:250`) — nothing but a close input moves it.
Underneath, baileys is *not* idle: it pings every 30 s (below). Silence in the chat is not silence on
the wire.

**A dead stream** cannot stay at `online`, because the only paths out of a live socket both produce a
`connection.update` with `connection: "close"`:

- *Explicit termination* (server stream error, close frame). `BA/lib/Socket/socket.js:788-792`:
  ```js
  ws.on('CB:stream:error', (node) => {
    const [reasonNode] = getAllBinaryNodeChildren(node);
    logger.error({ reasonNode, fullErrorNode: node }, 'stream errored out');
    const { reason, statusCode } = getErrorCodeFromStreamError(node);
    void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }));
  });
  ```
  `end()` emits `connection.update { connection: 'close', lastDisconnect: { error, date } }`
  (`BA/lib/Socket/socket.js:496-502`). Latency: the same tick.

- *Silent death* (network gone, no FIN — the case a status screen most needs). Detected by the
  keep-alive, `BA/lib/Socket/socket.js:527-557`:
  ```js
  const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
    if (!lastDateRecv) { lastDateRecv = new Date(); }
    const diff = Date.now() - lastDateRecv.getTime();
    if (diff > keepAliveIntervalMs + 5000) {
      void end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }));
    } else if (ws.isOpen) {
      query({ tag: 'iq', attrs: { ..., xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] })...
    }
  }, keepAliveIntervalMs));
  ```
  `keepAliveIntervalMs` defaults to **30 000 ms** (`BA/lib/Defaults/index.js:48-53`), and whatsappd does
  not override it — its `makeWASocket` call passes only `version`, `logger`, `browser`,
  `syncFullHistory`, `shouldSyncHistoryMessage`, `auth`
  (`WD/dist/adapter-19V5lRxH.mjs:1170-1184`), and `SessionConfig` exposes no keep-alive knob
  (`WD/dist/index.d.mts` — only `syncGraceMs`, `reconnectBaseMs`, `reconnectMaxMs`, `verdictWindowMs`,
  `sendMinGapMs`). So the threshold is 35 s of no inbound bytes, evaluated on a 30 s tick: worst-case
  detection **≤ 65 s** after the last received byte.

whatsappd converts either close into a machine input at `WD/dist/adapter-19V5lRxH.mjs:1272-1281`:

```js
if (u.connection === "close") {
  const fault = classifyDisconnect(u.lastDisconnect?.error, intentional);
  queue.push({ t: "close", fault });
  queue.close();
}
```

and `onClose` routes it (`WD/dist/adapter-19V5lRxH.mjs:125-146`): `retryable → backing_off` with
`reason`, `retryAttempt`, `nextRetryAt` (exponential, base 1 s, cap 30 s — `backoffDelay` at `:117-122`);
`logged_out → { phase: "logged_out", reason }`; `suspended → { phase: "suspended", reason }`.

So: **healthy idle is `online`; a dead stream is `backing_off`, `logged_out`, or `suspended`, always,
within a bounded time.** There is no ambiguity to resolve at the application layer.

---

## 3. Which signal would have flipped in the #312 window, and how fast

The full chain for `conflict: replaced`, every hop from primary source:

1. WhatsApp sends `<stream:error><conflict type="replaced"/></stream:error>`.
2. `BA/lib/Utils/generics.js:282-284` — `const CODE_MAP = { conflict: DisconnectReason.connectionReplaced };`
   and `getErrorCodeFromStreamError` (`:289-299`) resolves `statusCode` to `440`
   (`DisconnectReason.connectionReplaced = 440`, `BA/lib/Types/index.js:17`).
3. `BA/lib/Socket/socket.js:788-792` — the `CB:stream:error` handler logs *"stream errored out"* (the
   exact string in the #312 report) and calls `end(Boom(..., { statusCode: 440 }))`.
4. `BA/lib/Socket/socket.js:496-502` — `end()` emits `connection.update { connection: 'close' }`.
5. `WD/dist/adapter-19V5lRxH.mjs:1272-1281` — whatsappd classifies it: `440 → "connection_replaced"`
   (`:62`), disposition `"logged_out"` (`:14`).
6. `WD/dist/adapter-19V5lRxH.mjs:127-136` (`onClose`) → next state `{ phase: "logged_out", reason:
   "connection_replaced" }`.
7. `WD/dist/adapter-19V5lRxH.mjs:1482-1501` (`apply`) → `store.clear()`, `status` assigned, pushed to
   `connection`, and **all channels closed** because `isTerminal` is true
   (`WD/dist/adapter-19V5lRxH.mjs:1587-1589`). `supervise()` then breaks its loop (`:1652`).

**`session.status.phase` was `"logged_out"` within milliseconds of the 20:53Z stream error**, and
`session.onStatus` pushed that exact value to any registered listener in the same tick. No listener was
registered (§1), and no code read the getter, so the observable phase never moved.

Detection latency is therefore governed by the failure mode, not by any timer the repo owns:

| failure mode | signal | detection latency |
|---|---|---|
| stream error (`conflict: replaced`, 515, 401, 440, `CB:failure`) | `CB:stream:error` / `CB:failure` → `end()` | same tick (ms) |
| server closes the socket / `xmlstreamend` | `BA/lib/Socket/socket.js:689` | same tick (ms) |
| silent network death, no FIN | baileys keep-alive | ≤ 65 s after last received byte (35 s threshold, 30 s tick) |

Two operational consequences of the `connection_replaced` path worth carrying into #374:

- It is **terminal, not retryable** — `isRetryable("connection_replaced")` is false. The runtime cannot
  recover in place; the correct reported liveness is a terminal failure, not a transient degradation.
- `apply()` calls `store.clear()` before assigning the status, so the credential store is **wiped**. The
  runtime's existing `logged_out` exit path already says this (`apps/runtime/src/host/whatsapp-runtime.ts:626-632`).
  A status screen showing "reconnecting…" after a `replaced` would be a second lie; it must show
  "logged out — re-pair required".
- The recoverable case (#374's "it recovers when the stream returns") is `connection_lost` /
  `timed_out` / `service_unavailable` / `restart_required`, which produce `backing_off` and then
  `connecting → authenticated → online` on their own.

---

## 4. Push, freshness bound, active probe, or a combination

| option | what it would be here | latency | cost | false positives / negatives |
|---|---|---|---|---|
| **(a) Push from stream events** — subscribe `session.onStatus` for the process lifetime and mirror every transition into the reported status | ~15 lines in `whatsapp-account.ts` / `whatsapp-runtime.ts`; the stream already exists and is already multi-subscriber (`connection.on`, `WD/.../adapter:1697`) | ms for stream errors; ≤65 s for silent death (the library's own bound) | zero — one more listener on a channel that is already being pushed | none for the phase itself. One gap: a *push-only* mirror can drift if a listener throws — though whatsappd isolates handler errors (`onHandlerError`, `WD/.../adapter:1470`, `:1690-1697`) and never lets one kill the connection |
| **(b) Derived freshness bound on last activity** — "online only if a message/receipt arrived in the last N minutes" | a timestamp updated in `whatsappEventSource` + a threshold | N, by construction | trivial | **fatal false positives.** This is exactly the healthy-idle-versus-dead-stream confusion the question names: a managed group can be silent for a whole weekend while the socket is perfectly alive. Any N small enough to catch a dead stream will constantly mark a healthy idle runtime dead |
| **(c) Active probe** — the runtime sends something to WhatsApp on a timer | either an app-level ping (not exposed by whatsappd's `WhatsAppSession` surface) or a real message send | tunable | **duplicates work already being done**: baileys already pings every 30 s (`BA/lib/Socket/socket.js:534-548`). A send-based probe emits real WhatsApp traffic (the existing smoke canary path, `whatsapp-runtime.ts:652-738`, is deliberately operator-triggered and one-shot for this reason) | a probe that fails for an unrelated reason (rate limit, group deleted) reads as a dead transport — precisely the #246 confusion, re-created |
| **(d) Combination** | (a) for the feed + a synchronous **pull of the same getter at read time** for `/health` | ms / ≤65 s | zero | none |

**Recommendation: (d), and specifically (a) + pull — never (b), never (c).**

The reasoning is that (c) is already implemented, inside the library, better than the app could do it:
the keep-alive is an active probe on the actual socket with the actual protocol, and its failure is
already classified into the closed `FaultReason` union rather than into an ambiguous exception. Adding
an app-level probe would pay for a second, worse copy of it. And (b) is not merely weaker — it is the
wrong quantity: message arrival measures *conversation* activity, and the whole point is that a silent
conversation over a live socket is healthy.

Because `session.status` is a synchronous getter over the same variable the push stream carries, "pull
at read time" costs a property access and carries zero staleness. That makes the freshness bound on the
*reporting* layer exactly zero; the only latency in the contract is the library's own detection latency,
which is what should be stated to operators.

---

## RECOMMENDED LIVENESS DEFINITION

The contract for `/health`, the control plane, and the #374 status screen. One source, two deliveries.

### Source of truth

**`session.status`** — whatsappd's live connection state (`WD/dist/adapter-19V5lRxH.mjs:1689-1691`). Not
a copy, not a cache, not a derived heuristic. The runtime holds the session already
(`apps/runtime/src/host/whatsapp-runtime.ts:562`); it needs to be reachable from the status reader.

### Reported shape

```ts
interface WhatsAppLiveness {
  /** Derived from session.status at read time — see the mapping below. */
  readonly phase: "disabled" | "starting" | "pairing" | "online" | "degraded" | "failed" | "stopped";
  /** whatsappd's FaultReason for degraded/failed; absent otherwise. Distinguishes replaced from lost. */
  readonly reason?: FaultReason;
  /** Epoch ms when the current phase was entered (from the onStatus transition). */
  readonly since: number;
  /** Epoch ms when the transport state was last read. Equals now for a pull. */
  readonly observedAt: number;
  /** Only for degraded: whatsappd's nextRetryAt, so a screen can count down honestly. */
  readonly retryAt?: number;
  readonly accountJid?: string;
  readonly chatTarget?: string;
}
```

Two new phases relative to today: **`degraded`** (transport down, library is retrying on its own) and a
`failed` that now genuinely means terminal. `disabled` keeps its current meaning — the window between
the HTTP bind and the deferred WhatsApp start (`apps/runtime/src/app.ts:256-258`).

### Mapping (total over whatsappd's `Status`)

| `session.status.phase` | reported `phase` | notes |
|---|---|---|
| no session yet (runtime not started) | `disabled` | |
| `disconnected` | `starting` before the first `online`; `stopped` after an intentional `stop()` | `disconnected` is both pre-start and post-intentional-teardown (`WD/.../adapter:151`) |
| `connecting` | `starting` | |
| `pairing` | `pairing` | carry `PairingState` as today |
| `authenticated` (`draining` / `syncing`) | `starting` | **not** online — whatsappd refuses sends here (`WD/.../adapter:1677`) |
| `online` | `online` | the only healthy value |
| `backing_off` | `degraded` | `reason` = `FaultReason`, `retryAt` = `nextRetryAt` |
| `logged_out` | `failed` | terminal; `reason` distinguishes `connection_replaced` (credential store wiped, re-pair required) from `logged_out_remote` |
| `suspended` | `failed` | terminal; re-pairing will not help |

### Derived aggregates

- `runtime.state === "healthy"` **iff** `phase === "online"`. `degraded` maps to `failed` in the
  existing four-value `AmbientRuntimeState` until that union grows a `degraded` member; it must never
  map to `healthy` or `starting`.
- `BridgeHealth.ok === (phase === "online")`, unchanged in form
  (`packages/installation/src/bridge-contract.ts:43`), now truthful in substance.
- The CLI smoke gate's `phase === "online"` assertion (`apps/cli/src/smoke.ts:104`) becomes meaningful
  without modification.

### Delivery

- **Pull** — `/health` and the bridge read `session.status` synchronously on each request and map it.
  Staleness: zero, by construction.
- **Push** — one process-lifetime `session.onStatus` subscription mirrors every transition into `since`,
  emits an operator-feed record (`operatorEvent: "agent.offline" | "agent.degraded" | "agent.online"`),
  and drives the status screen's live updates. The subscription must be registered **before** and live
  **beyond** authentication — unlike today's, which is torn down at `whatsapp-account.ts:335`.

### Stated bound (the number #374 must prove)

> **A dead WhatsApp stream is reflected in the reported phase within 65 seconds, and within one event
> loop tick when the stream terminates explicitly.**

Derivation, both from baileys source: 35 s no-data threshold (`keepAliveIntervalMs + 5000`,
`BA/lib/Socket/socket.js:536`) evaluated on a 30 s interval (`BA/lib/Defaults/index.js:53`) ⇒ ≤ 65 s;
`CB:stream:error` / `CB:failure` / `CB:xmlstreamend` call `end()` inline
(`BA/lib/Socket/socket.js:689`, `:788-792`, `:794-797`) ⇒ same tick. State the 65 s, not a rounder
number: it is the actual library bound, and quoting it makes the gate falsifiable.

### One correctness obligation this exposes

Honest reporting is necessary but not sufficient. The runtime fiber currently parks forever when the
session's channels close (§1), so after a terminal fault the process lives on with a dead transport. The
liveness contract makes that **visible**; #374 should also make the terminal transition **tear the fiber
down** — the same `onStatus` subscription that feeds liveness is the natural place to do it (shut down
the Coalescer queue on `isTerminal`, so `Stream.fromQueue` ends and the fiber exits to the existing
`failed` path at `whatsapp-runtime.ts:618-633`).

---

## 5. The operator log feed: what it emits, and how to subscribe in-process

### What it already emits

The feed is Pino with a semantic renderer. The vocabulary is the `OperatorEvent` union at
`packages/engine/src/logging/operator-reporter.ts:5-14`, rendered to glyph-prefixed lines by
`semanticBody` at `:98-127`:

| event | emitted from | renders as |
|---|---|---|
| `agent.online` | `apps/runtime/src/host/whatsapp-runtime.ts:571-579` | `◆ [AGENT] Online: …` |
| `chat.received` | `packages/engine/src/coalescer/whatsapp.ts:41-52` | `← [ACTOR] text` |
| `agent.processing` | `packages/agents/src/speaker/activity-reporter.ts:76` | `▶ [AGENT] Processing: N messages` |
| `agent.say` | `activity-reporter.ts:83`, `whatsapp-runtime.ts:164-167` | `→ [AGENT] Response: …` |
| `agent.settled_silent` | `activity-reporter.ts:88` | `— settled silent` |
| `agent.final` | `activity-reporter.ts:122` | `◇ [AGENT] Final: …` |
| `agent.completed` | `activity-reporter.ts:127` | `✓ [AGENT] Completed: 1.2s` |
| `agent.retrying` | `packages/engine/src/intake/admission-relay.ts:33` | `↻ [AGENT] Retrying: …` |
| `agent.failed` | `activity-reporter.ts:95`, `admission-relay.ts:55` | `× [AGENT] Failed: …` |

All of these belong on a status screen: they are precisely the "is it working right now" narrative.

**Gap worth fixing while #374 is open:** three emitted events are *not* in the `OperatorEvent` union and
therefore fall through to the generic renderer — `agent.react` (`whatsapp-runtime.ts:195`),
`agent.directive_processing` (`activity-reporter.ts:145`), `agent.directive_failed`
(`activity-reporter.ts:152`). They still reach the feed, just unstyled. Adding the liveness events
(`agent.offline` / `agent.degraded`) is the moment to close that.

Also on the feed and worth surfacing: everything at warn/error from any subsystem, including whatsappd
itself, which is injected as a child logger at warn-and-above
(`packages/engine/src/logging/logging.ts:142-146`) — so baileys' own *"stream errored out"* and
*"connection update"* records already land in the same feed the status screen would render. The #312
evidence was in the log the whole time; only the *reported phase* disagreed.

### How to subscribe from inside the same process

**There is no in-process subscription API today.** The root logger is a Pino instance over a fixed
`multistream` built once, with exactly two sinks — a console sink and a rotating file
(`packages/engine/src/logging/logging.ts:89-104`, `:114-125`). `getLogger()` returns children of the
global root (`:132-135`). Nothing exposes the record stream to another module.

Two existing seams make adding one small:

1. **The multistream array** — `createRootLogger(options, fileStream)` composes
   `streams = [{ stream: consoleSink }, { stream: fileStream }]` at `logging.ts:93-94`. A third entry, a
   `Writable` that parses each NDJSON line and fans it out to a `Set` of subscribers, is the whole
   feature. `summarizeRepeatedUpstream` (`logging.ts:62-79`) is an in-repo worked example of exactly
   this shape: a `Writable` that parses `JSON.parse(chunk.toString())` per record and decides what to do
   with it. And `createOperatorConsoleSink` (`operator-reporter.ts:162-187`) already implements the
   NDJSON line-buffering (partial chunks reassembled across writes) that such a fan-out needs — reuse it
   rather than re-deriving the buffering.

2. **The observer precedent** — `speakerActivity.subscribe(observer) => unsubscribe` and
   `subscribeDirectives` (`packages/agents/src/speaker/activity-reporter.ts:166-173`, singleton at
   `:209`) are the established in-process pub/sub idiom in this codebase: a `Set` of subscribers, each
   notified inside a `try`/`catch` so an observer can never change the behavior it observes
   (`:51-59`). A log feed subscription should match that signature and that isolation discipline.

For #374's "a slow or absent client never blocks or backs up the runtime": the fan-out must be
non-blocking and lossy under pressure — drop-oldest per subscriber with a bounded ring, notify inside
`try`/`catch`, and never await a subscriber. The `speakerActivity` notify loop is the model; the
existing `Queue.unbounded` in the coalescer is the anti-model (unbounded is safe for WhatsApp's inbound
rate, not for a log feed with a stalled HTTP client).

---

## What could not be established from a primary source

- **The exact wire node in the 20:53Z incident.** #312 quotes `conflict: replaced` and *"stream errored
  out"*, which matches `BA/lib/Socket/socket.js:790` and the `conflict` key in `CODE_MAP`
  (`BA/lib/Utils/generics.js:283`) exactly, but the raw `<stream:error>` node from that run is not in
  this repository. The chain in §3 is the code path such an error takes; it is not a replay of the
  captured frames. If the rotated log from capxul-vps for 2026-07-22 still exists, the whatsappd child
  logger would have recorded the `reasonNode`/`fullErrorNode` at error level, and that would close the
  last gap.
- **Whether the process kept a socket open.** #312 reports zero TCP connections, which is consistent
  with `end()` closing the ws (`BA/lib/Socket/socket.js:482-488`) and `supervise()` breaking on terminal
  (`WD/.../adapter:1652`), but that consistency is inference from code, not an observation this research
  reproduced.
