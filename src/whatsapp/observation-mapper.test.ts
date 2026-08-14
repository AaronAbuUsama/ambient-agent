import { expect, test } from "vite-plus/test";
import type { DurableInboundMessage } from "whatsappd";
import { textMessage } from "whatsappd/testing";
import {
  mapLiveWhatsAppMessage,
  whatsAppMessageNativeId,
  whatsAppLiveMessagePayloadSchema,
} from "./observation-mapper";

type DurableMedia = Extract<
  DurableInboundMessage,
  { kind: "image" | "video" | "audio" | "document" | "sticker" }
>["media"];

/** A live inbound image, as whatsappd hands it over once its bytes are stored. */
function imageMessage(media: DurableMedia): DurableInboundMessage {
  return {
    id: "message:image",
    chatId: "group@g.us",
    sender: { id: "15551234567@s.whatsapp.net", mode: "pn" },
    fromMe: false,
    timestamp: Date.parse("2026-08-14T10:00:00.000Z"),
    live: true,
    isGroup: true,
    kind: "image",
    media,
  };
}

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
  expect(whatsAppLiveMessagePayloadSchema.parse(observation?.payload)).toEqual(
    observation?.payload,
  );
});

test("retains a live image with its store ref, mimetype, and caption", () => {
  const observation = mapLiveWhatsAppMessage(
    "main",
    imageMessage({
      state: "stored",
      ref: "media:v1:abc123",
      byteLength: 69518,
      mimetype: "image/jpeg",
      caption: "Fajr time android",
    }),
  );

  const payload = whatsAppLiveMessagePayloadSchema.parse(observation?.payload);
  expect(payload).toMatchObject({
    kind: "image",
    media: {
      ref: "media:v1:abc123",
      mimetype: "image/jpeg",
      caption: "Fajr time android",
      byteLength: 69518,
    },
  });
  expect(observation?.conversationId).toBe("group@g.us");
});

test("retains a caption even when WhatsApp could not store the bytes", () => {
  const observation = mapLiveWhatsAppMessage(
    "main",
    imageMessage({
      state: "failed",
      reason: "download_failed",
      mimetype: "image/jpeg",
      caption: "The android still says Asr is approaching",
    }),
  );

  const payload = whatsAppLiveMessagePayloadSchema.parse(observation?.payload);
  expect(payload).toMatchObject({
    kind: "image",
    media: { caption: "The android still says Asr is approaching" },
  });
  // No ref means no bytes exist to describe — absence must be representable.
  expect("media" in payload && payload.media.ref).toBeUndefined();
});

test("still ignores kinds whose bytes WhatsApp does not store", () => {
  const location: DurableInboundMessage = {
    id: "message:location",
    chatId: "group@g.us",
    sender: { id: "15551234567@s.whatsapp.net", mode: "pn" },
    fromMe: false,
    timestamp: Date.parse("2026-08-14T10:00:00.000Z"),
    live: true,
    isGroup: true,
    kind: "location",
    lat: 51.5074,
    lng: -0.1278,
  };

  expect(mapLiveWhatsAppMessage("main", location)).toBeUndefined();
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
