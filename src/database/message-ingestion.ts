import { and, eq } from "drizzle-orm";
import type { AmbientDatabaseConnection } from "./database";
import type { NewObservation } from "./observations";
import { conversationInbox, observations, whatsappIngestionCursors } from "./schema";

export type NewWhatsAppMessageObservation = NewObservation & {
  readonly source: "whatsapp";
  readonly kind: "message";
  readonly conversationId: string;
};

export interface MessageIngestionResult {
  readonly observationId: string;
  readonly conversationId: string;
  readonly inboxItemId: string;
  readonly observationAccepted: boolean;
  readonly inboxAccepted: boolean;
}

export interface MessageIngestionRepository {
  cursor(accountId: string): Promise<
    | {
        readonly afterSeq: number;
        readonly state: "bootstrapping" | "active";
      }
    | undefined
  >;
  activate(accountId: string, afterSeq: number): Promise<void>;
  retainBatch(input: {
    readonly accountId: string;
    readonly seq: number;
    readonly observations: readonly NewWhatsAppMessageObservation[];
  }): Promise<readonly MessageIngestionResult[]>;
}

export function createMessageIngestionRepository(
  database: AmbientDatabaseConnection,
): MessageIngestionRepository {
  let writes: Promise<unknown> = Promise.resolve();
  const readCursor = async (accountId: string) => {
    const [row] = await database
      .select({
        afterSeq: whatsappIngestionCursors.afterSeq,
        state: whatsappIngestionCursors.state,
      })
      .from(whatsappIngestionCursors)
      .where(eq(whatsappIngestionCursors.accountId, accountId))
      .limit(1);
    return row;
  };

  return {
    cursor: readCursor,

    async activate(accountId, afterSeq) {
      const updatedAt = new Date().toISOString();
      await database
        .insert(whatsappIngestionCursors)
        .values({
          accountId,
          afterSeq,
          state: "active",
          updatedAt,
        })
        .onConflictDoNothing();
      const [updated] = await database
        .update(whatsappIngestionCursors)
        .set({
          state: "active",
          updatedAt,
        })
        .where(
          and(
            eq(whatsappIngestionCursors.accountId, accountId),
            eq(whatsappIngestionCursors.afterSeq, afterSeq),
          ),
        )
        .returning({ accountId: whatsappIngestionCursors.accountId });
      if (updated) return;

      const cursor = await readCursor(accountId);
      if (cursor?.state === "active" && cursor.afterSeq === afterSeq) return;
      throw new Error(`WhatsApp ingestion cursor changed before activation`);
    },

    retainBatch(input) {
      const write = () =>
        database.transaction(async (transaction) => {
          const [cursor] = await transaction
            .select({
              afterSeq: whatsappIngestionCursors.afterSeq,
              state: whatsappIngestionCursors.state,
            })
            .from(whatsappIngestionCursors)
            .where(eq(whatsappIngestionCursors.accountId, input.accountId))
            .limit(1);
          const afterSeq = cursor?.afterSeq ?? 0;
          if (input.seq <= afterSeq) return [];
          if (input.seq !== afterSeq + 1) {
            throw new Error(
              `WhatsApp ingestion cursor expected sequence ${afterSeq + 1}, received ${input.seq}`,
            );
          }

          const results: MessageIngestionResult[] = [];
          for (const observationInput of input.observations) {
            if (observationInput.accountId !== input.accountId) {
              throw new Error("WhatsApp ingestion batch contains another account");
            }

            const observationId = observationInput.id ?? crypto.randomUUID();
            const createdAt = observationInput.createdAt ?? new Date().toISOString();
            const [insertedObservation] = await transaction
              .insert(observations)
              .values({
                id: observationId,
                source: observationInput.source,
                accountId: observationInput.accountId,
                nativeId: observationInput.nativeId,
                conversationId: observationInput.conversationId,
                occurredAt: observationInput.occurredAt,
                kind: observationInput.kind,
                payload: observationInput.payload,
                createdAt,
              })
              .onConflictDoNothing({
                target: [observations.source, observations.accountId, observations.nativeId],
              })
              .returning({
                id: observations.id,
                conversationId: observations.conversationId,
                createdAt: observations.createdAt,
              });

            const observationRow =
              insertedObservation ??
              (
                await transaction
                  .select({
                    id: observations.id,
                    conversationId: observations.conversationId,
                    createdAt: observations.createdAt,
                  })
                  .from(observations)
                  .where(
                    and(
                      eq(observations.source, observationInput.source),
                      eq(observations.accountId, observationInput.accountId),
                      eq(observations.nativeId, observationInput.nativeId),
                    ),
                  )
                  .limit(1)
              )[0];
            if (!observationRow) {
              throw new Error("observation conflict did not resolve to a retained row");
            }

            const [insertedInboxItem] = await transaction
              .insert(conversationInbox)
              .values({
                id: crypto.randomUUID(),
                conversationId: observationRow.conversationId ?? observationInput.conversationId,
                kind: "message",
                referenceId: observationRow.id,
                createdAt: observationRow.createdAt,
              })
              .onConflictDoNothing({
                target: [conversationInbox.kind, conversationInbox.referenceId],
              })
              .returning({ id: conversationInbox.id });

            const inboxRow =
              insertedInboxItem ??
              (
                await transaction
                  .select({ id: conversationInbox.id })
                  .from(conversationInbox)
                  .where(
                    and(
                      eq(conversationInbox.kind, "message"),
                      eq(conversationInbox.referenceId, observationRow.id),
                    ),
                  )
                  .limit(1)
              )[0];
            if (!inboxRow) {
              throw new Error("inbox conflict did not resolve to a retained row");
            }

            results.push({
              observationId: observationRow.id,
              conversationId: observationRow.conversationId ?? observationInput.conversationId,
              inboxItemId: inboxRow.id,
              observationAccepted: insertedObservation !== undefined,
              inboxAccepted: insertedInboxItem !== undefined,
            });
          }

          const updatedAt = new Date().toISOString();
          await transaction
            .insert(whatsappIngestionCursors)
            .values({
              accountId: input.accountId,
              afterSeq: input.seq,
              state: cursor?.state ?? "bootstrapping",
              updatedAt,
            })
            .onConflictDoUpdate({
              target: whatsappIngestionCursors.accountId,
              set: {
                afterSeq: input.seq,
                updatedAt,
              },
            });
          return results;
        });
      const next = writes.then(write, write);
      writes = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
