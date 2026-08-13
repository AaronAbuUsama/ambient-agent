import type { ModelConfig } from "../models/contract";

/**
 * The Memory Agent is a bounded evidence analyst: it receives one batch of
 * retained messages plus the current ontology view and proposes changes. It
 * never writes anything itself — the host validates every proposal and applies
 * it through the existing patch machinery, so an invalid proposal fails the
 * job without touching the ontology.
 */

/**
 * One retained message given to the Memory Agent as evidence.
 *
 * `senderId` is absent when the retained record never carried the author
 * (historical group sync loses it); it is never fabricated. Quoted-reply
 * recovery in the job store fills it back in where the evidence names the
 * quoted author. `mentions` are real native ids and are linkable identities.
 */
export interface MemoryMessage {
  readonly observationId: string;
  readonly senderId?: string;
  readonly fromMe: boolean;
  readonly sentAt: string;
  readonly text: string;
  readonly mentions?: readonly string[];
  /** The observation this message replies to, when it is inside the batch. */
  readonly inReplyTo?: string;
  /** Present when the message carries media; the bytes stay in the store. */
  readonly attachment?: { readonly kind: string; readonly caption?: string };
}

export interface MemoryOntologyEntity {
  readonly id: string;
  readonly kind: string;
  readonly canonicalName: string;
  readonly nativeIds: readonly string[];
}

export interface MemoryOntologyPredicate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface MemoryOntologyClaim {
  readonly claimId: string;
  readonly entityId: string;
  readonly predicateName: string;
  readonly value: unknown;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
  readonly version: number;
}

export interface MemoryInput {
  readonly conversationId: string;
  /** The mandate's memory brief for this chat, when one is authored. */
  readonly brief?: string;
  readonly messages: readonly MemoryMessage[];
  readonly entities: readonly MemoryOntologyEntity[];
  readonly predicates: readonly MemoryOntologyPredicate[];
  readonly claims: readonly MemoryOntologyClaim[];
}

/** Proposed by the model; refs are symbolic until the host validates and applies. */
export interface ProposedEntity {
  readonly ref: string;
  readonly kind: string;
  readonly canonicalName: string;
  /** WhatsApp native ids observed for this entity in the batch. */
  readonly nativeIds: readonly string[];
}

export interface ProposedPredicate {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
}

export interface ProposedClaim {
  /** A proposed entity ref or an existing entity id from the ontology view. */
  readonly entity: string;
  /** A proposed predicate ref or an existing predicate id from the view. */
  readonly predicate: string;
  readonly value: unknown;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
  readonly evidenceObservationIds: readonly string[];
  /** An existing claim this one supersedes, at its current version. */
  readonly supersedes?: { readonly claimId: string; readonly version: number };
}

export interface MemoryProposal {
  readonly entities: readonly ProposedEntity[];
  readonly predicates: readonly ProposedPredicate[];
  readonly claims: readonly ProposedClaim[];
  /** The private terminal report. */
  readonly report: string;
}

/**
 * The host-owned tools a Memory Agent run receives. `proposeFacts` validates
 * AND applies the proposal in one call — an invalid proposal throws, the error
 * returns to the model as a tool failure, and the agent may correct itself
 * within the same bounded run. The host owns every write.
 */
export interface MemoryTools {
  proposeFacts(proposal: MemoryProposal, toolCallId: string): Promise<AppliedMemorySummary>;
}

export interface MemoryResult {
  /** The private terminal report — the agent's closing summary. */
  readonly report: string;
}

export interface MemoryAgent {
  readonly model: ModelConfig;
  run(input: MemoryInput, tools: MemoryTools, signal?: AbortSignal): Promise<MemoryResult>;
}

/** What one claimed digest window carries into a run. */
export interface MemoryWindowClaim {
  readonly conversationId: string;
  /** The agent run the claim opened; terminal transitions close it. */
  readonly runId: string;
  readonly input: MemoryInput;
  /** The window's last message; completion advances the watermark here. */
  readonly digestedThrough: { readonly at: string; readonly id: string };
  /**
   * Deterministic idempotency key for this window's ontology patch: the same
   * undigested window always derives the same key, so a crashed attempt that
   * applied its patch is recovered instead of digested twice — even by a
   * later re-claim.
   */
  readonly patchId: string;
}

/** A summary of what one applied proposal changed, retained in the run result. */
export interface AppliedMemorySummary {
  readonly report: string;
  readonly entitiesCreated: number;
  readonly linkedNativeIds: readonly string[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly entityName: string;
    readonly predicateName: string;
    readonly value: unknown;
    readonly confidence: string;
    readonly evidenceObservationIds: readonly string[];
  }[];
  readonly patchStatus: "applied" | "empty";
}

/**
 * The one authoritative mutation path for durable memory work. Memory is
 * default-on for every chat with a speaker record (any mode): a chat is due
 * when its undigested backlog reaches a full window, or when any backlog has
 * gone quiet — both derived from retained observations against the per-chat
 * watermark, never from process timers. Claiming opens the agent run and the
 * lease in one transaction; completion advances the watermark, finishes the
 * run, and writes the durable evaluation signal in one transaction; failure
 * counts an attempt, and a chat whose window keeps failing is parked rather
 * than left to spend money forever. An expired lease makes the chat claimable
 * again; the deterministic window patch key recovers an applied-but-unfinished
 * attempt.
 */
export interface MemoryWorkStore {
  claimNext(input: {
    readonly leaseOwner: string;
    readonly leaseMs: number;
    readonly model: ModelConfig;
    readonly promptVersion: string;
    /** Full-window size; a backlog this large is due immediately. */
    readonly window: number;
    /** Backlog younger than this stays coalescing; older backlog is due. */
    readonly quietMs: number;
    /** Consecutive failed windows after which a chat is parked. */
    readonly maximumAttempts: number;
    readonly now?: string;
  }): Promise<MemoryWindowClaim | undefined>;
  complete(input: {
    readonly conversationId: string;
    readonly leaseOwner: string;
    readonly runId: string;
    readonly digestedThrough: { readonly at: string; readonly id: string };
    readonly result: AppliedMemorySummary;
    readonly completedAt?: string;
  }): Promise<void>;
  fail(input: {
    readonly conversationId: string;
    readonly leaseOwner: string;
    readonly runId: string;
    readonly error: string;
    readonly completedAt?: string;
  }): Promise<void>;
}

export interface MemoryService {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(now?: string): Promise<{
    readonly outcome: "idle" | "done" | "failed";
    readonly runId?: string;
  }>;
}
