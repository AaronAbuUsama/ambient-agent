import { openSync, writeSync } from "node:fs";
import pino, { type Logger } from "pino";

/**
 * Fields the session log censors.
 *
 * @remarks
 * A copy of `whatsappd`'s own default-logger list, which it does not export.
 * Supplying a logger replaces theirs wholesale — redaction included — so a
 * workbench that only wanted to move the destination would otherwise start
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
 * @remarks
 * `whatsappd` defaults to a `pino` logger on file descriptor 1 — the same
 * descriptor a full-screen terminal renders into, which is why an unconfigured
 * workbench gets its frames shredded by the first Baileys warning. Standard
 * error is no better: it is the same terminal. A file is the only destination
 * that is not the screen.
 *
 * Synchronous by choice: at `warn` the volume is a line an hour, and the line
 * worth having is the one written just before the process died.
 */
export function createSessionLogger(file: string): Logger {
  return pino(
    {
      level: process.env.WA_LOG_LEVEL ?? "warn",
      redact: { paths: redactedPaths },
    },
    pino.destination({ dest: file, mkdir: true, sync: true }),
  );
}

/**
 * Divert everything else this process prints into the same file.
 *
 * @returns The restore, which must run before the process reports anything a
 * human should read on the terminal.
 *
 * @remarks
 * Call this *after* the renderer exists. OpenTUI keeps a private reference to
 * the real `write` and pushes every frame through that, so a wrapper installed
 * afterwards catches library output and never the UI. Installed before the
 * renderer, the same wrapper would swallow the frames instead.
 *
 * The renderer's console overlay already intercepts `console.*`; this covers
 * what it cannot — direct descriptor writes from native modules, and Node's own
 * process warnings, which reach the terminal without passing through `console`.
 */
export function captureStrayOutput(file: string): () => void {
  const fd = openSync(file, "a");
  const restores = (["stdout", "stderr"] as const).map((name) => {
    const stream = process[name];
    // Bound, because what goes back on the stream is a value this module has
    // held for a while, and a stream write that lost its receiver fails in a
    // place nobody would connect to this line.
    const original = stream.write.bind(stream);
    stream.write = ((
      chunk: string | Uint8Array,
      encoding?: unknown,
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      writeSync(fd, `${new Date().toISOString()} [${name}] ${text}`);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done(null);
      return true;
    }) as typeof stream.write;
    return () => {
      stream.write = original;
    };
  });

  return () => {
    for (const restore of restores) restore();
  };
}
