import type { ObservationRepository } from "../database/observations";
import { whatsAppTextMessagePayloadSchema } from "../whatsapp/observation-mapper";
import type { ConversationInput, ConversationMessage, ConversationRunClaim } from "./contract";

export interface ConversationContextBuilder {
  build(claim: ConversationRunClaim): Promise<ConversationInput>;
}

export function createConversationContextBuilder(
  observations: ObservationRepository,
  instructions: string,
): ConversationContextBuilder {
  return {
    async build(claim) {
      if (!claim.run.conversationId) {
        throw new Error(`conversation run "${claim.run.id}" has no conversation`);
      }
      const messageItems = claim.items.filter(({ kind }) => kind === "message");
      const retained = await observations.getMany(
        messageItems.map(({ referenceId }) => referenceId),
      );
      const byId = new Map(retained.map((observation) => [observation.id, observation]));
      const newMessages: ConversationMessage[] = messageItems.map((item) => {
        const observation = byId.get(item.referenceId);
        if (!observation) {
          throw new Error(`conversation inbox observation "${item.referenceId}" was not found`);
        }
        if (
          observation.source !== "whatsapp" ||
          observation.kind !== "message" ||
          observation.conversationId !== claim.run.conversationId
        ) {
          throw new Error(`conversation inbox observation "${item.referenceId}" is not a message`);
        }
        const payload = whatsAppTextMessagePayloadSchema.parse(observation.payload);
        return {
          observationId: observation.id,
          whatsappMessageId: payload.messageId,
          senderId: payload.sender.id,
          sentAt: observation.occurredAt,
          text: payload.text,
          fromAgent: false,
        };
      });

      return {
        conversationId: claim.run.conversationId,
        newMessages,
        instructions,
      };
    },
  };
}
