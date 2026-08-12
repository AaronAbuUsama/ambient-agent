import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Flatten one assistant message's text blocks; empty string when it has none. */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
}
