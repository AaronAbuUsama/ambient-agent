# Coalescer + Voice — execution state (handoff)

Single source of truth for the two-tier WhatsApp agent work. If you're resuming
after a compaction: **read this whole file first**, then confirm status back.

Sister doc (design detail, keep in sync): [`docs/COALESCER-DESIGN.md`](../COALESCER-DESIGN.md).
Prior stage (the GitHub agent): [`docs/planning/EXECUTION-STATE.md`](./EXECUTION-STATE.md).

---

## 1. Mission

A WhatsApp group-chat agent that feels like one assistant but is two tiers:

- **Coalescer** (no model) — subscribes to inbound WhatsApp messages, holds a
  bounded rolling window per chat, and decides *when* to wake the voice.
- **Conversationalist / "the voice"** (Agent 1, cheap+fast) — reads the window
  and decides **speak / act / stay silent**. It is a *participant*, not a
  reply-bot.
- **Worker** (Agent 2, deep model) — the existing fused GitHub agent (`agent/`).
  The voice delegates real work to it and narrates the result.

GitHub is only the test capability; the **architecture is the deliverable**.

---

## 2. Decisions (with the *why*)

1. **Coalescer built in Effect. DONE + committed.** Per-chat actor loop; debounce
   = `Queue.take` raced against a virtual sleep (`timeoutOption`). Deterministic
   under `TestClock`. See COALESCER-DESIGN §2.

2. **THE BEHAVIOR CORRECTION (Aaron, this session) — load-bearing.** The voice
   must **engage whenever it judges it can help** (someone stuck, a bug, a PR/issue
   mentioned, a question it can answer), **not** only when @-mentioned. An
   @-mention / quote-reply just means *"respond NOW, skip the wait."* Staying
   quiet during pure social chatter is normal. **This judgment lives in the
   voice's PERSONA instructions, not in code.** The old `selfGatingConversationalist`
   stub had this backwards (silent unless addressed) and is a placeholder to be
   replaced, NOT the intended behavior.

3. **"Debounce" was the wrong word — it needs a CAP (throttle + settle window).**
   Pure debounce starves a busy chat (timer keeps resetting → bot never speaks).
   Wanted: **fire when the chat goes quiet OR when a max wait has elapsed,
   whichever first** — so a nonstop chat still fires every ~`maxWait`, processes
   the pile, responds, gathers again. NOT YET IMPLEMENTED (see §4, held item 1).
   Effect's `groupedWithin` is *tumbling* (doesn't reset per message) so it's not
   a drop-in; we keep our loop and add the cap.

4. **The voice is PLAIN EFFECT, NOT an Eve agent.** This is the crux that
   simplified everything. Eve only lets you start/resume a session from a
   "doorway" (an HTTP route / WS handler / scheduled job) — a background timer
   (our Coalescer) cannot call `send`. That doorway rule is *Eve's*, and Effect
   can't reach past it. **But the voice doesn't need Eve:** Eve's gift is durable
   cross-session memory, and we deliberately feed the voice only a *recent window*
   (not full history), so that gift is nearly unused. So: make the voice a plain
   Effect program that calls the model directly. The doorway problem evaporates;
   the whole hot path is one Effect graph.

5. **Model = AI SDK (`ai@7`) directly, wrapped in `Effect.tryPromise`. NOT
   `@effect/ai`.** Verified in the cloned effect repo: `@effect/ai`'s OpenAI
   provider authenticates with an API key against the real OpenAI API, and has
   **no AI-SDK bridge**. Our model `experimental_chatgpt()` speaks to the *Codex
   backend* with signed-JWT subscription auth (no key). Using `@effect/ai` would
   mean rebuilding Eve's Codex transport — rejected. `ai@7`'s `generateText` runs
   the tool loop for us; that's the seam.

6. **`experimental_chatgpt()` works standalone.** It returns a plain AI-SDK
   `LanguageModel` (`eve/dist/src/public/models/openai/index.d.ts`), reads the
   local Codex login, needs no Eve app. **Local-dev only — fails in deployment**
   (no Codex creds there); branch on env for prod.

7. **Worker stays an Eve agent** (the existing `agent/`), reached only when the
   voice `delegate()`s — the ONE Eve doorway, and only on real work, not per
   message. Delegation is **blocking (D1a)** — matches Eve's native subagent
   semantics (a subagent is a blocking tool; validated in the Eve docs). D1b
   (non-blocking) is a later swap; the `Effect`-returning `Worker.delegate` port
   keeps it a swap, not a rewrite.

8. **Silence needs no machinery** — the model simply doesn't call the `reply`
   tool. (Validated: Eve/channels drop empty/tool-only turns; and for a
   plain-Effect voice it's even simpler — no reply call = nothing sent.)

---

## 3. Done (committed on `main`)

- `f886a13` — feat(coalescer): the full Coalescer build. `src/coalescer/{events,
  config,ports,buffer,coalescer,mocks,demo}.ts`, `tests/coalescer/{coalescer,
  buffer}.test.ts`, `docs/COALESCER-DESIGN.md`. Includes the resilience hardening
  (`fire` catches failures AND defects, lets interruption through; empty windows
  never fire; `appendBounded` age-anchored on max timestamp for out-of-order msgs).
- `80ed4c6` — refactor(coalescer): the Tier-1 simplification (dead config removed,
  `Array.takeRight`, shared `delegateAndNarrate`, `startSelfGating` test helper).

**State: 71 tests green, `pnpm typecheck` clean, `pnpm run coalescer` demo works.**
Tip of `main` = `80ed4c6`. Working tree clean.

Two adversarial reviews already run and folded in: a correctness review (→ the
resilience hardening in `f886a13`) and a 4-angle simplify review (→ `80ed4c6`;
the one deferred item is the `Stream.groupByKey` fan-out, intentionally NOT done
because idle-chat eviction is easier against our owned registry — see §5).

---

## 4. Held / NEXT — Rung 1 (build in this order)

The testing ladder: **Rung 0** = `pnpm run coalescer` (scripted real-time
playground, exists). **Rung 1** = real voice + interactive terminal (NEXT).
**Rung 2** = real WhatsApp (needs re-pair; later).

Aaron said **"continue"** to building Rung 1. It is NOT yet started. Steps:

1. **Add the `maxWait` cap to the loop** (`src/coalescer/coalescer.ts`) + a new
   config knob `maxWait` (default ~10s) in `config.ts`. Warm state waits
   `Duration.min(debounceWindow, maxWait − elapsedSinceBurstStart)`. Track
   `burstStart` (a `Clock.currentTimeMillis` at first message of a burst).
   **Add a TestClock test**: a nonstop burst (messages every 1s forever) fires
   roughly every `maxWait`, not never. Sketch:
   ```ts
   // warm state:
   const capLeft = config.maxWait - (now - burstStart);
   const wait = Duration.min(config.debounceWindow, Duration.millis(capLeft));
   Queue.take(queue).pipe(Effect.timeoutOption(wait), /* onNone → fire; onSome → gather (keep burstStart) */)
   ```

2. **Write `src/coalescer/voice.ts`** — the real voice as a plain-Effect
   `Conversationalist` Layer. VERBATIM shape to preserve (plugs into the existing
   `Conversationalist` port unchanged; Coalescer does not change):
   ```ts
   // src/coalescer/voice.ts — real voice. Plain Effect + AI SDK. No Eve.
   import { Effect, Layer } from "effect";
   import { generateText, tool, stepCountIs } from "ai";
   import { experimental_chatgpt } from "eve/models/openai";   // ChatGPT sub, no key
   import { z } from "zod";
   import { Conversationalist, ConversationError, Outbound, Worker } from "./ports.ts";

   const PERSONA = `You're a regular member of this WhatsApp group.
   - Chime in WHENEVER you can genuinely help — someone's stuck, a bug/PR/issue comes up, a question you can answer.
   - Do NOT wait to be @-mentioned. Being addressed just means "definitely answer now."
   - Stay quiet during pure social chatter — silence is normal. To stay silent, just don't call reply.
   - For real GitHub work, call delegate() then reply() to narrate what came back.`;

   export const aiVoice: Layer.Layer<Conversationalist, never, Outbound | Worker> = Layer.effect(
     Conversationalist,
     Effect.gen(function* () {
       const outbound = yield* Outbound;
       const worker = yield* Worker;
       return {
         turn: (window) =>
           Effect.tryPromise({
             try: (signal) =>
               generateText({
                 model: experimental_chatgpt(),
                 system: PERSONA,
                 prompt: renderWindow(window),      // buffered recent messages as text
                 stopWhen: stepCountIs(6),
                 abortSignal: signal,
                 tools: {
                   reply:      tool({ description: "Say something in the group.",
                                      inputSchema: z.object({ text: z.string() }),
                                      execute: ({ text }) => Effect.runPromise(outbound.reply(window.chatId, text)) }),
                   set_typing: tool({ description: "Show typing while you work.",
                                      inputSchema: z.object({ on: z.boolean() }),
                                      execute: ({ on }) => Effect.runPromise(outbound.setTyping(window.chatId, on)) }),
                   delegate:   tool({ description: "Hand real GitHub work to the Worker; returns its result.",
                                      inputSchema: z.object({ instruction: z.string() }),
                                      execute: ({ instruction }) => Effect.runPromise(worker.delegate({ chatId: window.chatId, instruction })) }),
                 },
               }),
             catch: (cause) => new ConversationError({ cause }),
           }).pipe(Effect.asVoid),
       };
     }),
   );
   ```
   Plus a `renderWindow(window)` helper: format `window.messages` as a readable
   transcript (`pushName: text` per line) + note `window.reason`
   (mention/quote-reply/debounce) so the model knows if it was addressed.

3. **Interactive terminal harness** (Rung 1 test) — a script (e.g.
   `src/coalescer/repl.ts`, add `pnpm run voice`) where **you type messages** and
   watch the REAL model decide speak/silent/delegate. Mock ONLY the WhatsApp send
   (console `Outbound`) and the Worker (`cannedWorker`). Real time. This tests the
   two genuine unknowns: the model's persona/judgment, and the Effect↔AI-SDK seam.
   Existing `demo.ts` is the template; swap the stub voice Layer for `aiVoice`,
   read stdin lines → `Queue.offer` into the source.

**DoD for Rung 1:** you can hold a conversation in the terminal; the model stays
quiet on chit-chat, chimes in on relevant/GitHub-ish messages *without* being
@-mentioned, and delegates + narrates on a task. Existing `agent/` untouched.

---

## 5. Gotchas & guardrails (will bite if forgotten)

- **DO NOT touch the existing GitHub agent (`agent/`, `agent/tools/*`,
  `agent/channels/whatsapp.ts`, `agent/instructions.md`).** It is the future
  Worker; leave it entirely alone.
- **`experimental_chatgpt()` is local-dev only** — needs Codex CLI login
  (`~/.codex/auth.json`); fails in deploy. Branch on `NODE_ENV` for prod.
- **Do NOT go down the `@effect/ai` path** for the voice — it can't speak the
  Codex subscription backend (decision §2.5).
- **The Eve "doorway" is real and immovable** — a background timer can't call
  `send`. That is precisely why the voice is plain Effect, not an Eve agent. Don't
  re-litigate wiring the voice through an Eve session.
- **The Effect repo is cloned for reference** at
  `/Users/abuusama/projects/hack-space/effect` (sibling dir). Useful:
  `packages/ai` (= `@effect/ai`, rejected but for reference), `packages/platform`
  (`HttpClient`, if we ever need the Eve-client loopback for delegation).
- **WhatsApp creds are dead** (`logged_out_remote` per prior stage) — Rung 2
  needs a QR re-pair. Not needed for Rung 1.
- **`groupByKey` fan-out deferred on purpose** — the manual per-chat registry is
  kept because idle-chat eviction (a real future need) is easier against a
  registry we own than `groupByKey`'s opaque group lifecycle.
- **maxWait not yet built** — the committed loop is still pure debounce (starves a
  busy chat). Item 1 above fixes it.

---

## 6. Key file pointers

- Design + known edges: `docs/COALESCER-DESIGN.md` (esp. §7 known edges/seam notes).
- Core: `src/coalescer/coalescer.ts` (actor loop + router), `buffer.ts`,
  `events.ts`, `config.ts`, `ports.ts` (the 4 DI seams), `mocks.ts`, `demo.ts`.
- Tests: `tests/coalescer/{coalescer,buffer}.test.ts` (TestClock, `@effect/vitest`
  `it.scoped`).
- Model helper: `eve/models/openai` → `experimental_chatgpt(model?)`.
- AI SDK: `ai@7` → `generateText`, `tool`, `stepCountIs`.
