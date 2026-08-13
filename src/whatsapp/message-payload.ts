import { z } from "zod";

/**
 * The retained WhatsApp message payload, as this module writes it at
 * retention (live mapping and historical import). Deliberately loose: the
 * source evolves, retained rows are forever, and every reader must tolerate
 * both eras. Historical group rows may lack the sender entirely; media
 * carries its caption under `media`.
 *
 * This is the ONE schema for reading retained message payloads — memory,
 * evaluation evidence, and proofs all parse through it.
 */
export const retainedMessagePayloadSchema = z.looseObject({
  messageId: z.string().min(1).optional(),
  sender: z.looseObject({ id: z.string().min(1) }).optional(),
  fromMe: z.boolean().optional(),
  kind: z.string().optional(),
  text: z.string().optional(),
  media: z.looseObject({ caption: z.string().optional() }).optional(),
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
