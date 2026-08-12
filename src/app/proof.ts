import { z } from "zod";
import { createConversationContextBuilder } from "../conversation/context-builder";
import { createPiConversationAgent } from "../conversation/pi-agent";
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
  /** Replay the latest retained run offline: a live model call with a stubbed sender, no WhatsApp. */
  replayConversationRun(conversationId: string): Promise<{
    readonly decision: "reply" | "silence";
    readonly textLength: number;
  }>;
  readonly evidence: {
    latestRun(conversationId: string): Promise<ProofRunEvidence | undefined>;
    toolCalls(runId: string): Promise<readonly ProofToolEvidence[]>;
    evaluations(runId: string): Promise<readonly ProofEvaluationEvidence[]>;
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
      outboundMode: conversational ? "conversation" : config.conversation.outboundMode,
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
      await repositories.speakers.seed([
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
        async recall(query) {
          const claims = await repositories.memory.recall({
            nativeIds: [
              conversationId,
              ...new Set(context.newMessages.map(({ senderId }) => senderId)),
            ],
            query,
          });
          return { claims };
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
    },

    async stop() {
      await resources.conversation?.stop().catch(() => {});
      await resources.whatsapp.stop().catch(() => {});
      await resources.database.close().catch(() => {});
    },
  };
}
