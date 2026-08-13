# Ambient Current State

Status date: 2026-08-13.

This is the rolling rescue and delivery ledger. It records the current truth,
not a distant phase plan.

## Home wayfinding stopped (2026-08-13)

The ~/.ambient home wayfinding (map #1) was stopped by the master as
over-engineered sprawl: parallel tickets invented machinery for consumers
that do not exist, and simple questions grew fog instead of answers. What
locked before the stop stands: ADR 0001 (home layout, amended), ADR 0002
(mandate file: one file, fail-closed, config by convention), CONTEXT.md
vocabulary (active chat, broken chat, mode as speaking rights, watermark
never authored), and the research findings (fs-watch, agent-home prior art,
mcp.json, git-home — findings now in `docs/research/`). Everything else
was parked, then folded into the MVP reset below (2026-08-13).

**Correction to this ledger:** Memory v2 is a working implementation proven
against one golden bed. It is not product-validated canon; treat its
protocol shapes as provisional until real product slices exercise them.

## Completed slice: Home v1 (2026-08-13)

**Proof (gate passed 2026-08-13).** Deterministic: 111/111 tests, check
clean; mandate scan fail-closed (missing/torn/invalid/duplicate = broken),
mirror sync semantics, watermark ratchet, skills chat-wins fold, prompt
composition all covered. Live on the machine: `ambient init` created the
real home; the cutover moved `./data` into `state/`; `activate "Tst"`
resolved the mirror and wrote a mandate; a broken `mode:` produced the
exact zod error in doctor and recovered on fix. Live on the rig: bare
`ambient` ran the daemon against the rig home (connected account
"android", startup sync mirrored the rig mandate, clean SIGTERM);
`proof:conversation-replay` green on the new composition;
`proof:whatsapp-live-loop` end to end — real peer message → speaker
through home config + mandate-synced records + the single guarded send
path → reply delivered and token-verified on the peer's mirror, both
evaluation cases succeeded.

**Real-life acceptance (`proof:home-live`, green 2026-08-13).** The full
journey against the RUNNING daemon (bare `ambient` as a child process, the
master's peer profile sending real messages, mandate files edited live, no
restarts): no mandate → silence; mandate written (watcher) → listening
silence; flipped responding with a chat-scoped skill → reply delivered
with the live token echoed AND the skill's marker present — a SKILL.md
changed a real WhatsApp reply; the pre-activation backlog stayed
unanswered (activation starts from now, proven live); mandate broken live
→ silence; fixed live → replies again, token-verified. This run exposed
and fixed a real production bug the stepped harness could never see:
drizzle-orm/libsql opens a fresh connection per transaction (ignoring its
config), so overlapping daemon writes died as instant `SQLITE_BUSY` and a
transient lock detached the WhatsApp channel. Fix: transactions queue
in-process at the one authoritative database open, ambient.db is WAL, and
the accepted-source wake path retries busy blips instead of detaching.

**Review notes.** `seed` died into `sync` (one mutation path; the proof
harness composes via `current()`+`sync`); loopback and
`conversation.speakers`/`outboundMode` config are deleted; the skills
loader is our own ~100-line SKILL.md parser (no pi types outside the
agent adapter). Deviation: the session log still lands at
`state/whatsapp.log` (not `state/logs/ambient.log`); app events go to
stdout — file logging joins the TUI slice. Next slice selected at the
review stop with the master.

## The Home v1 brief as cut (2026-08-13, grilled with the master)

**Goal.** Ambient runs fresh from `~/.ambient` — no legacy, no old layout.
Mandates as files drive the live speakers, skills load by convention, and
one CLI is the whole operator surface. Single package until we outgrow it.

**In:**

- The home tree per ADR 0001 (amended): `config.yaml` (everything in the
  home — the only config location; `AMBIENT_CONFIG` override remains for
  the proof rig), `skills/`, `chats/<slug>/mandate.yaml`, `state/`
  (db, whatsappd territory, `logs/ambient.log` ndjson).
- Mandate projector per ADR 0002: strict schema `{chatId, mode default
listening, instructions, memoryBrief}` (`memoryBrief` stored now,
  consumed in the memory slice); fail-closed; active records mirror the
  set of valid folders (reconcile by scan); directory watcher as wake hint
  plus startup reconcile. `conversation.speakers` stanzas deleted;
  `conversation.enabled` dropped (no valid mandates = inert);
  `outboundMode` and the send allowlist guard unchanged.
- Skills, fundamental: package + home `skills/` + chat `skills/`,
  chat wins by name, eager-append into the speaker prompt (fixed identity,
  then mandate instructions, then skills); broken skill = loud in doctor,
  skipped in runs.
- CLI pass 1 — the **ops surface**, agent-friendly, JSON mode (commander +
  yaml, in-package): `ambient init` (idempotent: create the tree, seed
  `config.yaml`; non-interactive), `ambient doctor --json` (full readout —
  home, config, credentials, state, whatsapp auth, chats incl. exact
  mandate errors, skills; non-zero exit when broken), `ambient activate
--chat <name|id>` (destination match → mandate write). These operations
  are one module with two callers: the CLI now, the Root's tools at
  Root v1 — the human-friendly CLI (interactive onboarding, pairing UX,
  prompts) is a later pass built on top. Bare `ambient` = init-if-needed,
  then start the daemon and tail the logs. The deployment reuses the
  already-authenticated whatsappd state; pairing UX belongs to the human
  pass. No `start`, no `chats` command.
- The master chat: `master.chatId` in `config.yaml` marks the admin seat
  the Root occupies at Root v1 — but master-ness is metadata, not a ban
  (clarified by the master 2026-08-13): the same chat may carry an ordinary
  mandate and speak as an ordinary speaker today. Doctor shows both. The
  CLI/files are the operator stopgap until the Root configures the system
  from that chat.

**Out (named):** the human CLI pass (interactive onboarding, QR pairing
walkthrough, chat picker, @inquirer prompts) and the OpenTUI dashboard
(that slice opens with the workspace split); the Root and master-chat
occupant; mcp.json; git-backed home; packaging/npx; wiki.

**Proof gate (deterministic):** in the rig home — activate a chat, observe
listening (claims gated); flip its mandate to `responding`, observe the
speaker answer; break the mandate, observe fail-closed inactivity + doctor
non-zero with the exact error; the existing golden conversation proof
passes on the new composition.

## Completed slice: Identity & Voice (2026-08-13)

**Proof (green 2026-08-13, `proof:home-live` exit 0).** Deterministic:
117/117, check clean (log vocabulary levels, identity healer merges, alias
resolution in activate). Live, full journey against the running daemon with
production stopped (the rig subject and production share one WhatsApp
account — mutual exclusion now documented in the proof and the rig notes):
every phase green through ONE canonical-form mandate while traffic ran on
the lid form; the skill marker reached live output; and the daemon narrated
its own run — message received, reply sent, mandates, loud breakage — all
asserted from its stdout. Also landed: libsignal's raw console (which
printed private key material) muzzled at the daemon edge; upstream fix
belongs in whatsappd. The master's home: master-lid scar removed, the
startup healer folds historical lid rows on next start.

## The Identity & Voice brief as cut (2026-08-13, ordered by the master)

Two defects the first real master-DM test exposed. Both must land before
the memory ship gate. Build order: Part B first (its output makes Part A's
live validation legible).

### Part B — the operational log (build first)

**Product question.** Can the operator watch the daemon work — message in,
reply out, mandate changes, breakage — in decent, levelled, domain-formatted
lines, without free-form prints ever creeping into the code?

**Design.**

- **Engine** (`src/platform/logging.ts`, grows one function): pino — already
  a dependency, the proper library — level from `config.logging.level`, two
  sinks: pretty console when stdout is a TTY (pino-pretty), ndjson always to
  `state/logs/ambient.log` (the future TUI tails this). Reuse the existing
  redaction path list.
- **Vocabulary** (`src/app/operational-log.ts`, new): the ONLY birthplace of
  log lines — a closed, typed event set; free-form logging has no API:

  ```ts
  interface OperationalLog {
    daemonStarted(account: string): void; // info
    messageReceived(chat: string): void; // info  "→ master: message received"
    replySent(chat: string): void; // info  "← master: reply sent"
    runFailed(chat: string, error: string): void; // error
    mandatesChanged(active: string, broken: string): void; // info
    chatBroken(slug: string, problem: string): void; // warn  "✗ tst: mode — expected …"
    memoryDigested(chat: string, claims: number): void; // debug
  }
  ```

  Chats always render as slugs (never raw ids). Adding an event = one
  deliberate edit here, formatted once, levelled once.

- **Injection**: created in the composition root; handed to resources and
  services through their existing options as this narrow port; default is
  silent (tests unchanged). Touch points: ingestion callback, sender wrap,
  mandate resync, memory service completion, lifecycle start/stop.
- **Proof**: unit tests on formatting and level routing; live smoke — a
  daemon run visibly narrates one message → reply cycle.

### Part A — canonical chat identity (the pn/lid fix)

**Product question.** One human DM = ONE conversation everywhere — records,
watermarks, memory — regardless of which WhatsApp identity form the traffic
uses. Groups are unaffected (single id form).

**Design: canonicalize at ingestion.** whatsappd's mirror already maintains
the mapping (`wa_contact_aliases`: native_id → contact_id, 135 rows on this
account, lid → pn verified live). The whatsapp module resolves every inbound
conversation id to its canonical form (the alias table's `contact_id`, else
the raw id) BEFORE anything durable is written — ambient.db only ever sees
canonical ids. The observation mapper / accepted-source path owns it, fed by
an alias lookup on the mirror read model (`whatsapp/mirror.ts`).

- `activate` resolves any input (number, pn, lid) to canonical and writes
  one mandate; the projector is untouched.
- Alias unknown at first contact: the raw id IS canonical until whatsappd
  learns the mapping (contacts sync makes this brief); accept it.
- **Migration** (one bounded script at the rung): rewrite existing lid-form
  conversation ids to canonical across `observations`, `conversation_inbox`,
  `conversation_speakers`, `conversation_schedule`, memory tables; then
  delete the `master-lid/` scar folder — `master/` covers the DM.
- **Proof**: unit — mapper canonicalizes with alias present, passes through
  without; live — a fresh lid-form message retains under the pn id and is
  answered through the single `master/` mandate; doctor shows one entry.

**Done =** the daemon narrates its work at the chosen level; one folder per
human; the live master-DM loop answers on a fresh message; migration script
run; 100% suite green; ledger updated.

## Memory ship gate — attempted, NOT shipped (2026-08-13)

The three flagged claims are answered and the defects they exposed are
fixed. Production was deliberately **not** wiped: the gate is red.

### The verdict on the three flagged claims: extraction overreach

Not judge pedantry, and worse than the earlier entry supposed. Two of the
three were `reported_by: "E34"` — and `E34` is a **run-local symbol**. The
adapter shows the model compact ids (m1/E1/P1/C1) so it never transcribes a
uuid; the model referenced an entity inside a claim VALUE, and the symbol
passed through the tool boundary into the durable ontology, where it dangles
forever. Eight such claims were retained. Both claims also attributed a
report to a person their cited messages never name. The third
("default range 3 miles" for The Call App) cited one terse message that
alone names neither the app nor Masjids — real under-citation.

Fixed at the boundary that owns each defect:

- the adapter translates entity symbols appearing in claim values back to
  canonical names, where it already translates every other id;
- the host rejects any claim value carrying a symbol, a raw WhatsApp id, or
  a 7+ digit subscriber number — "Participant 4477…" is not a person's
  name, and recall reads these values back (real numbers were landing in
  claim text);
- the prompt: attribution only where the claim's OWN citations show the
  author; cite the neighbours that give a terse message its subject; claim
  values stay flat facts.

### What the gate then exposed, in order

Each fix uncovered the next defect. All are recorded because each was real:

1. **Judge pedantry, measured.** With values now flat, the judge began
   flagging `latest_status: "Open."` — demanding a citation literally say
   "open" about an unresolved bug — and flagged a `related_repository`
   claim whose citation contains the literal repo URL. Five of seven flags
   in one window were this. Status by convention is the ontology's default;
   a fact inside a cited message is supported by it. Both are now stated to
   the judge (`memory-judge-v3`). This is the ledger's own "no measurement
   of the judge's reliability" gap arriving as a number.
2. **Coverage collapse from an over-blunt rule.** Told not to invent
   authors, the extractor stopped extracting people: 1 person entity
   against v3's 7. Refusing to attribute an unsigned message was never a
   reason to leave a NAMED person out (`memory-v6`).
3. **Entities invisible to recall.** 5 of 7 person entities carried ZERO
   claims — memory knew Zeeshan Habib and Ehson existed and could recall
   nothing about them, because recall returns claims, not bare entities.
   Every entity now owes at least one claim naming it (`memory-v7`).
4. **Over-correction, reverted.** `memory-v8` told the extractor to skip
   the retired bot's test traffic; it took real content with it (claims
   126→72, golden 20→18). Reverted to v7 — the honest record of a change
   that measured worse.

The digest proof now measures **every** gate before failing on any of them.
A run costs ten minutes and real tokens, and the old fail-fast receipt hid
golden coverage behind the first judged shortfall — defect 2 above was
found only because faithfulness passed and the receipt kept going.

### The actual root cause: Ambient knew who these people were

Found by the master's question ("we have whatsappd — should we not be
passing the names, the jid/lid address book, all of that in?"). The answer
was better than pre-processing and better than a lookup tool: **the data was
already on the retained message, and the code dropped it.**

Measured on production observations:

| On the retained payload            | Present                       | Reached the analyst |
| ---------------------------------- | ----------------------------- | ------------------- |
| `sender.id`                        | 107 of 296 messages           | yes                 |
| `sender.alt` (the other id form)   | 107 — every authored message  | **no**              |
| `pushName` (the author's own name) | 45 messages, 5 distinct names | **no**              |

`database/memory-work.ts` mapped the payload into the analyst's input and
read `sender.id` only. So the analyst was told an id and asked to work out
who that was — which is why it wrote `"Participant 4477…"` as a person,
invented person entities, and left five of them with no claims. Five real
names sat unread in the same rows, and two of the golden labels it could
not hit are people's names.

The fix is a pass-through, not machinery: `senderName` and `senderAltId`
now reach the analyst, both id forms are linkable so one human cannot
become two people, and `whatsapp/message-payload.ts` owns the
linkable-identity rule in one place. Evaluation had its own copy of that
rule and did not know about the second id form — so when memory linked
both forms correctly, `identity_scope` failed the window. Exactly the
parallel-representation defect the engineering guide forbids, found by the
gate. Prompt version `memory-v9`.

**The lesson, recorded because it cost five prompt versions:** v4–v8 used
prompt text to compensate for data the host was withholding. What Ambient
already knows, it must never ask a model to infer.

### Model substitution (material to every number below)

Every gemini credential in the vibe pool is in cooldown
(`RESOURCE_EXHAUSTED`, "all credentials cooling down"), so the memory and
evaluator roles moved to **`gpt-5.6-terra`** (the master's call; the first
substitution, `gpt-5.4`, was merely the first pool model proven to
tool-call). The 20/22 baseline was set by gemini with a gemini judge, so
these numbers are **not** a continuation of that series: both the extractor
and the yardstick changed.

### Where memory-v7 on gpt-5.6-terra actually lands

Two full re-reads of the 261-message corpus, 8 windows each:

| Gate                       | Bar      | Run A                  | Run B (re-roll) |
| -------------------------- | -------- | ---------------------- | --------------- |
| per-window faithfulness    | ≥ 0.7    | **0.412** (one window) | 0.80 — all pass |
| mean faithfulness          | ≥ 0.85   | 0.881                  | 0.890           |
| mean completeness          | ≥ 0.7    | 0.795                  | **0.838**       |
| golden coverage            | ≥ 20/22  | **20/22**              | 19/22           |
| contract metrics           | all pass | pass                   | pass            |
| identity links to chat ids | 0        | 0                      | 0               |

Neither run cleared every gate at once, and the two runs fail different
gates. Run A's floor breach was one window of the retired bug-filing
agent's proof traffic; the re-roll (the master's sanctioned lever) cleared
it, and golden moved 20→19. Golden varies ±1 run to run, so a 20/22 bar
set from one gemini run is at the edge of this extractor's noise, not
clearly above or below it.

**Not shipped.** Production still holds v2's memory, untouched. Wiping
proven memory on a red gate — with a substituted extractor AND a
substituted judge — is the one irreversible mistake available here. Both
databases are backed up (`.proof-private/backups/*pre-v4-*`).

### Memory keeps up, live and proven (`proof:memory-keepup`, green)

The gate's third item passed on its own terms and does not depend on the
digest gate. A real WhatsApp message arrived while the daemon was running
and the daemon digested it **by itself** — no proof stepping, no human:

```text
mandates: bug-reports(listening) keepup(listening)
→ keepup: message received
~ keepup: memory digested (2 claims)
```

Receipt all green, including `stayedSilent`: listening mode remembers
without ever speaking. The retained claims are the right two — the issue
("build 02a54f crashes on Android when opening the settings page") and the
repository routing ("ambient-agent is the repository against which … is
being filed") — which is exactly the evidence shape Workers v1 needs.

The proof drives the real daemon (bare `ambient` on the rig home) and
asserts through its voice, so it needed `memoryDigested` in the operational
log — memory was previously silent, invisible to an operator watching a
default-on subsystem. Two hazards it exposed and now handles: two folders
claiming one chat id make BOTH inert (the rig still carried home-live's
mandate for that chat, which would have silenced this proof and blamed the
digest loop), and libsignal prints private key buffers from any process
running a real account, so the proof muzzles it as the daemon does.

**Recommendation withdrawn (corrected by the master, same session).** This
record first recommended holding the bar until the gemini pool recovered, so
the yardstick would match the one that set it. That was wrong on its
premise. Gemini was never a standard — it was a free model that happened to
be there, and it is not the model Ambient intends to run. A number produced
by a throwaway model is not a bar to defend.

**The bar is re-baselined on the model we intend to run.** Golden 20/22 is
retired as a target. `gpt-5.6-terra` with the identity fix below sets the
new baseline, and the answer key itself needs the per-chat rework named in
the canon before any count deserves to gate a ship.

## The MVP and the road (reset 2026-08-13, with the master)

**The MVP.** Ambient on one machine, run from `~/.ambient`: speakers active
per mandates; memory default-on, caught up and keeping up live; one real
Worker journey (Bug Reports evidence → GitHub issue in the right
repository); and the Root in the master chat operating the system through
the same operations the CLI exposes. The human-friendly CLI and the TUI
are post-MVP.

**Inventory — what exists vs what the MVP still needs:**

- speaker agent: shipped, live-proven;
- memory agent: rebuilt on the speaker's pattern (below), brief-aware, and
  now **live-proven keeping up** (a real message digested by the running
  daemon). Catch-up is NOT shipped to production: the ship gate is red on
  golden coverage and the gemini yardstick is unavailable — see the memory
  ship gate record above, which needs the master's decision;
- evals: shipping signal + judged gates held as the yardstick through the
  rebuild;
- home + ops CLI: decided (ADR 0001/0002), not built — the active slice;
- worker: not built; the journey and the bar are already named (queued
  brief below);
- root: not built; comes **last** — it operates everything else through
  the ops surface, so that surface and the other kinds must exist first.

**Order** (one active slice at a time; the next is selected at each review
stop, never committed in advance):

1. **Done (2026-08-13):** Home v1 — proof gate passed (record above).
   **Done (2026-08-13): Identity & Voice** — canonical identity and the
   operational log, proof green. **Active: none** — the memory ship gate is
   next, in a fresh context window.
2. **Attempted, still open:** the memory ship gate. Done: the recorded
   verdict on the three claims (extraction overreach) and the four defects
   it exposed, fixed; one real message digested through the running system
   with retained evidence. NOT done: the production wipe-and-re-read — the
   gate is red and the yardstick model is cooling down. The remaining
   decision is the gate's own terms, not the extraction; see the record
   above.
3. **Themes, MVP-ordered but uncommitted:** Workers v1 (queued brief
   below) — **done =** the delegation loop proven end to end (durable
   assignment → worker run → durable result → originating inbox → speaker
   reports it), the six-question protocol answered, crash/retry
   deterministic tests, one live filing into the right repository with
   retained evidence, `worker-*` eval cases. Root v1 (the master chat
   gets its occupant; its tools are the ops surface) — **done =** a
   master-chat message causes the Root to operate the system through the
   ops tools (activate a chat, revise a mandate via the validating write
   path) with durable evidence per operation and no raw file writes: the
   journey "activate the gym group" happens entirely from WhatsApp. That
   is the MVP. Post-MVP themes: the human CLI pass and OpenTUI
   dashboard (opens with the workspace split), brief-aware judge,
   packaging/npx, git-backed home, wiki projection, derived-maps
   regeneration, dormant `skills`/`run_skills` table deletion.

## Product direction

The current product model is defined in
[`../canon/product-model.md`](../canon/product-model.md). Canonical module and
protocol ownership is defined in
[`../canon/architecture.md`](../canon/architecture.md). Ambient is one Root-led
autonomous entity whose Conversation Agents manage situated WhatsApp
relationships, Workers perform bounded objectives, and Memory Agents maintain
evidence-backed continuity.

## Proven implementation

The existing backend has valuable behaviour that must survive restructuring:

- authenticated WhatsApp state and retained local history are preserved;
- the accepted-source log is followed with a durable cursor;
- live inbound text is retained exactly once as an Observation and Conversation
  Inbox item;
- Conversation work coalesces rapid input into bounded immutable claims;
- leases, retries, expiry recovery, and shutdown abort are durable;
- model runs, tool calls, evaluations, and model snapshots are retained;
- memory recall selects current evidence-backed claims before filtering and
  limiting;
- WhatsApp sends use scoped destinations and durable idempotent operations;
- a real inbound message was processed by Qwen and one guarded reply was sent
  only to the authorized `Tst` group.

These are implementation assets, not proof that the current module boundaries
are correct.

## Rescue scorecard

All boundaries from the 2026-08-12 architecture audit are realized:

| Area          | Boundary                                                       | State                                                                                              |
| ------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Application   | One authoritative `createAmbient(config)`                      | Rescued; proofs share the composition through the harness                                          |
| Models        | One deep `ModelRuntime` resolved at startup                    | Rescued                                                                                            |
| Conversation  | `ConversationService` plus one `ConversationWorkStore`         | Rescued                                                                                            |
| WhatsApp      | Ambient-owned service facade plus conversation-bound text send | Rescued; further effect capabilities arrive with product                                           |
| Persistence   | Stores shaped around transactional invariants                  | Conversation work rescued; remaining repositories are app-internal reads pending their role slices |
| Proofs        | Shared composition with explicit proof surface                 | Rescued                                                                                            |
| Configuration | Validated structured document plus external secrets            | Rescued                                                                                            |

## Completed slices

### Baseline recovery and composition-root rescue

The abandoned provider refactor was removed without changing retained product
data or the proven Phase 2B runtime. The executable baseline was validated before
the lifecycle work continued.

Production now has one authoritative composition root:

```ts
const ambient = await createAmbient(config);
await ambient.start();
const exit = await ambient.wait();
await ambient.stop();
```

`main.ts` no longer receives or coordinates the concrete database, WhatsApp
controller, or Conversation scheduler. The Ambient lifecycle owns startup,
unexpected WhatsApp failure, idempotent shutdown, and cleanup failure reporting.
WhatsApp-specific detachment interpretation remains inside the WhatsApp module.

The post-slice review found and closed two lifecycle defect classes:

- cleanup failure could leave `Ambient.wait()` pending forever;
- WhatsApp failure or shutdown during attachment could still start Conversation.

Proof scripts still use the lower-level resource factory. Migrating them onto the
production composition path remains explicit rescue work rather than being
silently claimed complete.

**Proof**

- `vp check`: clean, 42 source files;
- `vp test`: 58 tests across 11 files;
- focused lifecycle and WhatsApp failure tests: 11 tests;
- `drizzle-kit check`: clean;
- frozen strict-peer installation: clean;
- no live model call or WhatsApp send was performed.

### Mapping cutover

The architecture audit now records:

- every current production module with a Keep, Reshape, Merge, Internalize,
  Remove, or Defer disposition;
- target Ambient, model, WhatsApp, Conversation, store, evaluation, and proof
  boundaries;
- dependency direction and forbidden imports;
- transaction and durable-protocol ownership;
- a Conversation-scoped WhatsApp capability model grounded in `whatsappd`'s
  existing typed durable operations;
- proven behaviour, current architecture, and deliberately unimplemented
  product frontiers;
- a scored comparison of the next rescue candidates.

No runtime code changed during this cutover.

### Conversation service and work-store rescue

The proven Conversation journey is now expressed through one coherent service
and one authoritative durable work store, with no runtime behaviour change:

- `src/conversation/contract.ts` owns the Conversation vocabulary and ports:
  `ConversationWorkStore`, `ConversationRecall`, `ConversationEvaluationSink`,
  `ScopedMessageSender`, and the role-agent contract. It imports no concrete
  database, Drizzle, Pi, or `whatsappd` types.
- `src/conversation/service.ts` (`createConversationService`) owns timing,
  debounce-driven claiming, context construction, tool binding, lease renewal,
  shutdown abort, and process-local wake acceleration.
- `src/database/conversation-work.ts` implements the work-store port and is the
  single transaction path for claims, leases, Agent Run creation, tool
  evidence, completion, Inbox consumption or release, retries, and
  expired-lease recovery.
- The Inbox repository is reduced to retention and a pending read model; the
  Run repository to non-conversation run creation and evidence reads. Their
  former claim, consume, release, and completion methods are gone.
- The synchronous run-contract evaluation moved behind the Conversation-owned
  evaluation sink, implemented next to the evaluations store.
- A restart regression proves a lost process-local wake callback cannot strand
  committed Inbox work: reconciliation at service start drains it.

**Proof**

- `vp check`: clean, 42 source files;
- `vp test`: 58 tests across 11 files, including the new lost-wake restart
  regression and work-store tool-evidence invariants;
- `drizzle-kit check`: clean;
- frozen strict-peer installation: clean;
- no live model invocation or WhatsApp send occurred.

### Model runtime and structured configuration

The model subsystem is now one deep module resolved once at startup:

- `src/models/contract.ts` owns the provider-neutral vocabulary: the durable
  `ModelConfig` snapshot, `ModelRole`, and the validated models document
  (provider definitions with secret references, role profiles). The deployment
  catalogue is data: `ambient.config.json` committed at the default path, not
  a document shadow-copied in code.
- `src/models/runtime.ts` (`createModelRuntime`) constructs Pi providers,
  resolves credentials from the environment (the only application code that
  does), validates every configured role once, and hands each role a
  `ModelRunner`: snapshot, resolved immutable model, and a stream bound to the
  role's generation limits. Missing credentials, unknown providers, and
  unconfigured roles fail closed with precise errors.
- `conversation/pi-agent.ts` keeps only role behaviour (prompt, tools, input
  formatting, terminal result) and consumes a bound runner; the role-agent
  contract no longer carries a model parameter. The per-role environment
  matrix, `agent-models.ts`, and the repository's last `any` are gone.
- The models section of configuration is a validated JSON document
  (`ambient.config.json`, path via `AMBIENT_CONFIG`); adding another
  OpenAI-compatible provider is a configuration-only change, proven by a
  deterministic test. `proof:model-runtime` runs every configured role live
  outside WhatsApp when invoked explicitly — Qwen by default, local Vibe by
  pointing a role at the bundled `vibe` provider.

**Proof**

- `vp check`: clean, 45 source files;
- `vp test`: 67 tests across 12 files, including model-runtime resolution,
  fail-closed credential and provider errors, and the config-only provider
  addition;
- `drizzle-kit check`: clean;
- frozen strict-peer installation: clean;
- no live model invocation or WhatsApp send in deterministic tests.

### Rescue sprint: proof composition, configuration, WhatsApp boundary

Agreed 2026-08-12 and completed the same day as two gated slices. Proof for
both: `vp check` clean (47 files), `vp test` 63/63 across 12 files,
`drizzle-kit check` clean, frozen strict-peer install clean, no live model
call or WhatsApp send in deterministic tests, no controller import outside
`src/whatsapp/`, no wiring import in WhatsApp proof scripts.

#### Slice: proof composition and configuration sweep

**Product question.** Can both proofs run on the same composition assembly as
production through one narrow harness — destination discovery, accepted-input
waiting, one bounded run, read-only evidence — with no raw schema access, no
rebuilt services, and all structured configuration in the validated document?

**Owner.** `app/proof.ts` owns the harness over the private composition
assembly; `app/config.ts` owns the full validated document; the run repository
gains two evidence reads; proof scripts keep only proof policy (target hint
matching, timeouts, reporting).

**Safety.** The harness takes an explicit `authorizeDestination` override that
strengthens the final outbound guard inside the production sender; without it
the Conversation role is not composed at all. No live send or model call in
deterministic tests.

**Non-goals.** No WhatsApp facade change (next slice); no new proof kinds.

**Proof gate.** WhatsApp proof scripts import no Drizzle, schema, repository,
service, or model-runtime symbols (the model proof consumes the models
module's own public runtime by design); every former
`CONVERSATION_*`/`WHATSAPP_*` structured env var is document-owned with env
retained only for secrets, `AMBIENT_CONFIG`, and deployment overrides
(`AMBIENT_DATABASE_URL`, `WHATSAPP_DATA_DIR`, `WA_LOG_LEVEL`); all gates
(`vp check`, `vp test`, `drizzle-kit check`, frozen strict-peer install) pass.

#### Slice: WhatsApp boundary

**Product question.** Can the application and proofs consume WhatsApp only
through an Ambient-owned service facade — lifecycle, a conversation-bound text
effect, and narrow destination discovery — with the concrete session
controller private to the WhatsApp module?

**Owner.** `whatsapp/service.ts` owns the facade (`start`, `waitForFailure`,
`stop`, `conversationSender`, `destinations`) and hides controller
construction, deployment options, snapshots, and raw send methods.
Composition and the proof harness lose every concrete controller reference.

**Non-goals.** No new model-visible WhatsApp tools or capability groups
(reactions, media, read state follow real product slices); no change to
ingestion or durable operation semantics.

**Proof gate.** No file outside `src/whatsapp/` imports the session
controller; the lifecycle consumes `start`/`stop`/`waitForFailure`; the
outbound destination guard and loopback policy live behind the facade with
the proof override still strengthening the final guard; all gates pass.

## Completed slice: memory on the speaker's pattern (2026-08-13)

Selected by the master mid-session after stopping the live-memory grill:
"producer" and "job" were repudiated as product concepts, the wayfinding
process was abandoned, and the direction reset to the simplest system — the
memory agent as the speaker's peer. V2's extraction-quality work (the
golden-first method, attribution recovery, host validation, versioned facts)
is preserved; v2's bespoke machinery is deleted.

**Product question.** Does memory behave as presence, not plumbing:
default-on for every allowed chat, catching up on the retained past and
keeping up with live traffic, through the same agent pattern the speaker
runs — no jobs, no producer, nothing a human must trigger?

**Owner.** `memory/` owns the agent (now on pi's Agent with a
`propose_facts` tool) and the service loop; `database/memory-work.ts` owns
the one durable transition; `whatsapp/message-payload.ts` owns the
retained-payload schema every reader now shares (was four copies).

**Durable protocol.**

1. Retained records: the per-chat `memory_schedule` row — digested-through
   watermark, fenced lease, attempt count — plus the agent run.
2. Owning service: the memory work store. Due-ness derives from retained
   observations against the watermark: a full window (40) is due
   immediately, any smaller backlog is due once quiet for 5 minutes —
   data-derived, never a process timer.
3. Consumer: the memory service drain, already in the production lifecycle.
4. Idempotency: claiming opens the lease and the agent run in one
   transaction; the window's deterministic patch key
   (`patch:window:<first-observation-id>`) means even a re-claimed crashed
   attempt recovers instead of digesting twice.
5. Retry/recovery: lease expiry reopens the chat; a failed window re-derives
   identically and re-runs; three consecutive failures park the chat.
6. Evidence: the run (input, result, and now tool calls), the ontology
   patch, and the evaluation signal riding the terminal transition.

**The agent, on the pattern.** `MemoryAgent.run(input, tools, signal)` — the
contract AGENTS.md always prescribed. `propose_facts` validates AND applies
at the tool boundary; a rejected proposal returns to the model in-loop
(capped at 3); never proposing is memory silence, an empty digest. The
one-shot JSON-scraping call is gone. Prompt: a general analyst base plus the
mandate's per-chat memory brief (`conversation_speakers.memory_brief`,
seeded like instructions); the Bug Reports issue-centric focus is now that
chat's brief, not the prompt. promptVersion `memory-v3`.

**Evals.** Untouched by design — the master's yardstick decision: same two
cases, same signal, same golden grading; the evidence assembler merely
stopped expecting a `jobId`. The digest proof now drives the production
path: seed a listening speaker, drain the memory service window by window.

**Proof.** Deterministic: `vp check` clean (68 files); `vp test` 89/89
across 15 files (new: default-on gating including unlisted chats never
digesting, quiet coalescing, ordered windows, park-after-three, memory
silence, brief flow, crash-recovered windows); `drizzle-kit check` clean
(migrations: drop `memory_jobs`, create `memory_schedule`, add
`memory_brief`). Live (rig, 2026-08-13, gemini pool, wipe-and-re-read per
the master's decision; pre-wipe backup in `.proof-private/backups/`): the
rebuilt agent re-derived the Bug Reports memory from source through the
production path — 8 windows, contract metrics perfect on every window
(grounding 1.0, zero banned identity links), **golden coverage 20/22 — the
best yet** (v2 shipped 17/22; newly met labels include previously-unmet
ones; only the prayer-times root-cause phrasing and the "vital" preference
remain), 40 issue / 7 person / 4 repository / 1 product / 4 organization
entities, 180 claims, 168 recalled. Judged: completeness mean 0.86 (gate
0.7); faithfulness mean 0.93 BUT one window scored 0.67 — below the 0.7
per-window floor, so the strict judged gate did not pass on the first
attempt (the judge flagged 3 of that window's 9 claims as not fully
supported; all cite real batch messages, so the dispute is wording, not
fabrication). Production ship deliberately withheld pending that review.

**Ship status.** Superseded by the memory ship gate below (2026-08-13), which
answered the three flagged claims and rebuilt the extractor around what they
exposed.

**Open questions.** Live retention gaps (media and Ambient's own messages
are not retained live — the mapper keeps inbound text only); abandoned
`running` runs are never terminalized (preexisting); the memory dials
(window 40 / quiet 5m / poll 15s) are service defaults, promoted to
configuration when tuning becomes real.

## Completed slice: Memory v2 — golden-first rebuild (2026-08-12)

Selected from the Memory v1 post-slice review, in the master's words: look
at the group and the ontology first, make the golden data set, and treat
the screenshots as part of the record.

**Product question.** Does the Bug Reports group's memory now match what a
careful human reader finds in the same thread — every person, repo, and
issue with its evolution — instead of a green-but-hollow digest?

**The golden pass (private reference, `.proof-private/`).** A full manual
read of all 252 mirror messages plus every image and video frame produced
a hand-labeled reference ontology: the real people behind the lids (the
group was never two-participant — quoted replies and mentions carry five
distinct voices), 5 repositories including the wrong-target design-system
dump and the unnamed API repo, 18 distinct issues with status evolution
(the prayer-times saga ends root-caused with a Reset-button follow-up;
pinch-zoom ends fixed-verified), the product's stable facts, and the
master's standing agent-quality preferences. The screenshots carried
decisive evidence — the Fajr comparison set shows iOS disagreeing with
four independent sources by ~50 minutes — so media is now imported as
evidence (refs and captions retained; bytes stay in the store).

**Defects fixed before extraction.**

- The mirror's historical group rows carry NO author — `sender` and
  `ref.participant` are both the chat id, worse than the v1 audit
  believed. Import now drops the group-id sender instead of presenting
  the chat as a person, and carries mentions and quoted-reply context
  through; the job store deterministically recovers authorship where a
  quoted reply names the quoted author, and mentions become linkable
  identities. Chat ids are banned as identities at the mutation path AND
  in the `identity_scope` eval metric.
- The poisoned v1 digest was surgically reset from both databases
  (pre-reset backups in `.proof-private/backups/`), integrity-checked
  before commit.

**Extraction reshaped from the reference.**

- `memory-v2` prompt: issue-centric coverage mandate ("missing an issue is
  worse than a modestly-worded claim"), dedup/evolution via supersession,
  attribution honesty, attachments as citable evidence, claim economy.
- Sequential windowed digestion (40 messages per durable job) so later
  windows see the ontology earlier windows built.
- The ontology view a window receives now includes entities evidenced in
  the conversation, not only sender-linked ones — without this, issue
  entities (which have no identity links) were invisible to later windows
  and cross-window dedup was structurally impossible.
- One current claim per (entity, predicate) is now a host invariant: a
  restated fact becomes a reinforcement, a changed fact becomes a
  supersession, and the model's uuid transcription can no longer
  invalidate a proposal (the adapter presents m1/E1/P1/C1 symbols and
  translates back).

**Evals that can now see.** `memory-judged-v2` gives the judge the FULL
window plus the claims — the v1 judge saw only cited evidence and was
structurally blind to omission — and adds a `memory_completeness` score.
The digest proof grades the shipped ontology against the golden reference
mechanically: mustFind pattern coverage with a minimum, banned identity
suffixes, and minimum issue/person entity counts. Judged gates aggregate
across windows (mean faithfulness ≥ 0.85 with a 0.7 per-window floor) so
one verdict on a small window cannot flip the proof.

**Proof.** Deterministic: `vp check` clean (67 files); `vp test` 84/84
across 15 files (new: quoted-author recovery + mention linking + chat-id
rejection; reinforce/supersede dedup invariant; media-aware import);
`drizzle-kit check` clean (no schema change). Autonomous rig + production
(2026-08-12, gemini pool): 251 observations imported per database
(media included), 7 windowed digests each, every contract metric green on
every window. Rig: faithfulness 1.0 on all 7 windows, completeness mean
0.93, 159 recalled claims, 37 issue / 4 person / 4 repository entities,
golden coverage 17/22 (minimum 16). Production ship: faithfulness mean
0.95 (floor 0.83), completeness mean 0.93, 181 recalled claims, 37 issue /
5 person / 4 repository / 1 product entities, 185 claims, golden coverage
17/22. Zero identity links to chat ids in either database.

**Honest headroom.** Five golden labels stay unmet (the two developers'
names, the root-cause-in-one-claim phrasing, the sunrise-minus widget bug,
the "prayer times are vital" preference) — real extraction targets the
reference keeps visible, not gate failures. Vision-derived claims from
screenshot content remain future work; media refs and captions are
retained for it.

**Open questions.** Incremental memory on live traffic; who authors memory
jobs in production (the Root, later); predicate governance as the ontology
grows; when speaker recall should use the new conversation-scoped read.

## Completed slice: Memory Agent v1 (2026-08-12)

Selected 2026-08-12 under the master's standing crack-on directive; the
evaluations review found no owed simplifications (the pending-signal
pattern now exists twice — evals and the coming memory jobs — and stays
unshared until a third real use proves the promotion).

**Product question.** Can Ambient turn retained real conversation history
into evidence-backed memory — entities, identity links, and validated
claims — that recall then actually returns?

**Concrete journey.** The blessed Bug Reports history (~250 retained text
messages, two participants) is imported read-only from the production
device's mirror as historical Observations — evidence only, never Inbox
work. One durable Memory Job digests them: the Memory Agent (memory role,
gemini pool) receives the bounded batch plus the current ontology view and
proposes entities, identity links, predicates, and claims; the host
validates and applies them through the existing patch machinery. Recall
for the two participants then returns real evidence-backed claims — proven
offline on the rig, no WhatsApp connection, no human.

**Owner.** `whatsapp/` owns mirror→observation history mapping (bounded
import from a designated mirror, read-only); `memory/` owns the Memory
Agent contract, prompt, and host-side validation; `database/` implements
the job store; the proof harness gains narrow memory stepping.

**Durable protocol.** `memory_jobs` — one digest job for one conversation
batch: pending → claimed under a fenced lease → done or failed; the agent
invocation is retained as an `agent_runs` row (role `memory`); ontology
changes apply only through `memory_patches` with its existing
memory-role gate; historical observations dedupe on native identity;
lease expiry reopens an abandoned job.

**Smallest API.** `MemoryAgent.run(input)` returning proposed operations
plus a private report — one bounded model call, host-validated, no tools
in v1; `MemoryJobStore { create, claimNext, complete, fail }`; one history
import entry point on the WhatsApp module; recall unchanged.

**Preserved invariants.** History creates no Inbox items and wakes no
speaker; `applyPatch` remains the only claim mutation path and stays
role-gated; mirrors are read read-only; nothing derived from the profiles
enters code, logs, commits, or receipts.

**Non-goals.** Episodes; incremental memory on live traffic (the next
memory slice, needs a producer policy); listening-chat scheduling;
cross-chat synthesis.

**Proof.** Deterministic: `vp check` clean (67 files); `vp test` 82/82
across 15 files (digest apply + recall + evaluation, invalid-proposal
rejection without ontology damage, lease recovery with the idempotent
per-job patch, history import mapping/dedup with no Inbox rows). Rig and
production (autonomous, 2026-08-12): 236 text messages imported from the
designated mirror (16 non-text skipped); one live digest each on the
gemini pool; `memory-contract-v1` passed all five rules with grounding
1.0; `memory-judged-v1` faithfulness 1.0 with no missed-facts flag; recall
returned evidence-backed claims on both databases (3 rig, 5 production).
**Shipped:** production memory now knows the Bug Reports group — people,
projects, and notably `github_username` and `repository_url` knowledge,
which is exactly the repo-routing evidence Workers v1 needs. The private
golden file was authored from the first digest and is operator-editable.
Digests are deliberately conservative (few strong claims); richer
extraction is prompt iteration, now measurable through the eval cases and
replay.

**Post-slice review (2026-08-12, with the master).** The master's audit
showed the green metrics measured internal consistency, not truth. Three
defects: the history import kept the mirror's `sender` field — which for
group messages is the chat itself — so 174 of 238 messages lost their true
author (`ref.participant`) and the one identity link bound a person to the
group id; the completeness probe judged only the cited claims and never saw
the batch, so omissions were structurally invisible; and the
conservative prompt yielded roughly a tenth of the salient facts. A manual
read of the full corpus found ~18 issue-worthy bugs and features (several
with status evolution and a root-caused fix — supersession material), five
distinct people, four repositories, and the master's standing
agent-quality preferences — none captured. Media messages (screenshots,
part of future issue filing) were skipped entirely by the import.
Memory v2 is therefore golden-first: fix attribution and media import,
reset the poisoned digest from both databases, hand-label the corpus
(including images) into a private reference ontology, derive the target
ontology shape from it, then reshape the extractor and score coverage
against the reference. Recorded lesson: an eval only measures what it is
pointed at.

**Open questions.** Incremental memory production for post-watermark
traffic; who authors memory jobs in production (the Root, later);
predicate governance as the ontology grows.

## Completed slice: asynchronous evaluations v1 (2026-08-12)

Selected 2026-08-12 after the speaker-presence review (master confirmed the
sequence). Review findings: the gate stayed one shared function with no new
mutation paths; per-chat instructions leaked no provider types; the speaker
vocabulary earned its place. No simplifications owed.

**Product question.** Can reply quality be judged and iterated from durable
run evidence — asynchronously, with the live Conversation path never waiting
on evaluation, and with a model judge under the reserved `evaluator` role?

**Concrete journey.** The rig runs the live loop; the subject's run
completes and durably signals evaluation; the async runner claims the
signal, records the deterministic contract metrics from retained evidence,
and a judge under the `evaluator` role scores the reply decision and
quality. Separately, the latest retained run input replays offline through
the current prompt with a stubbed sender — a live model call, no WhatsApp
send — retaining a replay evaluation.

**Owner.** `evals/` owns the evaluation contracts, service, and judge;
`database/evaluation-work.ts` implements the claim/consume store; terminal
run transitions in `database/conversation-work.ts` write the durable signal
inside their existing transactions; composition wires the runner into the
Ambient lifecycle; the proof harness gains evaluation stepping and replay.

**Durable protocol.** `evaluation_pending` (subject run id) is the handoff,
written atomically with every terminal run transition (complete, fail,
expired-lease recovery). The runner claims under a lease, retains
`evaluation_runs` — the contract case plus a judged case whose
`evaluatorRunId` links the evaluator-role agent run — and consumes the
signal last. Dedup key: subject run + case id. A crash inside the window
can duplicate an evaluation row: accepted, because evaluation is
observational and never authoritative.

**Smallest API.** `EvaluationService { start, stop, runOnce }`;
`EvaluationWorkStore { claimNext, complete }`; `ConversationJudge`;
`RunRepository.finish` for non-conversation runs. The Conversation service
loses its evaluation dependency entirely.

**Preserved invariants.** Evaluation failure never changes run or effect
outcomes; the live path performs no evaluation work; destination and effect
guards untouched.

**Non-goals.** No judged comparison across promptVersions yet (replay
retains its outcome; comparison lands with the first real prompt bump); no
memory or worker evaluation; no alerting.

**Proof.** Deterministic: `vp check` clean (58 files); `vp test` 78/78
across 13 files (signal on complete, fail, and expiry recovery;
claim/consume; judge-failure retention; lease contention; evidence
assembly; the live path free of evaluation awaits); `drizzle-kit check`
clean; frozen strict-peer install clean. Rig (autonomous, 2026-08-12): the
live loop passed with evaluations — the contract case succeeded and the
judge scored the real reply (`reply_decision` passed, `reply_quality`
1.0) — and `proof:conversation-replay` re-ran the latest retained input
offline (decision `reply`, 53 characters, no WhatsApp connection opened).
Two defects were caught and fixed en route: the vibe sonnet pool
intermittently demands thinking (judge and rig conversation roles moved to
the gemini pool), and evaluator runs sharing their subject's conversation
id exposed that `latestRunForConversation` must mean the conversation
role's own latest run.

**Open questions.** Judge-case coverage grows from accumulated real runs;
replay comparison shape; the production evaluator provider (vibe is
local-only; the role flips to a hosted provider when the deployment needs
it).

## Completed slice: speaker presence (2026-08-12)

**Shared vocabulary** (master ↔ canon, agreed 2026-08-12): a **speaker** is
the Conversation Agent presence in one chat — all speakers are instances of
the same agent with different per-chat grants. An **allowed chat** is one
with a durable speaker record (earlier ledger entries called this a
"Conversation mandate"; same record, renamed — it remains the first form of
the product model's Conversation assignment). A speaker record carries a
**mode** (`listening` | `responding`; `proactive` reserved) and an
**activation point**. The Root later authors these records through the
master's special chat; until then the operator seeds them from
configuration. The claiming-not-ingestion constraint stands: every accepted
message is still observed and retained; speakers run only in allowed chats.

### Slice: speaker presence — live replies in allowed chats

**Product question.** Can Ambient hold durable per-chat speaker presence —
replying live only in chats the operator has allowed, in the right mode,
from the activation point onward — without weakening the proven ingestion,
claim, lease, and effect invariants?

**Concrete journey.** The operator seeds the `Tst` group and their own
number as `responding`. A member posts in `Tst`; the speaker claims the
batch and one guarded live reply lands (`outboundMode: "conversation"`,
conversation enabled). A message in any other chat is retained as an
Observation and Inbox item but is never scheduled, claimed, or answered. A
restart changes nothing durable.

**Owner.** `conversation/contract.ts` owns the speaker-record vocabulary and
seed port. `database/conversation-work.ts` gates window authoring inside its
existing transactions: `setPendingWindow` never sets `dueAt` without an
active `responding` speaker, and both Inbox reads (pending window, claim
row-select) honour the activation watermark — `claimNext`, `nextWakeAt`, and
the service loop stay untouched. `app/config.ts` owns the validated
`conversation.speakers` seed list; composition seeds at startup before the
Conversation service starts.

**Durable records.**

- `conversation_speakers`: `conversationId` PK, `mode`
  (`listening` | `responding`), nullable `instructions` (the per-chat
  overrideable standard prompt; the global config string stays the
  fallback), `attendFrom` watermark, timestamps. `listening` rows are
  accepted and inert until the Memory slice gives them behaviour.
- Seeding is **upsert-listed**: configuration authors exactly the rows it
  names and never touches rows it does not name (the future Root authors
  those). A listed entry may set `mode: "listening"` to silence a chat.
- The gate is the state transition: no active `responding` record ⇒ no
  schedule window ⇒ no claim, while Observation and Inbox retention continue
  unchanged for every accepted message. Backlog from before `attendFrom` is
  never claimed; full history belongs to the Memory slice.

**Smallest API.** One seed port on the Conversation contract plus the gate
inside the existing work store. The production sender now receives an
authorize bound to speaker records — the proof-only strengthening of the
final outbound guard becomes a production invariant (destination sendable ⇔
active `responding` speaker).

**Preserved invariants.** Exactly-once ingestion; bounded immutable claims;
fenced leases, retry, and expiry recovery; operation receipts as the only
proof of communication; terminal results stay private; loopback proofs
unchanged.

**Non-goals.** No Memory Agent, no skill loading, no `proactive` wiring, no
Root, no new WhatsApp capabilities (reactions, media), no per-chat
scheduling overrides.

**Proof gate.** Deterministic: an unlisted chat is never scheduled or
claimed; `listening` never claims; pre-`attendFrom` items are never
claimed; upsert-listed seed semantics (unnamed rows untouched); config
validation fails closed. All repository gates (`vp check`, `vp test`,
`drizzle-kit check`, frozen strict-peer install). Then one controlled live
proof: a real reply in `Tst` with `outboundMode: "conversation"` under the
speaker-bound authorize.

**Open questions deliberately not resolved.** Skill-loading mechanics
(researched below, deferred until the first real skill exists); whether
`listening` chats receive Memory runs (Memory slice); proactive restraint
policy; the Root authoring protocol and the master's special chat.

**Proof.** Deterministic: `vp check` clean (50 files); `vp test` 73/73
across 12 files (ten new gate, watermark, seed, and instructions tests);
`drizzle-kit check` clean; frozen strict-peer install clean; no live model
call or WhatsApp send in deterministic tests. Live (autonomous,
2026-08-12): the two-account rig ran the full loop — one peer ping accepted
exactly once, one Conversation run claimed behind the speaker gate and
succeeded, `recall` and `send_message` tool evidence retained with a
durable operation receipt, and the reply delivered to the peer's own mirror
with the loop token echoed. No human was involved. En route the loop
exposed a real defect: the `credential: "none"` provider path resolved no
stream-time key, so every vibe-backed run failed; `src/models/runtime.ts`
now resolves pi-ai's `"unused"` placeholder. Production go-live in `Tst` is
now purely an operator config flip (seed the real group id,
`enabled: true`, `outboundMode: "conversation"`).

### Research note: prompt and skill primitives (2026-08-12)

Requested by the master during replanning ("what primitives do we have?").

- `pi-agent-core` (the only Pi layer Ambient depends on, with `pi-ai`) has
  no prompt layering: `AgentState.systemPrompt` is one plain string Ambient
  assembles; tools are explicit `AgentTool`s. It DOES ship skill loading
  (verified against the installed 0.84.1, `dist/harness/skills.d.ts`):
  `loadSkills(env, dirs)` with recursive SKILL.md discovery and
  `loadSourcedSkills` with per-directory provenance tags.
- `pi-coding-agent` (present in the store, not a project dependency)
  implements the Agent Skills standard (agentskills.io): SKILL.md packages,
  names + descriptions always in the system prompt, full instructions loaded
  on demand through a read tool (progressive disclosure). Prior art to copy,
  not a library speakers can consume.
- Ambient already retains the durable half, unused: `skills`
  (name/description/instructions/revision) and `run_skills` (per-run
  instruction snapshots) in the schema.
- Speaker prompt model settled: fixed shared system prompt (identity, same
  for every speaker) + per-chat overrideable standard prompt (this slice) +
  granted skills (later: eager-append instructions while skills are few and
  short; adopt progressive disclosure with a load tool if they multiply).

## Where things stand (wrap-up, 2026-08-13)

**Have:** the memory rebuild on the speaker's pattern (above), green on
every deterministic gate and better than v2 against the master's
hand-labelled answer key (20/22 vs 17/22) on the rig. The eval machinery
survived unchanged as the yardstick. Wayfinding abandoned; vocabulary
reset to the master's terms.

**Don't have:** production ship (still v2's memory); a judge that knows the
chat's brief (it scores generic extraction craft, not the chat's mandate);
worker/root evals (those kinds don't exist yet); live retention of media
and own messages.

_Struck through by the memory ship gate record above (2026-08-13): the live
keep-up run now exists and is green; the flagged-claims verdict is
recorded; and the judge's reliability is no longer unmeasured — two of its
blind spots were characterized from its own verdicts and fixed._

**Next (items 1–2 are the "memory ship gate" likely-next slice; item 4
happened as the 2026-08-13 reset above):**

1. ~~Review the three flagged claims~~ — done, verdict recorded above.
   The production wipe-and-re-read remains, blocked on the gate decision.
2. ~~One live keep-up proof~~ — done and green (`proof:memory-keepup`).
3. Brief-aware judge: pass the chat's memory brief into the judged case
   as its rubric — chat-scoped evals with one field and one prompt line.
   Now better motivated: this session showed the judge scoring generic
   craft and mis-flagging the ontology's own conventions.
4. The master's re-cut/replanning session, with named seams: per-chat
   answer-key file in the chat folder (build at the second real bed),
   worker evals with the worker, the per-role eval seam formalized at the
   third agent kind, judge-vs-answer-key calibration, the visibility
   layer as a `wiki/` projection.

## Workers v1 — queued candidate brief

Queued as an MVP theme at the 2026-08-13 reset (selected properly at a
review stop). The customer-feedback journey: a bounded Worker files a
GitHub issue from validated Bug Reports evidence, its durable result
returns to the originating conversation's Inbox, and the speaker decides
how to report it. Product context from the master (2026-08-12): a previous
bug-filing agent lived in this group and was retired for being poor — the
bar is real usefulness, and filing must target the **right repository**,
so repo routing is part of the worker's design, not an afterthought.
GitHub credentials are already available on this machine; the proof
targets a scratch repository. Worker runs ship with `worker-*` evaluation
cases per the standing rule.

## Live test rig

Two linked proof profiles copied (checksums verified) from the whatsappd
repo's real-account rig into gitignored `.proof-private/`; the originals in
the whatsappd worktree are now dormant — never run both copies of one
profile concurrently. `android` is the subject and runs the production
composition; `ios` is the peer that plays the human counterpart. The peer's
mirror holds real correspondence, so anything that sends resolves against
`.proof-private/send-allowlist.json` and refuses everything else, per the
whatsappd runbook (`docs/runbooks/real-account-testing.md` in that repo).
Real identifiers never enter code, logs, commits, or receipts — statuses,
counts, and lengths only. `pnpm run proof:whatsapp-live-loop` runs the
whole loop autonomously; testing never requires the operator.

## Known debt

Accepted, durable, and owned here rather than in commit messages:

- **The proof roles are pinned off the pool that set the baseline** —
  `ambient.config.json` and the rig home now name `gpt-5.6-terra` for
  memory and evaluator because every gemini credential is cooling down.
  Move them back when the pool recovers, or the golden number keeps
  measuring two changes at once.
- **A claim-less entity is still representable** — the host accepts a
  proposal that creates an entity with no claim of its own, and recall
  returns claims, so such an entity is invisible to Ambient. `memory-v7`
  fixes this by instruction only. The host invariant (every entity created
  in a proposal owes a claim in the same proposal) is the real fix; it was
  deliberately not added mid-gate because a new rejection path can loop the
  model and fail a ten-minute window.
- **The golden gate matches claim TEXT, not knowledge** — a fact Ambient
  holds but words differently scores zero, which is how a 20/22 bar sits
  inside a ±1 run-to-run band. Calibration belongs with the per-chat
  answer-key seam already named for the master's re-cut.
- **Repository bag** — `AmbientRepositories` is now consumed only inside
  `src/app/` (resources and the proof harness) but remains a bag rather than
  explicit surfaces; `runs.start` has no production caller until a Memory or
  Worker slice; `inbox.enqueue` is the retention path awaiting its first
  `task_update` producer.
- **`root` model role** — the implemented `ModelRole` union and `agent_runs`
  role enum omit `root` until a Root slice creates the first root run.
- **Duplicated text extraction** — the assistant-text flatten exists in
  `pi-agent.ts` and `proofs/model-runtime.ts`; extract on a third caller.
- **Proof harness stepping** — the harness deliberately steps bounded runs via
  `notify` + `runOnce` instead of starting the live service loop (canon's
  "requesting one bounded run" capability); production lifecycle-protocol
  coverage stays with the lifecycle tests. Its accepted-input wait also rides
  the in-memory ingestion callback rather than a durable read since a
  watermark — acceptable for a hint-plus-durable-evidence proof, revisit if a
  proof ever needs crash-safe waiting.
- **Orphaned controller surface** — `waitForHistoryBackfill` and the snapshot
  `subscribe` seam on the session controller have no consumer outside the
  WhatsApp module since the facade landed; the Memory slice either adopts them
  onto the facade or deletes them.
- **DM identity forms** — a WhatsApp DM has two chat ids (phone-number form
  and `@lid` privacy form) and inbound traffic may use either; `ambient
activate <number>` covers only the pn form, so the first real master-DM
  test got silence until the lid form was activated separately (2026-08-13).
  Fix at the next touch: activate resolves both forms via the mirror
  (device-list/contacts know the mapping) and writes one mandate per form —
  or the record gate learns id aliasing.
- **libsignal stdout noise** — live runs print session-establishment output
  (including key buffers) directly from the libsignal dependency, bypassing
  the session logger; capture live-run output to private files only.

## Product-discovery themes

These are not committed sequential phases (the replanned frontier order after
the active and likely-next slices is memory → workers → root, revisited at
each review point):

- Memory Agent v1: full WhatsApp history ingested into memory as far back as
  the mirror goes, plus behaviour for `listening` chats. The operator blessed
  the real Bug Reports working group as the test bed (2026-08-12): ~250 text
  messages over a month, two participants; it is seeded as a `listening`
  speaker in both the production and rig databases, and its ids live only in
  `.proof-private/memory-testbed.json`. Its history exists only in the
  production device's mirror — linked devices do not share back-history — so
  the ingest design must read a designated mirror, not "the" mirror;
- customer feedback delegated to a bounded GitHub Worker;
- long-running supplier qualification;
- cross-thread continuity with Rex;
- Root v1: the master's special chat, Root attention, and the Root authoring
  speaker records, prompts, and skills;
- proactive speaker mode and its restraint policy;
- dynamic Worker definitions assembled from skills and MCP capabilities.

Each theme requires its own slice brief when selected.

## Open rescue questions

- What is the smallest useful operational surface returned by Ambient for
  proofs and diagnostics without leaking internal resources?
- When should history backfill move from WhatsApp session startup to
  Memory-owned indexing?
- Which current tables represent durable product concepts, and which encode the
  old workflow too specifically?
- Which Conversation-bound WhatsApp capability should follow text first:
  reactions, read state, or media?

Resolve these while touching the relevant slice, not in one speculative schema
redesign.
