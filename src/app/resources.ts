import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationService, type ConversationService } from "../conversation/service";
import { createModelRuntime } from "../models/runtime";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { createWhatsAppService, type WhatsAppService } from "../whatsapp/service";
import type { AppConfig } from "./config";
import type { AmbientLifecycleDependencies } from "./lifecycle";

export interface AppResources extends AmbientLifecycleDependencies {
  readonly database: AmbientDatabase;
  readonly whatsapp: WhatsAppService;
  readonly conversation?: ConversationService;
}

export interface AppResourceOptions {
  readonly onAcceptedMessage?: (input: {
    readonly observationId: string;
    readonly conversationId: string;
  }) => void;
  /**
   * Proof-only safety override that STRENGTHENS the final outbound guard: the
   * resolved destination must be explicitly authorized or the send refuses.
   * Production passes nothing and keeps the unmodified guard.
   */
  readonly authorizeOutbound?: (conversationId: string) => boolean;
}

export async function createAppResources(
  config: AppConfig,
  options: AppResourceOptions = {},
): Promise<AppResources> {
  const database = await openAmbientDatabase(config.database.url);
  try {
    let conversation: ConversationService | undefined;
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      config.whatsapp.accountId,
      database.repositories.messageIngestion,
      (result) => {
        options.onAcceptedMessage?.({
          observationId: result.observationId,
          conversationId: result.conversationId,
        });
        void conversation?.wake(result.conversationId).catch(() => {});
      },
    );
    const whatsapp = createWhatsAppService({
      accountId: config.whatsapp.accountId,
      dataDirectory: config.whatsapp.dataDirectory,
      historyBackfillLimit: config.whatsapp.historyBackfillLimit,
      logLevel: config.logging.level,
      acceptedSource,
    });
    if (config.conversation.enabled) {
      const runner = createModelRuntime(config.models).forRole("conversation");
      conversation = createConversationService({
        scheduling: config.conversation.scheduling,
        instructions: config.conversation.instructions,
        work: database.repositories.conversationWork,
        recall: database.repositories.memory,
        evaluation: database.repositories.conversationEvaluation,
        agent: createPiConversationAgent(runner),
        sender: whatsapp.conversationSender(
          config.conversation.outboundMode,
          options.authorizeOutbound,
        ),
      });
    }

    return { database, whatsapp, ...(conversation ? { conversation } : {}) };
  } catch (error) {
    await database.close();
    throw error;
  }
}
