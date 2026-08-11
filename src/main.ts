import { createAmbient } from "./app/ambient";
import { loadAppConfig } from "./app/config";
import { WhatsAppSessionController } from "./whatsapp/session/controller";
import { localDeployment } from "./whatsapp/session/local-deployment";

const config = loadAppConfig();
const whatsapp = new WhatsAppSessionController(
  localDeployment({
    accountId: config.whatsapp.accountId,
    directory: config.whatsapp.dataDirectory,
    historyBackfillLimit: config.whatsapp.historyBackfillLimit,
    logLevel: config.logging.level,
  }),
);
const ambient = createAmbient({ whatsapp });
let shuttingDown = false;

function nextShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function unexpectedWhatsAppDetachment(): Promise<Error> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const changed = () => {
      const snapshot = whatsapp.getSnapshot();
      if (snapshot.attachment !== "detached") return;

      unsubscribe();
      resolve(
        new Error(
          snapshot.error
            ? `WhatsApp detached unexpectedly: ${snapshot.error}`
            : "WhatsApp detached unexpectedly",
        ),
      );
    };

    unsubscribe = whatsapp.subscribe(changed);
    changed();
  });
}

const signal = nextShutdownSignal();

try {
  await ambient.start();
  console.info(`Ambient connected WhatsApp account "${config.whatsapp.accountId}"`);

  void whatsapp
    .waitForHistoryBackfill()
    .then((progress) => {
      console.info(
        `WhatsApp history backfill ${progress.state}: ${progress.messages} messages across ${progress.done}/${progress.total} chats`,
      );
    })
    .catch((error: unknown) => {
      if (!shuttingDown) console.error("WhatsApp history backfill failed", error);
    });

  const outcome = await Promise.race([
    signal.then((received) => ({ kind: "signal" as const, received })),
    unexpectedWhatsAppDetachment().then((error) => ({ kind: "failure" as const, error })),
  ]);
  if (outcome.kind === "failure") throw outcome.error;
  console.info(`Received ${outcome.received}; stopping Ambient`);
} finally {
  shuttingDown = true;
  await ambient.stop();
}
