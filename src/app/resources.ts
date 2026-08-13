import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationService, type ConversationService } from "../conversation/service";
import type { EvaluationService } from "../evals/contract";
import { createPiConversationJudge, createPiMemoryJudge } from "../evals/judge";
import { createEvaluationService } from "../evals/service";
import type { MemoryService } from "../memory/contract";
import { createPiMemoryAgent } from "../memory/pi-agent";
import { createMemoryService } from "../memory/service";
import { scanMandates } from "../home/mandates";
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
  readonly memoryService?: MemoryService;
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
    // The mandate files are the control (ADR 0002): active records mirror the
    // set of valid chat folders. Broken chats are simply absent — brokenness
    // is recomputed loudly by `ambient doctor`, never stored.
    const mandates = scanMandates(config.home);
    await database.repositories.speakers.sync(
      mandates.active.map((mandate) => ({
        conversationId: mandate.chatId,
        mode: mandate.mode,
        ...(mandate.instructions === undefined ? {} : { instructions: mandate.instructions }),
        ...(mandate.memoryBrief === undefined ? {} : { memoryBrief: mandate.memoryBrief }),
      })),
    );
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
            memoryJudge: createPiMemoryJudge(
              models.forRole("evaluator"),
              database.repositories.runs,
            ),
          }
        : {}),
      maximumItemsPerRun: config.conversation.scheduling.maximumItemsPerRun,
    });
    const memoryService = config.models.roles.memory
      ? createMemoryService({
          work: database.repositories.memoryWork,
          agent: createPiMemoryAgent(models.forRole("memory")),
          ontology: database.repositories.memory,
          // Issue-centric coverage on dense windows legitimately exceeds the
          // old 50; still bounded.
          maximumClaimsPerJob: 80,
        })
      : undefined;
    if (config.conversation.enabled) {
      const runner = models.forRole("conversation");
      // In live mode the durable speaker record is the production outbound
      // belt: a destination is sendable only with an active responding
      // speaker. A proof override composes with it and can only tighten it.
      const proofGuard = options.authorizeOutbound;
      const speakerGuard = (conversationId: string) =>
        database.repositories.speakers.isResponding(conversationId);
      const outboundGuard = proofGuard
        ? async (conversationId: string) =>
            (await speakerGuard(conversationId)) && proofGuard(conversationId)
        : speakerGuard;
      conversation = createConversationService({
        scheduling: config.conversation.scheduling,
        instructions: config.conversation.instructions,
        work: database.repositories.conversationWork,
        recall: database.repositories.memory,
        agent: createPiConversationAgent(runner),
        sender: whatsapp.conversationSender(outboundGuard),
      });
    }

    return {
      database,
      whatsapp,
      evaluations,
      models,
      ...(memoryService ? { memoryService } : {}),
      ...(conversation ? { conversation } : {}),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
