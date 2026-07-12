/**
 * The voice (Agent 1) — a real, model-backed `Conversationalist`, as PLAIN
 * EFFECT wrapping the AI SDK. NOT an Eve agent: Eve can only start a session
 * from a "doorway" (an HTTP route / WS handler / scheduled job), and our caller
 * is a background timer (the Coalescer), which can't reach past that doorway.
 * The voice also doesn't NEED Eve — it only ever sees a recent window, not full
 * history, so Eve's durable cross-session memory would go unused. So the whole
 * hot path stays one Effect graph and the doorway problem evaporates. See
 * `docs/planning/COALESCER-VOICE-HANDOFF.md` §2.4–2.5.
 *
 * The model runs the tool loop itself (`ai@7`'s `streamText`, wrapped in
 * `Effect.tryPromise`): each `execute` runs a small Effect against the injected
 * Outbound / Worker services. Silence needs no machinery — the model simply
 * doesn't call `reply`, so nothing is sent.
 *
 * We must STREAM: the Codex backend rejects a non-streaming request outright
 * (`generateText` → 400 `{"detail":"Stream must be set to true"}`). `streamText`
 * drives the same tool loop; we drain it with `consumeStream()` and rethrow any
 * captured stream error so a failed turn becomes a `ConversationError`, never a
 * silent no-op.
 *
 * `experimental_chatgpt()` bills the local ChatGPT/Codex login and so is
 * LOCAL-DEV ONLY — it fails in deployment (no Codex creds there). Branch on env
 * before shipping.
 */
import { Duration, Effect, Layer, Runtime } from "effect";
import { stepCountIs, streamText, tool } from "ai";
import { experimental_chatgpt } from "eve/models/openai";
import { z } from "zod";
import type { ConversationWindow } from "./events.ts";
import { Conversationalist, ConversationError, Outbound, Worker } from "./ports.ts";

const DEFAULT_PERSONA = `You're a regular member of this WhatsApp group.
- Chime in WHENEVER you can genuinely help — someone's stuck, a bug/PR/issue comes up, a question you can answer.
- Do NOT wait to be @-mentioned. Being addressed just means "definitely answer now."
- Stay quiet during pure social chatter — silence is normal. To stay silent, just don't call reply.
- For real GitHub work, call delegate() then reply() to narrate what came back.`;

/**
 * Appended to every persona. The group is tool-driven: the ONLY channel to the
 * humans is the `reply` tool — assistant prose is drained and discarded, never
 * delivered. Without this, the model answers a clear question in plain text,
 * calls no tool, and the group hears nothing (verified against the Codex
 * backend). Spelling out the contract makes it call `reply`, while still
 * choosing silence (no tool call) on off-topic chatter.
 */
const SPEECH_CONTRACT = `

How the group hears you: they ONLY see messages you send by calling the reply tool. Any text you write outside a tool call is discarded — nobody sees it. So whenever you want to say ANYTHING, you must call reply with that text. If you have nothing to add, call no tools at all — that is how you stay silent.`;

/** `HH:MM:SS`, matching the whatsapp.ts traffic logs so turns interleave readably. */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/**
 * Render the buffered window as a plain transcript plus a one-line note on how
 * the loop woke us (addressed → answer now; ambient → jump in only if useful),
 * so the model has the same context a human scrolling up would.
 */
const renderWindow = (window: ConversationWindow): string => {
  const transcript = window.messages.map((m) => `${m.pushName ?? m.from}: ${m.text}`).join("\n");
  const note =
    window.reason === "mention"
      ? "You were just @-mentioned — answer now."
      : window.reason === "quote-reply"
        ? "Someone just replied to one of your messages — answer now."
        : "No one addressed you directly — jump in only if you can genuinely help; otherwise stay silent.";
  return `Recent messages in the group:\n${transcript}\n\n(${note})`;
};

/**
 * The voice as a `Conversationalist` Layer. `persona` is the system prompt — pass
 * a chat-specific one (e.g. a bug-intake persona for a QA group); it defaults to a
 * general helpful-group-member persona.
 */
export const aiVoice = (persona: string = DEFAULT_PERSONA): Layer.Layer<Conversationalist, never, Outbound | Worker> => Layer.effect(
  Conversationalist,
  Effect.gen(function* () {
    const outbound = yield* Outbound;
    const worker = yield* Worker;
    // Build the model once — it's pure allocation (credentials are read lazily, per
    // request), so there's nothing per-turn to gain by rebuilding it. This is also the
    // natural place to branch on env for a deployed model (experimental_chatgpt is
    // local-dev only; see the header note).
    const model = experimental_chatgpt();
    return {
      turn: (window) => {
        const chatId = window.chatId;

        // Auto-typing: keep WhatsApp's "typing…" lit for the whole turn as a mechanical
        // side-effect of *working* — NOT a tool the model has to remember to call. The
        // indicator auto-expires after ~25s, so refresh it on a timer; it's raced against
        // the turn below (so it's interrupted the instant the turn ends) and `ensuring`
        // clears it whatever the outcome — reply, silence, error, or scope shutdown.
        const keepTyping = outbound
          .setTyping(chatId, true)
          .pipe(Effect.zipRight(Effect.sleep(Duration.seconds(8))), Effect.forever);

        // Run each tool's Effect on the turn fiber's OWN runtime (not a bare, detached
        // `Effect.runPromise`) so log context and — the load-bearing part — interruption
        // propagate into an in-flight tool, e.g. a long blocking `worker.delegate` that
        // must be torn down when the loop's scope closes. Same runtime-capture seam
        // repl.ts uses to bridge stdin into the running program.
        const runTurn = Effect.runtime<never>().pipe(
          Effect.flatMap((runtime) =>
            Effect.tryPromise({
              try: async (signal) => {
                const run = <A>(eff: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(eff, { signal });
                let replied = false;
                let delegated = false;
                let streamError: unknown;
                const result = streamText({
                  model,
                  system: persona + SPEECH_CONTRACT,
                  prompt: renderWindow(window),
                  stopWhen: stepCountIs(6),
                  abortSignal: signal,
                  // consumeStream() swallows+logs stream errors by default; capture the real
                  // cause here and rethrow below so the failure reaches `catch`, not the console.
                  onError: ({ error }) => {
                    streamError = error;
                  },
                  tools: {
                    reply: tool({
                      description: "Say something in the group. This is the ONLY way the group hears you.",
                      inputSchema: z.object({ text: z.string() }),
                      execute: ({ text }) => {
                        replied = true;
                        return run(outbound.reply(chatId, text));
                      },
                    }),
                    delegate: tool({
                      description: "Hand real GitHub work to the Worker; returns its result to narrate.",
                      inputSchema: z.object({ instruction: z.string() }),
                      // Never let a Worker failure reject the tool mid-turn: fold it into a
                      // result the model can narrate, exactly as the stub's delegateAndNarrate does.
                      execute: ({ instruction }) => {
                        delegated = true;
                        return run(
                          worker.delegate({ chatId, instruction }).pipe(
                            Effect.catchAll((err) => Effect.succeed({ summary: `couldn't do that: ${String(err)}` })),
                          ),
                        );
                      },
                    }),
                  },
                });
                await result.consumeStream({ onError: () => {} });
                if (streamError !== undefined) throw streamError;
                // Silence is a DECISION — log it as loudly as a reply, so the terminal always
                // shows what the voice CHOSE, never just an absence you have to interpret.
                const decision = replied
                  ? delegated
                    ? "🛠️  delegated + replied"
                    : "💬 replied"
                  : delegated
                    ? "🛠️  delegated, no reply"
                    : "🤫 chose to stay silent";
                console.log(`[${stamp()}] ${decision} — ${chatId}`);
              },
              catch: (cause) => new ConversationError({ cause }),
            }),
          ),
        );

        // Announce the wake-up (eligible + why: addressed vs ambient), keep typing lit for
        // the turn's duration, then always clear it. The turn's error still propagates so
        // the Coalescer's fire() logs a failed turn.
        const addressed = window.reason !== "debounce";
        return Effect.sync(() =>
          console.log(
            `[${stamp()}] 🗣️  voice turn — ${addressed ? `addressed (${window.reason})` : "ambient"}, ${window.messages.length} msg → ${chatId}`,
          ),
        ).pipe(
          Effect.zipRight(Effect.race(runTurn, keepTyping)),
          Effect.ensuring(outbound.setTyping(chatId, false)),
        );
      },
    };
  }),
);
