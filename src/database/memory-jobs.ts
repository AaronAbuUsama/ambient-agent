import { and, asc, eq, gt, inArray, isNull, lte, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { MemoryInput, MemoryJobStore, MemoryOntologyClaim } from "../memory/contract";
import type { AmbientDatabaseConnection } from "./database";
import {
  agentRuns,
  claimEvidence,
  claims,
  entities,
  evaluationPending,
  identityLinks,
  memoryJobs,
  observations,
  predicateDefinitions,
} from "./schema";

const jobInputSchema = z.object({ observationIds: z.array(z.string().min(1)).min(1) });

const messagePayloadSchema = z.looseObject({
  messageId: z.string().min(1).optional(),
  sender: z.looseObject({ id: z.string().min(1) }).optional(),
  fromMe: z.boolean().optional(),
  kind: z.string().optional(),
  text: z.string().optional(),
  media: z.looseObject({ caption: z.string().optional() }).optional(),
  context: z
    .looseObject({
      mentions: z.array(z.string().min(1)).optional(),
      quoted: z.looseObject({ from: z.string().min(1), id: z.string().min(1) }).optional(),
    })
    .optional(),
});

const confidenceSchema = z.enum(["low", "medium", "high", "confirmed"]);

export function createMemoryJobStore(database: AmbientDatabaseConnection): MemoryJobStore {
  const buildInput = async (
    conversationId: string,
    observationIds: readonly string[],
  ): Promise<MemoryInput> => {
    const rows = await database
      .select()
      .from(observations)
      .where(inArray(observations.id, [...observationIds]))
      .orderBy(asc(observations.occurredAt), asc(observations.id));
    const parsed = rows.map((row) => ({ row, payload: messagePayloadSchema.parse(row.payload) }));

    // Quoted-reply recovery: a quoted context names the quoted message's real
    // author, so unattributed historical rows regain their sender when the
    // batch itself proves it. Nothing is ever guessed.
    const authorByMessageId = new Map<string, string>();
    const observationByMessageId = new Map<string, string>();
    for (const { row, payload } of parsed) {
      if (payload.messageId) observationByMessageId.set(payload.messageId, row.id);
      const quoted = payload.context?.quoted;
      if (quoted) authorByMessageId.set(quoted.id, quoted.from);
    }

    const messages = parsed.map(({ row, payload }) => {
      const recovered = payload.messageId ? authorByMessageId.get(payload.messageId) : undefined;
      const senderId = payload.sender?.id ?? recovered;
      const inReplyTo = payload.context?.quoted
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
      ? await database
          .select({ entityId: identityLinks.entityId })
          .from(identityLinks)
          .where(
            and(eq(identityLinks.namespace, "whatsapp"), inArray(identityLinks.nativeId, senders)),
          )
      : [];
    // Entities without identity links (issues, repos) are visible through the
    // conversation their evidence came from — without this, later windows can
    // never reuse or supersede what earlier windows learned.
    const conversationEntities = await database
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
      ? await database.select().from(entities).where(inArray(entities.id, entityIds))
      : [];
    const allLinks = entityIds.length
      ? await database
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
      ? await database
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
                database
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

    const predicateRows = await database.select().from(predicateDefinitions);

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
  };

  const terminalize = async (
    input:
      | {
          readonly status: "done";
          readonly jobId: string;
          readonly leaseOwner: string;
          readonly runId: string;
          readonly result: unknown;
          readonly completedAt?: string;
        }
      | {
          readonly status: "failed";
          readonly jobId: string;
          readonly leaseOwner: string;
          readonly runId?: string;
          readonly error: string;
          readonly completedAt?: string;
        },
  ): Promise<void> => {
    const completedAt = input.completedAt ?? new Date().toISOString();
    await database.transaction(async (transaction) => {
      const [job] = await transaction
        .update(memoryJobs)
        .set({
          status: input.status,
          runId: input.runId ?? null,
          error: input.status === "failed" ? input.error : null,
          leaseOwner: null,
          leaseUntil: null,
          completedAt,
        })
        .where(
          and(
            eq(memoryJobs.id, input.jobId),
            eq(memoryJobs.status, "pending"),
            eq(memoryJobs.leaseOwner, input.leaseOwner),
          ),
        )
        .returning({ id: memoryJobs.id });
      if (!job) {
        throw new Error(
          `memory job "${input.jobId}" is not pending under lease owner "${input.leaseOwner}"`,
        );
      }

      if (input.runId) {
        const [run] = await transaction
          .update(agentRuns)
          .set({
            status: input.status === "done" ? "succeeded" : "failed",
            result: input.status === "done" ? input.result : null,
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
      }
    });
  };

  return {
    async create({ conversationId, observationIds }) {
      const jobId = crypto.randomUUID();
      await database.insert(memoryJobs).values({
        id: jobId,
        conversationId,
        status: "pending",
        input: { observationIds: [...observationIds] },
        createdAt: new Date().toISOString(),
      });
      return { jobId };
    },

    async claimNext({ leaseOwner, leaseMs, now = new Date().toISOString() }) {
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const claimed = await database.transaction(async (transaction) => {
        const claimable = and(
          eq(memoryJobs.status, "pending"),
          or(isNull(memoryJobs.leaseUntil), lte(memoryJobs.leaseUntil, now)),
        );
        const [candidate] = await transaction
          .select({
            id: memoryJobs.id,
            conversationId: memoryJobs.conversationId,
            input: memoryJobs.input,
          })
          .from(memoryJobs)
          .where(claimable)
          .orderBy(asc(memoryJobs.createdAt), asc(memoryJobs.id))
          .limit(1);
        if (!candidate) return undefined;
        const [leased] = await transaction
          .update(memoryJobs)
          .set({ leaseOwner, leaseUntil })
          .where(and(eq(memoryJobs.id, candidate.id), claimable))
          .returning({ id: memoryJobs.id });
        return leased ? candidate : undefined;
      });
      if (!claimed) return undefined;
      const { observationIds } = jobInputSchema.parse(claimed.input);
      // Assembled outside the claim transaction: a broken batch keeps its
      // lease and cools down instead of hot-looping the claimer.
      return {
        jobId: claimed.id,
        conversationId: claimed.conversationId,
        input: await buildInput(claimed.conversationId, observationIds),
      };
    },

    complete(input) {
      return terminalize({ status: "done", ...input });
    },

    fail(input) {
      return terminalize({ status: "failed", ...input });
    },
  };
}
