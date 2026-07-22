/**
 * The Scribe's own coalescer, at the `dispatchSpeaker` funnel (#149).
 *
 * Flue serializes the Scribe's admissions but never collapses N queued admissions
 * into one turn, so per-input dispatch would be one LLM call per message. This
 * debounces: sibling inputs across Surfaces accumulate and dispatch as ONE combined
 * extraction turn per quiet-period-or-cap. It reuses the coalescer's `debounceActor`
 * over already-composed inputs (a different layer & element type from the raw
 * WhatsApp coalescer) with much laggier knobs and NO immediate-fire predicate.
 *
 * Failure isolation (#141 D2): `offer` is called independently of Speaker admission,
 * never awaited, and can never throw — either arm may fail without gating the other.
 * There is no durable Scribe admission ledger yet; a crash can drop one live buffer.
 */
import { randomUUID } from "node:crypto";
import { dispatch } from "@flue/runtime";
import { Effect, Queue, Semaphore } from "effect";

import { debounceActor, type DebounceParams } from "@ambient-agent/engine/coalescer/debounce-actor.ts";
import scribe from "./agent.ts";
import { scribeBatchInput, type ScribeBatchInput, type ScribeOffer } from "./input.ts";
import { scribeCoalescerConfig } from "./config.ts";

/** Why a batch fired. Unused downstream (extraction is uniform) but keeps the actor typed. */
type ScribeFireReason = "debounce" | "maximum-wait" | "capacity";

export type DispatchScribeBatch = (attemptId: string, batch: ScribeBatchInput) => Promise<unknown>;

export interface ScribeCoalescerOptions {
  /** Override any laggy default knob. */
  readonly config?: Partial<DebounceParams>;
  /** Maximum model attempts in flight; later Batches wait without sharing model state. */
  readonly maxConcurrentAttempts?: number;
  /** Injected for tests; defaults to dispatching the Scribe agent with the batched inputs. */
  readonly dispatchBatch?: DispatchScribeBatch;
}

export interface ScribeCoalescer {
  /** Offer one funnel input to the Scribe. Detached, best-effort, never throws. */
  readonly offer: (offer: ScribeOffer) => void;
  /** The router fiber; the default instance forks it lazily. Exposed for tests. */
  readonly run: Effect.Effect<void>;
}

const defaultDispatchBatch: DispatchScribeBatch = (attemptId, batch) =>
  dispatch(scribe, { id: attemptId, input: batch });

let runtimeDispatchBatch: DispatchScribeBatch | undefined;
const productionAttempts = Semaphore.makeUnsafe(4);

/**
 * Production binds Flue's terminal-result direct-agent API here. The runtime `dispatch`
 * fallback exists for isolated tests, but it settles at admission and therefore cannot
 * measure model concurrency.
 */
export const configureScribeAttemptDispatch = (dispatchBatch: DispatchScribeBatch): (() => void) => {
  const previous = runtimeDispatchBatch;
  runtimeDispatchBatch = dispatchBatch;
  return () => {
    if (runtimeDispatchBatch === dispatchBatch) runtimeDispatchBatch = previous;
  };
};

/** One process-wide execution gate shared by live ingestion and Historical Replay. */
export const dispatchScribeAttempt = (attemptId: string, batch: ScribeBatchInput): Promise<unknown> =>
  Effect.runPromise(
    productionAttempts.withPermits(1)(
      Effect.tryPromise({
        try: () => (runtimeDispatchBatch ?? defaultDispatchBatch)(attemptId, batch),
        catch: (cause) => cause,
      }),
    ),
  );

export const createScribeCoalescer = (options: ScribeCoalescerOptions = {}): ScribeCoalescer => {
  const params = scribeCoalescerConfig(options.config);
  const dispatchBatch = options.dispatchBatch ?? dispatchScribeAttempt;
  const attempts = Semaphore.makeUnsafe(Math.max(1, options.maxConcurrentAttempts ?? 4));
  // Created eagerly so `offer` can enqueue synchronously (a plain data structure,
  // safe to use from the plain-async funnel and across the forked router fiber).
  const mailbox = Effect.runSync(Queue.unbounded<ScribeOffer>());

  // A failed extraction turn logs and ingestion continues; durable retry is a later rung.
  const swallow =
    (attemptId: string, batchId: string) =>
    (cause: unknown): Effect.Effect<void> =>
      Effect.logError(`Scribe extraction failed for ${batchId}; the attempt was not durably retried`).pipe(
        Effect.annotateLogs({ cause: String(cause), attemptId, batchId }),
      );

  const scribeLoop = debounceActor<ScribeOffer, ScribeFireReason>(params, {
    reasons: { debounce: "debounce", maxWait: "maximum-wait", capacity: "capacity" },
    flush: (buffer) => {
      const attemptId = `scribe-attempt:${randomUUID()}`;
      const batch = scribeBatchInput(buffer.map((entry) => entry.input));
      const attempt = attempts.withPermits(1)(
        Effect.tryPromise({
          try: () => dispatchBatch(attemptId, batch),
          catch: (cause) => cause,
        }).pipe(
          Effect.asVoid,
          Effect.catch(swallow(attemptId, batch.batchId)),
          Effect.catchDefect(swallow(attemptId, batch.batchId)),
        ),
      );
      return Effect.forkDetach(attempt).pipe(Effect.asVoid);
    },
  });

  const run = scribeLoop(mailbox);

  return {
    offer: (entry) => {
      try {
        Queue.offerUnsafe(mailbox, entry);
      } catch {
        // Best-effort: the Scribe fan-out must never surface into the Speaker's path.
      }
    },
    run,
  };
};

let defaultInstance: ScribeCoalescer | undefined;
let started = false;

/**
 * The process-wide Scribe coalescer used by the funnel. The router fiber starts on
 * the first `offer` (nothing to run until the funnel fans out) on the default runtime.
 */
export const scribeCoalescer: Pick<ScribeCoalescer, "offer"> = {
  offer: (entry) => {
    try {
      if (defaultInstance === undefined) defaultInstance = createScribeCoalescer();
      if (!started) {
        started = true;
        Effect.runFork(defaultInstance.run);
      }
      defaultInstance.offer(entry);
    } catch {
      // Best-effort: a Scribe fan-out failure can never re-run or re-deliver the Speaker.
    }
  },
};
