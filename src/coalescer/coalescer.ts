/**
 * The Coalescer — the timing layer with no model.
 *
 * One actor fiber per `chatId`, each draining its own `Queue<IncomingMessage>`.
 * The debounce is expressed as "take the next message, but give up after
 * `debounceWindow`" (`Queue.take` raced against a virtual sleep via
 * `timeoutOption`), which is exactly the flush rule: the timeout restarts every
 * iteration → "one debounce timer that resets on each new message", so light
 * traffic fires ~one window later and heavy traffic coalesces into one fire at
 * the end of the burst. An @-mention / quote-reply of the bot skips the wait and
 * flushes immediately. See `docs/COALESCER-DESIGN.md` §2.
 *
 * Everything time-based routes through the Effect `Clock`, so under `TestClock`
 * the whole thing runs in virtual time with zero real sleeps.
 */
import { Context, Effect, HashMap, Option, Queue, Ref, type Scope, Stream } from "effect";
import { appendBounded, type BufferBounds } from "./buffer.ts";
import { addressesBot, type ConversationWindow, type IncomingMessage, reasonOf } from "./events.ts";
import { CoalescerConfig, type CoalescerConfigValues } from "./config.ts";
import { Conversationalist, EventSource } from "./ports.ts";

type ConversationalistService = Context.Tag.Service<typeof Conversationalist>;

/**
 * Fire: hand the buffered window to the voice. A failing turn must not kill the
 * chat's actor loop — one bad turn should never wedge the chat. We swallow-and-log
 * both typed failures (`catchAll`) *and* defects (`catchAllDefect`, e.g. a throw
 * inside the real Eve session), but deliberately let **interruption** through
 * untouched so scope shutdown still tears the loop down cleanly. Empty windows
 * never fire (a config edge, e.g. `maxBufferMessages: 0`) — there is nothing to say.
 */
const logTurnError = (window: ConversationWindow) => (cause: unknown) =>
  Effect.logError(`conversationalist turn failed for ${window.chatId}`).pipe(
    Effect.annotateLogs({ cause: String(cause) }),
  );

const fire = (
  convo: ConversationalistService,
  window: ConversationWindow,
): Effect.Effect<void> =>
  window.messages.length === 0
    ? Effect.void
    : convo.turn(window).pipe(Effect.catchAll(logTurnError(window)), Effect.catchAllDefect(logTurnError(window)));

/**
 * Build the per-chat actor loop for a given config + voice. Returns a function
 * that, given a chat's queue, runs its debounce loop forever.
 */
const makeChatLoop = (config: CoalescerConfigValues, convo: ConversationalistService) => {
  const bounds: BufferBounds = {
    maxBufferMessages: config.maxBufferMessages,
    maxBufferAgeMillis: config.maxBufferAgeMillis,
  };

  return (chatId: string, queue: Queue.Dequeue<IncomingMessage>): Effect.Effect<never> => {
    // A message landed: buffer it, and either flush now (bot addressed) or keep waiting.
    const onMessage = (buffer: readonly IncomingMessage[], msg: IncomingMessage): Effect.Effect<never> => {
      const next = appendBounded(buffer, msg, bounds);
      return addressesBot(msg, config.botId)
        ? fire(convo, { chatId, messages: next, reason: reasonOf(msg, config.botId) }).pipe(Effect.zipRight(step([])))
        : step(next);
    };

    const step = (buffer: readonly IncomingMessage[]): Effect.Effect<never> =>
      buffer.length === 0
        ? // Cold: block indefinitely for the first message of a new burst.
          Queue.take(queue).pipe(Effect.flatMap((msg) => onMessage([], msg)))
        : // Warm: wait for the next message, but give up after the quiet window.
          Queue.take(queue).pipe(
            Effect.timeoutOption(config.debounceWindow),
            Effect.flatMap(
              Option.match({
                onNone: () => fire(convo, { chatId, messages: buffer, reason: "debounce" }).pipe(Effect.zipRight(step([]))),
                onSome: (msg) => onMessage(buffer, msg),
              }),
            ),
          );

    return step([]);
  };
};

/**
 * Run the Coalescer: drain the inbound stream, route each message to its chat's
 * actor (lazily creating the queue + fiber on first sight of a `chatId`), and
 * let each actor's debounce loop decide when to fire the voice.
 *
 * Blocks until the source stream ends, so callers fork it. Chat-actor fibers are
 * `forkScoped` — they live until the enclosing `Scope` closes, giving clean
 * shutdown. The router drains sequentially, so lazy queue creation never races.
 */
export const run: Effect.Effect<
  void,
  never,
  EventSource | Conversationalist | CoalescerConfig | Scope.Scope
> = Effect.gen(function* () {
  const { events } = yield* EventSource;
  const config = yield* CoalescerConfig;
  const convo = yield* Conversationalist;
  const chatLoop = makeChatLoop(config, convo);
  const registry = yield* Ref.make(HashMap.empty<string, Queue.Queue<IncomingMessage>>());

  const routeTo = (msg: IncomingMessage): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const existing = HashMap.get(yield* Ref.get(registry), msg.chatId);
      if (Option.isSome(existing)) {
        yield* Queue.offer(existing.value, msg);
        return;
      }
      const queue = yield* Queue.unbounded<IncomingMessage>();
      yield* Ref.update(registry, HashMap.set(msg.chatId, queue));
      yield* Effect.forkScoped(chatLoop(msg.chatId, queue));
      yield* Queue.offer(queue, msg);
    });

  yield* events.pipe(
    // fromMe = the bot's own messages; live=false = history backfill. Neither drives the loop.
    Stream.filter((m) => m.live && !m.fromMe),
    Stream.runForEach(routeTo),
  );
});
