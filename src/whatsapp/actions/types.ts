import type { ActionHandle } from "agentic-tui-kit";
import { z } from "zod";

export const chatIdSchema = z.string().trim().min(1);

export const attachmentReceiptSchema = z.object({
  attachment: z.enum(["detached", "attaching", "attached", "detaching"]),
  status: z.string(),
});

export const routeReceiptSchema = z.object({
  windowId: z.string().min(1),
  address: z.string().min(1),
});

export interface WhatsAppActions {
  readonly connect: ActionHandle<Record<string, never>, z.infer<typeof attachmentReceiptSchema>>;
  readonly disconnect: ActionHandle<Record<string, never>, z.infer<typeof attachmentReceiptSchema>>;
  readonly reconnect: ActionHandle<Record<string, never>, z.infer<typeof attachmentReceiptSchema>>;
  readonly unlink: ActionHandle<Record<string, never>, { unlinked: true }>;
  readonly openChat: ActionHandle<{ chatId: string }, z.infer<typeof routeReceiptSchema>>;
  readonly openSettings: ActionHandle<Record<string, never>, z.infer<typeof routeReceiptSchema>>;
  readonly listChats: ActionHandle<
    Record<string, never>,
    Array<{ chatId: string; title: string; isGroup: boolean; lastMessageAt: number }>
  >;
  readonly send: ActionHandle<
    { chatId: string; text: string },
    { operationId: string; chatId: string }
  >;
  readonly loadOlder: ActionHandle<{ chatId: string }, { chatId: string; older: string }>;
  readonly markRead: ActionHandle<{ chatId: string }, { chatId: string; marked: number }>;
}
