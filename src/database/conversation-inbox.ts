import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import { conversationInbox } from "./schema";

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

/**
 * Inbox retention and pending reads. Claim, consumption, and release are owned
 * exclusively by the conversation work store.
 */
export interface ConversationInboxRepository {
  enqueue(input: {
    readonly id?: string;
    readonly conversationId: string;
    readonly kind: ConversationInboxItem["kind"];
    readonly referenceId: string;
    readonly createdAt?: string;
  }): Promise<{ readonly item: ConversationInboxItem; accepted: boolean }>;
  pending(conversationId: string, limit?: number): Promise<readonly ConversationInboxItem[]>;
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
  };
}
