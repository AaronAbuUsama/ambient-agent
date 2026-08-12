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
  context: z
    .looseObject({
      mentions: z.array(z.string().min(1)).optional(),
      quoted: z.looseObject({ from: z.string().min(1), id: z.string().min(1) }).optional(),
    })
    .optional(),
  media: z
    .looseObject({
      ref: z.string().min(1).optional(),
      mimetype: z.string().min(1).optional(),
      caption: z.string().optional(),
      byteLength: z.number().optional(),
    })
    .optional(),
});

const mediaKinds = new Set(["image", "video", "audio", "document", "sticker"]);

export interface HistoryImportResult {
  readonly scanned: number;
  readonly imported: number;
  readonly deduplicated: number;
  readonly skippedUnsupported: number;
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
 *
 * Attribution honesty: the mirror's historical group rows record the group id
 * as both sender and participant — the true author was never synced. Such rows
 * are imported WITHOUT a sender rather than presenting the group as a person;
 * quoted-reply context (which names the quoted message's real author) and
 * mentions are carried through so downstream consumers can recover identity
 * where the evidence supports it.
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
    let skippedUnsupported = 0;
    for (const row of rows.rows) {
      const raw = row["data_json"];
      if (typeof raw !== "string") {
        skippedUnsupported += 1;
        continue;
      }
      const parsed = mirrorMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        skippedUnsupported += 1;
        continue;
      }
      const message = parsed.data;
      const isText = message.kind === "text" && typeof message.text === "string";
      const isMedia = mediaKinds.has(message.kind);
      if (!isText && !isMedia) {
        skippedUnsupported += 1;
        continue;
      }
      const timestamp = message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000;
      const attributed = message.sender.id !== message.chatId;
      const context =
        message.context?.mentions?.length || message.context?.quoted
          ? {
              ...(message.context.mentions?.length ? { mentions: message.context.mentions } : {}),
              ...(message.context.quoted
                ? { quoted: { from: message.context.quoted.from, id: message.context.quoted.id } }
                : {}),
            }
          : undefined;
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
          ...(attributed ? { sender: message.sender } : {}),
          fromMe: message.fromMe,
          timestamp,
          historical: true,
          kind: message.kind,
          ...(isText ? { text: message.text } : {}),
          ...(isMedia && message.media
            ? {
                media: {
                  ...(message.media.ref ? { ref: message.media.ref } : {}),
                  ...(message.media.mimetype ? { mimetype: message.media.mimetype } : {}),
                  ...(message.media.caption ? { caption: message.media.caption } : {}),
                },
              }
            : {}),
          ...(context ? { context } : {}),
        },
      });
      if (accepted) imported += 1;
      else deduplicated += 1;
    }
    return { scanned: rows.rows.length, imported, deduplicated, skippedUnsupported };
  } finally {
    client.close();
  }
}
