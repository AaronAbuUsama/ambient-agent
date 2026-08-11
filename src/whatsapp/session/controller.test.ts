import { expect, test } from "vite-plus/test";
import { memoryBackend } from "whatsappd";
import { createTestWhatsAppSession } from "whatsappd/testing";
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
