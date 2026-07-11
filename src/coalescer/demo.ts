/**
 * A runnable feel-test for the fast loop, in isolation — `pnpm run coalescer`.
 *
 * Real (wall-clock) time, so you can *feel* the debounce: a heavy burst collapses
 * into one fire, a lull passes, an @-mention jumps the queue, and an ambient
 * aside is heard but stays silent. Everything downstream is mocked (console
 * Outbound, a slow canned Worker); the Coalescer and the voice stub are the real
 * ones from this module. Same wiring as the TestClock suite — only the clock
 * differs.
 */
import { Console, Duration, Effect, Layer, Queue } from "effect";
import * as Coalescer from "./coalescer.ts";
import { configLayer } from "./config.ts";
import type { IncomingMessage } from "./events.ts";
import { queueEventSource } from "./mocks.ts";
import { Conversationalist, Outbound, Worker } from "./ports.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "team@g.us";
const base = Date.now();

/** A scripted inbound: text + who + how long to wait before offering it. */
interface Scripted {
  readonly afterMs: number;
  readonly from: string;
  readonly pushName: string;
  readonly text: string;
  readonly mentionsBot?: boolean;
}

const script: readonly Scripted[] = [
  // Heavy burst — five messages < 3s apart. Expect ONE coalesced fire at the end.
  { afterMs: 0, from: "a", pushName: "Ana", text: "morning all" },
  { afterMs: 400, from: "b", pushName: "Bo", text: "did the deploy go out?" },
  { afterMs: 400, from: "a", pushName: "Ana", text: "think so" },
  { afterMs: 400, from: "c", pushName: "Cy", text: "nice" },
  { afterMs: 400, from: "b", pushName: "Bo", text: "☕️" },
  // Lull, then a direct @-mention → immediate fire, jumps the debounce.
  { afterMs: 5000, from: "b", pushName: "Bo", text: "@bot can you review PR 42?", mentionsBot: true },
  // A lone ambient aside → fires after the window, but the voice stays silent.
  { afterMs: 5000, from: "c", pushName: "Cy", text: "brb lunch" },
];

const toMessage = (s: Scripted, i: number, at: number): IncomingMessage => ({
  id: `m${i}`,
  chatId: CHAT,
  from: `${s.from}@s.whatsapp.net`,
  pushName: s.pushName,
  text: s.text,
  timestamp: base + at,
  isGroup: true,
  fromMe: false,
  live: true,
  mentions: s.mentionsBot ? [BOT] : [],
});

// Console Outbound — the group surface, mocked to stdout.
const consoleOutbound = Layer.succeed(Outbound, {
  reply: (chatId, text) => Console.log(`   \u{1F4AC} reply → ${chatId}: "${text}"`),
  setTyping: (chatId, on) => Console.log(`   ⌨️  typing ${on ? "on" : "off"}`),
});

// A deliberately slow Worker — this is what the blocking delegate (D1a) waits on.
const slowWorker = Layer.succeed(Worker, {
  delegate: (task) =>
    Console.log(`   \u{1F6E0}️  worker: "${task.instruction}" (working…)`).pipe(
      Effect.zipRight(Effect.sleep(Duration.seconds(2))),
      Effect.as({ summary: `reviewed ${task.instruction.match(/pr \d+/i)?.[0] ?? "it"} — LGTM` }),
    ),
});

// The voice: logs each fire (so you can see *when* the Coalescer wakes it), then
// applies the same self-gating policy as the test stub.
const loggingVoice: Layer.Layer<Conversationalist, never, Outbound | Worker> = Layer.effect(
  Conversationalist,
  Effect.gen(function* () {
    const outbound = yield* Outbound;
    const worker = yield* Worker;
    return {
      turn: (window) =>
        Effect.gen(function* () {
          const secs = ((Date.now() - base) / 1000).toFixed(1);
          yield* Console.log(
            `\u{1F514} [t+${secs}s] FIRE (${window.reason}) — ${window.messages.length} msg(s): ` +
              window.messages.map((m) => `${m.pushName}:"${m.text}"`).join(" | "),
          );
          if (window.reason === "debounce") {
            yield* Console.log("   \u{1F92B} (ambient — staying silent)");
            return;
          }
          const last = window.messages[window.messages.length - 1]!;
          yield* outbound.setTyping(window.chatId, true);
          const result = yield* worker
            .delegate({ chatId: window.chatId, instruction: last.text })
            .pipe(Effect.catchAll((err) => Effect.succeed({ summary: `couldn't do that: ${String(err)}` })));
          yield* outbound.reply(window.chatId, `on it — ${result.summary}`);
          yield* outbound.setTyping(window.chatId, false);
        }),
    };
  }),
);

const main = Effect.gen(function* () {
  yield* Console.log(`coalescer demo — bot=${BOT}, chat=${CHAT}, debounce=3s\n`);
  const inbox = yield* Queue.unbounded<IncomingMessage>();

  const services = Layer.mergeAll(
    loggingVoice.pipe(Layer.provideMerge(Layer.merge(consoleOutbound, slowWorker))),
    configLayer({ botId: BOT, debounceWindow: Duration.seconds(3) }),
    queueEventSource(inbox),
  );

  // Feed the script in the background at real-time offsets.
  yield* Effect.forkScoped(
    Effect.forEach(
      script,
      (s, i) =>
        Effect.sleep(Duration.millis(s.afterMs)).pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              const at = Date.now() - base;
              return Console.log(`\u{1F4E8} [t+${(at / 1000).toFixed(1)}s] ${s.pushName}: "${s.text}"`).pipe(
                Effect.zipRight(Queue.offer(inbox, toMessage(s, i, at))),
              );
            }),
          ),
        ),
      { discard: true },
    ),
  );

  yield* Effect.forkScoped(Coalescer.run.pipe(Effect.provide(services)));
  yield* Effect.sleep(Duration.seconds(17));
  yield* Console.log("\ndone.");
});

Effect.runPromise(Effect.scoped(main)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
