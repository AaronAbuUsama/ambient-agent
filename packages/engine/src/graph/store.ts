import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The shared graph — a derived-meaning layer above the Conversation Archive and
 * GitHub (MEMORY-STATE-SPEC §3). Three STRICT tables in `application.sqlite`, kept
 * generic on purpose: the eleven entity types and eleven relation types are enforced
 * at the tool boundary (valibot), while the database enforces only what a database is
 * good at — the type/relation/platform enums, primary keys, foreign keys, and the
 * `(from,relation,to)` uniqueness that makes an edge one fact.
 *
 * Type-prefixed ids (`person_1f3a9c`) because these ids surface in prompts and a
 * prefix stops the model mis-wiring an edge.
 */

export type GraphEntityType =
  | "person"
  | "agent"
  | "thread"
  | "topic"
  | "commitment"
  | "repository"
  | "issue"
  | "pull_request"
  | "project"
  | "milestone"
  | "goal";

export type GraphRelationType =
  | "participates_in"
  | "interested_in"
  | "discusses"
  | "mentions"
  | "works_on"
  | "made_by"
  | "about"
  | "resolves"
  | "part_of"
  | "blocks"
  | "advances";

export type GraphPlatform = "whatsapp" | "github";

export interface GraphProvenance {
  readonly chatId?: string;
  readonly messageId?: string;
  readonly deliveryId?: string;
}

export interface GraphIdentityRef {
  readonly platform: GraphPlatform;
  readonly externalId: string;
  readonly displayName?: string;
}

export interface GraphEntity {
  readonly entityId: string;
  readonly type: GraphEntityType;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence: number;
  readonly provenance: GraphProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GraphRelation {
  readonly relationId: string;
  readonly fromId: string;
  readonly relation: GraphRelationType;
  readonly toId: string;
  readonly confidence: number;
  readonly provenance: GraphProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityUpsert {
  readonly type: GraphEntityType;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly provenance?: GraphProvenance;
  /** Keyed types converge here: `(platform, externalId) → entityId` is one owner per external id. */
  readonly identity?: GraphIdentityRef;
  /** Keyless update targeting: when present and found, that node is updated instead of a new one inserted. */
  readonly id?: string;
}

export interface RelationUpsert {
  readonly fromId: string;
  readonly relation: GraphRelationType;
  readonly toId: string;
  readonly confidence?: number;
  readonly provenance?: GraphProvenance;
}

export interface EntityQuery {
  readonly type?: GraphEntityType;
  readonly query?: string;
  readonly limit?: number;
}

export interface GraphStore {
  /** Upsert an entity. Keyed entities converge via `graph_identities`; restating raises confidence. */
  upsertEntity(input: EntityUpsert): GraphEntity;
  /** Upsert an edge on `UNIQUE(from,relation,to)`; restating raises confidence. */
  upsertRelation(input: RelationUpsert): GraphRelation;
  /** Repoint every edge and identity from loser to survivor, then delete the loser. */
  mergeEntities(survivorId: string, loserId: string): void;
  getEntity(entityId: string): GraphEntity | undefined;
  resolveIdentity(platform: GraphPlatform, externalId: string): GraphEntity | undefined;
  relationsFrom(fromId: string, relation?: GraphRelationType): readonly GraphRelation[];
  relationsTo(toId: string, relation?: GraphRelationType): readonly GraphRelation[];
  findEntities(query: EntityQuery): readonly GraphEntity[];
  /** True when `toId` is reachable from `fromId` by following `blocks` edges. */
  blocksReachable(fromId: string, toId: string): boolean;
  close(): void;
}

interface EntityRow {
  entity_id: string;
  type: GraphEntityType;
  properties_json: string;
  confidence: number;
  source_chat_id: string | null;
  source_message_id: string | null;
  source_delivery_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  relation_id: string;
  from_id: string;
  relation: GraphRelationType;
  to_id: string;
  confidence: number;
  source_chat_id: string | null;
  source_message_id: string | null;
  source_delivery_id: string | null;
  created_at: string;
  updated_at: string;
}

const TYPE_LIST =
  "'person','agent','thread','topic','commitment','repository','issue','pull_request','project','milestone','goal'";
const RELATION_LIST =
  "'participates_in','interested_in','discusses','mentions','works_on','made_by','about','resolves','part_of','blocks','advances'";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS graph_entities (
    entity_id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (${TYPE_LIST})),
    properties_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graph_relations (
    relation_id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    relation TEXT NOT NULL CHECK (relation IN (${RELATION_LIST})),
    to_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (from_id, relation, to_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS graph_relations_to_idx ON graph_relations(to_id, relation);
  CREATE INDEX IF NOT EXISTS graph_relations_from_idx ON graph_relations(from_id, relation);
  CREATE TABLE IF NOT EXISTS graph_identities (
    platform TEXT NOT NULL CHECK (platform IN ('whatsapp','github')),
    external_id TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
    display_name TEXT,
    PRIMARY KEY (platform, external_id)
  ) STRICT;
`;

/** Two independent observations agreeing raise certainty (noisy-OR): c' = 1 - (1-a)(1-b). */
const combineConfidence = (existing: number, observed: number): number => 1 - (1 - existing) * (1 - observed);

const shortId = (type: string): string => `${type}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;

const stripUndefined = (properties: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));

const decodeProvenance = (
  row: Pick<EntityRow, "source_chat_id" | "source_message_id" | "source_delivery_id">,
): GraphProvenance => ({
  ...(row.source_chat_id === null ? {} : { chatId: row.source_chat_id }),
  ...(row.source_message_id === null ? {} : { messageId: row.source_message_id }),
  ...(row.source_delivery_id === null ? {} : { deliveryId: row.source_delivery_id }),
});

const decodeEntity = (row: EntityRow): GraphEntity => ({
  entityId: row.entity_id,
  type: row.type,
  properties: JSON.parse(row.properties_json) as Record<string, unknown>,
  confidence: row.confidence,
  provenance: decodeProvenance(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeRelation = (row: RelationRow): GraphRelation => ({
  relationId: row.relation_id,
  fromId: row.from_id,
  relation: row.relation,
  toId: row.to_id,
  confidence: row.confidence,
  provenance: decodeProvenance(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface GraphStoreOptions {
  readonly now?: () => Date;
}

export const createGraphStore = (databasePath: string, options: GraphStoreOptions = {}): GraphStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const now = options.now ?? (() => new Date());
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(SCHEMA);

  const selectEntity = database.prepare("SELECT * FROM graph_entities WHERE entity_id = ?");
  const selectIdentity = database.prepare(
    "SELECT entity_id FROM graph_identities WHERE platform = ? AND external_id = ?",
  );
  const selectRelation = database.prepare(
    "SELECT * FROM graph_relations WHERE from_id = ? AND relation = ? AND to_id = ?",
  );

  const transaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };

  const getEntity = (entityId: string): GraphEntity | undefined => {
    const row = selectEntity.get(entityId) as unknown as EntityRow | undefined;
    return row === undefined ? undefined : decodeEntity(row);
  };

  const resolveIdentityId = (platform: GraphPlatform, externalId: string): string | undefined =>
    (selectIdentity.get(platform, externalId) as unknown as { entity_id: string } | undefined)?.entity_id;

  const upsertEntity: GraphStore["upsertEntity"] = (input) =>
    transaction(() => {
      const timestamp = now().toISOString();
      const observed = input.confidence ?? 1;
      const properties = stripUndefined(input.properties);
      const provenance = input.provenance ?? {};
      const existingId =
        input.identity !== undefined
          ? resolveIdentityId(input.identity.platform, input.identity.externalId)
          : input.id !== undefined && getEntity(input.id) !== undefined
            ? input.id
            : undefined;

      if (existingId !== undefined) {
        const existing = getEntity(existingId)!;
        const merged = { ...existing.properties, ...properties };
        database
          .prepare(
            `UPDATE graph_entities
                SET properties_json = ?, confidence = ?, source_chat_id = ?, source_message_id = ?,
                    source_delivery_id = ?, updated_at = ?
              WHERE entity_id = ?`,
          )
          .run(
            JSON.stringify(merged),
            combineConfidence(existing.confidence, observed),
            provenance.chatId ?? null,
            provenance.messageId ?? null,
            provenance.deliveryId ?? null,
            timestamp,
            existingId,
          );
        if (input.identity?.displayName !== undefined) {
          database
            .prepare("UPDATE graph_identities SET display_name = ? WHERE platform = ? AND external_id = ?")
            .run(input.identity.displayName, input.identity.platform, input.identity.externalId);
        }
        return getEntity(existingId)!;
      }

      const entityId = input.id ?? shortId(input.type);
      database
        .prepare(
          `INSERT INTO graph_entities
             (entity_id, type, properties_json, confidence, source_chat_id, source_message_id, source_delivery_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entityId,
          input.type,
          JSON.stringify(properties),
          observed,
          provenance.chatId ?? null,
          provenance.messageId ?? null,
          provenance.deliveryId ?? null,
          timestamp,
          timestamp,
        );
      if (input.identity !== undefined) {
        database
          .prepare("INSERT INTO graph_identities (platform, external_id, entity_id, display_name) VALUES (?, ?, ?, ?)")
          .run(input.identity.platform, input.identity.externalId, entityId, input.identity.displayName ?? null);
      }
      return getEntity(entityId)!;
    });

  const upsertRelation: GraphStore["upsertRelation"] = (input) =>
    transaction(() => {
      const timestamp = now().toISOString();
      const observed = input.confidence ?? 1;
      const provenance = input.provenance ?? {};
      const existing = selectRelation.get(input.fromId, input.relation, input.toId) as unknown as RelationRow | undefined;
      if (existing !== undefined) {
        database
          .prepare(
            `UPDATE graph_relations
                SET confidence = ?, source_chat_id = ?, source_message_id = ?, source_delivery_id = ?, updated_at = ?
              WHERE relation_id = ?`,
          )
          .run(
            combineConfidence(existing.confidence, observed),
            provenance.chatId ?? null,
            provenance.messageId ?? null,
            provenance.deliveryId ?? null,
            timestamp,
            existing.relation_id,
          );
        return decodeRelation(selectRelation.get(input.fromId, input.relation, input.toId) as unknown as RelationRow);
      }
      const relationId = shortId("rel");
      database
        .prepare(
          `INSERT INTO graph_relations
             (relation_id, from_id, relation, to_id, confidence, source_chat_id, source_message_id,
              source_delivery_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relationId,
          input.fromId,
          input.relation,
          input.toId,
          observed,
          provenance.chatId ?? null,
          provenance.messageId ?? null,
          provenance.deliveryId ?? null,
          timestamp,
          timestamp,
        );
      return decodeRelation(selectRelation.get(input.fromId, input.relation, input.toId) as unknown as RelationRow);
    });

  const mergeEntities: GraphStore["mergeEntities"] = (survivorId, loserId) => {
    if (survivorId === loserId) throw new Error("Cannot merge an entity into itself.");
    transaction(() => {
      if (getEntity(survivorId) === undefined) throw new Error(`Survivor entity ${survivorId} does not exist.`);
      if (getEntity(loserId) === undefined) throw new Error(`Loser entity ${loserId} does not exist.`);
      // OR REPLACE folds a repointed edge onto the survivor's existing identical fact.
      database.prepare("UPDATE OR REPLACE graph_relations SET from_id = ? WHERE from_id = ?").run(survivorId, loserId);
      database.prepare("UPDATE OR REPLACE graph_relations SET to_id = ? WHERE to_id = ?").run(survivorId, loserId);
      database.prepare("DELETE FROM graph_relations WHERE from_id = ? AND to_id = ?").run(survivorId, survivorId);
      database.prepare("UPDATE graph_identities SET entity_id = ? WHERE entity_id = ?").run(survivorId, loserId);
      database.prepare("DELETE FROM graph_entities WHERE entity_id = ?").run(loserId);
    });
  };

  const relationsFrom: GraphStore["relationsFrom"] = (fromId, relation) => {
    const rows = (
      relation === undefined
        ? database.prepare("SELECT * FROM graph_relations WHERE from_id = ?").all(fromId)
        : database.prepare("SELECT * FROM graph_relations WHERE from_id = ? AND relation = ?").all(fromId, relation)
    ) as unknown as RelationRow[];
    return rows.map(decodeRelation);
  };

  const relationsTo: GraphStore["relationsTo"] = (toId, relation) => {
    const rows = (
      relation === undefined
        ? database.prepare("SELECT * FROM graph_relations WHERE to_id = ?").all(toId)
        : database.prepare("SELECT * FROM graph_relations WHERE to_id = ? AND relation = ?").all(toId, relation)
    ) as unknown as RelationRow[];
    return rows.map(decodeRelation);
  };

  const findEntities: GraphStore["findEntities"] = ({ type, query, limit = 20 }) => {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (type !== undefined) {
      clauses.push("type = ?");
      parameters.push(type);
    }
    if (query !== undefined && query.trim().length > 0) {
      clauses.push("properties_json LIKE ? ESCAPE '\\'");
      parameters.push(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = database
      .prepare(`SELECT * FROM graph_entities ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(parameters as never[]), Math.max(1, Math.min(limit, 100))) as unknown as EntityRow[];
    return rows.map(decodeEntity);
  };

  const blocksReachable: GraphStore["blocksReachable"] = (fromId, toId) => {
    const visited = new Set<string>();
    const stack = [fromId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === toId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of relationsFrom(current, "blocks")) stack.push(edge.toId);
    }
    return false;
  };

  return {
    upsertEntity,
    upsertRelation,
    mergeEntities,
    getEntity,
    resolveIdentity: (platform, externalId) => {
      const id = resolveIdentityId(platform, externalId);
      return id === undefined ? undefined : getEntity(id);
    },
    relationsFrom,
    relationsTo,
    findEntities,
    blocksReachable,
    close: () => database.close(),
  };
};
