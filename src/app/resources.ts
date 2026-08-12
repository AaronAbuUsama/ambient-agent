import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationScheduler, type ConversationScheduler } from "../conversation/scheduler";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { WhatsAppSessionController } from "../whatsapp/session/controller";
import { localDeployment } from "../whatsapp/session/local-deployment";
import type { AppConfig } from "./config";
import type { AmbientLifecycleDependencies } from "./lifecycle";

export interface AppResources extends AmbientLifecycleDependencies {
  readonly database: AmbientDatabase;
  readonly whatsapp: WhatsAppSessionController;
  readonly conversation?: ConversationScheduler;
}

export async function createAppResources(
  config: AppConfig,
  onAcceptedMessage?: (input: {
    readonly observationId: string;
    readonly conversationId: string;
  }) => void,
): Promise<AppResources> {
  const database = await openAmbientDatabase(config.database.url);
  try {
    let conversation: ConversationScheduler | undefined;
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      config.whatsapp.accountId,
      database.repositories.messageIngestion,
      (result) => {
        onAcceptedMessage?.({
          observationId: result.observationId,
          conversationId: result.conversationId,
        });
        void conversation?.wake(result.conversationId).catch(() => {});
      },
    );
    const whatsapp = new WhatsAppSessionController({
      ...localDeployment({
        accountId: config.whatsapp.accountId,
        directory: config.whatsapp.dataDirectory,
        historyBackfillLimit: config.whatsapp.historyBackfillLimit,
        logLevel: config.logging.level,
      }),
      acceptedSource,
    });
    if (config.conversation.enabled) {
      conversation = createConversationScheduler({
        scheduling: config.conversation.scheduling,
        model: config.models.conversation,
        instructions: config.conversation.instructions,
        schedule: database.repositories.conversationSchedule,
        observations: database.repositories.observations,
        memory: database.repositories.memory,
        runs: database.repositories.runs,
        evaluations: database.repositories.evaluations,
        agent: createPiConversationAgent(),
        sender: {
          async sendText({ conversationId, text, idempotencyKey }) {
            const target =
              config.conversation.outboundMode === "loopback"
                ? whatsapp.loopbackAddress()
                : conversationId;
            if (!target) throw new Error("WhatsApp loopback address is not available");
            const operation = await whatsapp.sendText(target, text, idempotencyKey);
            return { operationId: operation.id };
          },
        },
      });
    }

    return { database, whatsapp, ...(conversation ? { conversation } : {}) };
  } catch (error) {
    await database.close();
    throw error;
  }
}
