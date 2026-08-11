import { defineAction } from "agentic-tui-kit";
import { z } from "zod";
import type { WhatsAppSessionController } from "../session/controller";
import { chatTitle } from "../tui/presentation";
import { whatsAppActions } from "./ids";

export function defineChatQueryActions(session: WhatsAppSessionController) {
  const listChats = defineAction({
    id: whatsAppActions.listChats,
    title: "List chats",
    group: "WhatsApp",
    description: "List the chats held in the local mirror, newest activity first.",
    inputSchema: z.object({}),
    outputSchema: z.array(
      z.object({
        chatId: z.string(),
        title: z.string(),
        isGroup: z.boolean(),
        lastMessageAt: z.number(),
      }),
    ),
    sideEffect: "local-read",
    execute: () =>
      [...session.getSnapshot().chats]
        .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
        .map((chat) => ({
          chatId: chat.chatId,
          title: chatTitle(chat, (nativeId) => session.resolveContact(nativeId)),
          isGroup: chat.isGroup,
          lastMessageAt: chat.lastMessageAt,
        })),
  });

  return { listChats };
}
