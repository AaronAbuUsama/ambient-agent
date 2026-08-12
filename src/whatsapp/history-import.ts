import { createClient } from "@libsql/client";
import { z } from "zod";
import { whatsAppMessageNativeId } from "./observation-mapper";

const mirrorMessageSchema = z.looseObject({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  sender: z.looseObject({ id: z.string().min(1), mode: z.string().min(1) }),
  fromMe: z.boolean(),
  timestamp: z.number(),
  kind: z.string(),
  text: z.string().optional(),
});

export interface HistoryImportResult {
  readonly scanned: number;
  readonly imported: number;
  readonly deduplicated: number;
  readonly skippedNonText: number;
}

/** The retention port; satisfied by the observations repository. */
export interface HistoryObservationSink {
  retain(observation: {
    readonly source: "whatsapp";
    readonly accountId: string;
    readonly nativeId: string;
    readonly conversationId: string;
    readonly occurredAt: string;
    readonly kind: "message";
    readonly payload: unknown;
  }): Promise<{ readonly accepted: boolean }>;
}

/**
 * Import one chat's retained history from a designated whatsappd mirror as
 * historical Observations — evidence for Memory, never Inbox work, so no
 * speaker is ever woken by it. The mirror is read read-only; retention dedupes
 * on native message identity, so re-import and overlap with live ingestion are
 * both safe.
 */
export async function importChatHistory(options: {
  readonly mirrorUrl: string;
  readonly mirrorAccountId: string;
  readonly chatId: string;
  readonly limit?: number;
  readonly sink: HistoryObservationSink;
}): Promise<HistoryImportResult> {
  const client = createClient({ url: options.mirrorUrl });
  try {
    const rows = await client.execute({
      sql: `SELECT data_json FROM wa_messages
            WHERE account_id = ? AND chat_id = ?
            ORDER BY timestamp ASC, message_id ASC
            LIMIT ?`,
      args: [options.mirrorAccountId, options.chatId, options.limit ?? 1000],
    });

    let imported = 0;
    let deduplicated = 0;
    let skippedNonText = 0;
    for (const row of rows.rows) {
      const raw = row["data_json"];
      if (typeof raw !== "string") {
        skippedNonText += 1;
        continue;
      }
      const parsed = mirrorMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.kind !== "text" || !parsed.data.text) {
        skippedNonText += 1;
        continue;
      }
      const message = parsed.data;
      const timestamp = message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000;
      const { accepted } = await options.sink.retain({
        source: "whatsapp",
        accountId: options.mirrorAccountId,
        nativeId: whatsAppMessageNativeId(message.chatId, message.messageId),
        conversationId: message.chatId,
        occurredAt: new Date(timestamp).toISOString(),
        kind: "message",
        payload: {
          version: 1,
          messageId: message.messageId,
          chatId: message.chatId,
          sender: message.sender,
          fromMe: message.fromMe,
          timestamp,
          historical: true,
          text: message.text,
        },
      });
      if (accepted) imported += 1;
      else deduplicated += 1;
    }
    return { scanned: rows.rows.length, imported, deduplicated, skippedNonText };
  } finally {
    client.close();
  }
}
