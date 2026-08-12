import type { ModelConfig } from "../agent-models";

export interface ConversationSchedulingConfig {
  readonly debounceMs: number;
  readonly maximumWaitMs: number;
  readonly leaseMs: number;
  readonly maximumItemsPerRun: number;
}

/**
 * One durable Conversation Inbox item: something this conversation's agent has
 * not dealt with yet. It is the retained handoff into a Conversation run — an
 * envelope, not the content.
 *
 * - `kind: "message"`: an accepted inbound WhatsApp message; `referenceId` is
 *   the retained Observation id, dereferenced when building run input.
 * - `kind: "task_update"`: a Worker result returned to the conversation that
 *   delegated it. No slice produces these yet; the kind reserves the seam.
 */
export interface ConversationWorkItem {
  readonly id: string;
  readonly kind: "message" | "task_update";
  readonly referenceId: string;
}

/**
 * One bounded immutable claim: the checkout receipt for a batch of Inbox work.
 *
 * "Claim" is queue vocabulary here — work checked out under a fenced lease —
 * unrelated to Memory's evidence-backed claims (facts). Membership is frozen
 * at claim time: at most `maximumItemsPerRun` items in Inbox order, and later
 * arrivals wait for the next run.
 */
export interface ConversationClaim {
  readonly runId: string;
  readonly conversationId: string;
  readonly items: readonly ConversationWorkItem[];
}

export interface ClaimConversationWork {
  readonly leaseOwner: string;
  readonly now?: string;
  readonly model: ModelConfig;
  readonly agentId: string;
  readonly promptVersion: string;
  readonly scheduling: ConversationSchedulingConfig;
}

/** Retained evidence referenced by claimed work, read through the work store. */
export interface RetainedConversationObservation {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly conversationId?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

/**
 * The one authoritative durable mutation path for Conversation work.
 *
 * Owns scheduling windows, bounded immutable claims, fenced leases, Agent Run
 * and tool evidence transitions, Inbox consumption or release, retries, and
 * expired-lease recovery.
 *
 * A lease is a time-limited exclusive right to run one conversation. A healthy
 * runner renews it mid-run; a crashed runner leaves it to expire, and the next
 * claim anywhere fails the abandoned run and releases its items for retry.
 * Completion is fenced: it succeeds only while the caller still holds the
 * lease, so a stalled process cannot corrupt work it no longer owns.
 */
export interface ConversationWorkStore {
  reconcile(scheduling: ConversationSchedulingConfig): Promise<void>;
  notify(conversationId: string, scheduling: ConversationSchedulingConfig): Promise<void>;
  nextWakeAt(): Promise<string | undefined>;
  claimNext(input: ClaimConversationWork): Promise<ConversationClaim | undefined>;
  renewLease(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly now?: string;
    readonly leaseUntil: string;
  }): Promise<boolean>;
  observations(ids: readonly string[]): Promise<readonly RetainedConversationObservation[]>;
  beginTool(input: {
    readonly runId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly input: unknown;
  }): Promise<{ readonly toolCallId: string }>;
  finishTool(input: {
    readonly toolCallId: string;
    readonly result:
      | { readonly outcome: "succeeded"; readonly output: unknown }
      | { readonly outcome: "failed"; readonly error: string };
  }): Promise<void>;
  complete(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly result: ConversationResult;
    readonly completedAt?: string;
    readonly scheduling: ConversationSchedulingConfig;
  }): Promise<void>;
  fail(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly error: string;
    readonly completedAt?: string;
    readonly scheduling: ConversationSchedulingConfig;
  }): Promise<void>;
}

/** Scoped outbound text effect; the destination is bound by the host, never the model. */
export interface ScopedMessageSender {
  sendText(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly operationId: string }>;
}

export interface ConversationRecall {
  recall(input: {
    readonly nativeIds: readonly string[];
    readonly query: string;
  }): Promise<readonly RecalledMemory[]>;
}

/** Records the synchronous run-contract evaluation; never throws into the live path. */
export interface ConversationEvaluationSink {
  recordRunContract(input: {
    readonly runId: string;
    readonly conversationId: string;
    readonly promptVersion: string;
    readonly itemCount: number;
    readonly maximumItemsPerRun: number;
    readonly at: string;
    readonly outcome:
      | { readonly status: "succeeded"; readonly operationId?: string }
      | { readonly status: "failed"; readonly error: string };
  }): Promise<void>;
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
