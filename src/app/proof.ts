import type { AgentRun, ToolCall } from "../database/runs";
import type { EvaluationRun } from "../database/evaluations";
import type { AppConfig } from "./config";
import { createAppResources, type AppResources } from "./resources";

export interface AcceptedProofMessage {
  readonly observationId: string;
  readonly conversationId: string;
}

export interface ProofDestination {
  readonly id: string;
  readonly label: string;
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
  destinations(): readonly ProofDestination[];
  waitForAccepted(
    match: (message: AcceptedProofMessage) => boolean,
    timeoutMs: number,
  ): Promise<AcceptedProofMessage>;
  /** Notify one conversation and drive the production service until a run completes. */
  requestConversationRun(
    conversationId: string,
    timeoutMs: number,
  ): Promise<"succeeded" | "failed">;
  readonly evidence: {
    latestRun(conversationId: string): Promise<AgentRun | undefined>;
    toolCalls(runId: string): Promise<readonly ToolCall[]>;
    evaluations(runId: string): Promise<readonly EvaluationRun[]>;
  };
  stop(): Promise<void>;
}

export interface ProofSafety {
  /**
   * Explicit final-guard override: every resolved outbound destination must be
   * authorized or the send refuses. Providing it composes the Conversation
   * role (model credentials are then required and validated at start); leaving
   * it out composes a listen-only harness that cannot send at all.
   */
  readonly authorizeDestination?: (conversationId: string) => boolean;
}

export async function createAmbientProofHarness(
  config: AppConfig,
  safety: ProofSafety = {},
): Promise<AmbientProofHarness> {
  const conversational = safety.authorizeDestination !== undefined;
  const proofConfig: AppConfig = {
    ...config,
    conversation: { ...config.conversation, enabled: conversational },
  };
  const accepted: AcceptedProofMessage[] = [];
  const listeners = new Set<(message: AcceptedProofMessage) => void>();
  const resources: AppResources = await createAppResources(proofConfig, {
    onAcceptedMessage: (message) => {
      accepted.push(message);
      for (const listener of listeners) listener(message);
    },
    ...(safety.authorizeDestination ? { authorizeOutbound: safety.authorizeDestination } : {}),
  });
  const { repositories } = resources.database;

  return {
    async start() {
      await resources.whatsapp.attach();
    },

    destinations() {
      const snapshot = resources.whatsapp.getSnapshot();
      return snapshot.chats.map((chat) => {
        const group = chat.isGroup
          ? snapshot.groups.find(({ groupId }) => groupId === chat.chatId)
          : undefined;
        return { id: chat.chatId, label: group?.subject ?? chat.subject ?? chat.chatId };
      });
    },

    waitForAccepted(match, timeoutMs) {
      const existing = accepted.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          rejectPromise(new Error(`no matching accepted message within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (message: AcceptedProofMessage) => {
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
      latestRun(conversationId) {
        return repositories.runs.latestRunForConversation(conversationId);
      },
      toolCalls(runId) {
        return repositories.runs.toolCallsForRun(runId);
      },
      evaluations(runId) {
        return repositories.evaluations.forSubject(runId);
      },
    },

    async stop() {
      await resources.whatsapp.dispose().catch(() => {});
      await resources.database.close().catch(() => {});
    },
  };
}
