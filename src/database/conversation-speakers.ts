import { and, eq, notInArray, sql } from "drizzle-orm";
import type { ConversationSpeakerStore, SpeakerMandateEntry } from "../conversation/contract";
import type { AmbientDatabaseConnection } from "./database";
import { conversationSpeakers } from "./schema";

export function createConversationSpeakerStore(
  database: AmbientDatabaseConnection,
): ConversationSpeakerStore {
  return {
    async sync(entries: readonly SpeakerMandateEntry[]) {
      const now = new Date().toISOString();
      await database.transaction(async (transaction) => {
        for (const entry of entries) {
          await transaction
            .insert(conversationSpeakers)
            .values({
              conversationId: entry.conversationId,
              mode: entry.mode,
              instructions: entry.instructions ?? null,
              memoryBrief: entry.memoryBrief ?? null,
              attendFrom: entry.attendFrom ?? now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: conversationSpeakers.conversationId,
              set: {
                mode: entry.mode,
                instructions: entry.instructions ?? null,
                memoryBrief: entry.memoryBrief ?? null,
                updatedAt: now,
                // The watermark is a machine-stamped ratchet: preserved across
                // re-syncs, it advances only on a flip into "responding" (or an
                // explicit test pin) — activation always starts from now.
                attendFrom:
                  entry.attendFrom ??
                  sql`CASE WHEN ${conversationSpeakers.mode} != 'responding' AND excluded.mode = 'responding'
                    THEN excluded.attend_from ELSE ${conversationSpeakers.attendFrom} END`,
              },
            });
        }
        // Mirror semantics: a chat without a valid mandate has no record.
        const listed = entries.map((entry) => entry.conversationId);
        if (listed.length === 0) {
          await transaction.delete(conversationSpeakers);
        } else {
          await transaction
            .delete(conversationSpeakers)
            .where(notInArray(conversationSpeakers.conversationId, listed));
        }
      });
    },

    async current() {
      const rows = await database.select().from(conversationSpeakers);
      return rows.map((row) => ({
        conversationId: row.conversationId,
        mode: row.mode,
        ...(row.instructions === null ? {} : { instructions: row.instructions }),
        ...(row.memoryBrief === null ? {} : { memoryBrief: row.memoryBrief }),
        attendFrom: row.attendFrom,
      }));
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
