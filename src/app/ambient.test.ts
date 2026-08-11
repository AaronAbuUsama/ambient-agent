import { expect, test } from "vite-plus/test";
import { createAmbient } from "./ambient";

test("Ambient starts and stops its WhatsApp dependency once", async () => {
  let attaches = 0;
  let disposes = 0;
  let closes = 0;
  const ambient = createAmbient({
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
