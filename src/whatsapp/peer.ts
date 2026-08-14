import type { WhatsAppDataStore } from "whatsappd";
import { mapLiveWhatsAppMessage, whatsAppLiveMessagePayloadSchema } from "./observation-mapper";
import { WhatsAppSessionController } from "./session/controller";
import { localDeployment } from "./session/local-deployment";

export interface PeerMessage {
  readonly chatId: string;
  readonly senderId: string;
  readonly text: string;
}

/**
 * A second linked account driven as the human counterpart in live proofs.
 *
 * Proof tooling, not a production role: it brings one profile online, sends
 * texts through the durable operation queue, and observes live inbound text in
 * memory. It retains nothing durable in Ambient's stores, and everything that
 * happened before it came online is treated as history, never proof traffic.
 */
export interface WhatsAppPeer {
  start(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  waitForText(match: (message: PeerMessage) => boolean, timeoutMs: number): Promise<PeerMessage>;
  stop(): Promise<void>;
}

export function createWhatsAppPeer(options: {
  readonly accountId: string;
  readonly dataDirectory: string;
  readonly logLevel?: string;
}): WhatsAppPeer {
  const received: PeerMessage[] = [];
  const listeners = new Set<() => void>();
  let source: WhatsAppDataStore | undefined;
  let afterSeq = 0;
  let primed = false;
  let active = false;
  let draining: Promise<void> = Promise.resolve();
  let sends = 0;

  const drain = async (): Promise<void> => {
    if (!active || !source) return;
    while (active) {
      const batches = await source.accepted(options.accountId, afterSeq);
      if (batches.length === 0) {
        // The backlog is exhausted; everything from here on is live traffic.
        primed = true;
        return;
      }
      let delivered = false;
      for (const batch of batches) {
        if (primed) {
          for (const { event } of batch.events) {
            if (event.type !== "message") continue;
            const observation = mapLiveWhatsAppMessage(options.accountId, event.message);
            if (!observation) continue;
            const payload = whatsAppLiveMessagePayloadSchema.parse(observation.payload);
            received.push({
              chatId: payload.chatId,
              senderId: payload.sender.id,
              text: payload.text ?? ("media" in payload ? (payload.media.caption ?? "") : ""),
            });
            delivered = true;
          }
        }
        afterSeq = batch.seq;
      }
      if (delivered) {
        for (const listener of Array.from(listeners)) listener();
      }
    }
  };

  const scheduleDrain = (): Promise<void> => {
    const next = draining.then(drain, drain);
    draining = next.catch(() => {});
    return next;
  };

  const controller = new WhatsAppSessionController({
    ...localDeployment({
      accountId: options.accountId,
      directory: options.dataDirectory,
      logLevel: options.logLevel,
    }),
    acceptedSource: {
      async start(nextSource) {
        source = nextSource;
        active = true;
        await scheduleDrain();
      },
      wake: scheduleDrain,
      async stop() {
        active = false;
        await draining;
        source = undefined;
      },
    },
  });

  return {
    async start() {
      await controller.attach();
    },

    async sendText(chatId, text) {
      sends += 1;
      // Unique per invocation: peer pings are genuinely new operations, and the
      // durable queue outlives the process, so a static key would collide.
      await controller.sendText(
        chatId,
        text,
        `peer:${options.accountId}:${sends}:${crypto.randomUUID()}`,
      );
    },

    waitForText(match, timeoutMs) {
      const existing = received.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          rejectPromise(new Error(`no matching peer message within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = () => {
          const message = received.find(match);
          if (!message) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolvePromise(message);
        };
        listeners.add(listener);
      });
    },

    async stop() {
      await controller.dispose();
    },
  };
}
