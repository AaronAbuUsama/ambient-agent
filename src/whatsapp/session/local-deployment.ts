import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSession, fileMediaStore, libsqlBackend, qrAuth } from "whatsappd";
import { createSessionLogger } from "../../platform/logging";
import type { WhatsAppSessionOptions } from "./controller";

/** Where one account's credentials, mirror database, media bytes, and log live. */
export interface DeploymentPaths {
  readonly directory: string;
  readonly databaseUrl: string;
  readonly mediaDirectory: string;
  /** Everything this process would otherwise print over the running UI. */
  readonly logFile: string;
}

export function deploymentPaths(directory = "./data"): DeploymentPaths {
  const root = resolve(directory);
  return {
    directory: root,
    // A local `file:` database opens in WAL, so `whatsapp.db-wal` and
    // `whatsapp.db-shm` sit beside it — move, copy, or delete the three together.
    databaseUrl: `file:${join(root, "whatsapp.db")}`,
    mediaDirectory: join(root, "media"),
    logFile: join(root, "whatsapp.log"),
  };
}

/**
 * The durable local deployment: libSQL for structured state, files for bytes.
 *
 * @param accountId - Scopes every durable record, and the single-writer lease
 * that stops two processes from opening the same account.
 */
export interface LocalDeploymentOptions {
  readonly accountId: string;
  readonly directory?: string;
  readonly historyBackfillLimit?: number;
  readonly logLevel?: string;
}

export function localDeployment({
  accountId,
  directory,
  historyBackfillLimit,
  logLevel,
}: LocalDeploymentOptions): WhatsAppSessionOptions {
  const paths = deploymentPaths(directory);
  // One logger for the deployment, not one per attach: every reconnect builds a
  // fresh Session, and a destination per Session is a file descriptor per
  // reconnect.
  const logger = createSessionLogger(paths.logFile, logLevel);
  return {
    accountId,
    historyBackfillLimit,
    createBackend: async () => {
      await mkdir(paths.mediaDirectory, { recursive: true });
      return libsqlBackend({
        url: paths.databaseUrl,
        accountId,
        media: fileMediaStore({ directory: paths.mediaDirectory }),
      });
    },
    openSession: (credentials) => createSession({ store: credentials, auth: qrAuth(), logger }),
  };
}
