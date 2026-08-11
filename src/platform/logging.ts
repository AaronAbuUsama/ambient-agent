import pino, { type Logger } from "pino";

/**
 * Fields the session log censors.
 *
 * @remarks
 * A copy of `whatsappd`'s own default-logger list, which it does not export.
 * Supplying a logger replaces theirs wholesale — redaction included — so a
 * deployment that only wanted to move the destination would otherwise start
 * writing message bodies, recipients, and auth tokens to disk. The two log
 * sites that matter both pass `{ err }` from Baileys or a socket, whose shape
 * is not ours to choose.
 */
const redactedPaths = [
  "*.text",
  "*.body",
  "*.caption",
  "*.message",
  "err.data.text",
  "err.data.body",
  "err.data.caption",
  "*.jid",
  "*.to",
  "*.from",
  "*.sender",
  "*.remoteJid",
  "*.participant",
  "err.data.to",
  "err.data.from",
  "err.data.jid",
  "*.authorization",
  "*.token",
  "*.authToken",
  "*.creds",
  "*.keys",
  "*.password",
  "authorization",
  "token",
  "authToken",
  "creds",
  "keys",
  "password",
  "err.config.headers.authorization",
  "err.config.headers.cookie",
];

/**
 * The logger the WhatsApp session and Baileys write through.
 *
 * @param file - Where the lines land. Created if missing.
 *
 * Synchronous by choice: at `warn` the volume is a line an hour, and the line
 * worth having is the one written just before the process died.
 */
export function createSessionLogger(file: string, level = "warn"): Logger {
  return pino(
    {
      level,
      redact: { paths: redactedPaths },
    },
    pino.destination({ dest: file, mkdir: true, sync: true }),
  );
}
