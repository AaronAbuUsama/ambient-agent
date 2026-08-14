import type { ModelConfig } from "../models/contract";

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
 * One durable speaker record: Ambient's presence in one chat.
 *
 * A chat with no record is not allowed: its messages are still observed and
 * retained as evidence, but no Conversation work is ever scheduled or claimed
 * there. `listening` keeps the speaker silent (reserved for the Memory slice);
 * `responding` lets it claim work and reply. `attendFrom` is the activation
 * watermark: Inbox items created before it are never claimed, so a newly
 * activated speaker starts from its activation point instead of draining the
 * backlog. The operator seeds these records from configuration today; a Root
 * slice later becomes their author without changing any consumer.
 */
export interface SpeakerMandateEntry {
  readonly conversationId: string;
  readonly mode: "listening" | "responding";
  /** Per-chat standard-prompt override; the global configuration string is the fallback. */
  readonly instructions?: string;
  /** Explicit activation watermark for tests; production never authors it (ADR 0002). */
  readonly attendFrom?: string;
  /** The mandate's memory brief: what this chat's memory is FOR, carried to every digest. */
  readonly memoryBrief?: string;
}

export interface ConversationSpeakerStore {
  /**
   * The one authoritative mutation path (ADR 0002): active records mirror
   * exactly the listed mandates. Listed chats are upserted; unlisted rows are
   * removed. `attendFrom` is machine-stamped — preserved across re-syncs, it
   * advances only when a record flips to `responding` (activation always
   * starts from now).
   */
  sync(entries: readonly SpeakerMandateEntry[]): Promise<void>;
  /** The current record set, so a caller can compose a sync without dropping rows (proof harness). */
  current(): Promise<readonly SpeakerMandateEntry[]>;
  /** The production outbound guard: a destination is sendable only with an active responding speaker. */
  isResponding(conversationId: string): Promise<boolean>;
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
  /** The speaker's per-chat instructions captured at claim time, when it has any. */
  readonly instructions?: string;
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

export interface ConversationMessage {
  readonly observationId: string;
  readonly whatsappMessageId: string;
  readonly senderId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly fromAgent: boolean;
}

/** One granted skill's text, ready for the speaker's prompt. */
export interface ConversationSkill {
  readonly name: string;
  readonly content: string;
}

/**
 * One agent this chat's speaker may delegate to: the advertisement rendered
 * into its context. The summary derives from the definition and its tools'
 * own code, so what is promised cannot drift from what the tools do.
 */
export interface ConversationDelegate {
  readonly name: string;
  readonly summary: string;
}

/** A Worker result returned to the chat that delegated it. */
export interface ConversationTaskUpdate {
  readonly taskId: string;
  readonly workerProfile: string;
  readonly status: string;
  readonly summary?: string | undefined;
}

export interface ConversationInput {
  readonly conversationId: string;
  readonly newMessages: readonly ConversationMessage[];
  readonly instructions: string;
  readonly skills: readonly ConversationSkill[];
  /** Agents this chat may delegate to; absent or empty means no delegation. */
  readonly agents?: readonly ConversationDelegate[] | undefined;
  /** Results of work this chat delegated, ready to be reported. */
  readonly taskUpdates?: readonly ConversationTaskUpdate[] | undefined;
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
  /**
   * Open one bounded assignment for a granted agent. The host validates the
   * agent and target against the chat's grant and derives the assignment id
   * from this run's claim, so a retried run adopts its own delegation.
   */
  delegate(
    input: {
      readonly agent: string;
      readonly objective: string;
      readonly target?: string | undefined;
    },
    callId: string,
  ): Promise<{ readonly taskId: string; readonly outcome: "created" | "adopted" }>;
}

export interface ConversationAgent {
  /**
   * The durable snapshot of the model this agent actually runs, stamped on
   * every claimed Agent Run. Carried by the agent so no caller can pair a
   * service with a snapshot that disagrees with the bound model.
   */
  readonly model: ModelConfig;
  run(
    input: ConversationInput,
    tools: ConversationAgentTools,
    signal?: AbortSignal,
  ): Promise<ConversationResult>;
}
