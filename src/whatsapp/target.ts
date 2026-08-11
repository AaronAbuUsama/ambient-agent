import { z } from "zod";

/**
 * Where the single WhatsApp pane is pointed.
 *
 * @remarks
 * A route rather than a second panel type, because this workbench is one pane:
 * `panel.navigate` refuses to move a window between panel types, so a chat and
 * a settings panel could never share one window. `chatId` is `""` on the
 * settings route rather than absent — `addressFields` encodes string fields
 * positionally and round-trips the address it produced, so an optional field
 * would make the address non-canonical and be rejected.
 */
export const whatsAppTargetSchema = z.object({
  view: z.enum(["chat", "settings"]),
  chatId: z.string(),
});

export type WhatsAppTarget = z.infer<typeof whatsAppTargetSchema>;

/** The route shown before any chat is chosen, and the workbench's landing view. */
export const settingsTarget: WhatsAppTarget = { view: "settings", chatId: "" };
