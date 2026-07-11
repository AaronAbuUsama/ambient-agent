# Coalescer — design

The **Coalescer** is the timing layer that sits between the raw WhatsApp event
stream and the **Conversationalist** (Agent 1, the voice). It has no model. Its
whole job is *when to wake the voice*: turn a noisy, bursty per-chat stream into
a small number of well-timed "fires", each carrying a recent window of context.

```
events ──▶ COALESCER (no model; per-chat debounce) ──▶ CONVERSATIONALIST (Agent 1, the voice)
                                                                │ delegate(task)
                                                                ▼
                                                             WORKER (Agent 2, the hands — MOCKED)
```

This session builds the Coalescer for real (Effect), a **speaking-only**
Conversationalist (a deterministic self-gating stub behind a clean port), and
mocks the worker, the event source, and outbound send. The fused GitHub agent
(`agent/`) is untouched — it is the *future* Worker.

---

## 1. Types

The event type mirrors the **full-fidelity** in-process shape whatsappd emits
from `createChannelAdapter().subscribe()` — `ChannelEvent = { type: "message",
ref: ConversationRef, message: InboundMessage }`
(`node_modules/whatsappd/dist/types-B8d1OyHV.d.mts:22`, and `InboundMessage`
`Base` at `update-Bi5ZPUjP.d.mts:39-101`). We flatten `{ref, message}` into one
record and keep exactly the fields the *lossy HTTP sidecar* drops but the
in-process `subscribe()` keeps — `context.mentions` and `context.quoted`
(`update-Bi5ZPUjP.d.mts:14-22`). Those two are the immediate-fire signal, so
they are load-bearing here.

```ts
// src/coalescer/events.ts
export interface IncomingMessage {
  readonly id: string;
  readonly chatId: string;            // JID: xxx@g.us (group) | xxx@s.whatsapp.net (dm)
  readonly from: string;              // sender JID (== chatId for DMs)
  readonly pushName?: string;         // WhatsApp display name
  readonly text: string;              // textOf(message) — "" for non-text kinds
  readonly timestamp: number;         // epoch MS (real: InboundMessage.timestamp[sec] * 1000)
  readonly isGroup: boolean;
  readonly fromMe: boolean;           // bot's own messages — filtered out
  readonly live: boolean;             // false = history backfill — filtered out
  readonly mentions: readonly string[];   // context.mentions ?? []   — @-mention JIDs
  readonly quotedFrom?: string;           // context.quoted?.from      — replied-to sender JID
}
```

> **Fidelity note.** Real `subscribe()` gives `{ref, message}`; the adapter for
> the real event source maps `message.context?.mentions ?? []` → `mentions` and
> `message.context?.quoted?.from` → `quotedFrom`, and `timestamp * 1000` → ms.
> Nothing else about the coalescer changes when the mock source is swapped for
> the real one — that is the point of mirroring the shape now.

On **fire**, the Coalescer hands the Conversationalist a window — the messages
buffered since the last fire, plus *why* it fired:

```ts
export type FireReason = "debounce" | "mention" | "quote-reply";

export interface ConversationWindow {
  readonly chatId: string;
  readonly messages: readonly IncomingMessage[];  // rolling buffer at fire time
  readonly reason: FireReason;
}
```

---

## 2. The flush rule (the thing being designed)

Per chat, independently:

- **Bounded rolling buffer** — a recent window, not full history. Bounded by
  **count** (`maxBufferMessages`, default 10) *and* **age** (`maxBufferAgeMillis`,
  default 5 min). On append: push, then evict from the front while over count,
  and evict any message older than `newest.timestamp − maxBufferAge`. Age is
  measured against the newest buffered message's own timestamp — self-contained,
  no clock read, so it is deterministic under test.

- **One debounce timer that resets on each new message.** Ambient traffic never
  fires on the leading edge; it fires once the burst *settles* (quiet for
  `debounceWindow`, default 3s). Light traffic (one message, then quiet) fires
  ~one window later carrying just that message; heavy traffic (messages arriving
  < `debounceWindow` apart) keeps resetting the timer and fires **once** at the
  end carrying the whole burst. The light/heavy split falls out of the single
  timer for free — no separate "is this heavy?" branch.

- **@mention / quote-reply of the bot → fire immediately.** Skip the debounce
  entirely: flush the buffer (including the addressing message) right now and
  cancel the pending timer. A directly-addressed user never waits for the quiet
  window. This is the *only* immediate-fire condition, and it is exactly what
  the lossy sidecar can't express — it needs `mentions` / `quotedFrom`.

### Why an actor loop, not `Stream.debounce`

`Stream.debounce` keeps only the **latest** element and drops the rest — we need
the *whole buffer*, and we need an immediate-flush override. Neither composes
onto the stock operator. The honest model is a **per-chat actor**: one fiber per
`chatId`, each draining its own `Queue<IncomingMessage>`, with the debounce
expressed as *"take the next message, but give up waiting after `debounceWindow`"*:

```
loop(buffer):
  if buffer is empty:
    msg ← queue.take                       // block indefinitely for the first message
    buffer' = appendBounded([], msg)
    if addressesBot(msg): flush(buffer', reasonOf(msg)); loop([])
    else                : loop(buffer')
  else:
    result ← queue.take  ⏱ timeout debounceWindow   // race take vs virtual sleep
    match result:
      Some(msg):                            // another message landed inside the window
        buffer' = appendBounded(buffer, msg)
        if addressesBot(msg): flush(buffer', reasonOf(msg)); loop([])   // immediate
        else                : loop(buffer')                             // reset timer
      None:                                 // quiet for a full window
        flush(buffer, "debounce"); loop([])
```

- The timeout **is** the debounce, and it restarts every iteration → "timer
  resets on each new message".
- `timeout` is built on `Effect.sleep`, which is driven by the `Clock`. Under
  `TestClock` the sleep is *virtual*: `TestClock.adjust(debounceWindow)` fires
  the timeout deterministically with zero real wall-clock. This is why the
  actor loop is chosen over ad-hoc `setTimeout` juggling — "as async as
  possible" **and** "as testable as possible".
- A **router** fiber drains the single inbound `Stream`, and on each event
  looks up (or lazily creates) the `{queue, fiber}` for that `chatId` and
  offers the message. Per-chat isolation = one entry per key in a `Ref<HashMap>`.

`flush(buffer, reason)` = `Conversationalist.turn({ chatId, messages: buffer, reason })`.

---

## 3. The Effect ↔ Eve seam

Effect-land (the Coalescer) stays loosely coupled from Eve-land (the
Conversationalist session) behind one small port — a `Context.Tag` service:

```ts
// src/coalescer/ports.ts
export class Conversationalist extends Context.Tag("Conversationalist")<
  Conversationalist,
  { readonly turn: (w: ConversationWindow) => Effect.Effect<void, ConversationError> }
>() {}
```

- **Prototype impl** (this session): a deterministic Layer that *self-gates* —
  given a window it decides speak / act / stay silent from the window alone
  (see decision #3), and calls the `Outbound` / `Worker` ports. No model, so the
  tests are deterministic.
- **Real impl** (later): a Layer whose `turn` is `Effect.tryPromise(() =>
  eveConversationalistSession.send(renderWindow(w), { continuationToken:
  w.chatId, ... }))` — the same session API the existing channel uses
  (`agent/channels/whatsapp.ts:166`). The Coalescer depends only on the tag; the
  Eve session is an implementation detail swapped at the Layer boundary.

The Conversationalist **owns the voice**. It reaches the group only through the
`Outbound` port (`reply`, `setTyping`) — mirrors `adapter.send` / `setTyping`
(`types-B8d1OyHV.d.mts:57,61`). The Worker never posts; it reports back and the
Conversationalist narrates.

```ts
export class Outbound extends Context.Tag("Outbound")<Outbound, {
  readonly reply: (chatId: string, text: string) => Effect.Effect<void>;
  readonly setTyping: (chatId: string, on: boolean) => Effect.Effect<void>;
}>() {}

export class Worker extends Context.Tag("Worker")<Worker, {
  readonly delegate: (task: WorkerTask) => Effect.Effect<WorkerResult, WorkerError>;
}>() {}

export class EventSource extends Context.Tag("EventSource")<EventSource, {
  readonly events: Stream.Stream<IncomingMessage>;
}>() {}
```

Everything is a `Layer`, so the event source, worker, and outbound are swappable
DI seams (mock now, real later) — exactly what `Effect.Service` + `Layer` are for.

---

## 4. Open decisions — recorded

### D1. Delegation model — blocking now, non-blocking is a Layer/fork swap

The fork: **(a)** Conversationalist `await`s `delegate()` inside its turn, then
replies — simplest, but the conversation is *blocked* while the worker grinds.
**(b)** Conversationalist kicks the worker off, ends its turn ("on it — give me
a sec"), stays free to chat, and is re-woken to narrate when the worker
finishes — what "don't block the conversation" actually requires.

**Decision: build (a) now; shape the seam so (b) is a swap, not a rewrite.**
`Worker.delegate` returns an `Effect`, so (a) is `const r = yield* worker.delegate(task)`
and (b) is `yield* Effect.fork(worker.delegate(task).pipe(Effect.flatMap(narrate)))`
plus a re-wake path (a `Queue<WorkerResult>` folded back in as a synthetic
fire). Floor-first: (a) ships the real timing loop today; the `Effect`-returning
port is the exact seam a `Fiber` + `Queue` slots into. Reversible, small blast
radius (one Layer + the narrate callback), and idiomatic Effect.

> **Blocking's blast radius (the concrete cost of (a), and the case for (b)).**
> `fire` is awaited *inline* in the actor loop, so while a turn runs the loop
> isn't taking from that chat's queue: the chat's debounce is effectively paused
> and inbound messages pile up in its unbounded queue until the turn returns. The
> mock voice is instant so this is invisible today, but the real Worker (the
> fused GitHub agent) can run for minutes — that's exactly when (b) earns its
> keep. (b) also caps the memory blast radius; a bounded per-chat queue with an
> overflow policy would too.

### D2. Buffer bounds + debounce constants — config, not constants

Feel-critical and will be tuned live, so they live in a `CoalescerConfig`
service, not literals: `debounceWindow` (default **3s**), `maxBufferMessages`
(default **10**), `maxBufferAgeMillis` (default **5 min**), `botId` (the bot JID,
for mention/quote detection). Defaults are sane; the Layer is overridable per
test and per deployment.

### D3. Cheap pre-filter vs Conversationalist self-gates — self-gate

**Decision: self-gate for now (floor-first).** The Coalescer fires on every
settled burst; the Conversationalist may choose silence. On a flat ChatGPT
subscription the marginal cost of a "decide to stay silent" turn is ~zero, so a
pre-filter is premature optimization. The seam for one later is clean anyway — a
pre-filter is just a `Stream.filter` before the router, or an early return in
`turn`. No machinery spent on a cost that likely won't materialize.

### D4. Effect ↔ Eve seam — one small port (see §3)

`Effect.tryPromise` around Eve's session API, behind the `Conversationalist`
tag. Effect and Eve stay loosely coupled; neither imports the other's guts.

---

## 5. What's mocked this session

| Seam | Prototype | Real (later) |
|------|-----------|--------------|
| `EventSource` | `Stream` fed from a test `Queue`, driven under `TestClock` | `adapter.subscribe()` → `Stream.async` |
| `Conversationalist` | deterministic self-gating stub (records turns) | Eve session via `Effect.tryPromise` |
| `Worker` | canned `WorkerResult` | the fused `agent/` GitHub agent, untouched |
| `Outbound` | collects replies into a `Ref<string[]>` | `adapter.send` / `setTyping` |

## 6. Tests (deterministic, `TestClock`)

- **light-fires** — one ambient message, advance `debounceWindow` → exactly one
  fire, buffer `[m]`, reason `debounce`.
- **heavy-coalesces** — five messages `< debounceWindow` apart → **no** fire
  mid-burst; after the burst settles, exactly one fire carrying all five.
- **mention / quote-reply skips debounce** — fires immediately (before any
  window elapses), reason `mention` / `quote-reply`; a mention mid-burst flushes
  the *accumulated* window, not just the mention.
- **per-chat isolation** — interleaved messages in two chats fire independently.
- **buffer bounds** — count cap (integration) and age eviction (unit).
- **filtering** — `fromMe` / non-`live` messages never fire.
- **resilience** — a turn that *dies* doesn't wedge the chat; the next burst
  still fires (see §7.1).
- **voice** — addressed task-like text delegates + narrates (blocking); an
  ambient burst is heard but stays silent (self-gate).

No real sleeps: virtual time only, so the whole suite is instant and
deterministic. Race-freedom comes from `TestClock.adjust` running
`awaitSuspended` (blocks until every supervised fiber settles) *before*
advancing virtual time, so each offered message fully propagates
source→router→actor before the clock moves.

---

## 7. Known edges & production seam notes

Recorded from an adversarial review, so the prototype's boundaries are explicit
rather than surprises when the real seams land.

### 7.1 Handled

- **A dying turn must not wedge the chat.** `fire` swallows-and-logs both typed
  failures *and* defects (a throw inside the real Eve session), while letting
  **interruption** propagate so scope shutdown still tears loops down. Empty
  windows never fire. Covered by the *resilience* test.
- **Out-of-order timestamps.** `appendBounded` anchors age eviction on the
  `max` timestamp in the buffer, not the just-appended message — WhatsApp
  timestamps can arrive out of order (participant clock skew, delivery retries).

### 7.2 Accepted prototype tradeoffs / real-seam requirements

- **Debounce boundary loss (benign).** The flush uses `Queue.take` raced against
  a timeout; a message offered in the *exact same instant* the window expires can
  be taken-then-dropped as the timeout wins the race. It cannot occur under
  `TestClock` (offers land at distinct virtual instants), and under a real clock
  the only possible casualty is a single *ambient* message at a burst boundary —
  never an addressed one. If it must be airtight: on the timeout branch, drain
  `Queue.takeAll` and fold any straggler back in before flushing.
- **Blocking pauses coalescing / unbounded per-chat queue** — see the D1 blast-
  radius note. This is the motivation for the D1b swap.
- **Registry / actors are not reclaimed.** Each distinct `chatId` adds a
  `HashMap` entry + queue + suspended fiber for the process lifetime. Fine for a
  prototype; a long-lived deployment wants idle-chat eviction (close the queue,
  let the loop end, drop the entry) keyed on last-seen.
- **No graceful drain on shutdown.** When the `Scope` closes, actors are
  interrupted mid-wait; a chat mid-window loses its un-flushed buffer. "Clean
  shutdown" here means *stop promptly*, not *flush pending windows first*. Add a
  scope finalizer that drains if last-window delivery ever matters.
- **`EventSource` has a `never` error channel**, so `run` can't fail. The real
  `adapter.subscribe()` → `Stream.async` bridge must own reconnection and never
  surface a stream failure — the coalescer shouldn't die on a transport blip, and
  the type gives it nowhere to report one.
