import { messageOf } from "../platform/errors";
import type {
  AppliedMemorySummary,
  MemoryAgent,
  MemoryInput,
  MemoryProposal,
  MemoryService,
  MemoryTools,
  MemoryWindowClaim,
  MemoryWorkStore,
} from "./contract";

/** The ontology writer the service needs; satisfied by the memory repository. */
export interface MemoryOntologyWriter {
  putEntity(input: {
    readonly id: string;
    readonly kind: string;
    readonly canonicalName: string;
  }): Promise<void>;
  putPredicate(input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly valueSchema: unknown;
  }): Promise<void>;
  linkIdentity(input: {
    readonly entityId: string;
    readonly namespace: string;
    readonly nativeId: string;
  }): Promise<void>;
  /** The current claim for one (entity, predicate), regardless of identity links. */
  currentClaim(input: {
    readonly entityId: string;
    readonly predicateId: string;
  }): Promise<
    { readonly claimId: string; readonly version: number; readonly value: unknown } | undefined
  >;
  applyPatch(input: {
    readonly id?: string;
    readonly runId: string;
    readonly source: unknown;
    readonly operations: readonly unknown[];
  }): Promise<{ readonly id: string; readonly status: "applied"; readonly appliedAt: string }>;
  getPatch(id: string): Promise<{ readonly status: string } | undefined>;
}

export interface MemoryServiceOptions {
  readonly work: MemoryWorkStore;
  readonly agent: MemoryAgent & { readonly promptVersion?: string };
  readonly ontology: MemoryOntologyWriter;
  readonly maximumClaimsPerJob?: number;
  /** Rejected proposals allowed before the run is cut off. */
  readonly maximumProposalAttempts?: number;
  /** Full-window size; a backlog this large is due immediately. */
  readonly window?: number;
  /** Backlog younger than this keeps coalescing; older backlog is due. */
  readonly quietMs?: number;
  /** Consecutive failed windows after which a chat is parked. */
  readonly maximumAttempts?: number;
  readonly leaseOwner?: string;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  /**
   * Narrates a completed window to the daemon's voice. The service knows the
   * conversation id; rendering it as a chat slug belongs to composition.
   */
  readonly narrateDigest?: (conversationId: string, claims: number) => void;
}

class ProposalValidationError extends Error {}

function validate(input: MemoryInput, proposal: MemoryProposal, maximumClaims: number): void {
  const batchIds = new Set(input.messages.map(({ observationId }) => observationId));
  // Linkable identities: real senders, their other native id form, and real
  // mentioned ids. A chat/group id is never a person; linking one poisons
  // every recall through it.
  const batchSenders = new Set(
    input.messages.flatMap((message) => [
      ...(message.senderId === undefined ? [] : [message.senderId]),
      ...(message.senderAltId === undefined ? [] : [message.senderAltId]),
      ...(message.mentions ?? []),
    ]),
  );
  const entityRefs = new Set(proposal.entities.map(({ ref }) => ref));
  const knownEntities = new Set(input.entities.map(({ id }) => id));
  const predicateRefs = new Set(proposal.predicates.map(({ ref }) => ref));
  const knownPredicates = new Set(input.predicates.map(({ id }) => id));
  const knownClaims = new Map(input.claims.map((claim) => [claim.claimId, claim]));

  if (proposal.claims.length > maximumClaims) {
    throw new ProposalValidationError(
      `proposal exceeds ${maximumClaims} claims (${proposal.claims.length})`,
    );
  }
  for (const entity of proposal.entities) {
    for (const nativeId of entity.nativeIds) {
      if (nativeId.endsWith("@g.us") || nativeId === input.conversationId) {
        throw new ProposalValidationError(
          `proposed entity "${entity.ref}" links a chat id as an identity`,
        );
      }
      if (!batchSenders.has(nativeId)) {
        throw new ProposalValidationError(
          `proposed entity "${entity.ref}" links a native id absent from the batch`,
        );
      }
    }
  }
  for (const [index, claim] of proposal.claims.entries()) {
    if (!entityRefs.has(claim.entity) && !knownEntities.has(claim.entity)) {
      throw new ProposalValidationError(
        `claim ${index} references unknown entity "${claim.entity}"`,
      );
    }
    if (!predicateRefs.has(claim.predicate) && !knownPredicates.has(claim.predicate)) {
      throw new ProposalValidationError(
        `claim ${index} references unknown predicate "${claim.predicate}"`,
      );
    }
    for (const evidenceId of claim.evidenceObservationIds) {
      if (!batchIds.has(evidenceId)) {
        throw new ProposalValidationError(`claim ${index} cites evidence outside the batch`);
      }
    }
    // A claim value is durable content that recall reads back. A run-local
    // symbol the adapter could not resolve would dangle forever, and a raw
    // subscriber number or WhatsApp id in recall text is the same poison the
    // identity ban exists for — "Participant 4477…" is not a person's name.
    const valueText = JSON.stringify(claim.value) ?? "";
    if (
      /@(?:g\.us|s\.whatsapp\.net|lid|broadcast)/.test(valueText) ||
      /\d{7,}/.test(valueText) ||
      (typeof claim.value === "string" && /^[EPC]\d+$|^m\d+$/.test(claim.value))
    ) {
      throw new ProposalValidationError(
        `claim ${index} value must name people and things in words, not ids or symbols`,
      );
    }
    if (claim.supersedes) {
      const existing = knownClaims.get(claim.supersedes.claimId);
      if (!existing || existing.version !== claim.supersedes.version) {
        throw new ProposalValidationError(
          `claim ${index} supersedes an unknown claim or stale version`,
        );
      }
    }
  }
}

/**
 * The deterministic memory runner: claims one durable job, invokes the Memory
 * Agent once, validates the proposal against the batch, applies it through the
 * patch machinery, and terminalizes job + run + evaluation signal atomically.
 */
export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const leaseOwner = options.leaseOwner ?? `memory-service:${crypto.randomUUID()}`;
  const leaseMs = options.leaseMs ?? 300_000;
  const pollMs = options.pollMs ?? 15_000;
  const maximumClaims = options.maximumClaimsPerJob ?? 50;
  const maximumProposalAttempts = options.maximumProposalAttempts ?? 3;
  const window = options.window ?? 40;
  const quietMs = options.quietMs ?? 300_000;
  const maximumAttempts = options.maximumAttempts ?? 3;
  const promptVersion = options.agent.promptVersion ?? "memory-v1";

  const apply = async (
    claim: MemoryWindowClaim,
    proposal: MemoryProposal,
  ): Promise<AppliedMemorySummary> => {
    validate(claim.input, proposal, maximumClaims);

    // Resolve proposed entities, reusing any existing entity that already owns
    // one of the proposed native ids — or, for identity-less entities like
    // issues, one that already carries the same kind and name.
    const byNativeId = new Map(
      claim.input.entities.flatMap((entity) =>
        entity.nativeIds.map((nativeId) => [nativeId, entity.id] as const),
      ),
    );
    const byKindAndName = new Map(
      claim.input.entities.map(
        (entity) =>
          [`${entity.kind} ${entity.canonicalName.toLocaleLowerCase()}`, entity.id] as const,
      ),
    );
    const entityIds = new Map<string, string>();
    const entityNames = new Map<string, string>();
    for (const entity of claim.input.entities) {
      entityIds.set(entity.id, entity.id);
      entityNames.set(entity.id, entity.canonicalName);
    }
    let entitiesCreated = 0;
    const linkedNativeIds: string[] = [];
    for (const entity of proposal.entities) {
      const existing =
        entity.nativeIds.map((id) => byNativeId.get(id)).find(Boolean) ??
        byKindAndName.get(`${entity.kind} ${entity.canonicalName.toLocaleLowerCase()}`);
      let entityId = existing;
      if (!entityId) {
        entityId = crypto.randomUUID();
        await options.ontology.putEntity({
          id: entityId,
          kind: entity.kind,
          canonicalName: entity.canonicalName,
        });
        entitiesCreated += 1;
      }
      entityIds.set(entity.ref, entityId);
      entityNames.set(entity.ref, entity.canonicalName);
      entityNames.set(entityId, entityNames.get(entityId) ?? entity.canonicalName);
      for (const nativeId of entity.nativeIds) {
        await options.ontology.linkIdentity({ entityId, namespace: "whatsapp", nativeId });
        linkedNativeIds.push(nativeId);
      }
    }

    const predicateIds = new Map<string, string>();
    const predicateNames = new Map<string, string>();
    for (const predicate of claim.input.predicates) {
      predicateIds.set(predicate.id, predicate.id);
      predicateNames.set(predicate.id, predicate.name);
    }
    const byPredicateName = new Map(claim.input.predicates.map((p) => [p.name, p.id]));
    for (const predicate of proposal.predicates) {
      const existing = byPredicateName.get(predicate.name);
      let predicateId = existing;
      if (!predicateId) {
        predicateId = crypto.randomUUID();
        await options.ontology.putPredicate({
          id: predicateId,
          name: predicate.name,
          description: predicate.description,
          valueSchema: {},
        });
      }
      predicateIds.set(predicate.ref, predicateId);
      predicateNames.set(predicate.ref, predicate.name);
      predicateNames.set(predicateId, predicate.name);
    }

    // One current claim per (entity, predicate) is a HOST invariant, not
    // model behaviour: a duplicate create becomes a reinforcement (same
    // value) or a supersession (new value), and a model-declared supersede
    // retargets the freshest claim this patch already produced. Without this,
    // any restated fact across digest windows violates the claims unique key.
    type PatchOperation =
      | {
          operation: "create";
          claimId: string;
          entityId: string;
          predicateId: string;
          value: unknown;
          confidence: string;
          evidenceObservationIds: readonly string[];
        }
      | {
          operation: "reinforce";
          claimId: string;
          expectedVersion: number;
          evidenceObservationIds: readonly string[];
        }
      | {
          operation: "supersede";
          claimId: string;
          supersedesClaimId: string;
          expectedVersion: number;
          value: unknown;
          confidence: string;
          evidenceObservationIds: readonly string[];
        };
    const appliedClaims: AppliedMemorySummary["claims"][number][] = [];
    const operations: PatchOperation[] = [];
    const inPatch = new Map<string, { claimId: string; version: number; value: unknown }>();
    for (const proposed of proposal.claims) {
      const entityId = entityIds.get(proposed.entity);
      const predicateId = predicateIds.get(proposed.predicate);
      if (!entityId || !predicateId) {
        throw new ProposalValidationError("claim references an unresolved entity or predicate");
      }
      const key = `${entityId} ${predicateId}`;
      const claimId = crypto.randomUUID();
      const shared = {
        value: proposed.value,
        confidence: proposed.confidence,
        evidenceObservationIds: proposed.evidenceObservationIds,
      };
      const target =
        inPatch.get(key) ??
        (proposed.supersedes
          ? { claimId: proposed.supersedes.claimId, version: proposed.supersedes.version }
          : await options.ontology.currentClaim({ entityId, predicateId }));
      let effectiveClaimId: string = claimId;
      if (!target) {
        operations.push({ operation: "create", claimId, entityId, predicateId, ...shared });
        inPatch.set(key, { claimId, version: 1, value: proposed.value });
      } else if (
        "value" in target &&
        JSON.stringify(target.value) === JSON.stringify(proposed.value)
      ) {
        operations.push({
          operation: "reinforce",
          claimId: target.claimId,
          expectedVersion: target.version,
          evidenceObservationIds: proposed.evidenceObservationIds,
        });
        effectiveClaimId = target.claimId;
      } else {
        operations.push({
          operation: "supersede",
          claimId,
          supersedesClaimId: target.claimId,
          expectedVersion: target.version,
          ...shared,
        });
        inPatch.set(key, { claimId, version: target.version + 1, value: proposed.value });
      }
      appliedClaims.push({
        claimId: effectiveClaimId,
        entityName: entityNames.get(proposed.entity) ?? proposed.entity,
        predicateName: predicateNames.get(proposed.predicate) ?? proposed.predicate,
        value: proposed.value,
        confidence: proposed.confidence,
        evidenceObservationIds: proposed.evidenceObservationIds,
      });
    }

    if (operations.length > 0) {
      await options.ontology.applyPatch({
        id: claim.patchId,
        runId: claim.runId,
        source: { conversationId: claim.conversationId, window: claim.patchId },
        operations,
      });
    }

    return {
      report: proposal.report,
      entitiesCreated,
      linkedNativeIds,
      claims: appliedClaims,
      patchStatus: operations.length > 0 ? "applied" : "empty",
    };
  };

  /**
   * One bounded agent run over one claimed batch. The propose_facts tool
   * validates AND applies host-side: a rejected proposal returns to the model
   * as a tool error it may correct in-loop; a model that cannot produce a
   * valid proposal is cut off after a few attempts rather than left to spend
   * the lease. An agent that never proposes chose silence — an empty digest.
   */
  const digest = async (claim: MemoryWindowClaim): Promise<AppliedMemorySummary> => {
    let applied: AppliedMemorySummary | undefined;
    let lastRejection: string | undefined;
    let rejections = 0;
    const controller = new AbortController();
    const tools: MemoryTools = {
      async proposeFacts(proposal) {
        if (applied) {
          throw new Error("propose_facts already applied a proposal in this run");
        }
        try {
          applied = await apply(claim, proposal);
          return applied;
        } catch (error) {
          if (error instanceof ProposalValidationError) {
            rejections += 1;
            lastRejection = error.message;
            if (rejections >= maximumProposalAttempts) controller.abort();
          }
          throw error;
        }
      },
    };
    const result = await options.agent.run(claim.input, tools, controller.signal);
    if (applied) return applied;
    if (lastRejection !== undefined) throw new ProposalValidationError(lastRejection);
    return {
      report: result.report,
      entitiesCreated: 0,
      linkedNativeIds: [],
      claims: [],
      patchStatus: "empty",
    };
  };

  const runOnce = async (
    at?: string,
  ): Promise<{ readonly outcome: "idle" | "done" | "failed"; readonly runId?: string }> => {
    const claim = await options.work.claimNext({
      leaseOwner,
      leaseMs,
      model: options.agent.model,
      promptVersion,
      window,
      quietMs,
      maximumAttempts,
      ...(at === undefined ? {} : { now: at }),
    });
    if (!claim) return { outcome: "idle" };
    try {
      // Crash recovery: a previous attempt may have applied this window's
      // patch and died before completing; the deterministic window key means
      // even a later re-claim recovers instead of digesting twice.
      const previous = await options.ontology.getPatch(claim.patchId);
      const summary =
        previous?.status === "applied"
          ? ({
              report: "Recovered: this window's patch was already applied by a previous attempt.",
              entitiesCreated: 0,
              linkedNativeIds: [],
              claims: [],
              patchStatus: "applied",
            } satisfies AppliedMemorySummary)
          : await digest(claim);
      await options.work.complete({
        conversationId: claim.conversationId,
        leaseOwner,
        runId: claim.runId,
        digestedThrough: claim.digestedThrough,
        result: summary,
      });
      options.narrateDigest?.(claim.conversationId, summary.claims.length);
      return { outcome: "done", runId: claim.runId };
    } catch (error) {
      await options.work
        .fail({
          conversationId: claim.conversationId,
          leaseOwner,
          runId: claim.runId,
          error: messageOf(error),
        })
        .catch(() => {});
      return { outcome: "failed", runId: claim.runId };
    }
  };

  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (active) {
      try {
        if ((await runOnce()).outcome === "idle") return;
      } catch {
        return;
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    draining ??= drain().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await scheduleDrain();
      timer = setInterval(() => void scheduleDrain(), pollMs);
      timer.unref?.();
    },

    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await draining;
    },

    runOnce,
  };
}
