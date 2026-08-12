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
        return evaluations.map(({ id, status }) => ({ id, status }));
      },
    },

    async stop() {
      await resources.conversation?.stop().catch(() => {});
      await resources.whatsapp.stop().catch(() => {});
      await resources.database.close().catch(() => {});
    },
  };
}
