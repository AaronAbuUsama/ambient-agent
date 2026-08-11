import type { AcceptedWhatsAppBatch, WhatsAppDataStore } from "whatsappd";
import type {
  MessageIngestionRepository,
  MessageIngestionResult,
} from "../database/message-ingestion";
import { mapLiveWhatsAppMessage } from "./observation-mapper";

export interface WhatsAppAcceptedSourceConsumer {
  start(source: WhatsAppDataStore): Promise<void>;
  wake(): Promise<void>;
  stop(): Promise<void>;
}

function observationsFromBatch(accountId: string, batch: AcceptedWhatsAppBatch) {
  return batch.events.flatMap(({ event }) => {
    if (event.type !== "message") return [];
    const observation = mapLiveWhatsAppMessage(accountId, event.message);
    return observation ? [observation] : [];
  });
}

export function createWhatsAppAcceptedSourceConsumer(
  accountId: string,
  repository: MessageIngestionRepository,
  onAcceptedMessage?: (result: MessageIngestionResult) => void,
): WhatsAppAcceptedSourceConsumer {
  let source: WhatsAppDataStore | undefined;
  let active = false;
  let draining: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    if (!active || !source) return;
    let cursor = await repository.cursor(accountId);
    let afterSeq = cursor?.afterSeq ?? 0;
    let state = cursor?.state ?? "bootstrapping";

    while (active) {
      const batches = await source.accepted(accountId, afterSeq);
      if (batches.length === 0) {
        if (state === "bootstrapping") {
          await repository.activate(accountId, afterSeq);
          state = "active";
        }
        return;
      }

      for (const batch of batches) {
        if (!active) return;
        const results = await repository.retainBatch({
          accountId,
          seq: batch.seq,
          observations: state === "active" ? observationsFromBatch(accountId, batch) : [],
        });
        afterSeq = batch.seq;
        for (const result of results) {
          if (!result.observationAccepted) continue;
          try {
            onAcceptedMessage?.(result);
          } catch {
            // Proof and telemetry listeners cannot roll back committed ingestion.
          }
        }
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    const next = draining.then(drain, drain);
    draining = next.catch(() => {});
    return next;
  };

  return {
    async start(nextSource) {
      source = nextSource;
      active = true;
      await scheduleDrain();
    },
    wake() {
      return scheduleDrain();
    },
    async stop() {
      active = false;
      await draining;
      source = undefined;
    },
  };
}
