import { expect, test } from "vite-plus/test";
import { createAmbientLifecycle } from "./lifecycle";

test("Ambient starts and stops its WhatsApp dependency once", async () => {
  let attaches = 0;
  let disposes = 0;
  let closes = 0;
  const ambient = createAmbientLifecycle({
    database: {
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    },
    whatsapp: {
      attach: () => {
        attaches += 1;
        return Promise.resolve();
      },
      dispose: () => {
        disposes += 1;
        return Promise.resolve();
      },
      waitForFailure: () => new Promise(() => {}),
    },
  });

  await Promise.all([ambient.start(), ambient.start()]);
  await Promise.all([ambient.stop(), ambient.stop()]);

  expect(attaches).toBe(1);
  expect(disposes).toBe(1);
  expect(closes).toBe(1);

  let restartError: unknown;
  try {
    await ambient.start();
  } catch (error) {
    restartError = error;
  }
  expect(restartError).toEqual(new Error("Ambient has stopped"));
});

test("Ambient wait resolves when WhatsApp detaches unexpectedly", async () => {
  const failure = Promise.withResolvers<{ readonly error: Error }>();
  const ambient = createAmbientLifecycle({
    database: { close: () => Promise.resolve() },
    whatsapp: {
      attach: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
      waitForFailure: () => failure.promise,
    },
  });

  await ambient.start();
  failure.resolve({ error: new Error("WhatsApp detached unexpectedly: connection lost") });

  await expect(ambient.wait()).resolves.toEqual({
    kind: "failed",
    error: new Error("WhatsApp detached unexpectedly: connection lost"),
  });
  await ambient.stop();
});

test("Ambient wait resolves as stopped during an intentional shutdown", async () => {
  const ambient = createAmbientLifecycle({
    database: { close: () => Promise.resolve() },
    whatsapp: {
      attach: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
      waitForFailure: () => new Promise(() => {}),
    },
  });

  await ambient.start();
  await ambient.stop();

  await expect(ambient.wait()).resolves.toEqual({ kind: "stopped" });
});

test("Ambient wait resolves as failed when shutdown cleanup rejects", async () => {
  const cleanupError = new Error("conversation stop failed");
  let whatsappDisposes = 0;
  let databaseCloses = 0;
  const ambient = createAmbientLifecycle({
    database: {
      close() {
        databaseCloses += 1;
        return Promise.resolve();
      },
    },
    whatsapp: {
      attach: () => Promise.resolve(),
      dispose() {
        whatsappDisposes += 1;
        return Promise.resolve();
      },
      waitForFailure: () => new Promise(() => {}),
    },
    conversation: {
      start: () => Promise.resolve(),
      stop: () => Promise.reject(cleanupError),
    },
  });

  await ambient.start();
  await expect(ambient.stop()).rejects.toBe(cleanupError);
  await expect(ambient.wait()).resolves.toEqual({ kind: "failed", error: cleanupError });
  expect(whatsappDisposes).toBe(1);
  expect(databaseCloses).toBe(1);
});

test("Ambient does not start Conversation after WhatsApp fails during startup", async () => {
  const failure = Promise.withResolvers<{ readonly error: Error }>();
  let conversationStarts = 0;
  const ambient = createAmbientLifecycle({
    database: { close: () => Promise.resolve() },
    whatsapp: {
      attach: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
      waitForFailure: () => failure.promise,
    },
    conversation: {
      start() {
        conversationStarts += 1;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    },
  });

  const starting = ambient.start();
  failure.resolve({ error: new Error("connection lost") });
  await Promise.resolve();
  await starting;

  expect(conversationStarts).toBe(0);
  await ambient.stop();
});

test("Ambient does not start Conversation when shutdown is requested during attach", async () => {
  const attached = Promise.withResolvers<void>();
  let conversationStarts = 0;
  const ambient = createAmbientLifecycle({
    database: { close: () => Promise.resolve() },
    whatsapp: {
      attach: () => attached.promise,
      dispose: () => Promise.resolve(),
      waitForFailure: () => new Promise(() => {}),
    },
    conversation: {
      start() {
        conversationStarts += 1;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    },
  });

  const starting = ambient.start();
  const stopping = ambient.stop();
  attached.resolve();
  await Promise.all([starting, stopping]);

  expect(conversationStarts).toBe(0);
});
