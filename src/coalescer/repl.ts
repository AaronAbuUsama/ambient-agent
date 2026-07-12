/**
 * Rung 1 test harness — talk to the REAL voice from your terminal (`pnpm run voice`).
 *
 * You type messages; they flow through the real Coalescer (real wall-clock time,
 * so you feel the debounce + cap) into the real model-backed `aiVoice`. Only the
 * two outermost seams are mocked: Outbound prints to the console instead of
 * WhatsApp, and the Worker is a canned stand-in for the GitHub agent. This exists
 * to exercise the two genuine unknowns — the model's persona/judgment (does it
 * stay quiet on chatter, chime in on something it can help with WITHOUT being
 * @-mentioned, delegate on real work?) and the Effect ↔ AI-SDK seam.
 *
 * Requires a local Codex login (`experimental_chatgpt()` is local-dev only).
 *
 * Commands:
 *   <text>              a message from "you"
 *   /as <name> <text>   a message from another group member (simulate the group)
 *   @bot ... (in text)  address the bot directly → immediate fire (skips the wait)
 *   /help               show this
 *   Ctrl-D              quit
 */
import * as readline from "node:readline";
import { Console, Deferred, Duration, Effect, Layer, Queue, Runtime } from "effect";
import * as Coalescer from "./coalescer.ts";
import { configLayer } from "./config.ts";
import type { IncomingMessage } from "./events.ts";
import { queueEventSource } from "./mocks.ts";
import { Outbound, Worker } from "./ports.ts";
import { aiVoice } from "./voice.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "repl@g.us";

let seq = 0;
/** Turn a typed line into an inbound message. "@bot" anywhere → addresses the bot. */
const toMessage = (text: string, pushName: string): IncomingMessage => ({
  id: `r${++seq}`,
  chatId: CHAT,
  from: `${pushName.toLowerCase()}@s.whatsapp.net`,
  pushName,
  text,
  timestamp: Date.now(),
  isGroup: true,
  fromMe: false,
  live: true,
  mentions: /@bot\b/i.test(text) ? [BOT] : [],
});

/** Parse a line into (pushName, text). `/as <name> <rest>` overrides the sender. */
const parseLine = (line: string): { pushName: string; text: string } | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const as = trimmed.match(/^\/as\s+(\S+)\s+(.*)$/);
  if (as) return { pushName: as[1]!, text: as[2]! };
  return { pushName: "you", text: trimmed };
};

// One-line command reference, shown in the banner and on `/help`.
const USAGE = "<text> · /as <name> <text> · include @bot to address it · /help · Ctrl-D to quit";

// Outbound → the console (what the bot would post to the group).
const consoleOutbound = Layer.succeed(Outbound, {
  reply: (chatId, text) => Console.log(`\n\u{1F916} bot → ${chatId}: ${text}\n`),
  setTyping: (_chatId, on) => Console.log(`   \u{2328}\u{FE0F}  (bot ${on ? "started" : "stopped"} typing)`),
});

// Worker → a canned stand-in for the real GitHub agent, with a small delay so the
// blocking delegate (D1a) — and any "typing" around it — is actually visible.
// (Named `consoleWorker` to avoid shadowing the `cannedWorker` factory exported by mocks.ts.)
const consoleWorker = Layer.succeed(Worker, {
  delegate: (task) =>
    Console.log(`   \u{1F6E0}\u{FE0F}  worker handling: "${task.instruction}"`).pipe(
      Effect.zipRight(Effect.sleep(Duration.seconds(1))),
      Effect.as({ summary: `done: ${task.instruction}` }),
    ),
});

const program = Effect.gen(function* () {
  yield* Console.log(
    [
      "voice REPL — real model, mocked WhatsApp + Worker.",
      `  bot=${BOT}  chat=${CHAT}`,
      "  type a message and watch the voice decide speak / delegate / stay silent.",
      `  ${USAGE}`,
      "",
    ].join("\n"),
  );

  const inbox = yield* Queue.unbounded<IncomingMessage>();
  const services = Layer.mergeAll(
    aiVoice().pipe(Layer.provideMerge(Layer.merge(consoleOutbound, consoleWorker))),
    configLayer({ botIds: [BOT] }),
    queueEventSource(inbox),
  );
  yield* Effect.forkScoped(Coalescer.run.pipe(Effect.provide(services)));

  // Bridge stdin (imperative) into the running Effect program: each line is offered
  // onto the same runtime the Coalescer runs on; Ctrl-D resolves `done` and we exit.
  const runtime = yield* Effect.runtime<never>();
  const done = yield* Deferred.make<void>();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", (line) => {
    if (line.trim() === "/help") {
      console.log(`  ${USAGE}`);
      return;
    }
    const parsed = parseLine(line);
    if (parsed) Runtime.runFork(runtime)(Queue.offer(inbox, toMessage(parsed.text, parsed.pushName)));
  });
  rl.on("close", () => Runtime.runFork(runtime)(Deferred.succeed(done, undefined)));

  yield* Deferred.await(done);
  yield* Console.log("\nbye.");
});

Effect.runPromise(Effect.scoped(program)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
