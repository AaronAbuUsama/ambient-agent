import { join } from "node:path";
import { createOperationalLogger, muzzleLibsignalConsole } from "../platform/logging";
import { createAmbient } from "./ambient";
import type { AppConfig } from "./config";
import { createOperationalLog } from "./operational-log";

/** The daemon process loop shared by `pnpm start` and bare `ambient`. */
export async function runAmbientProcess(config: AppConfig): Promise<void> {
  muzzleLibsignalConsole();
  // The operational voice is never quieter than info — that is its whole
  // purpose — but follows configuration into debug. The session logger keeps
  // its own (warn-default) level.
  const level = config.logging.level === "debug" ? "debug" : "info";
  const log = createOperationalLog(
    createOperationalLogger(join(config.home, "state", "logs", "ambient.log"), level),
  );
  const ambient = await createAmbient(config, { log });

  const signal = new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  try {
    await ambient.start();
    log.daemonStarted(config.whatsapp.accountId);

    const outcome = await Promise.race([
      signal.then((received) => ({ kind: "signal" as const, received })),
      ambient.wait().then((exit) => ({ kind: "ambient" as const, exit })),
    ]);
    if (outcome.kind === "ambient") {
      if (outcome.exit.kind === "failed") throw outcome.exit.error;
    } else {
      log.stopping(outcome.received);
    }
  } finally {
    await ambient.stop();
  }
}
