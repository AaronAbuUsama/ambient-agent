import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryBackend } from "whatsappd";
import { createTestWhatsAppSession, textMessage } from "whatsappd/testing";
import { openAmbientDatabase } from "../database/database";
import type { MessageIngestionRepository } from "../database/message-ingestion";
import { mapLiveWhatsAppMessage, whatsAppTextMessagePayloadSchema } from "./observation-mapper";
import { createWhatsAppAcceptedSourceConsumer } from "./message-ingestion";
import { WhatsAppSessionController } from "./session/controller";

test("concurrent ingestion accepts one Observation and one Inbox item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-whatsapp-concurrent-"));
  const database = await openAmbientDatabase(`file:${join(directory, "ambient.db")}`);
  const message = textMessage({
    id: "concurrent-message",
    chatId: "person@s.whatsapp.net",
    text: "Only once",
    timestamp: Date.parse("2026-08-11T09:00:00.000Z"),
  });

  try {
    const observation = mapLiveWhatsAppMessage("main", message)!;
    const results = (
      await Promise.all([
        database.repositories.messageIngestion.retainBatch({
          accountId: "main",
          seq: 1,
          observations: [observation],
        }),
        database.repositories.messageIngestion.retainBatch({
          accountId: "main",
          seq: 1,
          observations: [observation],
        }),
      ])
    ).flat();

    expect(results.filter((result) => result.observationAccepted)).toHaveLength(1);
    expect(results.filter((result) => result.inboxAccepted)).toHaveLength(1);
    expect(await database.repositories.inbox.pending(message.chatId)).toHaveLength(1);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one WhatsApp message is retained and queued exactly once across replay and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-whatsapp-ingestion-"));
  const url = `file:${join(directory, "ambient.db")}`;
  const message = textMessage({
    id: "message-1",
    chatId: "person@s.whatsapp.net",
    sender: "15551234567@s.whatsapp.net",
    text: "Please remember this",
    timestamp: Date.parse("2026-08-11T10:00:00.000Z"),
  });
  const backend = memoryBackend();

  try {
    const database = await openAmbientDatabase(url);
    const driver = createTestWhatsAppSession();
    const retained = Promise.withResolvers<void>();
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      "main",
      database.repositories.messageIngestion,
      () => retained.resolve(),
    );
    const session = new WhatsAppSessionController({
      accountId: "main",
      createBackend: () => backend,
      openSession: () => driver.session,
      acceptedSource,
    });

    try {
      await session.attach();
      await driver.emit({ type: "message", message });
      await retained.promise;
      await driver.emit({ type: "message", message });
      await acceptedSource.wake();

      const pending = await database.repositories.inbox.pending(message.chatId);
      expect(pending).toHaveLength(1);
      const observation = await database.repositories.observations.get(pending[0]!.referenceId);
      expect(observation).toMatchObject({
        source: "whatsapp",
        accountId: "main",
        conversationId: message.chatId,
        occurredAt: "2026-08-11T10:00:00.000Z",
        kind: "message",
      });
      expect(whatsAppTextMessagePayloadSchema.parse(observation?.payload)).toMatchObject({
        messageId: "message-1",
        text: "Please remember this",
      });
      expect(driver.commands.sent).toEqual([]);
    } finally {
      await session.dispose();
      await database.close();
    }

    const restartedDatabase = await openAmbientDatabase(url);
    const restartedDriver = createTestWhatsAppSession();
    const restartedAcceptedSource = createWhatsAppAcceptedSourceConsumer(
      "main",
      restartedDatabase.repositories.messageIngestion,
    );
    const restartedSession = new WhatsAppSessionController({
      accountId: "main",
      createBackend: () => backend,
      openSession: () => restartedDriver.session,
      acceptedSource: restartedAcceptedSource,
    });

    try {
      await restartedSession.attach();
      await restartedDriver.emit({ type: "message", message });
      await restartedAcceptedSource.wake();

      expect(await restartedDatabase.repositories.inbox.pending(message.chatId)).toHaveLength(1);
      expect(restartedDriver.commands.sent).toEqual([]);
    } finally {
      await restartedSession.dispose();
      await restartedDatabase.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh Ambient cursor watermarks existing source history without waking Conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-whatsapp-watermark-"));
  const database = await openAmbientDatabase(`file:${join(directory, "ambient.db")}`);
  const backend = memoryBackend();
  const historicalDriver = createTestWhatsAppSession();
  const historicalSession = new WhatsAppSessionController({
    accountId: "main",
    createBackend: () => backend,
    openSession: () => historicalDriver.session,
  });

  try {
    try {
      await historicalSession.attach();
      await historicalDriver.emit({
        type: "message",
        message: textMessage({
          id: "historical-message",
          chatId: "person@s.whatsapp.net",
          text: "Already accepted before Ambient ingestion",
        }),
      });
    } finally {
      await historicalSession.dispose();
    }

    const liveRetained = Promise.withResolvers<void>();
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      "main",
      database.repositories.messageIngestion,
      () => liveRetained.resolve(),
    );
    const liveDriver = createTestWhatsAppSession();
    const liveSession = new WhatsAppSessionController({
      accountId: "main",
      createBackend: () => backend,
      openSession: () => liveDriver.session,
      acceptedSource,
    });

    try {
      await liveSession.attach();
      expect(await database.repositories.inbox.pending("person@s.whatsapp.net")).toEqual([]);
      const cursor = await database.repositories.messageIngestion.cursor("main");
      expect(cursor?.state).toBe("active");
      expect(cursor?.afterSeq).toBeGreaterThanOrEqual(1);

      await liveDriver.emit({
        type: "message",
        message: textMessage({
          id: "new-live-message",
          chatId: "person@s.whatsapp.net",
          text: "Wake Ambient now",
        }),
      });
      await liveRetained.promise;

      expect(await database.repositories.inbox.pending("person@s.whatsapp.net")).toHaveLength(1);
    } finally {
      await liveSession.dispose();
    }
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a committed source message replays after Ambient persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-whatsapp-recovery-"));
  const database = await openAmbientDatabase(`file:${join(directory, "ambient.db")}`);
  const backend = memoryBackend();
  const repository = database.repositories.messageIngestion;
  let rejectNextMessage = true;
  const flakyRepository: MessageIngestionRepository = {
    cursor: (accountId) => repository.cursor(accountId),
    activate: (accountId, afterSeq) => repository.activate(accountId, afterSeq),
    retainBatch: (input) => {
      if (rejectNextMessage && input.observations.length > 0) {
        rejectNextMessage = false;
        return Promise.reject(new Error("simulated Ambient write failure"));
      }
      return repository.retainBatch(input);
    },
  };
  const failingDriver = createTestWhatsAppSession();
  const failingSession = new WhatsAppSessionController({
    accountId: "main",
    createBackend: () => backend,
    openSession: () => failingDriver.session,
    acceptedSource: createWhatsAppAcceptedSourceConsumer("main", flakyRepository),
  });

  try {
    await failingSession.attach();
    await failingDriver.emit({
      type: "message",
      message: textMessage({
        id: "recoverable-message",
        chatId: "person@s.whatsapp.net",
        text: "Persist me after restart",
      }),
    });

    for (let turn = 0; turn < 100; turn += 1) {
      if (failingSession.getSnapshot().attachment === "detached") break;
      await Promise.resolve();
    }
    expect(failingSession.getSnapshot()).toMatchObject({
      attachment: "detached",
      error: "simulated Ambient write failure",
    });
    await failingSession.dispose();

    const recovered = Promise.withResolvers<void>();
    const recoveringSession = new WhatsAppSessionController({
      accountId: "main",
      createBackend: () => backend,
      openSession: () => createTestWhatsAppSession().session,
      acceptedSource: createWhatsAppAcceptedSourceConsumer("main", repository, () =>
        recovered.resolve(),
      ),
    });
    try {
      await recoveringSession.attach();
      await recovered.promise;
      expect(await database.repositories.inbox.pending("person@s.whatsapp.net")).toHaveLength(1);
    } finally {
      await recoveringSession.dispose();
    }
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
