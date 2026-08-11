import { defineAction } from "agentic-tui-kit";
import { z } from "zod";
import type { WhatsAppSessionController } from "../session/controller";
import { requireAttached } from "./guards";
import { whatsAppActions } from "./ids";
import { chatIdSchema } from "./types";

export function defineMessagingActions(session: WhatsAppSessionController) {
  const send = defineAction({
    id: whatsAppActions.send,
    title: "Send message",
    group: "WhatsApp",
    description:
      "Queue a durable text message to one chat. The receipt names the operation; delivery is reported separately.",
    inputSchema: z.object({ chatId: chatIdSchema, text: z.string().trim().min(1) }),
    outputSchema: z.object({ operationId: z.string().min(1), chatId: z.string().min(1) }),
    sideEffect: "external-write",
    available: () =>
      session.getSnapshot().attachment === "attached" || "connect before sending messages",
    execute: async ({ chatId, text }) => {
      requireAttached(session);
      const operation = await session.sendText(chatId, text);
      return { operationId: operation.id, chatId };
    },
  });

  const loadOlder = defineAction({
    id: whatsAppActions.loadOlder,
    title: "Load earlier messages",
    group: "WhatsApp",
    description:
      "Read one older page from the local mirror. A background walk already does this for every chat, so this is the way to reach past the memory limit it stops at. The returned `older` reports the mirror only: nothing older stored here never means the phone has no more.",
    inputSchema: z.object({ chatId: chatIdSchema }),
    outputSchema: z.object({ chatId: z.string(), older: z.string() }),
    sideEffect: "local-write",
    execute: ({ chatId }) => {
      requireAttached(session);
      session.loadOlder(chatId);
      return { chatId, older: session.chatMessages(chatId)?.older ?? "loading" };
    },
  });

  const markRead = defineAction({
    id: whatsAppActions.markRead,
    title: "Mark chat read",
    group: "WhatsApp",
    description: "Acknowledge every retained inbound message in one chat.",
    inputSchema: z.object({ chatId: chatIdSchema }),
    outputSchema: z.object({ chatId: z.string(), marked: z.number().int().nonnegative() }),
    sideEffect: "external-write",
    available: () =>
      session.getSnapshot().attachment === "attached" || "connect before marking messages read",
    execute: async ({ chatId }) => {
      requireAttached(session);
      const refs = (session.chatMessages(chatId)?.messages ?? [])
        .filter((message) => !message.fromMe)
        .map((message) => message.ref);
      await session.markRead(refs);
      return { chatId, marked: refs.length };
    },
  });

  return { send, loadOlder, markRead };
}
