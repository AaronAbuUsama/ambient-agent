import { and, eq, sql } from "drizzle-orm";
import type {
  ConversationSpeakerSeedEntry,
  ConversationSpeakerStore,
} from "../conversation/contract";
import type { AmbientDatabaseConnection } from "./database";
import { conversationSpeakers } from "./schema";

export function createConversationSpeakerStore(
  database: AmbientDatabaseConnection,
): ConversationSpeakerStore {
  return {
    async seed(entries: readonly ConversationSpeakerSeedEntry[]) {
      if (entries.length === 0) return;
      const now = new Date().toISOString();
      await database.transaction(async (transaction) => {
        for (const entry of entries) {
          await transaction
            .insert(conversationSpeakers)
            .values({
              conversationId: entry.conversationId,
              mode: entry.mode,
              instructions: entry.instructions ?? null,
              attendFrom: entry.attendFrom ?? now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: conversationSpeakers.conversationId,
              set: {
                mode: entry.mode,
                instructions: entry.instructions ?? null,
                updatedAt: now,
                // Preserved on re-seed; advances only on a (re)activation into
                // "responding" or when the entry pins it explicitly.
                attendFrom:
                  entry.attendFrom ??
                  sql`CASE WHEN ${conversationSpeakers.mode} != 'responding' AND excluded.mode = 'responding'
                    THEN excluded.attend_from ELSE ${conversationSpeakers.attendFrom} END`,
              },
            });
        }
      });
    },

    async isResponding(conversationId) {
      const [row] = await database
        .select({ conversationId: conversationSpeakers.conversationId })
        .from(conversationSpeakers)
        .where(
          and(
            eq(conversationSpeakers.conversationId, conversationId),
            eq(conversationSpeakers.mode, "responding"),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
