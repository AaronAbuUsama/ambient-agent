/**
 * Mock Layers for the three seams we don't build this session — the event
 * source, the outbound surface, and the Worker — plus two Conversationalist
 * stubs. All are `Ref`-backed so tests can inspect what happened. Swapping any of
 * these for its real implementation is a one-line Layer change at the wiring
 * site; nothing in the Coalescer moves.
 */
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";
import {
  Conversationalist,
  EventSource,
  Outbound,
  Worker,
  type WorkerResult,
  type WorkerTask,
} from "./ports.ts";

// ── EventSource: a Stream fed from a Queue the test controls ─────────────────

export const queueEventSource = (queue: Queue.Dequeue<IncomingMessage>): Layer.Layer<EventSource> =>
  Layer.succeed(EventSource, { events: Stream.fromQueue(queue) });

// ── Outbound: collect replies + typing events instead of hitting WhatsApp ────

export type OutboundEvent =
  | { readonly kind: "reply"; readonly chatId: string; readonly text: string }
  | { readonly kind: "typing"; readonly chatId: string; readonly on: boolean };

export const collectingOutbound = (log: Ref.Ref<readonly OutboundEvent[]>): Layer.Layer<Outbound> =>
  Layer.succeed(Outbound, {
    reply: (chatId, text) => Ref.update(log, (l): readonly OutboundEvent[] => [...l, { kind: "reply", chatId, text }]),
    setTyping: (chatId, on) => Ref.update(log, (l): readonly OutboundEvent[] => [...l, { kind: "typing", chatId, on }]),
  });

// ── Worker: a canned result; optionally record the tasks it was handed ───────

export const cannedWorker = (
  reply: (task: WorkerTask) => WorkerResult = (t) => ({ summary: `handled: ${t.instruction}` }),
  tasks?: Ref.Ref<readonly WorkerTask[]>,
): Layer.Layer<Worker> =>
  Layer.succeed(Worker, {
    delegate: (task) =>
      (tasks ? Ref.update(tasks, (t) => [...t, task]) : Effect.void).pipe(Effect.as(reply(task))),
  });

// ── Conversationalist stub #1: record every fire (for timing tests) ──────────
// The pure timing behaviour is observable here — one entry per Coalescer fire,
// with the buffered window and the reason. No Outbound/Worker needed.

export const recordingConversationalist = (
  turns: Ref.Ref<readonly ConversationWindow[]>,
): Layer.Layer<Conversationalist> =>
  Layer.succeed(Conversationalist, {
    turn: (window) => Ref.update(turns, (t) => [...t, window]),
  });

// ── Conversationalist stub #2: a self-gating voice (for behaviour/demo) ──────
// Demonstrates all three outcomes deterministically:
//   • ambient burst (reason "debounce")            → stay silent (quiet in the noise)
//   • addressed, task-like text                     → delegate (blocking, D1a) + narrate
//   • addressed, chit-chat                          → just reply
// Depends on Outbound + Worker, exactly as the real Eve session's tools would.

const looksLikeTask = (text: string): boolean => /\b(pr|issue|review|check|deploy|bug|merge|close)\b/i.test(text);

export const selfGatingConversationalist: Layer.Layer<Conversationalist, never, Outbound | Worker> = Layer.effect(
  Conversationalist,
  Effect.gen(function* () {
    const outbound = yield* Outbound;
    const worker = yield* Worker;
    return {
      turn: (window: ConversationWindow) =>
        Effect.gen(function* () {
          if (window.reason === "debounce") return; // ambient: self-gate to silence
          const last = window.messages[window.messages.length - 1];
          if (last === undefined) return;
          if (looksLikeTask(last.text)) {
            yield* outbound.setTyping(window.chatId, true);
            // D1a: block on the worker inside the turn, then narrate its result.
            const result = yield* worker
              .delegate({ chatId: window.chatId, instruction: last.text })
              .pipe(Effect.catchAll((err) => Effect.succeed({ summary: `couldn't do that: ${String(err)}` })));
            yield* outbound.reply(window.chatId, `on it — ${result.summary}`);
            yield* outbound.setTyping(window.chatId, false);
          } else {
            yield* outbound.reply(window.chatId, `👋 ${last.pushName ?? "hey"}`);
          }
        }),
    };
  }),
);
