import { rejectAction } from "agentic-tui-kit";
import type { WhatsAppSessionController } from "../session/controller";

export function requireAttached(session: WhatsAppSessionController): void {
  const { attachment } = session.getSnapshot();
  if (attachment !== "attached") {
    rejectAction("unavailable", `not connected (${attachment})`);
  }
}

export function requireChat(session: WhatsAppSessionController, requested: string): void {
  const chat = session.getSnapshot().chats.find((candidate) => candidate.chatId === requested);
  if (!chat) rejectAction("not_found", `chat not found: ${requested}`);
}
