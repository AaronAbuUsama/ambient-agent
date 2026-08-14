import type { MediaDescription, MediaInterpreter } from "../media/contract";
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
  /** Interpret this batch's media, so the speaker is told what a picture shows. */
  readonly media?: MediaInterpreter;
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

      // Interpret this batch's pictures before the speaker reads them. The
      // description is retained, so a re-run of the same batch costs nothing.
      const describable = newMessages
        .map(({ attachment }) => attachment)
        .filter((attachment) => attachment?.ref !== undefined)
        .map((attachment) => ({
          ref: attachment!.ref!,
          ...(attachment!.mimetype === undefined ? {} : { mimetype: attachment!.mimetype }),
        }));
      const descriptions: ReadonlyMap<string, MediaDescription> =
        sources.media && describable.length > 0
          ? await sources.media.describe(describable)
          : new Map();
      const described = newMessages.map((message) => {
        const found = message.attachment?.ref
          ? descriptions.get(message.attachment.ref)
          : undefined;
        if (!message.attachment || found?.status !== "described") return message;
        return {
          ...message,
          attachment: { ...message.attachment, description: found.description },
        };
      });

      const taskItems = claim.items.filter(({ kind }) => kind === "task_update");
      const taskUpdates =
        taskItems.length > 0 && sources.taskUpdates
          ? await sources.taskUpdates(taskItems.map(({ referenceId }) => referenceId))
          : [];

      return {
        conversationId: claim.conversationId,
        newMessages: described,
        instructions: claim.instructions ?? instructions,
        skills: (await sources.skills?.(claim.conversationId)) ?? [],
        agents: (await sources.agents?.(claim.conversationId)) ?? [],
        taskUpdates,
      };
    },
  };
}
