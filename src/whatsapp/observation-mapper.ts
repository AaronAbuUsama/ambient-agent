import type { DurableInboundMessage } from "whatsappd";
import { z } from "zod";
import type { NewWhatsAppMessageObservation } from "../database/message-ingestion";

/** Message kinds whose bytes WhatsApp stores for us; everything else is dropped. */
export const liveMediaKinds = ["image", "video", "audio", "document", "sticker"] as const;

const liveMessageBase = {
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
};

/** `kind` is absent on text payloads retained before media was ingested live. */
const liveTextPayloadSchema = z.object({
  ...liveMessageBase,
  kind: z.literal("text").optional(),
  text: z.string(),
});

/**
 * Bytes never live in the payload: `ref` addresses them in the media store, and
 * is absent when WhatsApp's own download or store attempt failed — the caption
 * is then all that survives.
 */
const liveMediaPayloadSchema = z.object({
  ...liveMessageBase,
  kind: z.enum(liveMediaKinds),
  media: z.object({
    ref: z.string().min(1).optional(),
    mimetype: z.string().min(1).optional(),
    caption: z.string().optional(),
    byteLength: z.number().nonnegative().optional(),
  }),
  text: z.string().optional(),
});

export const whatsAppLiveMessagePayloadSchema = z.union([
  liveMediaPayloadSchema,
  liveTextPayloadSchema,
]);

export function whatsAppMessageNativeId(chatId: string, messageId: string): string {
  return `${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;
}

type LiveMediaMessage = Extract<DurableInboundMessage, { kind: (typeof liveMediaKinds)[number] }>;

function isMediaMessage(message: DurableInboundMessage): message is LiveMediaMessage {
  return (liveMediaKinds as readonly string[]).includes(message.kind);
}

/** The retained shape of one message's content, or undefined for kinds we drop. */
function retainedContent(message: DurableInboundMessage): Record<string, unknown> | undefined {
  if (message.kind === "text") return { kind: "text", text: message.text };
  if (!isMediaMessage(message)) return undefined;
  return {
    kind: message.kind,
    media: {
      ...(message.media.state === "stored"
        ? { ref: message.media.ref, byteLength: message.media.byteLength }
        : {}),
      ...(message.media.mimetype ? { mimetype: message.media.mimetype } : {}),
      ...(message.media.caption ? { caption: message.media.caption } : {}),
    },
    ...(message.text ? { text: message.text } : {}),
  };
}

/**
 * Convert one live incoming message into Ambient's durable source shape.
 *
 * Text and media are retained; a screenshot is a bug report, so dropping it
 * loses evidence that never comes back. Historical mirror import and outbound
 * echoes are separate policies, and kinds WhatsApp does not store bytes for
 * (location, contacts) are still ignored — they must not wake Conversation
 * through this live ingestion boundary.
 */
export function mapLiveWhatsAppMessage(
  accountId: string,
  message: DurableInboundMessage,
): NewWhatsAppMessageObservation | undefined {
  if (!message.live || message.fromMe) return undefined;
  const content = retainedContent(message);
  if (!content) return undefined;

  const payload = whatsAppLiveMessagePayloadSchema.parse({
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
    ...content,
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
