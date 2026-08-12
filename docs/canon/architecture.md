# Ambient Architecture

Status: canonical architecture boundary map.

This document defines the module ownership, dependency direction, durable
protocols, and implementation frontiers that current rescue work must preserve.
It does not prescribe speculative Root, Worker, or Memory mechanics before a
real product slice proves them.

The normative product ontology is
[`product-model.md`](./product-model.md). The active implementation frontier is
recorded in [`../status/current-state.md`](../status/current-state.md). The
diagrams under [`../maps/`](../maps/) are derived views of this document and the
status ledger.

## Architectural thesis

Ambient is one durable application with one production composition root and a
small number of deep modules:

```text
main
  -> createAmbient(config)
       -> models
       -> whatsapp
       -> conversation
       -> root              as product behaviour arrives
       -> assignments       as product behaviour arrives
       -> worker            as product behaviour arrives
       -> memory
       -> storage adapters
       -> evaluations
```

Each domain module owns its vocabulary, execution contract, and required
persistence ports. Infrastructure implements those ports. Third-party types,
database rows, environment access, and operation mechanics stop at adapters.

The current code has durable mechanisms worth preserving, but it exposes them
through overlapping repositories, a broad scheduler, a concrete WhatsApp
controller, and provider-specific role construction. Rescue means changing
those boundaries without weakening the proven protocols.

## Dependency direction

The target dependency rules are:

```text
process boundary
  -> app composition
       -> domain services and agent-kind modules
            -> domain-owned ports and values
                 <- storage, model, and channel adapters
```

Allowed dependencies:

- `main` depends only on validated application configuration and `Ambient`;
- `app` constructs concrete adapters and binds them to domain-owned ports;
- role modules depend on provider-neutral model runners and their own tools;
- Conversation depends on Conversation-owned work, evidence, recall, and effect
  ports;
- WhatsApp adapters may depend on `whatsappd`;
- storage adapters may depend on Drizzle, libSQL, and schema rows;
- proofs may depend on explicit proof surfaces and read models.

Forbidden dependencies:

- role contracts importing concrete repositories, Drizzle rows, Pi types, or
  `whatsappd` types;
- `main` coordinating database, channel, or scheduler internals;
- proofs reconstructing a second production graph;
- model-produced tool input selecting an arbitrary WhatsApp chat;
- two public mutation APIs completing or recovering the same durable run;
- application code reading provider or role configuration from the
  environment after startup.

## Target modules

### Ambient application

`createAmbient(config)` is the sole production composition root. It opens
resources, binds adapters, and returns one lifecycle facade:

```ts
interface Ambient {
  start(): Promise<void>;
  wait(): Promise<AmbientExit>;
  stop(): Promise<void>;
}
```

The application module hides:

- resource construction order;
- startup and reverse-order cleanup;
- channel attachment and unexpected failure;
- service startup and shutdown;
- concrete database connections;
- model and channel adapter construction.

`main.ts` owns process concerns only: configuration loading, signal handling,
starting Ambient, waiting for termination, and stopping it.

### Models

The model subsystem resolves provider definitions and role profiles once at
startup:

```ts
type ModelRole = "root" | "conversation" | "worker" | "memory" | "evaluator";

interface ModelRuntime {
  readonly roles: readonly ModelRole[];
  forRole(role: ModelRole): ModelRunner;
}
```

The implemented union currently omits `root`: the durable `agent_runs` role
enum has no root runs yet, and both are extended together when a Root slice
lands. The target keeps `root` because the product model makes the Root a
first-class agent kind.

A `ModelRunner` is one role's ready-to-use binding: the durable
provider/model/settings snapshot, the resolved immutable model, and a stream
bound to the role's generation limits. Mutable Pi model collections, protocol
adapters, credential values, and provider construction remain private to
`src/models/runtime.ts`, which is also the only application code that reads
secret values from the environment.

Role agents receive a bound runner. They do not receive a provider name,
environment object, mutable model registry, credential, or parallel
configuration graph. Only configured roles exist; an unconfigured role fails
closed at resolution.

Structured configuration distinguishes:

- provider definitions;
- executable protocol adapters;
- role profiles;
- secret references;
- secret values supplied by deployment.

### WhatsApp

WhatsApp is one deep Ambient-owned module, not a generic interchangeable channel
abstraction. It owns:

- authenticated account lifecycle and single-writer ownership;
- local mirror and media storage;
- accepted-source subscription and cursor following;
- mapping accepted WhatsApp input into Ambient observations;
- durable WhatsApp operation submission and receipts;
- session recreation, connection recovery, and failure reporting;
- WhatsApp-specific history and diagnostics.

The production lifecycle needs only a narrow service:

```ts
interface WhatsAppService {
  start(): Promise<void>;
  waitForFailure(): Promise<WhatsAppFailure>;
  stop(): Promise<void>;
}
```

Ingress runs inside this service. Application callers do not receive the
`whatsappd` runtime, client, backend, retained mirror, or concrete session
controller.

`whatsappd` already owns a rich typed durable operation vocabulary, including
text, media, locations, contacts, reactions, edits, revocation, read receipts,
and phone history requests. Ambient must adapt those operations rather than
copying them into a second generic `WhatsAppCommand` union.

#### Conversation-bound WhatsApp effects

Conversation does not receive the host-level WhatsApp service. It receives a
capability bundle already bound to one conversation and one run:

```ts
interface ConversationEffectScope {
  readonly conversationId: ConversationId;
  readonly runId: AgentRunId;
  readonly allowedMessageRefs: ReadonlySet<ConversationMessageRef>;
}

interface ConversationMessaging {
  sendText(input: { readonly text: string }): Promise<WhatsAppEffectReceipt>;
}

interface ConversationReactions {
  react(input: {
    readonly message: ConversationMessageRef;
    readonly emoji: string;
  }): Promise<WhatsAppEffectReceipt>;
  unreact(input: { readonly message: ConversationMessageRef }): Promise<WhatsAppEffectReceipt>;
}

interface ConversationEffects {
  readonly messaging: ConversationMessaging;
  readonly reactions?: ConversationReactions;
}
```

The exact bundle grows only when a real Conversation journey grants another
capability. Media sending, editing, revocation, and read state should be added
as named capability groups, not as one universal command executor.

Scoping rules:

- the destination is captured by the host, never supplied by the model;
- message references must come from bounded run input or prior effects owned by
  that Conversation;
- capability presence is determined before the model run;
- the host derives idempotency keys from retained run and tool-call identity;
- a successful durable operation receipt is the evidence of communication;
- terminal model text is private and is never an implicit WhatsApp send.

### Conversation

Conversation is one durable service plus one role agent:

```ts
interface ConversationService {
  start(): Promise<void>;
  wake(conversationId?: ConversationId): Promise<void>;
  stop(): Promise<void>;
}

interface ConversationAgent {
  run(
    input: ConversationInput,
    tools: ConversationTools,
    signal: AbortSignal,
  ): Promise<ConversationResult>;
}
```

The service owns:

- detecting eligible durable Inbox work;
- debounce and maximum-wait policy;
- bounded immutable claims;
- leases and renewal;
- Agent Run and tool evidence lifecycle;
- curated context construction;
- binding recall and Conversation effects;
- success, failure, release, retry, and expiry recovery;
- private terminal reports;
- wake timers and process-local acceleration.

The role agent owns:

- Conversation prompt and behaviour policy;
- deciding whether and how to act within granted tools;
- provider-neutral model interaction;
- a private terminal result.

The service must not construct providers or expose database repositories to the
role agent.

### Conversation work store

One aggregate-shaped store owns authoritative Conversation work mutations:

```ts
interface ConversationWorkStore {
  reconcile(scheduling: ConversationSchedulingConfig): Promise<void>;
  notify(conversationId: string, scheduling: ConversationSchedulingConfig): Promise<void>;
  nextWakeAt(): Promise<string | undefined>;
  claimNext(input: ClaimConversationWork): Promise<ConversationClaim | undefined>;
  renewLease(input: RenewConversationLease): Promise<boolean>;
  observations(ids: readonly string[]): Promise<readonly RetainedConversationObservation[]>;
  beginTool(input: BeginConversationTool): Promise<{ toolCallId: string }>;
  finishTool(input: FinishConversationTool): Promise<void>;
  complete(input: CompleteConversationRun): Promise<void>;
  fail(input: FailConversationRun): Promise<void>;
}
```

The port is owned by `src/conversation/contract.ts` and implemented by
`src/database/conversation-work.ts`. It hides the `conversation_schedule`,
`conversation_inbox`, `conversation_run_items`, `agent_runs`, and `tool_calls`
transaction details. It is authoritative for:

- one active lease per conversation;
- immutable claimed Inbox membership;
- no run completion with active tool calls;
- consume-on-success and release-on-failure;
- fenced completion by lease owner and expiry;
- expired run and tool recovery;
- retry eligibility and the next durable work window;
- reading the retained observations referenced by claimed work.

The Inbox repository is reduced to retention and a pending read model, and the
Run repository to non-conversation run creation and evidence reads. Their
former claim, consumption, release, and completion methods are owned
exclusively by the work store and no longer exist as public peers.

### WhatsApp ingestion store

Accepted WhatsApp input crosses into Ambient through one transaction:

```ts
interface WhatsAppIngestionStore {
  cursor(accountId: WhatsAppAccountId): Promise<WhatsAppIngestionCursor | undefined>;
  activate(input: ActivateWhatsAppCursor): Promise<void>;
  retain(batch: AcceptedWhatsAppInputBatch): Promise<readonly AcceptedObservation[]>;
}
```

The transaction owns:

- accepted-source sequence fencing;
- native message deduplication;
- Observation retention;
- Conversation Inbox creation;
- cursor advancement.

The Inbox item is the durable handoff to Conversation. A callback to
`ConversationService.wake()` is only an acceleration hint. Conversation must
recover pending Inbox work by reconciliation, and must not depend on a callback
having survived a crash.

### Memory

Memory is a proven role since the 2026-08-12 Memory v2 slice. `memory/` owns
the Memory Agent contract, prompt, and host-side validation; `database/`
implements its stores. The Memory Agent is a bounded evidence analyst: it
receives one immutable batch of retained messages plus the current ontology
view and proposes entities, identity links, predicates, and claims. It never
writes; the host validates every proposal and applies it through the patch
machinery, so an invalid proposal fails the job without touching the ontology.

```ts
interface MemoryAgent {
  propose(input: MemoryInput, signal?: AbortSignal): Promise<MemoryProposal>;
}
```

Host-owned invariants, enforced at the mutation path (not by prompt):

- one current claim per (entity, predicate): a restated fact becomes a
  reinforcement, a changed fact becomes a supersession;
- a chat or group id can never be linked as an identity;
- linkable identities are only ids evidenced in the batch (senders,
  mentions, and quoted-reply authors — historical group sync loses
  authorship, and the import never fabricates it);
- `applyPatch` remains the only claim mutation path, idempotent per job;
- the model never sees or copies real uuids — the adapter presents compact
  symbols and translates back.

The ontology view a digest receives includes entities evidenced in its
conversation, not only identity-linked ones, so identity-less entities
(issues, repositories) stay visible and deduplicable across windows.

Conversation's stable dependency remains a narrow read port: recall by
identity, plus conversation-scoped recall (current claims whose evidence was
observed in one conversation). Conversation never receives unrestricted
ontology or database access.

### Assignments and Workers

The current `tasks` tables and repository are valuable prototype evidence for
leases, retries, updates, and artifacts, but the product ontology now uses
assignments rather than a peer Task Coordinator role.

No generic assignment framework is authorized by this mapping cutover.
`tasks.ts` remains dormant and internal until a product slice proves which
parts become:

- durable assignments;
- Worker attempts;
- results and artifacts;
- Conversation or Root attention handoffs.

### Evaluations

Safety invariants required for correct completion remain synchronous and owned
by the service or store that performs the transition.

Quality evaluation consumes retained run evidence asynchronously.

The durable handoff is `evaluation_pending`, written atomically with every
terminal Conversation run transition. The `evals/` module owns the contracts:
an `EvaluationWorkStore` claims a pending subject under a fenced lease,
assembles retained evidence, and consumes the signal after recording; a
`ConversationJudge` under the reserved `evaluator` role retains its own agent
run and links it through `evaluatorRunId`. Deterministic contract metrics are
computed from retained evidence, never from live state. The Conversation
service performs no evaluation work, and evaluation failure must not change
whether a WhatsApp effect or Agent Run succeeded.

### Proofs and operations

Proofs must use the same production composition and explicit safety policy.
They may receive narrow capabilities for:

- authorized destination discovery;
- waiting for accepted input;
- requesting one bounded run;
- reading retained run, tool, operation, and evaluation evidence.

They must not receive the database repository bag, raw schema, concrete
WhatsApp controller, or independent model construction.

The exact proof surface is deliberately deferred until the proof-composition
rescue. It must be added as an explicit composition option or dedicated harness,
not by widening the production `Ambient` facade.

## Durable protocols

### Startup and shutdown

```text
main
  -> load and validate configuration once
  -> createAmbient(config)
  -> Ambient.start
       -> WhatsApp starts and ingress attaches
       -> unexpected channel failure is observed
       -> Conversation starts only if the channel is healthy
  -> Ambient.wait
  -> Ambient.stop
       -> Conversation stops and aborts active work
       -> WhatsApp stops
       -> database closes
```

Owner: Ambient lifecycle.

Authority: in-memory lifecycle state, because this protocol concerns one process
instance. Durable product work remains in the stores it owns.

### Accepted WhatsApp input

```text
whatsappd accepted-source batch
  -> validate next source sequence
  -> map accepted messages
  -> one Ambient transaction:
       Observation
       Conversation Inbox item
       source cursor
  -> commit
  -> optional Conversation wake hint
```

Owner: WhatsApp ingestion adapter and `WhatsAppIngestionStore`.

Idempotency: accepted-source sequence plus native WhatsApp identity.

Recovery: replay before commit, resume after cursor on commit. Historical
watermarking remains distinct from live Conversation wake policy.

### Conversation run

```text
pending Conversation Inbox
  -> derive or reconcile due window
  -> atomic bounded claim:
       create Agent Run
       freeze ordered Inbox membership
       acquire fenced lease
  -> build curated Conversation input
  -> bind scoped recall and WhatsApp effects
  -> run Conversation Agent
  -> retain each tool start and terminal outcome
  -> atomically complete:
       private result
       consume claimed Inbox
       release lease
       schedule remaining pending work
```

Owner: `ConversationService` and `ConversationWorkStore`.

Idempotency: immutable claim membership, fenced lease, unique run/tool-call
identity, and deterministic WhatsApp operation keys.

Recovery: expired runs and active tool calls fail, claimed Inbox is released,
and pending work becomes eligible again.

A concrete trace with default timings (750 ms debounce, 5 s maximum wait,
120 s lease):

1. 10:00:00.000 — inbound "are we still on for Friday?" commits an
   Observation, an Inbox item, and the cursor in one ingestion transaction;
   a process-local wake hint fires.
2. `notify` computes `dueAt` 10:00:00.750; the service sets a timer instead of
   running immediately.
3. 10:00:00.400 — "also send the address?" commits; `dueAt` slides to
   10:00:01.150, coalescing both messages into one future run.
4. 10:00:01.150 — `claimNext` freezes both items into one Agent Run under a
   lease until 10:02:01; a racing claimer gets nothing.
5. The service builds curated input from the retained Observations and runs
   the agent; one `send_message` call retains tool evidence and the durable
   operation receipt.
6. `complete` records the private summary, consumes both Inbox items, releases
   the lease, and schedules any work that arrived meanwhile.

A crash before step 6 changes nothing durable until the lease expires; the
next claim fails the abandoned run and releases its items for retry with the
same idempotency key.

### Conversation WhatsApp effect

```text
model selects a granted tool
  -> service validates run lease and capability
  -> retain running tool evidence
  -> submit scoped idempotent whatsappd operation
  -> retain operation receipt in tool evidence
  -> complete tool evidence
```

Owner: Conversation service for tool lifecycle, WhatsApp for operation
submission and receipts.

The model cannot supply the destination. Reactions and message-management
operations can reference only messages carried in the bounded capability scope.

If an operation receipt exists and later model execution fails, the run must not
be recorded as though no effect occurred. Current code preserves this invariant
by succeeding the run with an explanatory private summary.

### Recall

```text
model selects recall
  -> retain running tool evidence
  -> query Conversation-scoped identities
  -> Memory read model returns current evidence-backed claims
  -> retain returned claim references
  -> complete tool evidence
```

Owner: Conversation service for scope and evidence, Memory for recall semantics.

### Memory digestion

```text
designated mirror history + retained observations
  -> bounded Memory Job (durable, fenced lease)
  -> Memory Agent proposes over batch + ontology view
  -> host validates and applies one idempotent patch
  -> job + memory run + evaluation signal terminalize in one transaction
  -> conversation-scoped recall returns current claims
```

Owner: memory service for validation and application; the job store for
claim, lease, and terminal transitions; `applyPatch` for ontology mutation.

History import retains evidence only — it never creates Inbox work and never
wakes a speaker. Media messages are retained with their store refs and
captions; bytes stay in the media store.

### Evaluation

```text
terminal Agent Run evidence
  -> durable evaluation wake
  -> evaluation runner claims evidence
  -> retain metrics and annotations
```

Owner: evaluations subsystem.

The memory judge receives the full digested window plus the applied claims —
a judge that sees only cited evidence is structurally blind to omission
(the recorded Memory v1 lesson: an eval only measures what it is pointed
at).

Evaluation observes effects and run outcomes. It does not decide whether they
occurred.

## Current module disposition

Disposition meanings:

- **Keep**: boundary is already useful and should remain recognizable.
- **Reshape**: preserve behaviour but change the public boundary.
- **Merge**: absorb into a deeper authoritative module.
- **Internalize**: keep as implementation detail or read model, remove as a
  public peer.
- **Defer**: do not redesign until a relevant product slice.
- **Remove**: delete the obsolete public concept after callers migrate.

| Current module                             | Disposition                    | Target owner                                            |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------- |
| `src/main.ts`                              | Keep                           | process boundary                                        |
| `src/app/ambient.ts`                       | Keep                           | sole production composition root                        |
| `src/app/lifecycle.ts`                     | Keep                           | Ambient lifecycle                                       |
| `src/app/resources.ts`                     | Keep (app-internal)            | private composition assembly                            |
| `src/app/proof.ts`                         | Keep (rescued)                 | shared-composition proof harness                        |
| `src/app/config.ts`                        | Keep (rescued)                 | validated structured application configuration          |
| `src/models/contract.ts`                   | Keep (rescued)                 | model vocabulary and configuration document             |
| `src/models/runtime.ts`                    | Keep (rescued)                 | provider construction, secrets, and role runners        |
| `src/conversation/contract.ts`             | Keep (rescued)                 | Conversation-owned domain contracts and ports           |
| `src/conversation/context-builder.ts`      | Keep (rescued)                 | Conversation service internal                           |
| `src/conversation/pi-agent.ts`             | Keep (rescued)                 | Conversation agent adapter using a bound `ModelRunner`  |
| `src/conversation/service.ts`              | Keep (rescued)                 | `ConversationService`                                   |
| `src/database/conversation-work.ts`        | Keep (rescued)                 | storage implementation of `ConversationWorkStore`       |
| `src/database/conversation-inbox.ts`       | Keep (reduced)                 | Inbox retention and pending read model                  |
| `src/database/runs.ts`                     | Keep (reduced), later reshape  | non-conversation run creation and evidence reads        |
| `src/database/message-ingestion.ts`        | Keep, reshape                  | storage implementation of `WhatsAppIngestionStore`      |
| `src/database/observations.ts`             | Reshape                        | evidence read ports, mutation internal to ingestion     |
| `src/database/database.ts`                 | Internalize                    | database connection and adapter assembly                |
| `src/database/schema.ts`                   | Keep, internalize              | storage schema                                          |
| `src/database/tasks.ts`                    | Defer                          | future assignments and Worker protocol                  |
| `src/memory/contract.ts`                   | Keep (proven 2026-08-12)       | Memory-owned agent, job, and proposal contracts         |
| `src/memory/service.ts`                    | Keep (proven 2026-08-12)       | memory runner: validate, apply, host invariants         |
| `src/memory/pi-agent.ts`                   | Keep (proven 2026-08-12)       | Memory agent adapter with symbol translation            |
| `src/database/memory.ts`                   | Keep (reshaped 2026-08-12)     | ontology store, patch application, recall read models   |
| `src/database/memory-jobs.ts`              | Keep (proven 2026-08-12)       | durable memory jobs: claim, lease, terminalize          |
| `src/whatsapp/history-import.ts`           | Keep (proven 2026-08-12)       | mirror history to evidence, attribution-honest          |
| `src/evals/service.ts`                     | Keep (proven 2026-08-12)       | async evaluation runner and contract metrics            |
| `src/evals/judge.ts`                       | Keep (proven 2026-08-12)       | evaluator-role judges for conversation and memory       |
| `src/database/conversation-speakers.ts`    | Keep (proven 2026-08-12)       | durable speaker records and activation watermarks       |
| `src/database/evaluations.ts`              | Keep (rescued)                 | evaluation retention behind the evals recorder port     |
| `src/whatsapp/service.ts`                  | Keep (rescued)                 | Ambient-owned WhatsApp service facade                   |
| `src/whatsapp/session/controller.ts`       | Keep (internal)                | private WhatsApp service implementation                 |
| `src/whatsapp/session/local-deployment.ts` | Keep, internalize              | WhatsApp deployment adapter                             |
| `src/whatsapp/session/history-backfill.ts` | Keep, defer ownership decision | WhatsApp history operation, later Memory indexing input |
| `src/whatsapp/message-ingestion.ts`        | Reshape                        | WhatsApp accepted-source ingress adapter                |
| `src/whatsapp/observation-mapper.ts`       | Keep, internalize              | WhatsApp ingress mapping                                |
| `src/proofs/whatsapp-ingestion.ts`         | Keep (rescued)                 | proof policy over the shared harness                    |
| `src/proofs/whatsapp-conversation.ts`      | Keep (rescued)                 | proof policy over the shared harness                    |
| `src/platform/logging.ts`                  | Keep, internalize              | platform adapter                                        |
| `src/platform/errors.ts`                   | Keep, internalize              | platform utility                                        |

The independent Inbox mutation API, independent Run completion API, concrete
controller exposure, and proof-only alternate composition root are all
removed. The repository bag survives only as an `src/app/`-internal assembly
detail; it becomes explicit surfaces as role slices claim their stores.

## Frontier definitions

The current contents of these frontiers belong in
[`../status/current-state.md`](../status/current-state.md). These definitions are
stable architectural categories.

### Proven behaviour frontier

Behaviour backed by deterministic tests or controlled retained live evidence.
Architecture rescue must preserve it unless a stronger invariant intentionally
replaces it.

### Current architecture frontier

The deepest coherent module boundary the implementation currently supports.
Status records which target boundaries are rescued and which mechanisms still
leak across them.

### Deliberately unimplemented product frontier

Settled product concepts that do not yet have an evidenced runtime slice. Their
absence is not an architecture defect. Each requires a product question,
durable protocol brief, and proof gate before implementation.

## Rescue order constraints

The mapping does not freeze a distant roadmap. It establishes only these
ordering facts:

1. rescue Conversation ownership before adding more Conversation tools or Root
   handoffs;
2. bind role agents to a provider-neutral runner before adding another model
   provider;
3. create Conversation-scoped effects before exposing more `whatsappd`
   operations to a model;
4. migrate proofs only onto explicit surfaces from the rescued composition;
5. do not reshape tasks into generic assignments until a real Worker or Root
   journey proves the lifecycle.
