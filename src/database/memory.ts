import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import {
  agentRuns,
  claimEvidence,
  claims,
  entities,
  memoryPatches,
  memoryPatchOperations,
  predicateDefinitions,
} from "./schema";

const confidenceSchema = z.enum(["low", "medium", "high", "confirmed"]);
const evidenceSchema = z.array(z.string().min(1)).min(1);
const jsonValueSchema = z.json();

const patchOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    claimId: z.string().min(1),
    entityId: z.string().min(1),
    predicateId: z.string().min(1),
    value: jsonValueSchema,
    confidence: confidenceSchema,
    evidenceObservationIds: evidenceSchema,
  }),
  z.object({
    operation: z.literal("reinforce"),
    claimId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    evidenceObservationIds: evidenceSchema,
  }),
  z.object({
    operation: z.literal("supersede"),
    claimId: z.string().min(1),
    supersedesClaimId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    value: jsonValueSchema,
    confidence: confidenceSchema,
    evidenceObservationIds: evidenceSchema,
  }),
]);

export type MemoryPatchOperation = z.infer<typeof patchOperationSchema>;

export interface MemoryRepository {
  putEntity(input: {
    readonly id: string;
    readonly kind: string;
    readonly canonicalName: string;
    readonly at?: string;
  }): Promise<void>;
  putPredicate(input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly valueSchema: z.infer<typeof jsonValueSchema>;
    readonly at?: string;
  }): Promise<void>;
  getPatch(id: string): Promise<
    | {
        readonly id: string;
        readonly status: "pending" | "applied" | "rejected";
        readonly error?: string;
      }
    | undefined
  >;
  applyPatch(input: {
    readonly id?: string;
    readonly runId: string;
    readonly source: z.infer<typeof jsonValueSchema>;
    readonly operations: readonly MemoryPatchOperation[];
    readonly createdAt?: string;
  }): Promise<{ readonly id: string; readonly status: "applied"; readonly appliedAt: string }>;
}

export function createMemoryRepository(database: AmbientDatabaseConnection): MemoryRepository {
  return {
    async putEntity(input) {
      const at = input.at ?? new Date().toISOString();
      await database
        .insert(entities)
        .values({
          id: input.id,
          kind: input.kind,
          canonicalName: input.canonicalName,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: entities.id,
          set: {
            kind: input.kind,
            canonicalName: input.canonicalName,
            updatedAt: at,
          },
        });
    },

    async putPredicate(input) {
      const at = input.at ?? new Date().toISOString();
      await database
        .insert(predicateDefinitions)
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          valueSchema: input.valueSchema,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: predicateDefinitions.id,
          set: {
            name: input.name,
            description: input.description,
            valueSchema: input.valueSchema,
            updatedAt: at,
          },
        });
    },

    async getPatch(id) {
      const [patch] = await database
        .select({
          id: memoryPatches.id,
          status: memoryPatches.status,
          error: memoryPatches.error,
        })
        .from(memoryPatches)
        .where(eq(memoryPatches.id, id))
        .limit(1);
      return patch
        ? {
            id: patch.id,
            status: patch.status,
            error: patch.error ?? undefined,
          }
        : undefined;
    },

    async applyPatch(input) {
      const id = input.id ?? crypto.randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const operations = z.array(patchOperationSchema).min(1).parse(input.operations);
      const [run] = await database
        .select({ role: agentRuns.role })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .limit(1);
      if (!run || run.role !== "memory") {
        throw new Error(`agent run "${input.runId}" cannot apply memory patches`);
      }

      try {
        return await database.transaction(async (transaction) => {
          const [currentRun] = await transaction
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(eq(agentRuns.id, input.runId))
            .limit(1);
          if (!currentRun || currentRun.status !== "running") {
            throw new Error(`agent run "${input.runId}" cannot apply memory patches`);
          }

          await transaction.insert(memoryPatches).values({
            id,
            runId: input.runId,
            status: "pending",
            source: input.source,
            createdAt,
          });

          const evidenceRows: (typeof claimEvidence.$inferInsert)[] = [];
          const operationRows: (typeof memoryPatchOperations.$inferInsert)[] = [];
          const collectEvidence = (claimId: string, observationIds: readonly string[]): void => {
            evidenceRows.push(
              ...observationIds.map((observationId) => ({
                claimId,
                observationId,
              })),
            );
          };

          for (const [position, operation] of operations.entries()) {
            if (operation.operation === "create") {
              await transaction.insert(claims).values({
                id: operation.claimId,
                entityId: operation.entityId,
                predicateId: operation.predicateId,
                value: operation.value,
                confidence: operation.confidence,
                version: 1,
                createdByPatchId: id,
                createdAt,
              });
              collectEvidence(operation.claimId, operation.evidenceObservationIds);
            } else if (operation.operation === "reinforce") {
              const [current] = await transaction
                .select({ version: claims.version })
                .from(claims)
                .where(eq(claims.id, operation.claimId))
                .limit(1);
              if (current?.version !== operation.expectedVersion) {
                throw new Error(
                  `claim "${operation.claimId}" expected version ${operation.expectedVersion}, found ${current?.version ?? "missing"}`,
                );
              }
              collectEvidence(operation.claimId, operation.evidenceObservationIds);
            } else {
              const [previous] = await transaction
                .select({
                  entityId: claims.entityId,
                  predicateId: claims.predicateId,
                  version: claims.version,
                })
                .from(claims)
                .where(eq(claims.id, operation.supersedesClaimId))
                .limit(1);
              if (previous?.version !== operation.expectedVersion) {
                throw new Error(
                  `claim "${operation.supersedesClaimId}" expected version ${operation.expectedVersion}, found ${previous?.version ?? "missing"}`,
                );
              }
              await transaction.insert(claims).values({
                id: operation.claimId,
                entityId: previous.entityId,
                predicateId: previous.predicateId,
                value: operation.value,
                confidence: operation.confidence,
                version: operation.expectedVersion + 1,
                supersedesClaimId: operation.supersedesClaimId,
                createdByPatchId: id,
                createdAt,
              });
              collectEvidence(operation.claimId, operation.evidenceObservationIds);
            }

            operationRows.push({
              id: crypto.randomUUID(),
              patchId: id,
              position,
              operation: operation.operation,
              claimId: operation.claimId,
              expectedVersion:
                "expectedVersion" in operation ? operation.expectedVersion : undefined,
              payload: operation,
            });
          }
          await transaction.insert(claimEvidence).values(evidenceRows).onConflictDoNothing();
          await transaction.insert(memoryPatchOperations).values(operationRows);

          const appliedAt = new Date().toISOString();
          const [applied] = await transaction
            .update(memoryPatches)
            .set({ status: "applied", appliedAt })
            .where(eq(memoryPatches.id, id))
            .returning({ id: memoryPatches.id });
          if (!applied) throw new Error(`memory patch "${id}" was not applied`);
          return { id, status: "applied" as const, appliedAt };
        });
      } catch (error) {
        await database.insert(memoryPatches).values({
          id,
          runId: input.runId,
          status: "rejected",
          source: input.source,
          error: String(error),
          createdAt,
        });
        throw error;
      }
    },
  };
}
