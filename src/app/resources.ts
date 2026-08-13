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
import { skillsForChat } from "../home/skills";
import { createMandateWatcher } from "../home/watcher";
import { createModelRuntime, type ModelRuntime } from "../models/runtime";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { createWhatsAppService, type WhatsAppService } from "../whatsapp/service";
import type { AppConfig } from "./config";
import type { AmbientLifecycleDependencies } from "./lifecycle";
import { silentOperationalLog, type OperationalLog } from "./operational-log";

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
  /** The daemon's voice; silent by default (tests, proofs that capture their own evidence). */
  readonly log?: OperationalLog;
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
    const log = options.log ?? silentOperationalLog;
    // The voice speaks in slugs — the product's own safe labels — falling
    // back to a shortened id for chats without a folder.
    const chatLabels = new Map<string, string>();
    const label = (conversationId: string) =>
      chatLabels.get(conversationId) ?? `${conversationId.slice(0, 10)}…`;
    let conversation: ConversationService | undefined;
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      config.whatsapp.accountId,
      database.repositories.messageIngestion,
      (result) => {
        log.messageReceived(label(result.conversationId));
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
    let lastMandateSummary = "";
    const resyncMandates = async () => {
      const mandates = scanMandates(config.home);
      await database.repositories.speakers.sync(
        mandates.active.map((mandate) => ({
          conversationId: mandate.chatId,
          mode: mandate.mode,
          ...(mandate.instructions === undefined ? {} : { instructions: mandate.instructions }),
          ...(mandate.memoryBrief === undefined ? {} : { memoryBrief: mandate.memoryBrief }),
        })),
      );
      chatLabels.clear();
      for (const mandate of mandates.active) chatLabels.set(mandate.chatId, mandate.slug);
      const summary =
        [
          ...mandates.active.map((mandate) => `${mandate.slug}(${mandate.mode})`),
          ...mandates.broken.map((chat) => `${chat.slug}(BROKEN)`),
        ].join(" ") || "none";
      if (summary !== lastMandateSummary) {
        lastMandateSummary = summary;
        log.mandatesChanged(summary);
        for (const chat of mandates.broken) log.chatBroken(chat.slug, chat.problem);
      }
    };
    await resyncMandates();
    // The watcher is a wake hint, never the authority: an edited mandate
    // takes effect without a restart, and the startup reconcile above stays
    // the truth after any missed event.
    const policyWatcher = createMandateWatcher(config.home, resyncMandates);
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
        // Skills are read fresh from the home per run: the chat's own skills
        // shadow home skills by name; broken skills are skipped (doctor is
        // the loud surface).
        skills: (conversationId) => {
          const slug = scanMandates(config.home).active.find(
            (mandate) => mandate.chatId === conversationId,
          )?.slug;
          return Promise.resolve(
            skillsForChat(config.home, slug).skills.map(({ name, content }) => ({
              name,
              content,
            })),
          );
        },
        work: database.repositories.conversationWork,
        recall: database.repositories.memory,
        agent: createPiConversationAgent(runner),
        sender: (() => {
          const sender = whatsapp.conversationSender(outboundGuard);
          return {
            async sendText(message: Parameters<typeof sender.sendText>[0]) {
              const result = await sender.sendText(message);
              log.replySent(label(message.conversationId));
              return result;
            },
          };
        })(),
      });
    }

    return {
      database,
      whatsapp,
      evaluations,
      models,
      policyWatcher,
      ...(memoryService ? { memoryService } : {}),
      ...(conversation ? { conversation } : {}),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
