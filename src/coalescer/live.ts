/**
 * Rung 2 — the voice in a REAL WhatsApp chat (`pnpm run live`).
 *
 * Wires the real Coalescer + real model-backed voice to a live whatsappd
 * session: real messages in, real replies out. Only the Worker is still a stub
 * (an honest placeholder) — swapping it for the real `agent/` GitHub agent is
 * Rung 2b (the one Eve doorway). The voice bills the local Codex login, so this
 * is local-dev only, exactly like the REPL.
 *
 * SAFETY: the voice replies for real and engages on relevance, not just when
 * @-mentioned, so a chat gate is mandatory — set WHATSAPP_GROUP_ID (or _IDS) to
 * your test group, or WHATSAPP_ALLOW_DM=true for a solo DM. With nothing set the
 * bot stays fully silent (fail closed).
 *
 * First run prints a QR to link the device; creds persist under WHATSAPP_STORE_DIR
 * (default ./.wa-auth), shared with the `pnpm whatsapp` sidecar.
 */
import { Console, Effect, Layer } from "effect";
import * as Coalescer from "./coalescer.ts";
import { configLayer } from "./config.ts";
import { aiVoice } from "./voice.ts";
import { botIdOf, openSession, whatsappEventSource, whatsappOutbound } from "./whatsapp.ts";
import { githubWorker } from "./worker.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env — use the ambient environment as-is.
}

const STORE_DIR = process.env.WHATSAPP_STORE_DIR ?? "./.wa-auth";

// The bot's `@lid` identity. In a LID-addressed chat, an @-mention of the bot
// carries its `@lid` JID — which `session.identity()` does NOT expose (it only
// gives the phone-number JID), so mentions there never match without this. Set it
// via env for now (auto-detection later); accepts a bare number (we append `@lid`)
// or a full `NNN@lid` JID.
const rawLid = process.env.WHATSAPP_BOT_LID?.trim();
const BOT_LID = rawLid ? (rawLid.includes("@") ? rawLid : `${rawLid}@lid`) : undefined;

// Chat gate — mirrors agent/channels/whatsapp.ts. Fail closed: an unset target
// silences the bot rather than turning it loose on every chat the number is in.
const parseSet = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const GROUPS = parseSet(process.env.WHATSAPP_GROUP_IDS ?? process.env.WHATSAPP_GROUP_ID);
const ALLOW_ANY_GROUP = process.env.WHATSAPP_ALLOW_ANY_GROUP === "true";
const ALLOW_DM = process.env.WHATSAPP_ALLOW_DM === "true";

const chatAllowed = (chatId: string, isGroup: boolean): boolean =>
  isGroup ? (GROUPS.size > 0 ? GROUPS.has(chatId.toLowerCase()) : ALLOW_ANY_GROUP) : ALLOW_DM;

// The voice's persona for this chat: a bug-intake assistant for non-technical QA
// testers of an iOS app. It gathers the details a good bug report needs, then
// delegates to the GitHub worker to file the issue and reports the link back.
const QA_PERSONA = `You're the bug-intake assistant in a WhatsApp group where non-technical QA testers report problems with an iOS app. They don't use GitHub — you file the reports for them.
- When someone describes a problem, gather what a good bug report needs with SHORT, friendly questions: steps to reproduce, what they expected vs. what actually happened, their device + iOS version, and how often it happens. Ask only for what's missing — don't interrogate, and don't ask for things they clearly already gave.
- Once you have enough (or the bug is obvious), call delegate with a clear, structured bug report: a one-line title, then a body with **Steps to reproduce**, **Expected**, **Actual**, **Device/iOS**, and **Frequency**. Then reply with the filed issue's number and link.
- Keep replies short and human — this is a chat, not a form.
- Stay quiet during off-topic chatter. You don't need to be @-mentioned to help.`;

const program = Effect.gen(function* () {
  if (GROUPS.size === 0 && !ALLOW_ANY_GROUP && !ALLOW_DM) {
    yield* Console.warn(
      "⚠️  No chat target set — the bot will stay silent. Set WHATSAPP_GROUP_ID=<jid@g.us> " +
        "(or WHATSAPP_ALLOW_DM=true) and re-run.",
    );
  }
  yield* Console.log(`connecting to WhatsApp (store: ${STORE_DIR})…`);

  const session = yield* openSession(STORE_DIR);
  const botPn = botIdOf(session);
  const botIds = BOT_LID ? [botPn, BOT_LID] : [botPn];
  yield* Console.log(
    `online as ${botPn}${BOT_LID ? ` (lid ${BOT_LID})` : ""} — watching ${
      GROUPS.size > 0 ? [...GROUPS].join(", ") : ALLOW_ANY_GROUP ? "any group" : ALLOW_DM ? "DMs" : "nothing"
    }\n`,
  );

  const services = Layer.mergeAll(
    aiVoice(QA_PERSONA).pipe(Layer.provideMerge(Layer.merge(whatsappOutbound(session), githubWorker))),
    configLayer({ botIds }),
    whatsappEventSource(session, chatAllowed),
  );

  // Runs until the process is killed; the scope's finalizers stop the session.
  yield* Coalescer.run.pipe(Effect.provide(services));
});

Effect.runPromise(Effect.scoped(program)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
