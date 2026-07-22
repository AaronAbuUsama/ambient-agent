import * as v from "valibot";

import type { GraphEntity, GraphEntityType, GraphRelationType, GraphStore } from "./store.ts";

/**
 * State injection — the read side (MEMORY-STATE-SPEC §5). `computeGraphDigest` is
 * plain deterministic code: a one-hop edge walk seeded from keys already in the
 * window, resolved through `graph_identities`. No model round-trip, no cache — it is
 * recomputed live at the `dispatchSpeaker` funnel every window, so a fact another
 * thread's Scribe wrote seconds ago is visible this turn. That staleness is the
 * cross-thread-memory feature.
 *
 * The type + schema live here in the engine so `inputs.ts` can carry the digest as a
 * flat `graphContext?` field on every input-union member; the thin
 * `buildGraphDigest(seeds)` that reads `getGraphStore()` (and the three consumers —
 * Speaker funnel, Coder/Reviewer/Planner Specialists) sits in the graph capability.
 */

/** A seed identity present in the window — a WhatsApp jid, a GitHub login, or an `owner/repo[#n]`. */
export interface DigestIdentitySeed {
  readonly platform: "whatsapp" | "github";
  readonly externalId: string;
}

export interface DigestSeeds {
  /** The thread's chat id, resolved to its Thread entity via `(whatsapp, chatId)`. */
  readonly chatId?: string;
  /** Participants + GitHub objects in view, resolved via `graph_identities`. */
  readonly identities: readonly DigestIdentitySeed[];
}

const digestEntitySchema = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  lowConfidence: v.boolean(),
});
const digestRelationSchema = v.object({
  fromId: v.string(),
  relation: v.string(),
  toId: v.string(),
  confidence: v.number(),
  lowConfidence: v.boolean(),
});
const digestCommitmentSchema = v.object({
  entityId: v.string(),
  type: v.string(),
  properties: v.record(v.string(), v.unknown()),
  confidence: v.number(),
  lowConfidence: v.boolean(),
  overdue: v.boolean(),
});

/** The pushed digest — one shape, shared by the Speaker input and the Specialist job input. */
export const graphDigestSchema = v.object({
  seeds: v.array(v.string()),
  entities: v.array(digestEntitySchema),
  relations: v.array(digestRelationSchema),
  commitments: v.array(digestCommitmentSchema),
});

export type GraphDigest = v.InferOutput<typeof graphDigestSchema>;
export type DigestEntity = v.InferOutput<typeof digestEntitySchema>;
export type DigestRelation = v.InferOutput<typeof digestRelationSchema>;
export type DigestCommitment = v.InferOutput<typeof digestCommitmentSchema>;

export interface DigestOptions {
  readonly now?: () => Date;
  /**
   * Facts at or below this confidence are flagged for the Speaker to confirm (§5 D5).
   * ponytail: a single default threshold; θ is prompt/eval-tuned, not settled here.
   */
  readonly lowConfidenceThreshold?: number;
}

const DEFAULT_LOW_CONFIDENCE = 0.75;

/** Roll-up edges followed for one extra hop off GitHub work-in-view (§5 D3, "secondary hops"). */
const SECONDARY_HOPS: readonly GraphRelationType[] = ["resolves", "part_of", "advances"];
const SECONDARY_HOP_TYPES: ReadonlySet<GraphEntityType> = new Set(["issue", "pull_request", "milestone"]);

const isOverdue = (due: unknown, nowMs: number): boolean => {
  if (typeof due !== "string") return false;
  const dueMs = Date.parse(due);
  // ponytail: only flags ISO-ish parseable dues; free-text dues never flag overdue.
  return !Number.isNaN(dueMs) && dueMs < nowMs;
};

export const computeGraphDigest = (store: GraphStore, seeds: DigestSeeds, options: DigestOptions = {}): GraphDigest => {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const threshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE;
  const low = (confidence: number): boolean => confidence <= threshold;

  // 1. Resolve seed keys → entity ids through graph_identities.
  const seedIds = new Set<string>();
  if (seeds.chatId !== undefined) {
    const thread = store.resolveIdentity("whatsapp", seeds.chatId, "thread");
    if (thread !== undefined) seedIds.add(thread.entityId);
  }
  for (const seed of seeds.identities) {
    const entity = store.resolveIdentity(seed.platform, seed.externalId);
    if (entity !== undefined) seedIds.add(entity.entityId);
  }

  // 2. One-hop walk out of every seed (both directions), collecting neighbours + edges.
  const entities = new Map<string, GraphEntity>();
  const relations = new Map<string, DigestRelation>();
  const remember = (entity: GraphEntity | undefined): void => {
    if (entity !== undefined && !entities.has(entity.entityId)) entities.set(entity.entityId, entity);
  };
  const edgeKey = (fromId: string, relation: string, toId: string): string => `${fromId}\u0000${relation}\u0000${toId}`;
  const record = (fromId: string, relation: GraphRelationType, toId: string, confidence: number): void => {
    relations.set(edgeKey(fromId, relation, toId), {
      fromId,
      relation,
      toId,
      confidence,
      lowConfidence: low(confidence),
    });
  };

  for (const seedId of seedIds) remember(store.getEntity(seedId));
  for (const seedId of seedIds) {
    for (const edge of store.relationsFrom(seedId)) {
      record(edge.fromId, edge.relation, edge.toId, edge.confidence);
      remember(store.getEntity(edge.toId));
    }
    for (const edge of store.relationsTo(seedId)) {
      record(edge.fromId, edge.relation, edge.toId, edge.confidence);
      remember(store.getEntity(edge.fromId));
    }
  }

  // 3. Secondary hop: roll-ups off the GitHub work-in-view discovered above. Snapshot
  //    first so newly-remembered roll-up nodes are not themselves re-walked.
  for (const entity of Array.from(entities.values())) {
    if (!SECONDARY_HOP_TYPES.has(entity.type)) continue;
    for (const relation of SECONDARY_HOPS) {
      for (const edge of store.relationsFrom(entity.entityId, relation)) {
        record(edge.fromId, edge.relation, edge.toId, edge.confidence);
        remember(store.getEntity(edge.toId));
      }
    }
  }

  // 4. Split open Commitments out of the flat neighbourhood; flag overdue ones.
  const commitments: DigestCommitment[] = [];
  const plainEntities: DigestEntity[] = [];
  for (const entity of entities.values()) {
    if (entity.type === "commitment") {
      if (entity.properties.status !== "open") continue;
      commitments.push({
        entityId: entity.entityId,
        type: entity.type,
        properties: entity.properties,
        confidence: entity.confidence,
        lowConfidence: low(entity.confidence),
        overdue: isOverdue(entity.properties.due, nowMs),
      });
      continue;
    }
    plainEntities.push({
      entityId: entity.entityId,
      type: entity.type,
      properties: entity.properties,
      confidence: entity.confidence,
      lowConfidence: low(entity.confidence),
    });
  }

  return { seeds: [...seedIds], entities: plainEntities, relations: [...relations.values()], commitments };
};

/** True when a digest carries nothing worth spending a transcript turn on. */
export const isEmptyDigest = (digest: GraphDigest): boolean =>
  digest.entities.length === 0 && digest.relations.length === 0 && digest.commitments.length === 0;
