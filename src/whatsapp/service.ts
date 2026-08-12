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
    mode: "loopback" | "conversation",
    authorize?: (conversationId: string) => boolean,
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

    conversationSender(mode, authorize) {
      return {
        async sendText({ conversationId, text, idempotencyKey }) {
          const target = mode === "loopback" ? controller.loopbackAddress() : conversationId;
          if (!target) throw new Error("WhatsApp loopback address is not available");
          if (authorize && !authorize(target)) {
            throw new Error(`outbound destination "${target}" is not authorized for this run`);
          }
          const operation = await controller.sendText(target, text, idempotencyKey);
          return { operationId: operation.id };
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
