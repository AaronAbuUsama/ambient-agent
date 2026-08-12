import { expect, test } from "vite-plus/test";
import { memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { WhatsAppSessionController } from "./controller";

test("an attached account completes an uncapped full-mirror history pass", async () => {
  const driver = createTestWhatsAppSession();
  const session = new WhatsAppSessionController({
    accountId: "history-backfill",
    createBackend: () => memoryBackend(),
    openSession: () => driver.session,
  });

  try {
    await session.attach();
    const progress = await session.waitForHistoryBackfill();

    expect(progress).toEqual({
      done: 0,
      total: 0,
      messages: 0,
      state: "complete",
    });
    expect(session.getSnapshot().historyBackfill).toEqual(progress);
  } finally {
    await session.dispose();
  }
});

test("a terminal WhatsApp session is torn down and surfaced as detached", async () => {
  const driver = createTestWhatsAppSession();
  const session = new WhatsAppSessionController({
    accountId: "terminal-session",
    createBackend: () => memoryBackend(),
    openSession: () => driver.session,
  });

  try {
    await session.attach();
    await driver.session.stop();

    for (let turn = 0; turn < 100; turn += 1) {
      if (session.getSnapshot().attachment === "detached") break;
      await Promise.resolve();
    }

    expect(session.getSnapshot().attachment).toBe("detached");
  } finally {
    await session.dispose();
  }
});

test("an unexpected terminal session resolves the failure boundary", async () => {
  const driver = createTestWhatsAppSession();
  const session = new WhatsAppSessionController({
    accountId: "terminal-failure",
    createBackend: () => memoryBackend(),
    openSession: () => driver.session,
  });

  try {
    await session.attach();
    const failure = session.waitForFailure();
    await driver.session.stop();

    await expect(failure).resolves.toEqual({
      error: new Error("WhatsApp detached unexpectedly"),
    });
  } finally {
    await session.dispose();
  }
});

test("an attached account follows committed accepted-source changes", async () => {
  const driver = createTestWhatsAppSession();
  let starts = 0;
  let wakes = 0;
  let stops = 0;
  const session = new WhatsAppSessionController({
    accountId: "message-consumer",
    createBackend: () => memoryBackend(),
    openSession: () => driver.session,
    acceptedSource: {
      start: () => {
        starts += 1;
        return Promise.resolve();
      },
      wake: () => {
        wakes += 1;
        return Promise.resolve();
      },
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    },
  });

  try {
    await session.attach();
    const wakesBeforeMessage = wakes;
    await driver.emit({
      type: "message",
      message: textMessage({
        id: "message-1",
        chatId: "person@s.whatsapp.net",
        text: "Retain me",
      }),
    });

    expect(starts).toBe(1);
    expect(wakes).toBeGreaterThan(wakesBeforeMessage);
  } finally {
    await session.dispose();
  }
  expect(stops).toBe(1);
});

test("loopback sends resolve the linked account and use durable operations", async () => {
  const driver = createTestWhatsAppSession({
    identity: {
      jid: "15551234567:12@s.whatsapp.net",
      phoneE164: "+15551234567",
    },
  });
  const session = new WhatsAppSessionController({
    accountId: "loopback-send",
    createBackend: () => memoryBackend(),
    openSession: () => driver.session,
  });

  try {
    await session.attach();
    const loopback = session.loopbackAddress();
    expect(loopback).toBe("15551234567@s.whatsapp.net");
    const operation = await session.sendText(loopback!, "Loopback only", "proof:loopback:1");
    expect(operation.input).toMatchObject({
      type: "send",
      chatId: loopback,
      content: { text: "Loopback only" },
    });
    expect(operation.idempotencyKey).toBe("proof:loopback:1");
  } finally {
    await session.dispose();
  }
});
