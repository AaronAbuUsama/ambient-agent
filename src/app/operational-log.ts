import type { Logger } from "pino";

/**
 * The daemon's voice: a closed, typed event vocabulary — the ONLY birthplace
 * of operational log lines. Free-form logging has no API here, so a new line
 * is always a deliberate one-file change, formatted once and levelled once.
 * Chats always render as slugs, never raw ids.
 */
export interface OperationalLog {
  daemonStarted(account: string): void;
  stopping(reason: string): void;
  messageReceived(chat: string): void;
  replySent(chat: string): void;
  memoryDigested(chat: string, claims: number): void;
  runFailed(chat: string, error: string): void;
  mandatesChanged(summary: string): void;
  chatBroken(slug: string, problem: string): void;
}

/** The default for tests and callers that have nothing to say. */
export const silentOperationalLog: OperationalLog = {
  daemonStarted() {},
  stopping() {},
  messageReceived() {},
  replySent() {},
  memoryDigested() {},
  runFailed() {},
  mandatesChanged() {},
  chatBroken() {},
};

export function createOperationalLog(logger: Logger): OperationalLog {
  return {
    daemonStarted: (account) => logger.info(`ambient online (account: ${account})`),
    stopping: (reason) => logger.info(`stopping (${reason})`),
    messageReceived: (chat) => logger.info(`→ ${chat}: message received`),
    replySent: (chat) => logger.info(`← ${chat}: reply sent`),
    memoryDigested: (chat, claims) => logger.info(`~ ${chat}: memory digested (${claims} claims)`),
    runFailed: (chat, error) => logger.error(`✗ ${chat}: run failed — ${error}`),
    mandatesChanged: (summary) => logger.info(`mandates: ${summary}`),
    chatBroken: (slug, problem) => logger.warn(`✗ chat ${slug}: ${problem}`),
  };
}
