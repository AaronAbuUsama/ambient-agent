import { randomUUID } from "node:crypto";
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import scribe from "@ambient-agent/agents/scribe/agent.ts";
import { dispatchScribeAttempt } from "@ambient-agent/agents/scribe/coalescer.ts";
import { scribeBatchWave, type ScribeBatchInput } from "@ambient-agent/agents/scribe/input.ts";
import { createHistoricalReplayStore } from "@ambient-agent/engine/intake/historical-replay.ts";
import { getManagedRuntimeDependencies } from "@ambient-agent/installation/runtime-dependencies.ts";

const input = v.object({});
const output = v.object({
  outcome: v.picklist(["live", "failed"]),
  surfacesProcessed: v.number(),
  batchesProcessed: v.number(),
  eventsProcessed: v.number(),
  errorCode: v.optional(v.string()),
});

const attemptBatch = async (
  batch: ScribeBatchInput,
  log: {
    warn(message: string, attributes?: object): void;
  },
): Promise<unknown | undefined> => {
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const attemptId = `scribe-attempt:${randomUUID()}`;
    try {
      await dispatchScribeAttempt(attemptId, batch);
      return undefined;
    } catch (cause) {
      failure = cause;
      if (attempt < 3) {
        log.warn("historical_replay.batch.retrying", {
          batchId: batch.batchId,
          attemptId,
          nextAttempt: attempt + 1,
          errorCode: "scribe_prompt_failed",
        });
      }
    }
  }
  return failure;
};

const run = async ({
  log,
}: {
  input: v.InferOutput<typeof input>;
  log: {
    info(message: string, attributes?: object): void;
    warn(message: string, attributes?: object): void;
    error(message: string, attributes?: object): void;
  };
}) => {
  const dependencies = getManagedRuntimeDependencies();
  const store = createHistoricalReplayStore(dependencies.paths.applicationDatabase);
  let batchesProcessed = 0;
  let eventsProcessed = 0;
  try {
    store.captureSnapshots();
    const surfacesProcessed = store.states().filter(({ mode }) => mode === "catching_up").length;
    log.info("historical_replay.started", { surfacesProcessed });
    for (;;) {
      const batch = store.nextBatch();
      if (batch === undefined) {
        if (store.advance() > 0) continue;
        log.info("historical_replay.live", { surfacesProcessed, batchesProcessed, eventsProcessed });
        return { outcome: "live" as const, surfacesProcessed, batchesProcessed, eventsProcessed };
      }
      if (batch.inputs.length === 0) {
        store.checkpoint(batch);
        log.info("historical_replay.batch.skipped", {
          archiveEventCount: batch.archiveEventCount,
          receiptCount: batch.receiptCount,
        });
        continue;
      }
      const wave = scribeBatchWave(batch.inputs);
      log.info("historical_replay.wave.started", {
        batchIds: wave.map(({ batchId }) => batchId),
        batch: batchesProcessed + 1,
        archiveEventCount: batch.archiveEventCount,
        scribeEventCount: batch.archiveEventCount - batch.receiptCount,
        surfaceCount: new Set(batch.inputs.map(({ chatId }) => chatId)).size,
      });
      const failures = (await Promise.all(wave.map((input) => attemptBatch(input, log)))).filter(
        (failure) => failure !== undefined,
      );
      if (failures.length > 0) {
        store.fail("scribe_prompt_failed");
        log.error("historical_replay.failed", {
          batchIds: wave.map(({ batchId }) => batchId),
          attempts: 3,
          errorCode: "scribe_prompt_failed",
        });
        return {
          outcome: "failed" as const,
          surfacesProcessed,
          batchesProcessed,
          eventsProcessed,
          errorCode: "scribe_prompt_failed",
        };
      }
      store.checkpoint(batch);
      batchesProcessed += wave.length;
      eventsProcessed += batch.archiveEventCount - batch.receiptCount;
      log.info("historical_replay.wave.completed", {
        batchIds: wave.map(({ batchId }) => batchId),
        batchesProcessed,
        eventsProcessed,
      });
    }
  } finally {
    store.close();
  }
};

export default defineWorkflow({ agent: scribe, input, output, run });
