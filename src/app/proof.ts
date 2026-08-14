import { z } from "zod";
import { createConversationContextBuilder } from "../conversation/context-builder";
import type { RecalledMemory } from "../conversation/contract";
import { importChatHistory, type HistoryImportResult } from "../whatsapp/history-import";
import { retainedMessagePayloadSchema } from "../whatsapp/message-payload";
import { createPiConversationAgent } from "../conversation/pi-agent";
import type { GhCommand } from "../github/issues";
import type { WhatsAppDestination } from "../whatsapp/service";
import type { AppConfig } from "./config";
import { createAppResources, type AcceptedMessage, type AppResources } from "./resources";

/** Narrow run evidence: never the curated input or private terminal result. */
export interface ProofRunEvidence {
  readonly id: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly error?: string;
}

export interface ProofToolEvidence {
  readonly toolName: string;
  readonly outcome: "running" | "succeeded" | "failed";
  readonly output?: unknown;
  readonly error?: string;
}

export interface ProofEvaluationEvidence {
  readonly id: string;
  readonly caseId: string;
  readonly status: "running" | "succeeded" | "failed";
}

/**
 * The narrow proof surface over the production composition assembly.
 *
 * Proof scripts get destination discovery, accepted-input waiting, one bounded
 * Conversation run at a time, and read-only evidence — never the database,
 * repositories, concrete WhatsApp controller, or hand-wired services.
 */
export interface AmbientProofHarness {
  start(): Promise<void>;
  /** Chats the authenticated account can see, for proof-side target matching. */
  destinations(): readonly WhatsAppDestination[];
  waitForAccepted(
    match: (message: AcceptedMessage) => boolean,
    timeoutMs: number,
  ): Promise<AcceptedMessage>;
  /** Notify one conversation and drive the production service until a run completes. */
  requestConversationRun(
    conversationId: string,
    timeoutMs: number,
  ): Promise<"succeeded" | "failed">;
  /** Step the asynchronous evaluation runner over one pending subject. */
  runEvaluationsOnce(): Promise<"idle" | "processed">;
  /** Import one chat's history from a designated mirror as memory evidence. */
  importHistory(options: {
    readonly mirrorUrl: string;
    readonly mirrorAccountId: string;
    readonly chatId: string;
    readonly limit?: number;
  }): Promise<HistoryImportResult>;
  /**
   * Digest one conversation's retained backlog through the production memory
   * path: seed a listening speaker (memory is default-on for allowed chats)
   * and drain the memory service window by window, so later windows see the
   * ontology earlier windows built.
   */
  requestMemoryDigest(
    conversationId: string,
    options?: { readonly brief?: string },
  ): Promise<{
    readonly outcome: "done" | "failed";
    readonly runIds: readonly string[];
    readonly windows: number;
    /** Windows that failed and were re-derived — a blip absorbed, not hidden. */
    readonly retried: number;
    readonly batchSize: number;
    readonly senders: readonly string[];
  }>;
  /** Current evidence-backed claims for the given identities; proof-side reads only. */
  recallFor(nativeIds: readonly string[], query?: string): Promise<readonly RecalledMemory[]>;
  /** Current claims evidenced inside one conversation; proof-side reads only. */
  recallForConversation(conversationId: string): Promise<readonly RecalledMemory[]>;
  /** Ontology shape counts for proof gates; no content leaves the database. */
  ontologySummary(): Promise<{
    readonly entitiesByKind: Readonly<Record<string, number>>;
    readonly identityNativeIds: readonly string[];
    readonly claimCount: number;
  }>;
  /**
   * Retain one synthetic accepted message through the production ingestion
   * path — rehearsal proofs only; a live proof receives real accepted input.
   */
  injectAccepted(input: {
    readonly conversationId: string;
    readonly senderId: string;
    readonly senderName?: string;
    readonly text: string;
  }): Promise<{ readonly observationId: string; readonly inboxItemId: string }>;
  /** Drive the worker drain until it claims and finishes one assignment. */
  requestWorkerRun(
    timeoutMs: number,
  ): Promise<{ readonly outcome: "done" | "failed"; readonly taskId?: string }>;
  /** Assignment evidence: statuses, profiles, targets, artifact titles — never content. */
  assignments(conversationId: string): Promise<
    readonly {
      readonly id: string;
      readonly status: string;
      readonly workerProfile: string;
      readonly target?: string;
      readonly artifactTitles: readonly string[];
      readonly resultSummaryLength: number;
    }[]
  >;
  /** The inbox item kinds the latest run consumed, from its retained input snapshot. */
  latestRunInboxKinds(conversationId: string): Promise<readonly string[]>;
  /** Start the policy watcher so on-disk mandate and agent edits reach the running composition. */
  watchPolicy(): Promise<void>;
  /** Replay the latest retained run offline: a live model call with a stubbed sender, no WhatsApp. */
  replayConversationRun(conversationId: string): Promise<{
    readonly decision: "reply" | "silence";
    readonly textLength: number;
  }>;
  readonly evidence: {
    latestRun(conversationId: string): Promise<ProofRunEvidence | undefined>;
    toolCalls(runId: string): Promise<readonly ProofToolEvidence[]>;
    evaluations(runId: string): Promise<readonly ProofEvaluationEvidence[]>;
    /** Evaluations of a subject with their metric rows: scores and pass flags only. */
    evaluationDetails(subjectRunId: string): Promise<
      readonly (ProofEvaluationEvidence & {
        readonly results: readonly {
          readonly metric: string;
          readonly score?: number;
          readonly passed?: boolean;
        }[];
      })[]
    >;
  };
  stop(): Promise<void>;
}

export interface ProofSafety {
  /**
   * Explicit final-guard override: every resolved outbound destination must be
   * authorized or the send refuses. Providing it composes the Conversation
   * role (model credentials are then required and validated at start) and
   * forces outbound mode to "conversation" so the guarded destination and the
   * resolved destination cannot diverge; leaving it out composes a listen-only
   * harness that cannot send at all.
   */
  readonly authorizeDestination?: (conversationId: string) => boolean;
  /** Proof-scoped instructions override, applied inside the harness. */
  readonly instructions?: string;
  /**
   * Worker toolbox `gh` override: a rehearsal that provides one cannot reach
   * real GitHub. Leaving it out keeps the real CLI (live proofs).
   */
  readonly gh?: GhCommand;
}

export async function createAmbientProofHarness(
  config: AppConfig,
  safety: ProofSafety = {},
): Promise<AmbientProofHarness> {
  const conversational = safety.authorizeDestination !== undefined;
  const proofConfig: AppConfig = {
    ...config,
    conversation: {
      ...config.conversation,
      enabled: conversational,
      instructions: safety.instructions ?? config.conversation.instructions,
    },
  };
  const replayInputSchema = z.object({
    inboxItems: z.array(
      z.object({
        inboxItemId: z.string().min(1),
        kind: z.enum(["message", "task_update"]),
        referenceId: z.string().min(1),
      }),
    ),
    instructions: z.string().optional(),
  });
  const harnessCreatedAt = new Date().toISOString();
  const accepted: AcceptedMessage[] = [];
  const listeners = new Set<(message: AcceptedMessage) => void>();
  const resources: AppResources = await createAppResources(proofConfig, {
    onAcceptedMessage: (message) => {
      accepted.push(message);
      for (const listener of listeners) listener(message);
    },
    authorizeOutbound: safety.authorizeDestination,
    ...(safety.gh ? { gh: safety.gh } : {}),
  });
  const { repositories } = resources.database;

  return {
    async start() {
      await resources.whatsapp.start();
    },

    destinations() {
      return resources.whatsapp.destinations();
    },

    waitForAccepted(match, timeoutMs) {
      const existing = accepted.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          rejectPromise(new Error(`no matching accepted message within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (message: AcceptedMessage) => {
          if (!match(message)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolvePromise(message);
        };
        listeners.add(listener);
      });
    },

    async requestConversationRun(conversationId, timeoutMs) {
      const conversation = resources.conversation;
      if (!conversation) {
        throw new Error("this proof harness was composed without the Conversation role");
      }
      // A bounded run requires an active responding speaker; the proof
      // activates one for exactly this conversation, attending only messages
      // accepted since the harness was created.
      const mandates = await repositories.speakers.current();
      await repositories.speakers.sync([
        ...mandates.filter((mandate) => mandate.conversationId !== conversationId),
        { conversationId, mode: "responding", attendFrom: harnessCreatedAt },
      ]);
      await repositories.conversationWork.notify(
        conversationId,
        proofConfig.conversation.scheduling,
      );
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const outcome = await conversation.runOnce();
        if (outcome !== "idle") return outcome;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      throw new Error(`no conversation run became due within ${timeoutMs}ms`);
    },

    runEvaluationsOnce() {
      return resources.evaluations.runOnce();
    },

    importHistory(options) {
      return importChatHistory({ ...options, sink: repositories.observations });
    },

    async requestMemoryDigest(conversationId, { brief } = {}) {
      const memoryService = resources.memoryService;
      if (!memoryService) {
        throw new Error("this proof harness was composed without the memory role");
      }
      const batch = await repositories.observations.forConversation(conversationId, {
        kind: "message",
        limit: 10_000,
      });
      if (batch.length === 0) throw new Error("no retained observations to digest");
      const senders = [
        ...new Set(
          batch.flatMap(({ payload }) => {
            const parsed = retainedMessagePayloadSchema.safeParse(payload);
            return parsed.success && parsed.data.sender ? [parsed.data.sender.id] : [];
          }),
        ),
      ];
      // Memory is default-on for allowed chats: presence, not a job, is what
      // makes the backlog digestible. Listening keeps the chat silent.
      const mandates = await repositories.speakers.current();
      await repositories.speakers.sync([
        ...mandates.filter((mandate) => mandate.conversationId !== conversationId),
        {
          conversationId,
          mode: "listening",
          ...(brief === undefined ? {} : { memoryBrief: brief }),
        },
      ]);
      const runIds: string[] = [];
      let windows = 0;
      let retried = 0;
      for (;;) {
        const { outcome, runId } = await memoryService.runOnce();
        if (outcome === "idle") break;
        windows += 1;
        // Only completed windows carry gradable evidence; a failed window's
        // work is done again under a new run id.
        if (runId !== undefined && outcome === "done") runIds.push(runId);
        if (outcome !== "done") {
          // A failed window is not terminal by design: the watermark did not
          // move, so the same window re-derives identically on the next claim.
          // Catching up over hundreds of messages must survive a provider
          // blip; only a window that keeps failing ends the drain, and the
          // chat's own park-after-three still bounds it.
          retried += 1;
          if (retried > 3) {
            return {
              outcome: "failed",
              runIds,
              windows,
              retried,
              batchSize: batch.length,
              senders,
            };
          }
          continue;
        }
        if (windows > 1000) throw new Error("memory digest did not converge");
      }
      return { outcome: "done", runIds, windows, retried, batchSize: batch.length, senders };
    },

    recallFor(nativeIds, query = "") {
      return repositories.memory.recall({ nativeIds: [...nativeIds], query, limit: 100 });
    },

    recallForConversation(conversationId) {
      return repositories.memory.recallForConversation({ conversationId, limit: 200 });
    },

    ontologySummary() {
      return repositories.memory.summary();
    },

    async replayConversationRun(conversationId) {
      const run = await repositories.runs.latestRunForConversation(conversationId);
      if (!run || run.role !== "conversation") {
        throw new Error("no retained conversation run to replay");
      }
      const input = replayInputSchema.parse(run.input);
      const builder = createConversationContextBuilder(
        repositories.conversationWork,
        proofConfig.conversation.instructions,
      );
      const context = await builder.build({
        runId: run.id,
        conversationId,
        items: input.inboxItems.map(({ inboxItemId, kind, referenceId }) => ({
          id: inboxItemId,
          kind,
          referenceId,
        })),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      });
      const agent = createPiConversationAgent(resources.models.forRole("conversation"));
      let captured: string | undefined;
      await agent.run(context, {
        async sendMessage(text) {
          captured = text;
          return { operationId: `replay-${crypto.randomUUID()}` };
        },
        async delegate() {
          return Promise.reject(new Error("replay runs do not delegate"));
        },
        async recall(query) {
          const claims = await repositories.memory.recall({
            conversationId,
            nativeIds: [
              conversationId,
              ...new Set(context.newMessages.map(({ senderId }) => senderId)),
            ],
            query,
          });
          return { claims };
        },
        async searchHistory(query) {
          const messages = await repositories.memory.searchHistory({ conversationId, query });
          return { messages };
        },
        async viewImage() {
          return { unavailable: "not available in this context" };
        },
      });
      const decision = captured === undefined ? ("silence" as const) : ("reply" as const);
      const textLength = captured?.length ?? 0;
      const evaluation = await repositories.evaluations.start({
        role: "conversation",
        subjectRunId: run.id,
        caseId: "conversation-replay-v1",
        configuration: { promptVersion: run.promptVersion },
      });
      await repositories.evaluations.recordResult({
        evaluationRunId: evaluation.id,
        metric: "replay_decision",
        passed: true,
        detail: { decision, textLength },
      });
      await repositories.evaluations.finish(evaluation.id, { status: "succeeded" });
      return { decision, textLength };
    },

    async injectAccepted({ conversationId, senderId, senderName, text }) {
      const accountId = proofConfig.whatsapp.accountId;
      const ingestion = repositories.messageIngestion;
      if (!(await ingestion.cursor(accountId))) await ingestion.activate(accountId, 0);
      const seq = ((await ingestion.cursor(accountId))?.afterSeq ?? 0) + 1;
      const occurredAt = new Date().toISOString();
      const nativeId = `rehearsal-${seq}`;
      const [result] = await ingestion.retainBatch({
        accountId,
        seq,
        observations: [
          {
            source: "whatsapp",
            kind: "message",
            accountId,
            nativeId,
            conversationId,
            occurredAt,
            payload: {
              version: 1,
              messageId: nativeId,
              chatId: conversationId,
              sender: { id: senderId, mode: "pn" },
              fromMe: false,
              timestamp: Math.floor(Date.parse(occurredAt) / 1000),
              live: true,
              isGroup: conversationId.endsWith("@g.us"),
              ...(senderName === undefined ? {} : { pushName: senderName }),
              text,
            },
          },
        ],
      });
      if (!result) throw new Error("synthetic message was not retained");
      return { observationId: result.observationId, inboxItemId: result.inboxItemId };
    },

    async requestWorkerRun(timeoutMs) {
      const worker = resources.worker;
      if (!worker) throw new Error("this proof harness was composed without the worker role");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await worker.runOnce();
        if (result.outcome !== "idle") {
          return {
            outcome: result.outcome,
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          };
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      throw new Error(`no assignment became claimable within ${timeoutMs}ms`);
    },

    async assignments(conversationId) {
      const rows = await repositories.tasks.listForConversation(conversationId);
      return Promise.all(
        rows.map(async (task) => ({
          id: task.id,
          status: task.status,
          workerProfile: task.workerProfile,
          ...(task.target === undefined ? {} : { target: task.target }),
          artifactTitles: (await repositories.tasks.listArtifacts(task.id)).map(
            ({ title }) => title,
          ),
          resultSummaryLength: task.resultSummary?.length ?? 0,
        })),
      );
    },

    async latestRunInboxKinds(conversationId) {
      const run = await repositories.runs.latestRunForConversation(conversationId);
      if (!run) return [];
      const parsed = replayInputSchema.safeParse(run.input);
      return parsed.success ? parsed.data.inboxItems.map(({ kind }) => kind) : [];
    },

    async watchPolicy() {
      await resources.policyWatcher?.start();
    },

    evidence: {
      // Mapped, not passed through: the retained run also carries the curated
      // input and private terminal result, which never belong in proof output.
      async latestRun(conversationId) {
        const run = await repositories.runs.latestRunForConversation(conversationId);
        return run && { id: run.id, status: run.status, error: run.error };
      },
      async toolCalls(runId) {
        const calls = await repositories.runs.toolCallsForRun(runId);
        return calls.map(({ toolName, outcome, output, error }) => ({
          toolName,
          outcome,
          output,
          error,
        }));
      },
      async evaluations(runId) {
        const evaluations = await repositories.evaluations.forSubject(runId);
        return evaluations.map(({ id, caseId, status }) => ({ id, caseId, status }));
      },
      async evaluationDetails(subjectRunId) {
        const evaluations = await repositories.evaluations.forSubject(subjectRunId);
        return Promise.all(
          evaluations.map(async ({ id, caseId, status }) => ({
            id,
            caseId,
            status,
            results: await repositories.evaluations.resultsFor(id),
          })),
        );
      },
    },

    async stop() {
      await resources.conversation?.stop().catch(() => {});
      await resources.worker?.stop().catch(() => {});
      await resources.policyWatcher?.stop().catch(() => {});
      await resources.whatsapp.stop().catch(() => {});
      await resources.database.close().catch(() => {});
    },
  };
}
