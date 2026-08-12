import type { ModelConfig } from "../models/contract";

/**
 * The Memory Agent is a bounded evidence analyst: it receives one batch of
 * retained messages plus the current ontology view and proposes changes. It
 * never writes anything itself — the host validates every proposal and applies
 * it through the existing patch machinery, so an invalid proposal fails the
 * job without touching the ontology.
 */

/** One retained message given to the Memory Agent as evidence. */
export interface MemoryMessage {
  readonly observationId: string;
  readonly senderId: string;
  readonly fromMe: boolean;
  readonly sentAt: string;
  readonly text: string;
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

export interface MemoryAgent {
  readonly model: ModelConfig;
  propose(input: MemoryInput, signal?: AbortSignal): Promise<MemoryProposal>;
}

/** What one claimed job carries into a run. */
export interface MemoryJobClaim {
  readonly jobId: string;
  readonly conversationId: string;
  readonly input: MemoryInput;
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
 * The one authoritative mutation path for durable memory jobs. Completion
 * finishes the memory agent run, terminalizes the job, and writes the durable
 * evaluation signal in a single transaction; an expired lease reopens an
 * abandoned job.
 */
export interface MemoryJobStore {
  create(input: {
    readonly conversationId: string;
    readonly observationIds: readonly string[];
  }): Promise<{ readonly jobId: string }>;
  claimNext(input: {
    readonly leaseOwner: string;
    readonly leaseMs: number;
    readonly now?: string;
  }): Promise<MemoryJobClaim | undefined>;
  complete(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly runId: string;
    readonly result: AppliedMemorySummary;
    readonly completedAt?: string;
  }): Promise<void>;
  fail(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly runId?: string;
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
