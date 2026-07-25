/**
 * The retained-state observation seam (#386).
 *
 * **The nest this closes.** Live truth existed at a seam and was discarded there: a callback fired
 * once, to whoever happened to be listening, and nothing held the value afterwards. An observer that
 * was not attached at emit time could not learn it — so `/health` reported `online` for ten minutes
 * against a dead stream (#373), and a setup page opened mid-pairing rendered blank against a live
 * pairing session (#370). Every downstream then invented its own copy of the state and never
 * reconciled it.
 *
 * **The shape, named once here and quoted by #371 and #374: _snapshot-plus-deltas_.**
 *
 * A channel *holds* its current value, *exposes it for pull* ({@link Observed.snapshot}), and takes
 * long-lived subscriptions for *push* ({@link Observed.subscribe}). A consumer reads a snapshot on
 * connect and receives deltas thereafter. There is no event log and no replay: a subscriber that
 * attaches after a publication learns the current value from its snapshot, not from a re-emission.
 *
 * Four properties this seam guarantees, and which the consumers rely on:
 *
 * 1. **Late attach is not a lost value.** `snapshot()` is total — a channel always has a value.
 * 2. **Zero subscribers never blocks the producer.** `publish` assigns and iterates a possibly
 *    empty set; there is no queue, no backpressure, and a throwing observer is isolated.
 * 3. **Reconnect recovers everything.** State is the whole value, not an accumulated fold, so one
 *    snapshot restores a client completely. `revision` lets it tell "unchanged" from "missed".
 * 4. **Stale is distinguishable from idle.** A producer that publishes with `freshUntil` is
 *    promising renewal; past that instant the observation reads `stale: true` and a delta is
 *    emitted. A value published *without* a deadline is legitimately idle and never goes stale.
 *    (A rotating pairing QR is the first kind; a healthy silent WhatsApp socket is the second.)
 *
 * **Pull is never a shadow.** {@link Retained.refreshWith} lets a producer name a live source that
 * is read at observation time, so the seam projects the truth rather than caching a copy of it —
 * this is how liveness reports whatsappd's `session.status` (a getter over the connection state
 * machine) instead of a field that was written once during authentication and then rotted.
 *
 * **Why the registry is a process global.** `apps/cli` loads the runtime through a dynamic
 * `import()` of a separately bundled dist (`lifecycle.ts:30`), so the two halves of one process do
 * not share module instances. A module-level `Map` would give the control plane an empty registry
 * and the runtime a private one. The registry therefore hangs off `globalThis` under a
 * `Symbol.for` key — the same technique, and the same reason, as the runtime status slot it
 * replaces.
 */
import type { Status } from "whatsappd";

import type { WhatsAppRuntimePhase, WhatsAppRuntimeStatus } from "./runtime-health.ts";

/** One reading of a channel: the current value, plus everything needed to judge it. */
export interface Observation<T> {
  readonly channel: string;
  readonly value: T;
  /** Epoch ms of the publication that produced `value`. */
  readonly at: number;
  /** Epoch ms this reading was taken. */
  readonly observedAt: number;
  /**
   * Monotonic count of what this channel has announced — every publication, plus the moment a
   * promised renewal failed to arrive. Equal revisions mean the same *announcement*, not
   * necessarily an identical `value`: a channel with a live source (see {@link Retained.refreshWith})
   * projects that source at read time, so its value can move within one revision.
   */
  readonly revision: number;
  /** The renewal deadline the producer promised, when it promised one. */
  readonly freshUntil?: number;
  /** True only when a promised renewal did not arrive. Never true for a value published without one. */
  readonly stale: boolean;
}

export type Observer<T> = (observation: Observation<T>) => void;

/** The consumer half: pull the current value, or subscribe for deltas. */
export interface Observed<T> {
  readonly channel: string;
  /** The current value. Always available, whatever the subscriber count and whenever it attaches. */
  readonly snapshot: () => Observation<T>;
  /** Deltas from now on — never a replay of what `snapshot` already carries. Returns unsubscribe. */
  readonly subscribe: (observer: Observer<T>) => () => void;
}

export interface PublishOptions {
  /**
   * Epoch ms by which the producer promises to publish again. Omit for a value that is correct
   * until something changes it — the difference between a value that went stale and one that is
   * simply idle.
   */
  readonly freshUntil?: number;
}

/** The producer half. */
export interface Retained<T> extends Observed<T> {
  readonly publish: (value: T, options?: PublishOptions) => void;
  /**
   * Name a live source, read at observation time and applied to the published value. Use it when
   * the truth lives in a getter someone else owns; without it the channel reports what was last
   * published, which is a cache.
   */
  readonly refreshWith: (project: (published: T) => T) => void;
}

const REGISTRY = Symbol.for("ambient-agent.observation-registry");

interface Registry {
  readonly cells: Map<string, Retained<never>>;
  readonly watchers: Set<(cell: Observed<unknown>) => void>;
}

const registryGlobal = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry = (): Registry => (registryGlobal[REGISTRY] ??= { cells: new Map(), watchers: new Set() });

/**
 * Every call *out* of a cell — into an observer, into a projection, into a watcher — goes through
 * here. The producer's work is in flight and must not unwind because a browser connection
 * misbehaved or someone else's getter threw. Swallowed, but never silently: `process.emitWarning`
 * needs no logger this deep in `installation` and lands in the journal under a service manager, so
 * a consumer defect stays debuggable instead of turning into a stream that quietly says nothing.
 */
const isolate = <R>(what: string, act: () => R, fallback: R): R => {
  try {
    return act();
  } catch (cause) {
    process.emitWarning(cause instanceof Error ? cause : new Error(String(cause)), {
      code: "AMBIENT_OBSERVATION_THREW",
      detail: what,
    });
    return fallback;
  }
};

const createCell = <T>(channel: string, initial: T): Retained<T> => {
  let value = initial;
  let at = Date.now();
  let revision = 0;
  let freshUntil: number | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let project: ((published: T) => T) | undefined;
  const observers = new Set<Observer<T>>();

  const read = (): Observation<T> => {
    const observedAt = Date.now();
    return {
      channel,
      // The projection is the most failure-prone code in the cell: it reads someone else's live
      // getter. If it throws, the channel falls back to the published value rather than taking the
      // producer — or a control plane in the middle of serving a snapshot — down with it.
      value: project === undefined ? value : isolate(`${channel} projection`, () => project!(value), value),
      at,
      observedAt,
      revision,
      ...(freshUntil === undefined ? {} : { freshUntil }),
      stale: freshUntil !== undefined && observedAt > freshUntil,
    };
  };

  const notify = (): void => {
    if (observers.size === 0) return;
    const observation = read();
    for (const observer of [...observers]) {
      isolate(`${channel} observer`, () => observer(observation), undefined);
    }
  };

  return {
    channel,
    snapshot: read,
    subscribe: (observer) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    publish: (next, options) => {
      value = next;
      at = Date.now();
      revision += 1;
      freshUntil = options?.freshUntil;
      if (expiry !== undefined) clearTimeout(expiry);
      expiry = undefined;
      if (freshUntil !== undefined) {
        // Staleness is computed at read time, so this timer exists purely so that a *subscriber*
        // learns about it too. It bumps the revision, because going stale is a change in what the
        // channel says: a client that dedupes on revision must not drop exactly the notification
        // the timer exists to deliver. Unref'd — an unrenewed value never holds the process open.
        expiry = setTimeout(
          () => {
            revision += 1;
            notify();
          },
          Math.max(0, freshUntil - at) + 1,
        );
        expiry.unref?.();
      }
      notify();
    },
    refreshWith: (next) => {
      project = next;
    },
  };
};

/**
 * The channel named `channel`, created on first use. Later calls return the *same* cell with its
 * value intact — that is what lets the control plane and the separately bundled runtime meet on
 * one channel without either resetting the other's state.
 */
export const observed = <T>(channel: string, initial: T): Retained<T> => {
  const { cells, watchers } = registry();
  const existing = cells.get(channel);
  if (existing !== undefined) return existing as unknown as Retained<T>;
  const cell = createCell(channel, initial);
  cells.set(channel, cell as unknown as Retained<never>);
  // Isolated for the same reason a delta is: this runs on the *producer's* stack, at the moment it
  // first touches a channel, and a watcher that throws must neither unwind that producer nor stop
  // the remaining watchers from learning the channel exists.
  for (const watcher of [...watchers]) {
    isolate(`${channel} channel watcher`, () => watcher(cell as unknown as Observed<unknown>), undefined);
  }
  return cell;
};

/** Every channel that exists right now. */
export const observationChannels = (): readonly Observed<unknown>[] => [
  ...(registry().cells.values() as unknown as Iterable<Observed<unknown>>),
];

/**
 * Deltas from every channel, including channels registered *after* this call — the runtime creates
 * its channels when it boots, which is after the control plane has already accepted clients.
 */
export const subscribeToAllObservations = (observer: Observer<unknown>): (() => void) => {
  const { watchers } = registry();
  const unsubscribes = new Set<() => void>();
  const attach = (cell: Observed<unknown>): void => {
    unsubscribes.add(cell.subscribe(observer));
    // A channel that appears mid-connection is itself news: emit its first value as a delta so a
    // client that has already taken its snapshot is not left waiting for the next publication.
    isolate(`${cell.channel} first delta`, () => observer(cell.snapshot()), undefined);
  };
  const watcher = (cell: Observed<unknown>): void => attach(cell);
  watchers.add(watcher);
  for (const cell of observationChannels()) unsubscribes.add(cell.subscribe(observer));
  return () => {
    watchers.delete(watcher);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
};

/** The whole observable state of the process, keyed by channel — what a connecting client reads first. */
export const observationSnapshot = (): Record<string, Observation<unknown>> =>
  Object.fromEntries(observationChannels().map((cell) => [cell.channel, cell.snapshot()]));

/** Tests only: the registry is process-global, so a test that publishes must be able to start clean. */
export const resetObservations = (): void => {
  registry().cells.clear();
  registry().watchers.clear();
  delete sinceGlobal[LIVENESS_SINCE];
};

// ---------------------------------------------------------------------------
// The channels. Named here so that producer and consumer cannot disagree.
// ---------------------------------------------------------------------------

export const OBSERVATION_CHANNELS = {
  /** Identity of this process incarnation. Published before the control plane accepts a client. */
  instance: "instance",
  /** How the in-process runtime boot went — the control plane's own state. */
  runtime: "runtime",
  /** WhatsApp liveness (#374 consumes this). */
  whatsapp: "whatsapp",
  /** First-run and re-pair progress (#371 consumes this). */
  setup: "setup",
} as const;

/**
 * whatsappd's connection state, projected to the fields an operator surface needs and *nothing
 * else*. Deliberately not the raw `Status`: its `pairing` arm carries the QR and the pairing code,
 * and adding a live source to a channel should not quietly widen what that channel carries. The
 * projection is a whitelist, so a future whatsappd status arm degrades to phase-only rather than
 * leaking whatever it holds.
 *
 * This is a bound on what `transport` adds, not a claim about the whole channel: `status.pairing`
 * has carried `PairingProgress` since before this seam existed, because the authorized bridge
 * pairing route reads it (`bridge-contract.ts:49`). Both fields sit behind the control plane's
 * bearer gate; `/health` narrows to `phase` alone (`bridge-contract.ts:37-47`).
 */
export interface TransportObservation {
  readonly phase: Status["phase"];
  /** whatsappd's closed `FaultReason` — this is what tells `connection_replaced` from `timed_out`. */
  readonly reason?: string;
  readonly retryAttempt?: number;
  readonly nextRetryAt?: number;
}

export const transportObservation = (status: Status | undefined): TransportObservation | undefined => {
  if (status === undefined) return undefined;
  const detail = status as { readonly reason?: string; readonly retryAttempt?: number; readonly nextRetryAt?: number };
  return {
    phase: status.phase,
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
    ...(detail.retryAttempt === undefined ? {} : { retryAttempt: detail.retryAttempt }),
    ...(detail.nextRetryAt === undefined ? {} : { nextRetryAt: detail.nextRetryAt }),
  };
};

/**
 * **The stated bound (#374).** A dead WhatsApp stream is reflected in the reported phase within
 * **65 seconds**, and within one event-loop tick when the stream terminates explicitly.
 *
 * Derived in `docs/research/whatsapp-liveness.md` §"Stated bound", from baileys' own source rather
 * than from any timer this repository owns:
 *
 * - **Explicit termination** — a `<stream:error>` (the #312 `conflict: replaced`), a `CB:failure`,
 *   or an `xmlstreamend` calls `end()` inline, which emits `connection.update {connection:'close'}`
 *   on the same tick. whatsappd's assignment to `session.status` follows within milliseconds — it
 *   is a queue hop through `supervise()`, plus an awaited `store.clear()` on the `logged_out` arm,
 *   so "same tick" is baileys' emission, not whatsappd's assignment.
 * - **Silent death** (network gone, no FIN) — baileys' keep-alive gives up when no byte has arrived
 *   for `keepAliveIntervalMs + 5000` = 35 s, and evaluates that on a 30 s interval, so the worst
 *   case is 35 + 30 = **65 s** after the last received byte.
 *
 * This layer adds **zero**: `session.status` is a synchronous getter over the same variable the
 * push stream carries, and {@link Retained.refreshWith} reads it at observation time. So the bound
 * above is the whole bound, and it is a property of the WhatsApp client, not of a poll we chose.
 *
 * It is on the wire as {@link WhatsAppLiveness.boundMs} so a screen can say "last checked" honestly
 * instead of inventing a number. **What the tests assert is this layer's zero** — that a status the
 * transport changed without announcing is already reported on the next read
 * (`tests/speaker/whatsapp-runtime.test.ts`). The 35 s/30 s half is baileys' own and no fake session
 * can exercise it; that half is what the live tier on the rig proves.
 */
export const WHATSAPP_LIVENESS_BOUND_MS = 65_000;

/**
 * What an operator is told about the WhatsApp connection — the vocabulary #377 (Overview) and #382
 * (Logs) render, and the thing `/health` narrows to a phase.
 *
 * Derived, never stored: every field comes from whatsappd's live `session.status` plus the
 * runtime's own startup record, read together at observation time.
 */
export interface WhatsAppLiveness {
  readonly phase: WhatsAppRuntimePhase;
  /**
   * whatsappd's closed `FaultReason` for `degraded`/`failed`, or the runtime's own error string.
   * This is what tells `connection_replaced` (credentials wiped, re-pair required) from
   * `connection_lost` (it will come back by itself).
   */
  readonly reason?: string;
  /** Epoch ms this phase was entered — how a screen says "online for 3h" without keeping a clock. */
  readonly since: number;
  /** whatsappd's `nextRetryAt` while `degraded`, so a countdown is the truth rather than a guess. */
  readonly retryAt?: number;
  /**
   * Terminal in whatsappd's sense: the connection state machine will not leave this phase unaided,
   * so nothing will improve without an operator. It does **not** mean re-pairing is futile — for
   * `logged_out_remote` (unlinked from the phone) re-pairing is exactly the fix, while for
   * `suspended` it is not and for `connection_replaced` the credential store was already wiped.
   * Read `reason` to tell them apart.
   */
  readonly terminal?: true;
  /** whatsappd's retry counter while `degraded` — "attempt 7" is a wedged loop, "attempt 1" is a blip. */
  readonly retryAttempt?: number;
  readonly accountJid?: string;
  readonly chatTarget?: string;
  /** {@link WHATSAPP_LIVENESS_BOUND_MS}, on the wire so a consumer never has to hard-code it. */
  readonly boundMs: number;
}

/**
 * whatsappd's connection phase → the reported phase. Total over `Status["phase"]`, and settled by
 * `docs/research/whatsapp-liveness.md` §"Mapping".
 *
 * The two that are easy to get wrong: `authenticated` is **not** `online` — whatsappd refuses every
 * send in that arm — and `backing_off` is `degraded` rather than `failed`, because the library
 * recovers from it unaided and telling an operator to re-pair would be a second lie.
 */
const REPORTED_PHASE: Record<Status["phase"], WhatsAppRuntimePhase> = {
  disconnected: "starting",
  connecting: "starting",
  pairing: "pairing",
  authenticated: "starting",
  online: "online",
  backing_off: "degraded",
  logged_out: "failed",
  suspended: "failed",
};

/** Terminal in whatsappd's sense: the state machine will not leave it, so neither will we. */
const TERMINAL_TRANSPORT = new Set<Status["phase"]>(["logged_out", "suspended"]);

/**
 * An unrecognised transport phase — a whatsappd minor bump adding a `Status` arm this build does
 * not know — reports `degraded`, never the optimistic answer. `REPORTED_PHASE` is total in
 * TypeScript, so this is unreachable at compile time and deliberately not unreachable at runtime:
 * a phase we cannot interpret is a connection we cannot vouch for, and the whole point of #374 is
 * that "we don't know" must not render as "fine".
 */
const UNKNOWN_TRANSPORT_PHASE: WhatsAppRuntimePhase = "degraded";

/**
 * Phases the *runtime* owns outright. The transport cannot express "the process never started this
 * account" or "the operator stopped it", so when the runtime says one of these it wins — otherwise
 * a stopped runtime whose last-seen transport was `backing_off` would report `degraded` forever.
 */
const RUNTIME_OWNED = new Set<WhatsAppRuntimePhase>(["disabled", "stopped", "failed"]);

/**
 * `since` for the reported phase, on `globalThis` for the same reason the registry is: `apps/cli`
 * loads the runtime as a separately bundled dist, and a module-level variable would be two
 * variables.
 *
 * **This slot is why {@link whatsappLiveness} must be called with the real transport, once per
 * observation, and never speculatively.** It records the first time a derivation *saw* a phase, so
 * a second derivation of the same moment from different inputs — say, one that omitted the
 * transport and therefore concluded `online` — overwrites the entry and makes the next real
 * derivation look like a fresh transition. The symptom is `since` resetting to now on every
 * whatsappd backoff tick: "degraded for 0 seconds", forever, on exactly the outage `since` exists
 * to measure. Publishers must carry liveness forward rather than re-derive it
 * (`whatsapp-runtime.ts`), and {@link INITIAL_WHATSAPP_OBSERVATION} is hoisted for the same reason.
 */
const LIVENESS_SINCE = Symbol.for("ambient-agent.liveness-since");
const sinceGlobal = globalThis as typeof globalThis & {
  [LIVENESS_SINCE]?: { phase: WhatsAppRuntimePhase; at: number };
};

const phaseSince = (phase: WhatsAppRuntimePhase, now: number): number => {
  const held = sinceGlobal[LIVENESS_SINCE];
  if (held !== undefined && held.phase === phase) return held.at;
  sinceGlobal[LIVENESS_SINCE] = { phase, at: now };
  return now;
};

/**
 * The one derivation. `/health`, the bridge, the CLI and `/api/observe` all report what this
 * returns, so there is exactly one answer to "is the coworker connected right now" in the process.
 *
 * `transport` is whatsappd's truth, read at observation time; `status` is the runtime's startup
 * record. Transport wins wherever it has an opinion, which is the whole point of #374 — before it,
 * the reported phase was the startup record alone, written four times and never again.
 *
 * **Asymmetric in both directions, and both matter.** The startup record is a **floor on readiness**
 * and the transport is a **ceiling on connectivity**, and what is reported is the lower of the two:
 *
 * - The transport may never report `online` before the runtime has finished booting. whatsappd says
 *   `online` the moment the socket is sendable, which is well before history sync has drained and
 *   the participation port is wired; reporting `healthy` there would replace #312's lie with its
 *   mirror image, a coworker that answers `/health` with "yes" while it cannot answer a message.
 * - Once the runtime *has* booted, anything short of an online transport is `degraded` — not
 *   `starting`. whatsappd's outage cycle alternates `backing_off → connecting → backing_off`, and
 *   `connecting` maps to `starting`, so without this an hours-old process would flap between
 *   `failed` and `starting` through an outage and claim to be booting. `starting` after boot is not
 *   a thing: it is a reconnection, which is a degraded connection.
 *
 * The second rule is #374's own addition — `docs/research/whatsapp-liveness.md` settled the
 * transport→phase table below, not this floor/ceiling relation between the two sources.
 */
export const whatsappLiveness = (
  status: WhatsAppRuntimeStatus,
  transport: TransportObservation | undefined,
  now: number = Date.now(),
): WhatsAppLiveness => {
  const derived = transport === undefined || RUNTIME_OWNED.has(status.phase) ? undefined : transport;
  const reported =
    derived === undefined ? status.phase : (REPORTED_PHASE[derived.phase] ?? UNKNOWN_TRANSPORT_PHASE);
  const booted = status.phase === "online";
  const phase =
    reported === "online" && !booted
      ? status.phase
      : reported === "starting" && booted
        ? "degraded"
        : reported;
  const reason = derived?.reason ?? status.error;
  return {
    phase,
    ...(reason === undefined ? {} : { reason }),
    since: phaseSince(phase, now),
    ...(derived?.nextRetryAt === undefined ? {} : { retryAt: derived.nextRetryAt }),
    ...(derived?.retryAttempt === undefined ? {} : { retryAttempt: derived.retryAttempt }),
    ...(derived !== undefined && TERMINAL_TRANSPORT.has(derived.phase) ? { terminal: true as const } : {}),
    ...(status.accountJid === undefined ? {} : { accountJid: status.accountJid }),
    ...(status.chatTarget === undefined ? {} : { chatTarget: status.chatTarget }),
    boundMs: WHATSAPP_LIVENESS_BOUND_MS,
  };
};

export interface WhatsAppObservation {
  /** What the runtime reports about its own startup. Raw input to `liveness`, not the answer. */
  readonly status: WhatsAppRuntimeStatus;
  /** Read from `session.status` at observation time, so it cannot be stale by construction. */
  readonly transport?: TransportObservation;
  /** The derived answer — what an operator is told. Always present; see {@link whatsappLiveness}. */
  readonly liveness: WhatsAppLiveness;
}

/**
 * The channel value for a `(status, transport)` pair, with liveness derived once.
 *
 * **Read path only.** Call it from a projection, where `transport` is the live getter's current
 * value — never from a publisher with `transport: undefined` as a placeholder, because the
 * derivation stamps `since` (see {@link LIVENESS_SINCE}) and a transport-blind derivation of a
 * moment the transport had an opinion about is a wrong answer that outlives itself. Publishers use
 * {@link whatsAppStatusUpdate}.
 */
export const whatsAppObservationOf = (
  status: WhatsAppRuntimeStatus,
  transport: TransportObservation | undefined,
): WhatsAppObservation => ({
  status,
  ...(transport === undefined ? {} : { transport }),
  liveness: whatsappLiveness(status, transport),
});

/**
 * The channel value for a publisher recording a new *startup* fact. Liveness and transport are
 * carried forward from the current observation rather than re-derived: the projection re-derives
 * both on the very next read, so deriving here would change nothing a reader sees and would leave
 * behind a `since` stamped from inputs that were never true together.
 */
export const whatsAppStatusUpdate = (
  current: WhatsAppObservation,
  status: WhatsAppRuntimeStatus,
): WhatsAppObservation => ({ ...current, status });

/**
 * The status every pre-#374 consumer already reads (`/health`, the bridge, `ambient-agent doctor`),
 * with its phase replaced by the derived one. Nothing downstream had to change to stop lying: they
 * were all reading one field, so making that field honest is the whole fix.
 */
export const reportedWhatsAppStatus = (observation: WhatsAppObservation): WhatsAppRuntimeStatus => ({
  ...observation.status,
  phase: observation.liveness.phase,
  ...(observation.status.error === undefined && observation.liveness.reason !== undefined
    ? { error: observation.liveness.reason }
    : {}),
});

/**
 * Built once, at module load, rather than per call: `observed` ignores `initial` after the channel
 * exists, but the expression is still evaluated every time — and evaluating it would ask the
 * derivation for `disabled`, resetting `since` under whatever phase is actually live.
 */
const INITIAL_WHATSAPP_OBSERVATION: WhatsAppObservation = whatsAppObservationOf({ phase: "disabled" }, undefined);

export const whatsappObservation = (): Retained<WhatsAppObservation> =>
  observed<WhatsAppObservation>(OBSERVATION_CHANNELS.whatsapp, INITIAL_WHATSAPP_OBSERVATION);

export type PairingObservation =
  | { readonly kind: "idle" }
  | {
      readonly kind: "awaiting_scan";
      readonly method: "qr" | "pairing_code";
      readonly qr?: string;
      readonly code?: string;
      readonly expiresAt: number;
      /** How many times the client has re-issued material. Rotation is health, not restart. */
      readonly rotations: number;
    }
  | { readonly kind: "paired"; readonly jid?: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DeviceObservation =
  | { readonly kind: "idle" }
  | {
      readonly kind: "awaiting_authorization";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt?: number;
    }
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly reason: string };

export interface SetupObservation {
  readonly pairing: PairingObservation;
  readonly device: DeviceObservation;
}

export const setupObservation = (): Retained<SetupObservation> =>
  observed<SetupObservation>(OBSERVATION_CHANNELS.setup, { pairing: { kind: "idle" }, device: { kind: "idle" } });

/**
 * Publish live WhatsApp pairing material. `expiresAt` is whatsappd's absolute rotation deadline, so
 * it is passed straight through as the seam's renewal promise: a QR that is *not* re-issued by then
 * reads `stale`, which is precisely the "client stopped producing codes" case that a page rendering
 * a dead QR could not otherwise tell from a page waiting on a live one.
 */
export const publishPairingProgress = (progress: {
  readonly method: "qr" | "pairing_code";
  readonly qr?: string;
  readonly code?: string;
  readonly expiresAt: number;
}): void => {
  const setup = setupObservation();
  const current = setup.snapshot().value;
  const rotations = current.pairing.kind === "awaiting_scan" ? current.pairing.rotations + 1 : 0;
  setup.publish(
    {
      ...current,
      pairing: {
        kind: "awaiting_scan",
        method: progress.method,
        ...(progress.qr === undefined ? {} : { qr: progress.qr }),
        ...(progress.code === undefined ? {} : { code: progress.code }),
        expiresAt: progress.expiresAt,
        rotations,
      },
    },
    { freshUntil: progress.expiresAt },
  );
};

/**
 * Pairing settled. Published without a deadline: neither outcome is perishable, so the channel goes
 * idle-correct rather than counting down to stale.
 *
 * A failure never overwrites `paired`. Pairing is over once it succeeded, and a runtime that dies an
 * hour later is a transport failure — which the whatsapp channel reports — not a retraction of the
 * pairing a page already watched complete.
 */
export const publishPairingSettled = (result: { readonly jid?: string } | { readonly reason: string }): void => {
  const setup = setupObservation();
  const current = setup.snapshot().value;
  if ("reason" in result && current.pairing.kind === "paired") return;
  setup.publish({
    ...current,
    pairing: "reason" in result ? { kind: "failed", reason: result.reason } : { kind: "paired", ...result },
  });
};

export const publishDeviceObservation = (device: DeviceObservation): void => {
  const setup = setupObservation();
  const current = setup.snapshot().value;
  setup.publish(
    { ...current, device },
    device.kind === "awaiting_authorization" && device.expiresAt !== undefined
      ? { freshUntil: device.expiresAt }
      : {},
  );
};
