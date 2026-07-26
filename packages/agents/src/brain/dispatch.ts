import { dispatch, observe, type DispatchReceipt } from "@flue/runtime";
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

const wakes = Semaphore.makeUnsafe(1);
const brainDispatches = createDispatchCorrelator<{ readonly batchId: string }>();
export const observeBrainDispatch = brainDispatches.ingest;
observe(observeBrainDispatch);

export const wakeBrain = async (
  inbox: BrainInbox,
  deliver: DispatchBrain = dispatchBrain,
  now: () => number = Date.now,
): Promise<BrainBatch | undefined> =>
  Effect.runPromise(
    wakes.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
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
        },
        catch: (cause) => cause,
      }),
    ),
  );

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
  stop(): void;
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
        return;
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
      for (const state of inbox.dispatchRecovery()) schedule(state);
    },
    stop(): void {
      active = false;
      unsubscribe();
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
};
