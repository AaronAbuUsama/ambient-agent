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
  forRole(role: ModelRole): ModelRunner;
}
```

A `ModelRunner` is provider-neutral. Pi model collections, protocol adapters,
base URLs, authentication, and provider catalogue types remain private to the
model adapter.

Role agents receive a bound runner. They do not receive a provider name,
environment object, mutable model registry, credential, or parallel
configuration graph.

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
  reconcile(policy: ConversationSchedulingPolicy): Promise<void>;
  nextWakeAt(): Promise<Instant | undefined>;
  claimNext(input: ClaimConversationWork): Promise<ConversationClaim | undefined>;
  renew(claim: ConversationClaimToken, until: Instant): Promise<boolean>;
  beginTool(input: BeginConversationTool): Promise<ToolEvidence>;
  finishTool(input: FinishConversationTool): Promise<ToolEvidence>;
  complete(input: CompleteConversationRun): Promise<void>;
  fail(input: FailConversationRun): Promise<void>;
}
```

This store hides the current `conversation_schedule`, `conversation_inbox`,
`conversation_run_items`, `agent_runs`, and `tool_calls` transaction details.
It is authoritative for:

- one active lease per conversation;
- immutable claimed Inbox membership;
- no run completion with active tool calls;
- consume-on-success and release-on-failure;
- fenced completion by lease owner and expiry;
- expired run and tool recovery;
- retry eligibility and the next durable work window.

The separate current Inbox and Run repositories may remain as private
implementation helpers or read models, but their overlapping mutation methods
must not remain public peers.

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

Memory currently provides useful evidence-backed recall but mixes ontology
administration, patch application, identity linkage, and Conversation-facing
recall in one repository.

The stable Conversation dependency is a narrow read port:

```ts
interface ConversationRecall {
  recall(input: ConversationRecallQuery): Promise<readonly RecalledClaim[]>;
}
```

Memory-owned write and analysis ports will be reshaped when a Memory Agent slice
is selected. Conversation never receives unrestricted ontology or database
access.

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

Quality evaluation consumes retained run evidence asynchronously:

```ts
interface EvaluationSink {
  notifyRunCompleted(runId: AgentRunId): Promise<void>;
}
```

The current Conversation scheduler performs evaluation inline after completion.
That path should be internalized and later replaced by an asynchronous evidence
consumer. Evaluation failure must not change whether a WhatsApp effect or Agent
Run succeeded.

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

### Evaluation

```text
terminal Agent Run evidence
  -> durable evaluation wake
  -> evaluation runner claims evidence
  -> retain metrics and annotations
```

Owner: evaluations subsystem.

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
| `src/app/resources.ts`                     | Reshape, then internalize      | private composition assembly                            |
| `src/app/config.ts`                        | Reshape                        | validated structured application configuration          |
| `src/agent-models.ts`                      | Merge                          | `models/` role profiles and snapshots                   |
| `src/conversation/contract.ts`             | Reshape                        | Conversation-owned domain contracts                     |
| `src/conversation/context-builder.ts`      | Reshape, internalize           | Conversation service                                    |
| `src/conversation/pi-agent.ts`             | Reshape                        | Conversation agent adapter using a bound `ModelRunner`  |
| `src/conversation/scheduler.ts`            | Reshape, merge                 | `ConversationService`                                   |
| `src/database/conversation-schedule.ts`    | Reshape                        | storage implementation of `ConversationWorkStore`       |
| `src/database/conversation-inbox.ts`       | Merge, internalize             | Conversation work store and read models                 |
| `src/database/runs.ts`                     | Merge, internalize             | role-owned work stores and evidence reads               |
| `src/database/message-ingestion.ts`        | Keep, reshape                  | storage implementation of `WhatsAppIngestionStore`      |
| `src/database/observations.ts`             | Reshape                        | evidence read ports, mutation internal to ingestion     |
| `src/database/database.ts`                 | Internalize                    | database connection and adapter assembly                |
| `src/database/schema.ts`                   | Keep, internalize              | storage schema                                          |
| `src/database/tasks.ts`                    | Defer                          | future assignments and Worker protocol                  |
| `src/database/memory.ts`                   | Reshape in a Memory slice      | Memory store plus narrow recall read model              |
| `src/database/evaluations.ts`              | Internalize, later reshape     | asynchronous evaluations store                          |
| `src/whatsapp/session/controller.ts`       | Keep, reshape                  | private WhatsApp service implementation                 |
| `src/whatsapp/session/local-deployment.ts` | Keep, internalize              | WhatsApp deployment adapter                             |
| `src/whatsapp/session/history-backfill.ts` | Keep, defer ownership decision | WhatsApp history operation, later Memory indexing input |
| `src/whatsapp/message-ingestion.ts`        | Reshape                        | WhatsApp accepted-source ingress adapter                |
| `src/whatsapp/observation-mapper.ts`       | Keep, internalize              | WhatsApp ingress mapping                                |
| `src/proofs/whatsapp-ingestion.ts`         | Reshape                        | shared-composition proof harness                        |
| `src/proofs/whatsapp-conversation.ts`      | Reshape                        | shared-composition proof harness and evidence reader    |
| `src/platform/logging.ts`                  | Keep, internalize              | platform adapter                                        |
| `src/platform/errors.ts`                   | Keep, internalize              | platform utility                                        |

The public repository bag, independent Inbox mutation API, independent Run
completion API, concrete controller exposure, and proof-only alternate
composition root are obsolete concepts. They are removed after their callers
migrate, not before.

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
