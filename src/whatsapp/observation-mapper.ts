import type { DurableInboundMessage } from "whatsappd";
import { z } from "zod";
import type { NewWhatsAppMessageObservation } from "../database/message-ingestion";

export const whatsAppTextMessagePayloadSchema = z.object({
  version: z.literal(1),
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  sender: z.object({
    id: z.string().min(1),
    mode: z.enum(["lid", "pn"]),
    alt: z.string().min(1).optional(),
  }),
  fromMe: z.literal(false),
  timestamp: z.number().nonnegative(),
  live: z.literal(true),
  isGroup: z.boolean(),
  keyParticipant: z.string().optional(),
  pushName: z.string().optional(),
  text: z.string(),
  context: z
    .object({
      quoted: z
        .object({
          id: z.string().min(1),
          from: z.string().min(1),
        })
        .optional(),
      mentions: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  flags: z
    .object({
      viewOnce: z.boolean().optional(),
      ephemeral: z.boolean().optional(),
      edited: z.boolean().optional(),
    })
    .optional(),
});

export function whatsAppMessageNativeId(chatId: string, messageId: string): string {
  return `${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;
}

/**
 * Convert one live incoming text message into Ambient's durable source shape.
 *
 * Historical mirror import, outbound echoes, and non-text payloads are separate
 * policies. They must not accidentally wake Conversation through this live
 * ingestion boundary.
 */
export function mapLiveWhatsAppMessage(
  accountId: string,
  message: DurableInboundMessage,
): NewWhatsAppMessageObservation | undefined {
  if (!message.live || message.fromMe || message.kind !== "text") return undefined;

  const payload = whatsAppTextMessagePayloadSchema.parse({
    version: 1,
    messageId: message.id,
    chatId: message.chatId,
    sender: message.sender,
    fromMe: false,
    timestamp: message.timestamp,
    live: true,
    isGroup: message.isGroup,
    ...(message.keyParticipant ? { keyParticipant: message.keyParticipant } : {}),
    ...(message.pushName ? { pushName: message.pushName } : {}),
    text: message.text,
    ...(message.context ? { context: message.context } : {}),
    ...(message.flags ? { flags: message.flags } : {}),
  });

  return {
    source: "whatsapp",
    accountId,
    nativeId: whatsAppMessageNativeId(message.chatId, message.id),
    conversationId: message.chatId,
    occurredAt: new Date(message.timestamp).toISOString(),
    kind: "message",
    payload,
  };
}
