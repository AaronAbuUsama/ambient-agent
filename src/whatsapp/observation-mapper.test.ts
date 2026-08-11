import { expect, test } from "vite-plus/test";
import { textMessage } from "whatsappd/testing";
import {
  mapLiveWhatsAppMessage,
  whatsAppMessageNativeId,
  whatsAppTextMessagePayloadSchema,
} from "./observation-mapper";

test("maps one live incoming text message into a stable Ambient observation", () => {
  const message = textMessage({
    id: "message:1",
    chatId: "person@s.whatsapp.net",
    sender: "15551234567@s.whatsapp.net",
    text: "Hello Ambient",
    timestamp: Date.parse("2026-08-11T10:00:00.000Z"),
  });

  const observation = mapLiveWhatsAppMessage("main", message);

  expect(observation).toEqual({
    source: "whatsapp",
    accountId: "main",
    nativeId: whatsAppMessageNativeId(message.chatId, message.id),
    conversationId: "person@s.whatsapp.net",
    occurredAt: "2026-08-11T10:00:00.000Z",
    kind: "message",
    payload: expect.objectContaining({
      version: 1,
      messageId: "message:1",
      chatId: "person@s.whatsapp.net",
      fromMe: false,
      live: true,
      text: "Hello Ambient",
    }),
  });
  expect(whatsAppTextMessagePayloadSchema.parse(observation?.payload)).toEqual(
    observation?.payload,
  );
});

test("does not wake Ambient for history or the linked account's own messages", () => {
  expect(
    mapLiveWhatsAppMessage(
      "main",
      textMessage({
        id: "history-message",
        chatId: "person@s.whatsapp.net",
        text: "Old context",
        live: false,
      }),
    ),
  ).toBeUndefined();

  expect(
    mapLiveWhatsAppMessage(
      "main",
      textMessage({
        id: "outbound-message",
        chatId: "person@s.whatsapp.net",
        sender: "15550000000@s.whatsapp.net",
        text: "Already sent",
        fromMe: true,
      }),
    ),
  ).toBeUndefined();
});
