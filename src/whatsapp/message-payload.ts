import { z } from "zod";

/**
 * The retained WhatsApp message payload, as this module writes it at
 * retention (live mapping and historical import). Deliberately loose: the
 * source evolves, retained rows are forever, and every reader must tolerate
 * both eras. Historical group rows may lack the sender entirely; media
 * carries its caption and, when WhatsApp stored the bytes, the `ref` that
 * addresses them in the media store.
 *
 * This is the ONE schema for reading retained message payloads — memory,
 * evaluation evidence, and proofs all parse through it.
 */
export const retainedMessagePayloadSchema = z.looseObject({
  messageId: z.string().min(1).optional(),
  /**
   * `alt` is the sender's OTHER native id — WhatsApp gives one human a phone
   * form and a lid form, and both name the same person.
   */
  sender: z.looseObject({ id: z.string().min(1), alt: z.string().min(1).optional() }).optional(),
  /** The name the sender publishes for themselves. Retained since ingestion. */
  pushName: z.string().min(1).optional(),
  fromMe: z.boolean().optional(),
  kind: z.string().optional(),
  text: z.string().optional(),
  media: z
    .looseObject({
      caption: z.string().optional(),
      /** Absent when the bytes were never stored; there is then nothing to look at. */
      ref: z.string().min(1).optional(),
      mimetype: z.string().min(1).optional(),
    })
    .optional(),
  context: z
    .looseObject({
      mentions: z.array(z.string().min(1)).optional(),
      quoted: z
        .looseObject({ from: z.string().min(1).optional(), id: z.string().min(1).optional() })
        .optional(),
    })
    .optional(),
});

export type RetainedMessagePayload = z.infer<typeof retainedMessagePayloadSchema>;

/**
 * Every native id this message proves belongs to a real person: its author,
 * the author's other id form, whoever it mentions, and the author of the
 * message it quotes.
 *
 * This rule has exactly one home. Memory validates proposed identity links
 * against it and evaluation scores identity scope against it, and when the
 * two disagreed — evaluation not knowing about the second id form — memory
 * did the right thing and the gate called it a defect.
 *
 * A chat/group id is NEVER here: it is not a person, and linking one poisons
 * every recall through it.
 */
export function linkableIdentities(payload: RetainedMessagePayload): readonly string[] {
  return [
    ...(payload.sender ? [payload.sender.id] : []),
    ...(payload.sender?.alt ? [payload.sender.alt] : []),
    ...(payload.context?.mentions ?? []),
    ...(payload.context?.quoted?.from ? [payload.context.quoted.from] : []),
  ].filter((id) => !id.endsWith("@g.us"));
}
