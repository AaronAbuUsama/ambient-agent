/**
 * Mock Layers for the Coalescer's event source and window-dispatch seam.
 * They are `Ref`-backed so timing tests can inspect exactly what fired.
 */
import { Layer, Queue, Ref, Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";
import { EventSource, WindowDispatcher } from "./ports.ts";

// ── EventSource: a Stream fed from a Queue the test controls ─────────────────

export const queueEventSource = (queue: Queue.Dequeue<IncomingMessage>): Layer.Layer<EventSource, never> =>
  Layer.succeed(EventSource, { events: Stream.fromQueue(queue) });

// ── Window dispatcher: record every dispatch (for timing tests) ───────────────
// The pure timing behaviour is observable here — one entry per Coalescer fire,
// with the buffered window and the reason.

export const recordingWindowDispatcher = (
  turns: Ref.Ref<readonly ConversationWindow[]>,
): Layer.Layer<WindowDispatcher, never> =>
  Layer.succeed(WindowDispatcher, {
    dispatch: (window) => Ref.update(turns, (t) => [...t, window]),
  });
