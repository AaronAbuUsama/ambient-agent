import { createAmbient } from "./app/ambient";
import { loadAppConfig } from "./app/config";

const config = loadAppConfig();
const ambient = await createAmbient(config);

function nextShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const signal = nextShutdownSignal();

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
