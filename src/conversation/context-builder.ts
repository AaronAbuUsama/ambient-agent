import { whatsAppTextMessagePayloadSchema } from "../whatsapp/observation-mapper";
import type {
  ConversationClaim,
  ConversationInput,
  ConversationMessage,
  ConversationSkill,
  ConversationWorkStore,
} from "./contract";

export interface ConversationContextBuilder {
  build(claim: ConversationClaim): Promise<ConversationInput>;
}

export function createConversationContextBuilder(
  evidence: Pick<ConversationWorkStore, "observations">,
  instructions: string,
  skills: (conversationId: string) => Promise<readonly ConversationSkill[]> = () =>
    Promise.resolve([]),
): ConversationContextBuilder {
  return {
    async build(claim) {
      const messageItems = claim.items.filter(({ kind }) => kind === "message");
      const retained = await evidence.observations(
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
          observation.conversationId !== claim.conversationId
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
        conversationId: claim.conversationId,
        newMessages,
        instructions: claim.instructions ?? instructions,
        skills: await skills(claim.conversationId),
      };
    },
  };
}
