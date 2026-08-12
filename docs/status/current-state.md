# Ambient Current State

Status date: 2026-08-12.

This is the rolling rescue and delivery ledger. It records the current truth,
not a distant phase plan.

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

## Active slice

None. **The architecture rescue is complete**: every boundary from the
canonical map is realized — one composition root, one Conversation service
over one work store, one deep model runtime, the validated configuration
document, the shared-composition proof harness, and the WhatsApp service
facade. The next step is a full replanning session with the master to
sequence the product frontier (conversation presence, Memory Agent, Workers,
Root) to a usable outcome. No product slice starts before that session.

## Known debt

Accepted, durable, and owned here rather than in commit messages:

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

## Product-discovery themes

These are not committed sequential phases:

- Root-managed Conversation presence;
- customer feedback delegated to a bounded GitHub Worker;
- long-running supplier qualification;
- cross-thread continuity with Rex;
- Root attention and proactive commitment review;
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
