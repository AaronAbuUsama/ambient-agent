# Snapshot-plus-deltas: the retained-state observation seam

The contract every in-process signal a browser watches goes through, defined by #386 and quoted
verbatim by **#371** (setup progress) and **#374** (honest liveness and the operator feed). Neither
node builds its own delivery: they publish to a channel and let this seam do the rest.

Code: `packages/installation/src/observation.ts`. Delivery: `GET /api/observe` on the control plane
(`apps/cli/src/control-plane.ts`).

## The nest it closes

> Live truth exists at a seam and is discarded there, so any observer that was not listening at emit
> time cannot learn it, and downstream invents its own state and never reconciles it.

Two confirmed instances, both now routed through this seam:

| Instance | What was discarded | Symptom |
|---|---|---|
| Liveness (#373) | `session.status` had zero reads repo-wide, and `onStatus` was torn down (`whatsapp-account.ts:335` on `eb5c8b6`) the instant authentication settled | `/health` reported `online` for 10+ minutes against a dead stream (#312) |
| Setup flow (#370) | `PairingCallbacks.onPairing` / `DeviceCodeCallbacks.onDeviceCode` were push-only and fire-and-forget | A page connecting late, or reopened mid-pair, rendered blank against a live pairing session |

## The name

**Snapshot-plus-deltas.** A channel holds its current value, exposes it for pull, and takes
long-lived subscriptions for push. A consumer reads a snapshot on connect and receives deltas
thereafter. There is no event log and no replay.

## The shape

```ts
interface Observation<T> {
  readonly channel: string;
  readonly value: T;
  readonly at: number;            // epoch ms of the publication that produced `value`
  readonly observedAt: number;    // epoch ms this reading was taken
  readonly revision: number;      // monotonic count of announcements — see the note below
  readonly freshUntil?: number;   // the renewal deadline the producer promised, if it promised one
  readonly stale: boolean;        // a promised renewal that did not arrive — never true without one
}

interface Observed<T> {
  readonly channel: string;
  readonly snapshot: () => Observation<T>;
  readonly subscribe: (observer: (o: Observation<T>) => void) => () => void;
}

interface Retained<T> extends Observed<T> {
  readonly publish: (value: T, options?: { readonly freshUntil?: number }) => void;
  readonly refreshWith: (project: (published: T) => T) => void;
}

const observed: <T>(channel: string, initial: T) => Retained<T>;
```

`observed(name, initial)` creates the channel on first use and returns the *same* cell with its
value intact on every later call — which is how the control plane and the separately bundled runtime
meet on one channel without either resetting the other's state.

### Five properties consumers may rely on

1. **Late attach is not a lost value.** `snapshot()` is total; a channel always has a value.
2. **No replay.** A subscriber receives only publications after it attached. What it missed it reads
   from its snapshot, and the `revision` gap tells it that it missed something at all.
3. **Zero subscribers never blocks the producer.** `publish` assigns and iterates a possibly empty
   set — no queue, no backpressure — and a throwing observer is isolated from the producer and from
   the other observers.
4. **Reconnect recovers everything.** State is the whole value, not a fold over events, so one
   snapshot restores a client completely.
5. **Stale is distinguishable from idle.** Publishing with `freshUntil` is a promise to publish
   again; past that instant the observation reads `stale: true` and a delta is emitted. A value
   published *without* a deadline is legitimately idle and never goes stale. A rotating pairing QR
   is the first kind; a healthy silent WhatsApp socket is the second.

(The module docblock in `observation.ts` numbers these 1–4 without "no replay", which it states in
its opening paragraph instead. This list is the canonical one to quote.)

### What `revision` does and does not promise

It counts what the channel has *announced*: every `publish`, plus the moment a promised renewal
failed to arrive. A gap therefore means "you missed something", which is what a reconnecting client
needs.

It is **not** a content hash. A channel with a live source projects that source at read time, so two
reads at the same revision can differ — on the `whatsapp` channel they routinely do, because that is
the point of the projection. Do not dedupe rendering on `revision` alone for a projected channel.

### Pull is never a shadow

`refreshWith` names a live source read at *observation* time, so a channel projects the truth rather
than caching a copy of it. Liveness uses it to report whatsappd's `session.status` getter — the
thing #373 found was never read — instead of a field written once during authentication.

## The channels

`OBSERVATION_CHANNELS` in `observation.ts` is the whole list; producer and consumer cannot disagree
about a name.

| channel | value | producer |
|---|---|---|
| `instance` | `InstanceIdentity` — `{ id, startedAt, pid }`, minted per boot | control plane, before the port binds |
| `runtime` | `RuntimeBoot` — `not-configured` / `starting` / `running` / `failed` | control plane |
| `whatsapp` | `WhatsAppObservation` — `{ status, transport? }` | `apps/runtime/src/host/whatsapp-runtime.ts` |
| `setup` | `SetupObservation` — `{ pairing, device }` | the runtime's `onPairing`, and the CLI's device-code callbacks |

`instance.id` is what lets a client tell "the value I hold is current" from "the process restarted
under me" — the one thing a snapshot alone cannot say.

`WhatsAppObservation.transport` is whatsappd's connection state projected to `{ phase, reason?,
retryAttempt?, nextRetryAt? }` and **deliberately not the raw `Status`**: its `pairing` arm carries
the QR and pairing code, and adding a live source to a channel should not quietly widen what that
channel carries. The projection is a whitelist, so a future whatsappd status arm degrades to
phase-only rather than leaking whatever it holds.

That is a bound on what `transport` adds, not a claim about the channel as a whole.
`WhatsAppObservation.status.pairing` has carried `PairingProgress` — QR and code — since before this
seam existed, because the authorized bridge pairing route reads it
(`bridge-contract.ts:49`). So both `whatsapp` and `setup` can carry pairing material, both sit behind
the control plane's bearer gate, and `/health` narrows to `phase` alone
(`bridge-contract.ts:37-47`). Treat every channel on `/api/observe` as privileged; none of them is a
public surface.

## Delivery: `GET /api/observe`

Server-sent events, behind the same bearer-token gate as every other control-plane path (#364's gate
runs before routing, so this is automatic).

```
event: snapshot
data: {"instance":{"channel":"instance","value":{...},"revision":1,"stale":false,...}, "runtime":{...}}

event: delta
data: {"channel":"whatsapp","value":{...},"at":...,"observedAt":...,"revision":7,"stale":false}
```

- The subscription is taken **after** the snapshot is written, so no publication is both in the
  snapshot and in a delta, and none can slip between the two.
- Channels registered *after* a client attached — the runtime boots later than the control plane, so
  its channels are always late — arrive as a delta carrying their first value. No reconnect needed.
- `: keepalive` comments every 15 s; the interval is unref'd, so an idle stream never holds the
  process open.

## What downstream owes

- **#374** consumes `whatsapp`, and owns *deriving* honest liveness from `transport` — the
  `degraded` phase, the `since` timestamp, and the operator feed. This seam deliberately does not
  pre-empt that mapping: it carries `status` (the runtime's own startup phase, unchanged in meaning)
  and `transport` (whatsappd's truth) side by side, and lets #374 decide what an operator is told.
- **#371** consumes `setup`, and owns the first-run flow over HTTP. Pairing material is already
  retained with its rotation deadline as `freshUntil`, so a page can tell a live QR from one the
  client stopped rotating.
