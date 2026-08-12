import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationService, type ConversationService } from "../conversation/service";
import type { EvaluationService } from "../evals/contract";
import { createPiConversationJudge } from "../evals/judge";
import { createEvaluationService } from "../evals/service";
import { createModelRuntime, type ModelRuntime } from "../models/runtime";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { createWhatsAppService, type WhatsAppService } from "../whatsapp/service";
import type { AppConfig } from "./config";
import type { AmbientLifecycleDependencies } from "./lifecycle";

export interface AppResources extends AmbientLifecycleDependencies {
  readonly database: AmbientDatabase;
  readonly whatsapp: WhatsAppService;
  readonly conversation?: ConversationService;
  readonly evaluations: EvaluationService;
  /** The startup-resolved model runtime, for app-internal consumers like the proof harness. */
  readonly models: ModelRuntime;
}

export interface AcceptedMessage {
  readonly observationId: string;
  readonly conversationId: string;
}

export interface AppResourceOptions {
  readonly onAcceptedMessage?: (input: AcceptedMessage) => void;
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
    await database.repositories.speakers.seed(config.conversation.speakers);
    const models = createModelRuntime(config.models);
    const evaluations = createEvaluationService({
      work: database.repositories.evaluationWork,
      recorder: database.repositories.evaluations,
      ...(config.models.roles.evaluator
        ? {
            judge: createPiConversationJudge(
              models.forRole("evaluator"),
              database.repositories.runs,
            ),
          }
        : {}),
      maximumItemsPerRun: config.conversation.scheduling.maximumItemsPerRun,
    });
    if (config.conversation.enabled) {
      const runner = models.forRole("conversation");
      // In live mode the durable speaker record is the production outbound
      // belt: a destination is sendable only with an active responding
      // speaker. A proof override composes with it and can only tighten it.
      const proofGuard = options.authorizeOutbound;
      const speakerGuard = (conversationId: string) =>
        database.repositories.speakers.isResponding(conversationId);
      const outboundGuard =
        config.conversation.outboundMode === "conversation"
          ? proofGuard
            ? async (conversationId: string) =>
                (await speakerGuard(conversationId)) && proofGuard(conversationId)
            : speakerGuard
          : proofGuard;
      conversation = createConversationService({
        scheduling: config.conversation.scheduling,
        instructions: config.conversation.instructions,
        work: database.repositories.conversationWork,
        recall: database.repositories.memory,
        agent: createPiConversationAgent(runner),
        sender: whatsapp.conversationSender(config.conversation.outboundMode, outboundGuard),
      });
    }

    return { database, whatsapp, evaluations, models, ...(conversation ? { conversation } : {}) };
  } catch (error) {
    await database.close();
    throw error;
  }
}
