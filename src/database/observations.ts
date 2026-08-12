import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import { observations } from "./schema";

const observationSourceSchema = z.enum(["whatsapp", "worker"]);
const observationKindSchema = z.enum([
  "message",
  "task_request",
  "worker_result",
  "conversation_report",
]);
const observationPayloadSchema = z.json();

export interface Observation {
  readonly id: string;
  readonly source: z.infer<typeof observationSourceSchema>;
  readonly accountId: string;
  readonly nativeId: string;
  readonly conversationId?: string;
  readonly occurredAt: string;
  readonly kind: z.infer<typeof observationKindSchema>;
  readonly payload: z.infer<typeof observationPayloadSchema>;
  readonly createdAt: string;
}

export type NewObservation = Omit<Observation, "id" | "createdAt"> & {
  readonly id?: string;
  readonly createdAt?: string;
};

export interface ObservationRepository {
  retain(
    observation: NewObservation,
  ): Promise<{ readonly observation: Observation; accepted: boolean }>;
  get(id: string): Promise<Observation | undefined>;
  getMany(ids: readonly string[]): Promise<readonly Observation[]>;
}

function decode(row: typeof observations.$inferSelect): Observation {
  return {
    id: row.id,
    source: observationSourceSchema.parse(row.source),
    accountId: row.accountId,
    nativeId: row.nativeId,
    conversationId: row.conversationId ?? undefined,
    occurredAt: row.occurredAt,
    kind: observationKindSchema.parse(row.kind),
    payload: observationPayloadSchema.parse(row.payload),
    createdAt: row.createdAt,
  };
}

export function createObservationRepository(
  database: AmbientDatabaseConnection,
): ObservationRepository {
  const getByNativeIdentity = async (
    source: Observation["source"],
    accountId: string,
    nativeId: string,
  ): Promise<Observation | undefined> => {
    const [row] = await database
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.source, source),
          eq(observations.accountId, accountId),
          eq(observations.nativeId, nativeId),
        ),
      )
      .limit(1);
    return row ? decode(row) : undefined;
  };

  return {
    async retain(input) {
      const id = input.id ?? crypto.randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const [inserted] = await database
        .insert(observations)
        .values({
          id,
          source: input.source,
          accountId: input.accountId,
          nativeId: input.nativeId,
          conversationId: input.conversationId,
          occurredAt: input.occurredAt,
          kind: input.kind,
          payload: input.payload,
          createdAt,
        })
        .onConflictDoNothing({
          target: [observations.source, observations.accountId, observations.nativeId],
        })
        .returning();

      if (inserted) {
        return {
          observation: decode(inserted),
          accepted: true,
        };
      }

      const observation = await getByNativeIdentity(input.source, input.accountId, input.nativeId);
      if (!observation) throw new Error("observation conflict did not resolve to a retained row");
      return { observation, accepted: false };
    },

    async get(id) {
      const [row] = await database
        .select()
        .from(observations)
        .where(eq(observations.id, id))
        .limit(1);
      return row ? decode(row) : undefined;
    },

    async getMany(ids) {
      if (ids.length === 0) return [];
      const rows = await database
        .select()
        .from(observations)
        .where(inArray(observations.id, [...ids]));
      const byId = new Map(rows.map((row) => [row.id, decode(row)]));
      return ids.flatMap((id) => {
        const observation = byId.get(id);
        return observation ? [observation] : [];
      });
    },
  };
}
