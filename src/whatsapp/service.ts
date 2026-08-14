import { OperationIdempotencyConflictError } from "whatsappd";
import type { ScopedMessageSender } from "../conversation/contract";
import type { WhatsAppAcceptedSourceConsumer } from "./message-ingestion";
import { WhatsAppSessionController } from "./session/controller";
import { localDeployment } from "./session/local-deployment";

export interface WhatsAppServiceOptions {
  readonly accountId: string;
  readonly dataDirectory: string;
  readonly historyBackfillLimit?: number;
  readonly logLevel: string;
  readonly acceptedSource: WhatsAppAcceptedSourceConsumer;
}

export interface WhatsAppDestination {
  readonly id: string;
  readonly label: string;
}

/**
 * The Ambient-owned WhatsApp boundary.
 *
 * Hides the session controller, deployment wiring, retained mirror snapshot,
 * and raw send methods. Callers get the host lifecycle, a conversation-bound
 * text effect, and read-only destination discovery for proofs.
 */
export interface WhatsAppService {
  start(): Promise<void>;
  waitForFailure(): Promise<{ readonly error: Error }>;
  stop(): Promise<void>;
  /**
   * The Conversation-scoped outbound text effect. The destination is resolved
   * by deployment policy, never by the model; an explicit `authorize` override
   * strengthens the final guard and is refused when it does not match.
   */
  conversationSender(
    authorize?: (conversationId: string) => boolean | Promise<boolean>,
  ): ScopedMessageSender;
  /** Chats the authenticated account can see, for proof-side target matching. */
  destinations(): readonly WhatsAppDestination[];
}

export function createWhatsAppService(options: WhatsAppServiceOptions): WhatsAppService {
  const controller = new WhatsAppSessionController({
    ...localDeployment({
      accountId: options.accountId,
      directory: options.dataDirectory,
      historyBackfillLimit: options.historyBackfillLimit,
      logLevel: options.logLevel,
    }),
    acceptedSource: options.acceptedSource,
  });

  return {
    async start() {
      await controller.attach();
    },

    waitForFailure() {
      return controller.waitForFailure();
    },

    stop() {
      return controller.dispose();
    },

    conversationSender(authorize) {
      return {
        async sendText({ conversationId, text, idempotencyKey }) {
          if (authorize && !(await authorize(conversationId))) {
            throw new Error(
              `outbound destination "${conversationId}" is not authorized for this run`,
            );
          }
          try {
            const operation = await controller.sendText(conversationId, text, idempotencyKey);
            return { operationId: operation.id };
          } catch (error) {
            // The durable queue already holds this claim's send: the effect
            // happened, with the text originally composed for it. A retried
            // claim re-composes different wording under the same key —
            // adopting the original is the truth; failing forever on the
            // rewording is not (measured live: one poisoned claim burned
            // twenty model runs retrying against this conflict).
            if (error instanceof OperationIdempotencyConflictError) {
              return { operationId: `adopted:${error.idempotencyKey}` };
            }
            throw error;
          }
        },
      };
    },

    destinations() {
      const snapshot = controller.getSnapshot();
      return snapshot.chats.map((chat) => {
        const group = chat.isGroup
          ? snapshot.groups.find(({ groupId }) => groupId === chat.chatId)
          : undefined;
        return { id: chat.chatId, label: group?.subject ?? chat.subject ?? chat.chatId };
      });
    },
  };
}
