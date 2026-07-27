import { dispatch, observe, type DispatchReceipt, type FlueObservation } from "@flue/runtime";
import { Effect, Semaphore } from "effect";
import type { Logger } from "pino";

import type { BrainBatch, BrainBatchRecovery, BrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import { createDispatchCorrelator } from "@ambient-agent/engine/dispatch/dispatch-correlator.ts";
import { getLogger } from "@ambient-agent/engine/logging/logging.ts";
import brain from "./agent.ts";

export interface BrainDispatchRequest {
  readonly id: "global";
  readonly input: {
    readonly type: "brain.batch";
    readonly batch: Omit<BrainBatch, "dispatch">;
  };
}

export type DispatchBrain = (request: BrainDispatchRequest) => Promise<DispatchReceipt>;

export const dispatchBrain: DispatchBrain = (request) => dispatch(brain, request);

interface DispatchScope {
  active: boolean;
  generation?: { stopped: boolean };
  inFlight: Set<Promise<BrainBatch | undefined>>;
  wakes: ReturnType<typeof Semaphore.makeUnsafe>;
}
const dispatchScopes = new Map<string, DispatchScope>();
const dispatchScopeFor = (inbox: BrainInbox): DispatchScope => {
  const existing = dispatchScopes.get(inbox.dispatchScope);
  if (existing !== undefined) return existing;
  const created = { active: true, inFlight: new Set<Promise<BrainBatch | undefined>>(), wakes: Semaphore.makeUnsafe(1) };
  dispatchScopes.set(inbox.dispatchScope, created);
  return created;
};
const brainDispatches = createDispatchCorrelator<{ readonly batchId: string }>({
  requireTerminalAcknowledgement: true,
});
export const observeBrainDispatch = (observation: FlueObservation): void => {
  if (observation.instanceId === "global") brainDispatches.ingest(observation);
};
observe(observeBrainDispatch);

export const wakeBrain = async (
  inbox: BrainInbox,
  deliver: DispatchBrain = dispatchBrain,
  now: () => number = Date.now,
): Promise<BrainBatch | undefined> => {
  const scope = dispatchScopeFor(inbox);
  const generation = scope.generation;
  return Effect.runPromise(
    scope.wakes.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          if (!scope.active || generation?.stopped) return undefined;
          const wake = (async () => {
            const batch = inbox.claimBatch();
            if (batch === undefined || batch.dispatch !== undefined) return batch;
            if (batch.nextRetryAt !== undefined && Date.parse(batch.nextRetryAt) > now()) return batch;
            const receipt = await deliver({
              id: "global",
              input: {
                type: "brain.batch",
                batch: {
                  id: batch.id,
                  createdAt: batch.createdAt,
                  intents: batch.intents,
                  knowledgeDeltas: batch.knowledgeDeltas,
                  specialistResults: batch.specialistResults,
                  githubEvents: batch.githubEvents,
                  scheduledWakes: batch.scheduledWakes,
                },
              },
            });
            const dispatched = inbox.markBatchDispatched(batch.id, receipt);
            brainDispatches.accepted(receipt.dispatchId, { batchId: batch.id });
            return dispatched;
          })();
          scope.inFlight.add(wake);
          try {
            return await wake;
          } finally {
            scope.inFlight.delete(wake);
          }
        },
        catch: (cause) => cause,
      }),
    ),
  );
};

type RecoveryLogger = Pick<Logger, "info" | "warn" | "error">;

export interface BrainDispatchRecoveryOptions {
  readonly deliver?: DispatchBrain;
  readonly logger?: RecoveryLogger;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface BrainDispatchRecovery {
  /** Enable retry timers after every Brain port is ready. Terminal observations persist before this. */
  activate(): void;
  /** Stop new dispatches and wait for any accepted dispatch receipt to be fenced durably. */
  stop(): Promise<void>;
}

/** Persist public Flue terminals immediately; dispatch retries only after activate(). */
export const configureBrainDispatchRecovery = (
  inbox: BrainInbox,
  options: BrainDispatchRecoveryOptions = {},
): BrainDispatchRecovery => {
  const logger = options.logger ?? getLogger("brain");
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scope = dispatchScopeFor(inbox);
  scope.active = false;
  const generation = { stopped: false };
  scope.generation = generation;
  let active = false;

  const schedule = (state: BrainBatchRecovery): void => {
    if (state.nextRetryAt === undefined) return;
    const existing = timers.get(state.batchId);
    if (existing !== undefined) clearTimer(existing);
    const timer = setTimer(() => {
      timers.delete(state.batchId);
      void wakeBrain(inbox, options.deliver, now).catch((cause) =>
        logger.error(
          {
            operatorEvent: "brain.batch.retry_failed",
            batchId: state.batchId,
            retryCount: state.retryCount,
            nextRetryAt: state.nextRetryAt,
            error: cause instanceof Error ? cause.message : String(cause),
          },
          "Brain Batch retry dispatch failed",
        ),
      );
    }, Math.max(0, Date.parse(state.nextRetryAt) - now()));
    timer.unref?.();
    timers.set(state.batchId, timer);
  };

  const unsubscribe = brainDispatches.subscribe((event, context, dispatchId) => {
    if (event.kind === "dispatched") return;
    try {
      const state = inbox.reconcileDispatchTerminal({
        batchId: context.batchId,
        dispatchId,
        outcome: event.kind,
        ...(event.kind === "failed" ? { error: event.error } : {}),
      });
      if (state === undefined) {
        logger.warn(
          {
            operatorEvent: "brain.batch.terminal_stale",
            batchId: context.batchId,
            dispatchId,
            terminalOutcome: event.kind,
          },
          "Ignored stale Brain Batch terminal event",
        );
        return true;
      }
      logger.info(
        {
          operatorEvent: "brain.batch.terminal",
          batchId: context.batchId,
          dispatchId,
          terminalOutcome: event.kind,
          retryCount: state.retryCount,
          ...(state.nextRetryAt === undefined ? {} : { nextRetryAt: state.nextRetryAt }),
        },
        state.nextRetryAt === undefined ? "Brain Batch dispatch settled" : "Brain Batch dispatch released for retry",
      );
      if (active) schedule(state);
      return true;
    } catch (cause) {
      logger.error(
        {
          operatorEvent: "brain.batch.recovery_failed",
          batchId: context.batchId,
          dispatchId,
          terminalOutcome: event.kind,
          error: cause instanceof Error ? cause.message : String(cause),
        },
        "Failed to reconcile Brain Batch terminal event",
      );
      return false;
    }
  });

  brainDispatches.recoverWith((dispatchId) => {
    const active = inbox.dispatchRecovery().find((state) => state.dispatchId === dispatchId);
    return active === undefined ? undefined : { batchId: active.batchId };
  });
  for (const state of inbox.dispatchRecovery()) {
    if (state.dispatchId !== undefined) brainDispatches.accepted(state.dispatchId, { batchId: state.batchId });
  }

  return {
    activate(): void {
      if (active) return;
      active = true;
      scope.active = true;
      for (const state of inbox.dispatchRecovery()) schedule(state);
    },
    async stop(): Promise<void> {
      active = false;
      generation.stopped = true;
      scope.active = false;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      await Promise.allSettled(scope.inFlight);
      unsubscribe();
    },
  };
};
