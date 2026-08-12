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

## Current architectural problems

| Area          | Preserve                                                                         | Problem                                                                                                       | Intended boundary                                      |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Application   | Correct startup and reverse-order shutdown                                       | Proofs still bypass the rescued production composition                                                        | One authoritative `createAmbient(config)`              |
| Models        | Successful Qwen run and durable model snapshots                                  | Rescued: one `ModelRuntime` resolves configured roles once; providers, credentials, and Pi stay in `models/`  | One deep `ModelRuntime` resolved at startup            |
| Conversation  | Durable debounce, claims, leases, tools, sends, and recovery                     | Rescued: one `ConversationService` over one Conversation-owned `ConversationWorkStore` port                   | `ConversationService` plus one `ConversationWorkStore` |
| WhatsApp      | Session recovery, accepted-source ingestion, retained mirror, durable operations | Concrete controller and callback mechanics leak into composition; Conversation has only an ad hoc text sender | Ambient-owned service plus conversation-bound effects  |
| Persistence   | Proven atomic transactions                                                       | Conversation work is store-shaped; remaining repositories are still table-shaped behind the public bag        | Stores shaped around transactional invariants          |
| Proofs        | Guarded live destination and retained evidence                                   | Proofs rebuild production wiring and duplicate policy                                                         | Shared Ambient composition with explicit proof ports   |
| Configuration | Secrets stay out of durable runs                                                 | Models are a validated JSON document; remaining deployment scalars still load from environment variables      | Validated structured document plus external secrets    |

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

## Active slice

None selected. Per delivery practice, the next slice is chosen after the
post-slice review of the model-runtime rescue.

## Likely next slice

### Proof composition

Migrate the two proofs onto the production `createAmbient` composition with
explicit narrow proof ports instead of the lower-level resource factory and
repository bag. The Conversation and model boundaries the proofs need now
exist, which raises this candidate's dependency value: it retires the last
alternate composition root and the direct store access in
`proofs/whatsapp-conversation.ts`.

## Rescue-candidate comparison

Scores are 1 (weak) to 5 (strong). Risk is scored inversely, so 5 means lower
implementation risk. Conversation (23) and model runtime (20) are completed
above.

| Candidate                     | Leverage | Interface certainty | Dependency value | Proofability | Risk |  Total |
| ----------------------------- | -------: | ------------------: | ---------------: | -----------: | ---: | -----: |
| Proof composition             |        3 |                   4 |                3 |            5 |    4 | **19** |
| WhatsApp boundary and effects |        4 |                   3 |                4 |            4 |    2 | **17** |

Proof composition edges ahead now that the boundaries it must consume exist:
its interface uncertainty dropped, and retiring the proof-only composition
path unblocks safe guarded validation of the riskier WhatsApp boundary slice
that follows.

## Known debt

Accepted, durable, and owned here rather than in commit messages:

- **Proof composition drift** — both proofs still build on the lower-level
  resource factory; `proofs/whatsapp-conversation.ts` additionally wires its
  own Conversation service, work-store `notify`, and model runner. Retired by
  the proof-composition slice.
- **Remaining environment scalars** — database URL, WhatsApp, scheduling,
  logging, and conversation toggles still load from env rather than the
  structured document. A later configuration sweep moves them; secrets stay in
  env by policy.
- **WhatsApp exposure** — `AppResources` still exposes the concrete
  `WhatsAppSessionController`, and Conversation's outbound text effect is an
  ad hoc scoped sender built in composition. Owned by the WhatsApp boundary
  and effects slice.
- **Repository bag** — `AmbientRepositories` remains a public bag pending
  internalization behind explicit surfaces; `runs.start` has no production
  caller until a Memory or Worker slice; `inbox.enqueue` is the retention
  path awaiting its first `task_update` producer.
- **`root` model role** — the implemented `ModelRole` union and `agent_runs`
  role enum omit `root` until a Root slice creates the first root run.
- **Duplicated text extraction** — the assistant-text flatten exists in
  `pi-agent.ts` and `proofs/model-runtime.ts`; extract on a third caller.

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
