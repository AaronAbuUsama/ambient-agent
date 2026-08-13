import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type {
  MemoryInput,
  MemoryOntologyClaim,
  MemoryWindowClaim,
  MemoryWorkStore,
} from "../memory/contract";
import { retainedMessagePayloadSchema } from "../whatsapp/message-payload";
import type { AmbientDatabaseConnection } from "./database";
import {
  agentRuns,
  claimEvidence,
  claims,
  conversationSpeakers,
  entities,
  evaluationPending,
  identityLinks,
  memorySchedule,
  observations,
  predicateDefinitions,
} from "./schema";

const confidenceSchema = z.enum(["low", "medium", "high", "confirmed"]);

type ObservationRow = typeof observations.$inferSelect;
type Transaction = Parameters<Parameters<AmbientDatabaseConnection["transaction"]>[0]>[0];

/**
 * Assemble one window's MemoryInput: the shaped messages plus the ontology
 * view. Quoted-reply recovery re-attributes historical rows whose author the
 * sync lost, when the batch itself proves it — nothing is ever guessed.
 * Entities without identity links (issues, repos) are visible through the
 * conversation their evidence came from; without this, later windows could
 * never reuse or supersede what earlier windows learned.
 */
async function buildInput(
  transaction: Transaction,
  conversationId: string,
  rows: readonly ObservationRow[],
): Promise<MemoryInput> {
  const parsed = rows.map((row) => ({
    row,
    payload: retainedMessagePayloadSchema.parse(row.payload),
  }));

  const authorByMessageId = new Map<string, string>();
  const observationByMessageId = new Map<string, string>();
  for (const { row, payload } of parsed) {
    if (payload.messageId) observationByMessageId.set(payload.messageId, row.id);
    const quoted = payload.context?.quoted;
    if (quoted?.id && quoted.from) authorByMessageId.set(quoted.id, quoted.from);
  }

  const messages = parsed.map(({ row, payload }) => {
    const recovered = payload.messageId ? authorByMessageId.get(payload.messageId) : undefined;
    const senderId = payload.sender?.id ?? recovered;
    const inReplyTo = payload.context?.quoted?.id
      ? observationByMessageId.get(payload.context.quoted.id)
      : undefined;
    const isMedia = payload.kind !== undefined && payload.kind !== "text";
    return {
      observationId: row.id,
      ...(senderId === undefined ? {} : { senderId }),
      fromMe: payload.fromMe ?? false,
      sentAt: row.occurredAt,
      text: payload.text ?? payload.media?.caption ?? "",
      ...(payload.context?.mentions?.length ? { mentions: payload.context.mentions } : {}),
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      ...(isMedia
        ? {
            attachment: {
              kind: payload.kind ?? "media",
              ...(payload.media?.caption ? { caption: payload.media.caption } : {}),
            },
          }
        : {}),
    };
  });

  const senders = [
    ...new Set(
      messages.flatMap((message) => [
        ...(message.senderId === undefined ? [] : [message.senderId]),
        ...(message.mentions ?? []),
      ]),
    ),
  ];
  const senderLinks = senders.length
    ? await transaction
        .select({ entityId: identityLinks.entityId })
        .from(identityLinks)
        .where(
          and(eq(identityLinks.namespace, "whatsapp"), inArray(identityLinks.nativeId, senders)),
        )
    : [];
  const conversationEntities = await transaction
    .selectDistinct({ entityId: claims.entityId })
    .from(claims)
    .innerJoin(claimEvidence, eq(claimEvidence.claimId, claims.id))
    .innerJoin(observations, eq(observations.id, claimEvidence.observationId))
    .where(eq(observations.conversationId, conversationId));
  const entityIds = [
    ...new Set([
      ...senderLinks.map(({ entityId }) => entityId),
      ...conversationEntities.map(({ entityId }) => entityId),
    ]),
  ];

  const entityRows = entityIds.length
    ? await transaction.select().from(entities).where(inArray(entities.id, entityIds))
    : [];
  const allLinks = entityIds.length
    ? await transaction
        .select()
        .from(identityLinks)
        .where(inArray(identityLinks.entityId, entityIds))
    : [];
  const linksByEntity = new Map<string, string[]>();
  for (const link of allLinks) {
    const list = linksByEntity.get(link.entityId) ?? [];
    list.push(link.nativeId);
    linksByEntity.set(link.entityId, list);
  }

  const successorClaims = alias(claims, "successor_claims");
  const claimRows = entityIds.length
    ? await transaction
        .select({
          id: claims.id,
          entityId: claims.entityId,
          value: claims.value,
          confidence: claims.confidence,
          version: claims.version,
          predicateName: predicateDefinitions.name,
        })
        .from(claims)
        .innerJoin(predicateDefinitions, eq(predicateDefinitions.id, claims.predicateId))
        .where(
          and(
            inArray(claims.entityId, entityIds),
            notExists(
              transaction
                .select({ id: successorClaims.id })
                .from(successorClaims)
                .where(
                  and(
                    eq(successorClaims.entityId, claims.entityId),
                    eq(successorClaims.predicateId, claims.predicateId),
                    gt(successorClaims.version, claims.version),
                  ),
                ),
            ),
          ),
        )
    : [];
  const currentClaims: MemoryOntologyClaim[] = claimRows.map((row) => ({
    claimId: row.id,
    entityId: row.entityId,
    predicateName: row.predicateName,
    value: row.value,
    confidence: confidenceSchema.parse(row.confidence),
    version: row.version,
  }));

  const predicateRows = await transaction.select().from(predicateDefinitions);

  return {
    conversationId,
    messages,
    entities: entityRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      canonicalName: row.canonicalName,
      nativeIds: linksByEntity.get(row.id) ?? [],
    })),
    predicates: predicateRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
    })),
    claims: currentClaims,
  };
}

export function createMemoryWorkStore(database: AmbientDatabaseConnection): MemoryWorkStore {
  const terminalize = async (
    input:
      | {
          readonly status: "succeeded";
          readonly conversationId: string;
          readonly leaseOwner: string;
          readonly runId: string;
          readonly digestedThrough: { readonly at: string; readonly id: string };
          readonly result: unknown;
          readonly completedAt?: string;
        }
      | {
          readonly status: "failed";
          readonly conversationId: string;
          readonly leaseOwner: string;
          readonly runId: string;
          readonly error: string;
          readonly completedAt?: string;
        },
  ): Promise<void> => {
    const completedAt = input.completedAt ?? new Date().toISOString();
    await database.transaction(async (transaction) => {
      const [schedule] = await transaction
        .update(memorySchedule)
        .set({
          ...(input.status === "succeeded"
            ? {
                digestedThroughAt: input.digestedThrough.at,
                digestedThroughId: input.digestedThrough.id,
                attempts: 0,
              }
            : { attempts: sql`${memorySchedule.attempts} + 1` }),
          leaseOwner: null,
          leaseUntil: null,
          activeRunId: null,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(memorySchedule.conversationId, input.conversationId),
            eq(memorySchedule.leaseOwner, input.leaseOwner),
            eq(memorySchedule.activeRunId, input.runId),
          ),
        )
        .returning({ conversationId: memorySchedule.conversationId });
      if (!schedule) {
        throw new Error(
          `memory schedule for "${input.conversationId}" is not leased to "${input.leaseOwner}"`,
        );
      }

      const [run] = await transaction
        .update(agentRuns)
        .set({
          status: input.status,
          result: input.status === "succeeded" ? input.result : null,
          error: input.status === "failed" ? input.error : null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.status, "running"),
            eq(agentRuns.role, "memory"),
          ),
        )
        .returning({ id: agentRuns.id });
      if (!run) throw new Error(`memory run "${input.runId}" is not running`);

      // The durable evaluation signal rides the terminal transition.
      await transaction
        .insert(evaluationPending)
        .values({ runId: input.runId, createdAt: completedAt })
        .onConflictDoNothing();
    });
  };

  return {
    async claimNext({
      leaseOwner,
      leaseMs,
      model,
      promptVersion,
      window,
      quietMs,
      maximumAttempts,
      now,
    }) {
      const at = now ?? new Date().toISOString();
      const quietBefore = new Date(Date.parse(at) - quietMs).toISOString();
      return database.transaction(async (transaction) => {
        // Memory is default-on for every chat with a speaker record, any
        // mode. Due-ness derives from retained observations against the
        // watermark — the poll is a wake-up hint, the scan is the truth.
        const candidates = await transaction
          .select({
            conversationId: conversationSpeakers.conversationId,
            memoryBrief: conversationSpeakers.memoryBrief,
            digestedThroughAt: memorySchedule.digestedThroughAt,
            digestedThroughId: memorySchedule.digestedThroughId,
          })
          .from(conversationSpeakers)
          .leftJoin(
            memorySchedule,
            eq(memorySchedule.conversationId, conversationSpeakers.conversationId),
          )
          .where(
            and(
              or(isNull(memorySchedule.leaseUntil), lte(memorySchedule.leaseUntil, at)),
              or(isNull(memorySchedule.attempts), lt(memorySchedule.attempts, maximumAttempts)),
            ),
          );

        let due:
          | {
              readonly conversationId: string;
              readonly memoryBrief: string | null;
              readonly oldest: string;
              readonly where: ReturnType<typeof and>;
            }
          | undefined;
        for (const candidate of candidates) {
          const afterWatermark =
            candidate.digestedThroughAt === null || candidate.digestedThroughId === null
              ? undefined
              : or(
                  gt(observations.occurredAt, candidate.digestedThroughAt),
                  and(
                    eq(observations.occurredAt, candidate.digestedThroughAt),
                    gt(observations.id, candidate.digestedThroughId),
                  ),
                );
          const backlogWhere = and(
            eq(observations.conversationId, candidate.conversationId),
            eq(observations.kind, "message"),
            afterWatermark,
          );
          const [stats] = await transaction
            .select({
              total: count(),
              oldest: min(observations.occurredAt),
              newest: max(observations.occurredAt),
            })
            .from(observations)
            .where(backlogWhere);
          if (!stats || stats.total === 0 || stats.oldest === null || stats.newest === null) {
            continue;
          }
          const isDue = stats.total >= window || stats.newest <= quietBefore;
          if (!isDue) continue;
          if (!due || stats.oldest < due.oldest) {
            due = {
              conversationId: candidate.conversationId,
              memoryBrief: candidate.memoryBrief,
              oldest: stats.oldest,
              where: backlogWhere,
            };
          }
        }
        if (!due) return undefined;

        const windowRows = await transaction
          .select()
          .from(observations)
          .where(due.where)
          .orderBy(asc(observations.occurredAt), asc(observations.id))
          .limit(window);
        const first = windowRows[0];
        const last = windowRows[windowRows.length - 1];
        if (!first || !last) return undefined;

        const runId = crypto.randomUUID();
        await transaction.insert(agentRuns).values({
          id: runId,
          agentId: "memory-analyst",
          role: "memory",
          conversationId: due.conversationId,
          status: "running",
          provider: model.provider,
          model: model.model,
          thinking: model.thinking,
          maxOutputTokens: model.maxOutputTokens,
          promptVersion,
          input: {
            conversationId: due.conversationId,
            observationIds: windowRows.map(({ id }) => id),
          },
          startedAt: at,
          createdAt: at,
          updatedAt: at,
        });

        const leaseUntil = new Date(Date.parse(at) + leaseMs).toISOString();
        await transaction
          .insert(memorySchedule)
          .values({
            conversationId: due.conversationId,
            attempts: 0,
            leaseOwner,
            leaseUntil,
            activeRunId: runId,
            updatedAt: at,
          })
          .onConflictDoUpdate({
            target: memorySchedule.conversationId,
            set: { leaseOwner, leaseUntil, activeRunId: runId, updatedAt: at },
          });

        return {
          conversationId: due.conversationId,
          runId,
          input: {
            ...(await buildInput(transaction, due.conversationId, windowRows)),
            ...(due.memoryBrief === null ? {} : { brief: due.memoryBrief }),
          },
          digestedThrough: { at: last.occurredAt, id: last.id },
          patchId: `patch:window:${first.id}`,
        } satisfies MemoryWindowClaim;
      });
    },

    complete({ conversationId, leaseOwner, runId, digestedThrough, result, completedAt }) {
      return terminalize({
        status: "succeeded",
        conversationId,
        leaseOwner,
        runId,
        digestedThrough,
        result,
        ...(completedAt === undefined ? {} : { completedAt }),
      });
    },

    fail({ conversationId, leaseOwner, runId, error, completedAt }) {
      return terminalize({
        status: "failed",
        conversationId,
        leaseOwner,
        runId,
        error,
        ...(completedAt === undefined ? {} : { completedAt }),
      });
    },
  };
}
