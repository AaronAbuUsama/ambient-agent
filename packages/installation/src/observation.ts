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

import type { WhatsAppRuntimeStatus } from "./runtime-health.ts";

/** One reading of a channel: the current value, plus everything needed to judge it. */
export interface Observation<T> {
  readonly channel: string;
  readonly value: T;
  /** Epoch ms of the publication that produced `value`. */
  readonly at: number;
  /** Epoch ms this reading was taken. */
  readonly observedAt: number;
  /** Monotonic publication count for this channel. Equal revisions mean equal values. */
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

interface Cell<T> extends Retained<T> {
  /** Registry-internal: erased to `Observed<unknown>` for consumers that enumerate channels. */
  readonly __retained: true;
}

const REGISTRY = Symbol.for("ambient-agent.observation-registry");

interface Registry {
  readonly cells: Map<string, Cell<never>>;
  readonly watchers: Set<(cell: Observed<unknown>) => void>;
}

const registryGlobal = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry = (): Registry => (registryGlobal[REGISTRY] ??= { cells: new Map(), watchers: new Set() });

const createCell = <T>(channel: string, initial: T): Cell<T> => {
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
      value: project === undefined ? value : project(value),
      at,
      observedAt,
      revision,
      ...(freshUntil === undefined ? {} : { freshUntil }),
      stale: freshUntil !== undefined && observedAt > freshUntil,
    };
  };

  // A throwing observer is the producer's problem only if we let it be. Isolate each one: the
  // producer's work is in flight and must not unwind because a browser connection misbehaved.
  const notify = (): void => {
    if (observers.size === 0) return;
    const observation = read();
    for (const observer of [...observers]) {
      try {
        observer(observation);
      } catch {
        // Deliberately swallowed and not logged here: `installation` has no logger at this depth,
        // and an observer that throws is a consumer defect, never a reason to fail a publish.
      }
    }
  };

  return {
    __retained: true,
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
        // learns about it too. Unref'd: an unrenewed value must never hold the process open.
        expiry = setTimeout(notify, Math.max(0, freshUntil - at) + 1);
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
  cells.set(channel, cell as unknown as Cell<never>);
  for (const watcher of [...watchers]) watcher(cell as unknown as Observed<unknown>);
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
    observer(cell.snapshot());
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
 * and this channel is read by `/health` consumers. Pairing material travels on the setup channel,
 * which exists to carry it.
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

export interface WhatsAppObservation {
  /** What the runtime reports about its own startup. Unchanged in meaning; #374 owns deriving from it. */
  readonly status: WhatsAppRuntimeStatus;
  /** Read from `session.status` at observation time, so it cannot be stale by construction. */
  readonly transport?: TransportObservation;
}

export const whatsappObservation = (): Retained<WhatsAppObservation> =>
  observed<WhatsAppObservation>(OBSERVATION_CHANNELS.whatsapp, { status: { phase: "disabled" } });

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

/** Pairing settled. Published without a deadline: "paired" is idle-correct, not perishable. */
export const publishPairingSettled = (result: { readonly jid?: string } | { readonly reason: string }): void => {
  const setup = setupObservation();
  const current = setup.snapshot().value;
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
