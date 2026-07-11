/**
 * The Coalescer's ports — every boundary to the outside world is a `Context.Tag`
 * service, so each is a swappable Layer (mock this session, real later). This is
 * the Effect ↔ Eve seam and the mock seams, in one place.
 *
 * Decisions D1/D3/D4 in `docs/COALESCER-DESIGN.md`.
 */
import { Context, Data, type Effect, type Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";

// ── Conversationalist (Agent 1, the voice) ──────────────────────────────────
// The Coalescer's sole output. In the prototype this is a deterministic
// self-gating stub; in production it is an Eve session invoked via
// `Effect.tryPromise` (see COALESCER-DESIGN §3). The Coalescer depends only on
// this tag — it never imports Eve.

export class ConversationError extends Data.TaggedError("ConversationError")<{
  readonly cause: unknown;
}> {}

export class Conversationalist extends Context.Tag("Conversationalist")<
  Conversationalist,
  {
    /** Wake the voice with a buffered window. It decides speak / act / stay silent. */
    readonly turn: (window: ConversationWindow) => Effect.Effect<void, ConversationError>;
  }
>() {}

// ── Outbound (the group surface) ────────────────────────────────────────────
// How the voice reaches the group. Mirrors whatsappd's `adapter.send` /
// `adapter.setTyping` (`whatsappd/dist/types-B8d1OyHV.d.mts:57,61`). Only the
// Conversationalist calls this — the Worker never posts.

export class Outbound extends Context.Tag("Outbound")<
  Outbound,
  {
    readonly reply: (chatId: string, text: string) => Effect.Effect<void>;
    readonly setTyping: (chatId: string, on: boolean) => Effect.Effect<void>;
  }
>() {}

// ── Worker (Agent 2, the hands) — MOCKED this session ───────────────────────
// `delegate` returns an `Effect`, which is the whole point: the prototype awaits
// it inline (blocking, decision D1a), and the later non-blocking design (D1b) is
// `Effect.fork(worker.delegate(task).pipe(...))` — a swap, not a rewrite. The
// real GitHub agent (`agent/`) drops in behind this tag, untouched.

export interface WorkerTask {
  readonly chatId: string;
  /** Natural-language instruction the Conversationalist delegates to the hands. */
  readonly instruction: string;
}

export interface WorkerResult {
  readonly summary: string;
}

export class WorkerError extends Data.TaggedError("WorkerError")<{
  readonly cause: unknown;
}> {}

export class Worker extends Context.Tag("Worker")<
  Worker,
  {
    readonly delegate: (task: WorkerTask) => Effect.Effect<WorkerResult, WorkerError>;
  }
>() {}

// ── EventSource (inbound stream) ────────────────────────────────────────────
// The raw per-chat event firehose. Mock: a `Stream` fed from a test `Queue`,
// driven under `TestClock`. Real: `adapter.subscribe()` bridged via `Stream.async`.

export class EventSource extends Context.Tag("EventSource")<
  EventSource,
  {
    readonly events: Stream.Stream<IncomingMessage>;
  }
>() {}
