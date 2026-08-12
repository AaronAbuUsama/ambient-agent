import type { ModelConfig } from "../agent-models";
import type { AgentRun } from "../database/runs";
import type { ConversationInboxItem } from "../database/conversation-inbox";

export interface ConversationSchedulingConfig {
  readonly debounceMs: number;
  readonly maximumWaitMs: number;
  readonly leaseMs: number;
  readonly maximumItemsPerRun: number;
}

export interface ConversationScheduleState {
  readonly conversationId: string;
  readonly firstPendingAt?: string;
  readonly latestPendingAt?: string;
  readonly dueAt?: string;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly activeRunId?: string;
}

export interface ConversationRunClaim {
  readonly run: AgentRun;
  readonly items: readonly ConversationInboxItem[];
}

export interface ClaimConversationRunInput {
  readonly leaseOwner: string;
  readonly now?: string;
  readonly model: ModelConfig;
  readonly agentId: string;
  readonly promptVersion: string;
  readonly scheduling: ConversationSchedulingConfig;
}

export interface ConversationMessage {
  readonly observationId: string;
  readonly whatsappMessageId: string;
  readonly senderId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly fromAgent: boolean;
}

export interface ConversationInput {
  readonly conversationId: string;
  readonly newMessages: readonly ConversationMessage[];
  readonly instructions: string;
}

export interface ConversationResult {
  readonly summary: string;
}

export interface RecalledMemory {
  readonly claimId: string;
  readonly text: string;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
  readonly evidenceObservationIds: readonly string[];
}

export interface ConversationAgentTools {
  sendMessage(text: string, callId: string): Promise<{ readonly operationId: string }>;
  recall(query: string, callId: string): Promise<{ readonly claims: readonly RecalledMemory[] }>;
}

export interface ConversationAgent {
  run(
    model: ModelConfig,
    input: ConversationInput,
    tools: ConversationAgentTools,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
}
