import { inArray } from "drizzle-orm";
import type { MediaDescription, MediaDescriptionStore } from "../media/contract";
import type { AmbientDatabaseConnection } from "./database";
import { mediaDescriptions } from "./schema";

export function createMediaDescriptionStore(
  database: AmbientDatabaseConnection,
): MediaDescriptionStore {
  return {
    async find(refs) {
      if (refs.length === 0) return [];
      const rows = await database
        .select()
        .from(mediaDescriptions)
        .where(inArray(mediaDescriptions.ref, [...refs]));

      return rows.map((row): MediaDescription => {
        const mimetype = row.mimetype ?? undefined;
        if (row.status === "described") {
          return {
            ref: row.ref,
            status: "described",
            // The check constraint guarantees the text; the column stays
            // nullable because a failed row has none.
            description: row.description ?? "",
            ...(mimetype === undefined ? {} : { mimetype }),
          };
        }
        return {
          ref: row.ref,
          status: "failed",
          failureReason: row.failureReason ?? "unknown",
          ...(mimetype === undefined ? {} : { mimetype }),
        };
      });
    },

    async record(input) {
      await database
        .insert(mediaDescriptions)
        .values({
          ref: input.ref,
          status: input.status,
          mimetype: input.mimetype ?? null,
          description: input.status === "described" ? input.description : null,
          failureReason: input.status === "failed" ? input.failureReason : null,
          model: input.model,
          promptVersion: input.promptVersion,
          createdAt: new Date().toISOString(),
        })
        // Describing the same blob twice is a race, not a correction: the
        // first description stands so every citation of it stays true.
        .onConflictDoNothing({ target: mediaDescriptions.ref });
    },
  };
}
