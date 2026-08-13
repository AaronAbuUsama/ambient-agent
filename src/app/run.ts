import { createAmbient } from "./ambient";
import type { AppConfig } from "./config";

/** The daemon process loop shared by `pnpm start` and bare `ambient`. */
export async function runAmbientProcess(config: AppConfig): Promise<void> {
  const ambient = await createAmbient(config);

  const signal = new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  try {
    await ambient.start();
    console.info(`Ambient connected WhatsApp account "${config.whatsapp.accountId}"`);

    const outcome = await Promise.race([
      signal.then((received) => ({ kind: "signal" as const, received })),
      ambient.wait().then((exit) => ({ kind: "ambient" as const, exit })),
    ]);
    if (outcome.kind === "ambient") {
      if (outcome.exit.kind === "failed") throw outcome.exit.error;
    } else {
      console.info(`Received ${outcome.received}; stopping Ambient`);
    }
  } finally {
    await ambient.stop();
  }
}
