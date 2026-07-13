import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { getWhatsAppHost, type WhatsAppHost } from "../../host/whatsapp-host.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const sayOutputSchema = v.union([
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

export const createSayTool = (chatId: string, host?: WhatsAppHost) =>
  defineTool({
    name: "say",
    description: "Send one message to the WhatsApp chat bound to this Ambience instance.",
    input: v.object({
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
    }),
    output: sayOutputSchema,
    // Resolve the transport only if Ambience actually chooses to speak. This
    // lets non-WhatsApp inputs (including terminal workflow events) initialize
    // and settle before the paired transport is wired in ticket #31.
    run: ({ input }) => (host ?? getWhatsAppHost()).say(chatId, input.text),
  });
