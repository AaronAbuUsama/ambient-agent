import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import { agentRuns, conversationInbox, conversationRunItems } from "./schema";

const inboxKindSchema = z.enum(["message", "task_update"]);

export interface ConversationInboxItem {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: z.infer<typeof inboxKindSchema>;
  readonly referenceId: string;
  readonly createdAt: string;
  readonly claimedByRunId?: string;
  readonly consumedByRunId?: string;
  readonly consumedAt?: string;
}

export interface ConversationInboxRepository {
  enqueue(input: {
    readonly id?: string;
    readonly conversationId: string;
    readonly kind: ConversationInboxItem["kind"];
    readonly referenceId: string;
    readonly createdAt?: string;
  }): Promise<{ readonly item: ConversationInboxItem; accepted: boolean }>;
  pending(conversationId: string, limit?: number): Promise<readonly ConversationInboxItem[]>;
  claim(
    conversationId: string,
    runId: string,
    limit: number,
  ): Promise<readonly ConversationInboxItem[]>;
  consume(runId: string, consumedAt?: string): Promise<number>;
  release(runId: string): Promise<number>;
}

export function decodeConversationInboxItem(
  row: typeof conversationInbox.$inferSelect,
): ConversationInboxItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: inboxKindSchema.parse(row.kind),
    referenceId: row.referenceId,
    createdAt: row.createdAt,
    claimedByRunId: row.claimedByRunId ?? undefined,
    consumedByRunId: row.consumedByRunId ?? undefined,
    consumedAt: row.consumedAt ?? undefined,
  };
}

export function createConversationInboxRepository(
  database: AmbientDatabaseConnection,
): ConversationInboxRepository {
  const finishClaimedItems = async (
    runId: string,
    requiredStatus: "succeeded" | "failed",
    update:
      | { readonly consumedByRunId: string; readonly consumedAt: string }
      | {
          readonly claimedByRunId: null;
        },
  ): Promise<number> =>
    database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (!run || run.status !== requiredStatus) {
        throw new Error(
          `agent run "${runId}" must ${requiredStatus === "succeeded" ? "succeed" : "fail"} before updating inbox items`,
        );
      }
      const rows = await transaction
        .update(conversationInbox)
        .set(update)
        .where(
          and(
            eq(conversationInbox.claimedByRunId, runId),
            isNull(conversationInbox.consumedByRunId),
          ),
        )
        .returning({ id: conversationInbox.id });
      return rows.length;
    });

  return {
    async enqueue(input) {
      const id = input.id ?? crypto.randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const [inserted] = await database
        .insert(conversationInbox)
        .values({
          id,
          conversationId: input.conversationId,
          kind: input.kind,
          referenceId: input.referenceId,
          createdAt,
        })
        .onConflictDoNothing({
          target: [conversationInbox.kind, conversationInbox.referenceId],
        })
        .returning();
      if (inserted) return { item: decodeConversationInboxItem(inserted), accepted: true };

      const [row] = await database
        .select()
        .from(conversationInbox)
        .where(
          and(
            eq(conversationInbox.kind, input.kind),
            eq(conversationInbox.referenceId, input.referenceId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("inbox conflict did not resolve to a retained row");
      return { item: decodeConversationInboxItem(row), accepted: false };
    },

    async pending(conversationId, limit = 100) {
      const rows = await database
        .select()
        .from(conversationInbox)
        .where(
          and(
            eq(conversationInbox.conversationId, conversationId),
            isNull(conversationInbox.claimedByRunId),
            isNull(conversationInbox.consumedByRunId),
          ),
        )
        .orderBy(asc(conversationInbox.createdAt), asc(conversationInbox.id))
        .limit(limit);
      return rows.map(decodeConversationInboxItem);
    },

    claim(conversationId, runId, limit) {
      return database.transaction(async (transaction) => {
        const [run] = await transaction
          .select({
            role: agentRuns.role,
            conversationId: agentRuns.conversationId,
            status: agentRuns.status,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1);
        if (!run) throw new Error(`agent run "${runId}" not found`);
        if (
          run.role !== "conversation" ||
          run.status !== "running" ||
          run.conversationId !== conversationId
        ) {
          throw new Error(
            `agent run "${runId}" cannot claim inbox for conversation "${conversationId}"`,
          );
        }

        const rows = await transaction
          .select()
          .from(conversationInbox)
          .where(
            and(
              eq(conversationInbox.conversationId, conversationId),
              isNull(conversationInbox.claimedByRunId),
              isNull(conversationInbox.consumedByRunId),
            ),
          )
          .orderBy(asc(conversationInbox.createdAt), asc(conversationInbox.id))
          .limit(limit);
        if (rows.length === 0) return [];

        const claimed = await transaction
          .update(conversationInbox)
          .set({ claimedByRunId: runId })
          .where(
            and(
              inArray(
                conversationInbox.id,
                rows.map((row) => row.id),
              ),
              isNull(conversationInbox.claimedByRunId),
              isNull(conversationInbox.consumedByRunId),
            ),
          )
          .returning({ id: conversationInbox.id });
        if (claimed.length !== rows.length) {
          throw new Error("conversation inbox items changed during claim");
        }
        await transaction.insert(conversationRunItems).values(
          rows.map((row, position) => ({
            runId,
            inboxItemId: row.id,
            position,
          })),
        );

        return rows.map((row) => decodeConversationInboxItem({ ...row, claimedByRunId: runId }));
      });
    },

    consume(runId, consumedAt = new Date().toISOString()) {
      return finishClaimedItems(runId, "succeeded", { consumedByRunId: runId, consumedAt });
    },

    release(runId) {
      return finishClaimedItems(runId, "failed", { claimedByRunId: null });
    },
  };
}
