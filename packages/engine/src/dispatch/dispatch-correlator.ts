import type { FlueObservation } from "@flue/runtime";

/**
 * Correlates Flue's public prompt-operation lifecycle with application context.
 * Flue observations carry only a dispatchId; whoever dispatched knows what that
 * dispatch was about. This module is the lookup table between the two, including
 * across restarts: a prompt operation is the normal settlement signal, and
 * submission_settled is emitted only when Flue recovery settles interrupted
 * durable work — possibly before any context for it exists in this process.
 */

export type DispatchLifecycleEvent =
  /** First sighting of a tracked dispatch — emitted exactly once per dispatch. */
  | { readonly kind: "dispatched" }
  /** A prompt operation finished successfully; the dispatch is settled. */
  | {
      readonly kind: "completed";
      readonly operationId?: string;
      readonly durationMs?: number;
      /** Non-empty final text output, when the agent produced one. */
      readonly finalText?: string;
    }
  /** The dispatch failed (errored operation or failed/aborted settlement). */
  | { readonly kind: "failed"; readonly error: string; readonly operationId?: string }
  /** Flue recovery settled the dispatch as completed without a fresh operation. */
  | { readonly kind: "settled" };

export type DispatchContextResolver<C> = (dispatchId: string) => C | undefined;

export interface DispatchCorrelatorOptions<C> {
  /** Derives a lookup key (e.g. chatId) so activeDispatchFor() can answer "what is this key processing?". */
  readonly keyOf?: (context: C) => string;
  readonly resolver?: DispatchContextResolver<C>;
}

export interface DispatchCorrelator<C> {
  /**
   * Record what a dispatch was about, immediately after dispatching it.
   * Pass null for dispatches this correlator should ignore entirely.
   */
  accepted(dispatchId: string, context: C | null): void;
  /** Feed one Flue observation through correlation. Wire via observe(correlator.ingest). */
  ingest(observation: FlueObservation): void;
  /** Install (or replace) the recovery lookup used when an observation precedes its context. */
  recoverWith(resolver: DispatchContextResolver<C>): void;
  /** Subscribe to correlated lifecycle events. Listener errors never affect the lifecycle. */
  subscribe(listener: (event: DispatchLifecycleEvent, context: C, dispatchId: string) => void): () => void;
  /** The dispatch currently processing for a key (requires options.keyOf), if still active. */
  activeDispatchFor(key: string): string | undefined;
}

const MAX_TRACKED_DISPATCHES = 100;
const TRACKING_TTL_MS = 24 * 60 * 60 * 1_000;

interface ExpiringContext<C> {
  readonly context: C;
  readonly expiresAt: number;
}

interface BufferedObservations {
  readonly events: FlueObservation[];
  readonly expiresAt: number;
}

const failureMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    return String((value as { readonly message?: unknown }).message ?? "Agent processing failed");
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "Agent processing failed";
};

const dropOldest = <T>(entries: Map<string, T>, evict: (key: string) => void): void => {
  while (entries.size >= MAX_TRACKED_DISPATCHES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    evict(oldest);
  }
};

export const createDispatchCorrelator = <C>(options: DispatchCorrelatorOptions<C> = {}): DispatchCorrelator<C> => {
  const active = new Map<string, ExpiringContext<C>>();
  const early = new Map<string, BufferedObservations>();
  const settled = new Map<string, number>();
  const ignored = new Map<string, number>();
  const announced = new Set<string>();
  const byKey = new Map<string, string>();
  const listeners = new Set<(event: DispatchLifecycleEvent, context: C, dispatchId: string) => void>();
  let resolver = options.resolver;

  const emit = (event: DispatchLifecycleEvent, context: C, dispatchId: string): void => {
    for (const listener of listeners) {
      try {
        listener(event, context, dispatchId);
      } catch {
        // Observer diagnostics must never change the agent lifecycle they observe.
      }
    }
  };

  const announce = (dispatchId: string, context: C): void => {
    if (announced.has(dispatchId)) return;
    announced.add(dispatchId);
    emit({ kind: "dispatched" }, context, dispatchId);
  };

  const forget = (dispatchId: string): void => {
    const context = active.get(dispatchId)?.context;
    active.delete(dispatchId);
    announced.delete(dispatchId);
    if (context !== undefined && options.keyOf !== undefined) {
      const key = options.keyOf(context);
      if (byKey.get(key) === dispatchId) byKey.delete(key);
    }
  };

  const markSettled = (dispatchId: string): void => {
    forget(dispatchId);
    dropOldest(settled, (key) => settled.delete(key));
    settled.set(dispatchId, Date.now() + TRACKING_TTL_MS);
  };

  const prune = (): void => {
    const now = Date.now();
    for (const [dispatchId, entry] of active) if (entry.expiresAt <= now) forget(dispatchId);
    for (const [dispatchId, entry] of early) if (entry.expiresAt <= now) early.delete(dispatchId);
    for (const [dispatchId, expiresAt] of settled) if (expiresAt <= now) settled.delete(dispatchId);
    for (const [dispatchId, expiresAt] of ignored) if (expiresAt <= now) ignored.delete(dispatchId);
  };

  const remember = (dispatchId: string, context: C): void => {
    dropOldest(active, forget);
    active.set(dispatchId, { context, expiresAt: Date.now() + TRACKING_TTL_MS });
  };

  const resolve = (dispatchId: string): C | undefined => {
    const remembered = active.get(dispatchId)?.context;
    if (remembered !== undefined) return remembered;
    let recovered: C | undefined;
    try {
      recovered = resolver?.(dispatchId);
    } catch {
      // The resolver's backing store may be between runtime instances; retain
      // the observation so the next configured resolver can recover it.
      return undefined;
    }
    if (recovered !== undefined) remember(dispatchId, recovered);
    return recovered;
  };

  const report = (event: FlueObservation, context: C): void => {
    const dispatchId = event.dispatchId!;
    if (event.type === "operation_start") {
      if (options.keyOf !== undefined) byKey.set(options.keyOf(context), dispatchId);
      announce(dispatchId, context);
      return;
    }

    if (event.type === "submission_settled") {
      announce(dispatchId, context);
      if (event.outcome === "completed") {
        emit({ kind: "settled" }, context, dispatchId);
      } else {
        emit(
          { kind: "failed", error: event.error?.message ?? `Agent processing ${event.outcome}` },
          context,
          dispatchId,
        );
      }
      markSettled(dispatchId);
      return;
    }

    if (event.type !== "operation") return;

    if (event.isError) {
      emit({ kind: "failed", error: failureMessage(event.error), operationId: event.operationId }, context, dispatchId);
      markSettled(dispatchId);
      return;
    }
    const finalText =
      event.agentOutput?.type === "text" && event.agentOutput.text.trim() !== "" ? event.agentOutput.text : undefined;
    emit(
      {
        kind: "completed",
        operationId: event.operationId,
        durationMs: event.durationMs,
        ...(finalText === undefined ? {} : { finalText }),
      },
      context,
      dispatchId,
    );
    markSettled(dispatchId);
  };

  const replay = (dispatchId: string, context: C): void => {
    const buffered = early.get(dispatchId);
    if (buffered === undefined) return;
    early.delete(dispatchId);
    for (const event of buffered.events) {
      if (settled.has(dispatchId)) break;
      report(event, context);
    }
  };

  return {
    accepted(dispatchId, context): void {
      prune();
      if (context === null) {
        early.delete(dispatchId);
        dropOldest(ignored, (key) => ignored.delete(key));
        ignored.set(dispatchId, Date.now() + TRACKING_TTL_MS);
        return;
      }
      if (settled.has(dispatchId)) return;
      remember(dispatchId, context);
      announce(dispatchId, context);
      replay(dispatchId, context);
    },
    ingest(event): void {
      const relevant =
        (event.type === "operation_start" && event.operationKind === "prompt") ||
        (event.type === "operation" && event.operationKind === "prompt") ||
        event.type === "submission_settled";
      if (!relevant || event.dispatchId === undefined) return;
      prune();
      if (settled.has(event.dispatchId) || ignored.has(event.dispatchId)) return;
      const context = resolve(event.dispatchId);
      if (context !== undefined) {
        report(event, context);
        return;
      }
      const buffered = early.get(event.dispatchId);
      if (buffered === undefined) {
        dropOldest(early, (key) => early.delete(key));
        early.set(event.dispatchId, { events: [event], expiresAt: Date.now() + TRACKING_TTL_MS });
      } else {
        if (buffered.events.length < 4) buffered.events.push(event);
      }
    },
    recoverWith(nextResolver): void {
      resolver = nextResolver;
      prune();
      for (const dispatchId of early.keys()) {
        const context = resolve(dispatchId);
        if (context !== undefined) replay(dispatchId, context);
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activeDispatchFor(key): string | undefined {
      const dispatchId = byKey.get(key);
      return dispatchId !== undefined && active.has(dispatchId) ? dispatchId : undefined;
    },
  };
};
