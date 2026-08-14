import { whatsAppLiveMessagePayloadSchema } from "../whatsapp/observation-mapper";
import type {
  ConversationClaim,
  ConversationDelegate,
  ConversationInput,
  ConversationMessage,
  ConversationSkill,
  ConversationTaskUpdate,
  ConversationWorkStore,
} from "./contract";

export interface ConversationContextBuilder {
  build(claim: ConversationClaim): Promise<ConversationInput>;
}

export interface ConversationContextSources {
  /** The chat's granted skills, read fresh at run assembly (the files are the control). */
  readonly skills?: (conversationId: string) => Promise<readonly ConversationSkill[]>;
  /** The chat's granted agents, composed fresh at run assembly. */
  readonly agents?: (conversationId: string) => Promise<readonly ConversationDelegate[]>;
  /** Dereference task_update inbox items to their assignments' outcomes. */
  readonly taskUpdates?: (taskIds: readonly string[]) => Promise<readonly ConversationTaskUpdate[]>;
}

export function createConversationContextBuilder(
  evidence: Pick<ConversationWorkStore, "observations">,
  instructions: string,
  sources: ConversationContextSources = {},
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
        const payload = whatsAppLiveMessagePayloadSchema.parse(observation.payload);
        const attachment =
          "media" in payload
            ? {
                kind: payload.kind,
                ...(payload.media.ref ? { ref: payload.media.ref } : {}),
                ...(payload.media.mimetype ? { mimetype: payload.media.mimetype } : {}),
              }
            : undefined;
        return {
          observationId: observation.id,
          whatsappMessageId: payload.messageId,
          senderId: payload.sender.id,
          sentAt: observation.occurredAt,
          text: payload.text ?? ("media" in payload ? (payload.media.caption ?? "") : ""),
          ...(attachment ? { attachment } : {}),
          fromAgent: false,
        };
      });

      const taskItems = claim.items.filter(({ kind }) => kind === "task_update");
      const taskUpdates =
        taskItems.length > 0 && sources.taskUpdates
          ? await sources.taskUpdates(taskItems.map(({ referenceId }) => referenceId))
          : [];

      return {
        conversationId: claim.conversationId,
        newMessages,
        instructions: claim.instructions ?? instructions,
        skills: (await sources.skills?.(claim.conversationId)) ?? [],
        agents: (await sources.agents?.(claim.conversationId)) ?? [],
        taskUpdates,
      };
    },
  };
}
