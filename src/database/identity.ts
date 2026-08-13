import { sql } from "drizzle-orm";
import type { AmbientDatabaseConnection } from "./database";

/**
 * Canonical chat identity (Identity & Voice, Part A): one human DM is one
 * conversation everywhere. Ingestion writes canonical ids going forward;
 * this store heals rows retained before an alias was known. Idempotent —
 * it runs at every startup and no-ops once nothing is left to rewrite.
 */
export interface IdentityStore {
  canonicalize(aliases: ReadonlyMap<string, string>): Promise<number>;
}

/** Tables where conversation_id is a plain column: rewrite in place. */
const plainTables = [
  "observations",
  "agent_runs",
  "tasks",
  "conversation_inbox",
  "episodes",
] as const;

/**
 * Tables where conversation_id is the PRIMARY KEY: the canonical row wins
 * when both forms exist (the canonical one is the live, mandate-synced row);
 * otherwise the native row is renamed.
 */
const keyedTables = ["conversation_speakers", "conversation_schedule", "memory_schedule"] as const;

export function createIdentityStore(database: AmbientDatabaseConnection): IdentityStore {
  return {
    async canonicalize(aliases) {
      let rewritten = 0;
      await database.transaction(async (transaction) => {
        for (const [native, canonical] of aliases) {
          if (native === canonical) continue;
          for (const table of plainTables) {
            const result = await transaction.run(
              sql`UPDATE ${sql.raw(table)} SET conversation_id = ${canonical} WHERE conversation_id = ${native}`,
            );
            rewritten += result.rowsAffected;
          }
          for (const table of keyedTables) {
            const result = await transaction.run(
              sql`UPDATE ${sql.raw(table)} SET conversation_id = ${canonical}
                  WHERE conversation_id = ${native}
                  AND NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} WHERE conversation_id = ${canonical})`,
            );
            rewritten += result.rowsAffected;
            const removed = await transaction.run(
              sql`DELETE FROM ${sql.raw(table)} WHERE conversation_id = ${native}`,
            );
            rewritten += removed.rowsAffected;
          }
        }
      });
      return rewritten;
    },
  };
}
