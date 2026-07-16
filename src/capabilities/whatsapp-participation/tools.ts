import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type { ProjectedConversationMessage } from "../../intake/conversation-archive.ts";
import { getWhatsAppParticipationPort, type WhatsAppSayPort } from "./whatsapp-port.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const historyMessageSchema = v.object({
  id: nonEmptyString,
  chatId: nonEmptyString,
  direction: v.union([v.literal("inbound"), v.literal("outbound")]),
  senderId: v.optional(nonEmptyString),
  senderName: v.optional(nonEmptyString),
  kind: nonEmptyString,
  text: v.string(),
  timestamp: v.pipe(v.number(), v.finite()),
});
const historyOutputSchema = v.object({
  messages: v.array(historyMessageSchema),
  context: v.string(),
});
const sayOutputSchema = v.union([
  v.object({ delivery: v.literal("sent"), messageId: nonEmptyString, typing: v.literal("cleared") }),
  v.object({
    delivery: v.literal("sent"),
    messageId: nonEmptyString,
    typing: v.literal("unknown"),
    typingError: nonEmptyString,
  }),
  v.object({ delivery: v.literal("failed"), deliveryError: nonEmptyString, typing: v.literal("cleared") }),
  v.object({
    delivery: v.literal("failed"),
    deliveryError: nonEmptyString,
    typing: v.literal("unknown"),
    typingError: nonEmptyString,
  }),
  v.object({ delivery: v.literal("unknown"), deliveryError: nonEmptyString, typing: v.literal("cleared") }),
  v.object({
    delivery: v.literal("unknown"),
    deliveryError: nonEmptyString,
    typing: v.literal("unknown"),
    typingError: nonEmptyString,
  }),
]);

const format = (messages: readonly ProjectedConversationMessage[]): string =>
  messages
    .map((message) => {
      const author =
        message.direction === "outbound" ? "Ambience" : (message.senderName ?? message.senderId ?? "participant");
      return `${new Date(message.timestamp).toISOString()} ${author}: ${message.text}`;
    })
    .join("\n");

export const createSayTool = (chatId: string, port?: WhatsAppSayPort) =>
  defineTool({
    name: "say",
    description:
      "Send one message to the WhatsApp chat bound to this Ambience instance, optionally replying to a triggering message.",
    input: v.object({
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
      replyTo: v.optional(
        v.object({
          messageId: nonEmptyString,
          fromMe: v.boolean(),
          participant: v.optional(nonEmptyString),
        }),
      ),
    }),
    output: sayOutputSchema,
    run: ({ input }) => (port ?? getWhatsAppParticipationPort()).say(chatId, input.text, input.replyTo),
  });

export const createReadWhatsAppThreadTool = (chatId: string) =>
  defineTool({
    name: "whatsapp_read_thread",
    description: "Read recent messages from this Ambience instance's WhatsApp chat, oldest to newest.",
    input: v.object({
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
    }),
    output: historyOutputSchema,
    run: ({ input }) => {
      const messages = getWhatsAppParticipationPort().readThread(chatId, input.limit ?? 30);
      return { messages: [...messages], context: format(messages) };
    },
  });

export const createSearchWhatsAppHistoryTool = (chatId: string) =>
  defineTool({
    name: "whatsapp_search",
    description: "Search message text in this Ambience instance's WhatsApp chat only.",
    input: v.object({ query: nonEmptyString }),
    output: historyOutputSchema,
    run: ({ input }) => {
      const messages = getWhatsAppParticipationPort().search(chatId, input.query);
      return { messages: [...messages], context: format(messages) };
    },
  });

export const createWhatsAppParticipationTools = (chatId: string): ToolDefinition[] => [
  createSayTool(chatId),
  createReadWhatsAppThreadTool(chatId),
  createSearchWhatsAppHistoryTool(chatId),
];
