import type { ProjectedConversationMessage } from "../../intake/conversation-archive.ts";

export type WhatsAppSayResult =
  | { readonly delivery: "sent"; readonly messageId: string; readonly typing: "cleared" }
  | {
      readonly delivery: "sent";
      readonly messageId: string;
      readonly typing: "unknown";
      readonly typingError: string;
    }
  | {
      readonly delivery: "failed";
      readonly deliveryError: string;
      readonly typing: "cleared";
    }
  | {
      readonly delivery: "failed";
      readonly deliveryError: string;
      readonly typing: "unknown";
      readonly typingError: string;
    }
  | {
      readonly delivery: "unknown";
      readonly deliveryError: string;
      readonly typing: "cleared";
    }
  | {
      readonly delivery: "unknown";
      readonly deliveryError: string;
      readonly typing: "unknown";
      readonly typingError: string;
    };

export interface WhatsAppSayPort {
  /** Own the full typing/send/finalization attempt and report observed state without retrying. */
  readonly say: (chatId: string, text: string) => Promise<WhatsAppSayResult>;
}

export interface WhatsAppHistoryPort {
  readThread(chatId: string, limit?: number): readonly ProjectedConversationMessage[];
  search(chatId: string, query: string, limit?: number): readonly ProjectedConversationMessage[];
}

export interface WhatsAppParticipationPort extends WhatsAppSayPort, WhatsAppHistoryPort {}

let configuredPort: WhatsAppParticipationPort | undefined;

export const configureWhatsAppParticipationPort = (port: WhatsAppParticipationPort): void => {
  configuredPort = port;
};

export const getWhatsAppParticipationPort = (): WhatsAppParticipationPort => {
  if (configuredPort === undefined) {
    throw new Error("The WhatsApp Participation port is not configured for Ambience.");
  }
  return configuredPort;
};
