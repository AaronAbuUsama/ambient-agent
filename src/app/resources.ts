import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import type { GhCommand } from "../github/issues";
import { createPiConversationAgent } from "../conversation/pi-agent";
import { createConversationService, type ConversationService } from "../conversation/service";
import type { EvaluationService } from "../evals/contract";
import { createPiConversationJudge, createPiMemoryJudge } from "../evals/judge";
import { createEvaluationService } from "../evals/service";
import type { MemoryService } from "../memory/contract";
import { createPiMemoryAgent } from "../memory/pi-agent";
import { createMemoryService } from "../memory/service";
import { scanAgents, type AgentDefinition } from "../home/agents";
import { scanMandates, type AgentGrant } from "../home/mandates";
import { skillsForChat } from "../home/skills";
import { createMandateWatcher } from "../home/watcher";
import { createModelRuntime, type ModelRuntime } from "../models/runtime";
import type { WorkerService } from "../worker/contract";
import { createPiWorkerAgent } from "../worker/pi-agent";
import { createWorkerService } from "../worker/service";
import { createWorkerToolbox } from "../worker/tools";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { createAliasResolver } from "../whatsapp/mirror";
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
  readonly worker?: WorkerService;
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
  /**
   * Proof-only `gh` override for the worker toolbox: a rehearsal that
   * provides one CANNOT reach real GitHub. Production passes nothing and
   * uses the real CLI.
   */
  readonly gh?: GhCommand;
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
    // One human, one conversation: every id entering the durable stores is
    // resolved through the account's alias map, and rows retained before an
    // alias was known are healed at startup (idempotent).
    const aliases = createAliasResolver(config.whatsapp.dataDirectory, config.whatsapp.accountId);
    await database.repositories.identity.canonicalize(await aliases.snapshot());
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
      (chatId) => aliases.resolve(chatId),
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
    // Delegation policy, refreshed with the mandates: which agents each chat
    // may use (the grant is the disclosure boundary), and the definitions
    // themselves. Both are read fresh at every resync, so a revoked grant or
    // an edited definition governs the next claim without a restart.
    const grantsByChat = new Map<string, Readonly<Record<string, AgentGrant>>>();
    const toolbox = createWorkerToolbox(options.gh ? { gh: options.gh } : {});
    const agentDefinitions = new Map<string, AgentDefinition>();
    let lastAgentSummary = "";
    const resyncMandates = async () => {
      const mandates = scanMandates(config.home);
      // Mandate ids are canonicalized too, so a hand-written lid-form file
      // still governs the one true conversation.
      const canonical = await Promise.all(
        mandates.active.map(async (mandate) => ({
          ...mandate,
          chatId: await aliases.resolve(mandate.chatId),
        })),
      );
      await database.repositories.speakers.sync(
        canonical.map((mandate) => ({
          conversationId: mandate.chatId,
          mode: mandate.mode,
          ...(mandate.instructions === undefined ? {} : { instructions: mandate.instructions }),
          ...(mandate.memoryBrief === undefined ? {} : { memoryBrief: mandate.memoryBrief }),
        })),
      );
      chatLabels.clear();
      grantsByChat.clear();
      for (const mandate of canonical) {
        chatLabels.set(mandate.chatId, mandate.slug);
        if (mandate.agents) grantsByChat.set(mandate.chatId, mandate.agents);
      }
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
      const agents = scanAgents(config.home, toolbox.check);
      agentDefinitions.clear();
      for (const agent of agents.agents) agentDefinitions.set(agent.name, agent);
      const agentSummary =
        [
          ...agents.agents.map(({ name }) => name),
          ...agents.broken.map(({ name }) => `${name}(BROKEN)`),
        ].join(" ") || "none";
      if (agentSummary !== lastAgentSummary) {
        lastAgentSummary = agentSummary;
        log.agentsChanged(agentSummary);
        for (const agent of agents.broken) log.agentBroken(agent.name, agent.problem);
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
          narrateDigest: (conversationId, claims) =>
            log.memoryDigested(label(conversationId), claims),
        })
      : undefined;
    // The Worker harness: any agent definition runs under it. Composition
    // resolves the CURRENT definition and the originating chat's CURRENT
    // grant at claim time — revocation and edits stop the next run.
    const worker = config.models.roles.worker
      ? createWorkerService({
          work: database.repositories.tasks,
          runs: database.repositories.runs,
          agent: createPiWorkerAgent(models.forRole("worker")),
          compose: (workerProfile, conversationId) => {
            const definition = agentDefinitions.get(workerProfile);
            if (!definition) return { problem: `no agent named "${workerProfile}"` };
            const grant = grantsByChat.get(conversationId)?.[workerProfile];
            if (!grant) return { problem: "not granted to this chat" };
            return toolbox.compose(definition, grant);
          },
          returnResult: async (conversationId, taskId) => {
            await database.repositories.inbox.enqueue({
              conversationId,
              kind: "task_update",
              referenceId: taskId,
            });
            void conversation?.wake(conversationId).catch(() => {});
          },
          narrate: (conversationId, workerProfile, outcome) =>
            log.workerFinished(label(conversationId), workerProfile, outcome),
          report: (conversationId, workerProfile, error) =>
            log.runFailed(label(conversationId), `worker ${workerProfile}: ${error}`),
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
          // Run ids are canonical; the label map (kept fresh by resync) is
          // the canonical-id → slug view of the same mandates.
          const slug = chatLabels.get(conversationId);
          return Promise.resolve(
            skillsForChat(config.home, slug).skills.map(({ name, content }) => ({
              name,
              content,
            })),
          );
        },
        // The delegation surface: granted agents render into the speaker's
        // context as descriptions derived from code; the delegate provider
        // is the authority regardless of what the context said.
        agents: (conversationId) => {
          const grants = grantsByChat.get(conversationId) ?? {};
          return Promise.resolve(
            Object.keys(grants).flatMap((name) => {
              const definition = agentDefinitions.get(name);
              const grant = grants[name];
              if (!definition || !grant) return [];
              const composed = toolbox.compose(definition, grant);
              return "problem" in composed ? [] : [{ name, summary: composed.summary }];
            }),
          );
        },
        taskUpdates: async (taskIds) => {
          const rows = await Promise.all(taskIds.map((id) => database.repositories.tasks.get(id)));
          return rows.flatMap((task) =>
            task
              ? [
                  {
                    taskId: task.id,
                    workerProfile: task.workerProfile,
                    status: task.status,
                    ...(task.resultSummary === undefined ? {} : { summary: task.resultSummary }),
                  },
                ]
              : [],
          );
        },
        delegate: async ({
          conversationId,
          requestedByRunId,
          agent,
          objective,
          target,
          idempotencyKey,
        }) => {
          const definition = agentDefinitions.get(agent);
          const grant = grantsByChat.get(conversationId)?.[agent];
          if (!definition || !grant) throw new Error(`"${agent}" is not available to this chat`);
          const composed = toolbox.compose(definition, grant);
          if ("problem" in composed) throw new Error(`"${agent}" cannot run: ${composed.problem}`);
          let boundTarget = target;
          if (composed.targets.length > 0) {
            if (boundTarget === undefined && composed.targets.length === 1) {
              boundTarget = composed.targets[0];
            }
            if (boundTarget === undefined || !composed.targets.includes(boundTarget)) {
              throw new Error(`target must be one of: ${composed.targets.join(", ")}`);
            }
          } else if (boundTarget !== undefined) {
            throw new Error(`"${agent}" takes no target`);
          }
          // ponytail: a flat in-flight cap; per-chat configuration when a
          // real chat needs a different budget.
          if ((await database.repositories.tasks.countActive(conversationId)) >= 3) {
            throw new Error(
              "this chat already has 3 assignments in flight; wait for one to finish",
            );
          }
          const { task, outcome } = await database.repositories.tasks.create({
            id: idempotencyKey,
            conversationId,
            requestedByRunId,
            objective,
            workerProfile: agent,
            ...(boundTarget === undefined ? {} : { target: boundTarget }),
          });
          // Adoption may only point at live work. A terminal assignment is
          // history — a retried run must hear that, never resurrect it
          // (measured live: a retry once adopted a cancelled assignment and
          // waited forever for a worker that would never come).
          if (outcome === "adopted" && task.status !== "queued" && task.status !== "running") {
            throw new Error(
              `this exact delegation already finished (${task.status}); nothing new was opened`,
            );
          }
          if (outcome === "created") log.delegated(label(conversationId), agent);
          worker?.wake();
          return { taskId: task.id, outcome };
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
      ...(worker ? { worker } : {}),
      ...(conversation ? { conversation } : {}),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
