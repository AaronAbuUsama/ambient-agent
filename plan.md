# Ambient core

Status: proposed hard cut.

This document defines the smallest complete architecture for Ambient. It replaces
the initial implementation plan without modifying [`plan.md`](./plan.md), which
remains as historical context.

Ambient is a durable conversational agent that can remember, start work, perform
that work through Workers, and return results to the originating conversation.
The system is intentionally backend-only. Product state lives in one application
database, model sessions are disposable, and every important transition can be
inspected and evaluated.

## Product statement

Ambient is not a chat interface with optional automation. It is a conversational
front door to durable work.

The irreducible initial roles are:

1. **Conversation Agent** — manages one conversation, communicates socially,
   recalls memory, starts tasks, queries tasks, and reports completed work.
2. **Worker Agent** — performs one durable task with an explicit objective and a
   run-scoped set of tools.
3. **Memory Analyst** — interprets retained evidence and maintains an
   evidence-backed ontology.
4. **Task Coordinator** — a deterministic service, not an agent, that owns task
   state, leases, retries, and durable handoffs between Conversation and Worker.

These roles communicate through retained records:

```text
WhatsApp
   |
   v
Observations -> Conversation Inbox -> Conversation Agent
                                          |
                                          | start_task
                                          v
                                      Task record
                                          |
                                          v
                                      Worker Agent
                                          |
                                          v
                                     Worker Result
                                          |
                                          v
                              Conversation task update
                                          |
                                          v
                                  Conversation Agent

Observations + task evidence -> Episodes -> Memory Analyst -> Ontology
                                                        |
                                                        v
                                    later recall and context construction
```

Agents do not call each other directly. Tasks, results, inbox items, observations,
and memory are the communication protocol.

## Hard-cut principles

### One deep core module

The external lifecycle should remain small:

```ts
interface Ambient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

declare function createAmbient(config: AmbientConfig): Promise<Ambient>;
```

WhatsApp, scheduling, agents, tasks, memory, Pi, persistence, and evaluation remain
internal modules behind this lifecycle.

### Role-specific agents

There is no generic domain `Agent`, universal model-produced `RunResult`, or
general orchestration framework.

```ts
interface ConversationAgent {
  run(input: ConversationInput): Promise<ConversationResult>;
}

interface WorkerAgent {
  run(input: WorkerTask): Promise<WorkerResult>;
}

interface MemoryAnalyst {
  run(input: MemoryJob): Promise<MemoryAnalysisResult>;
}
```

Shared Pi mechanics may be reused internally, but each role owns its input,
prompt, skills, tools, result, and evaluation criteria.

### Durable handoffs

A handoff always creates or updates durable product state before another agent
runs. In-memory callbacks and active Pi sessions are never the authority.

### Effects happen through tools

Model-produced terminal results summarize a run. They do not claim that an effect
happened. WhatsApp sends, task creation, task completion, and memory patches are
known from independently persisted tool and service outcomes.

### Configuration, not hardcoded providers

Agent implementations receive resolved model configuration. They do not contain
provider IDs, model IDs, API keys, or environment access.

### Evaluation begins with the first slice

Every vertical slice includes runtime invariants, role-specific cases, and an
inspectable end-to-end proof. Evaluation is not deferred until after prompts and
agents become complicated.

## Source layout

The initial source layout is role-first and intentionally shallow:

```text
src/
├── main.ts
├── ambient.ts
├── config.ts
│
├── database/
│   ├── database.ts
│   ├── migrations.ts
│   ├── observations.ts
│   ├── conversation-inbox.ts
│   ├── conversations.ts
│   ├── tasks.ts
│   ├── runs.ts
│   ├── episodes.ts
│   ├── memory.ts
│   └── evaluations.ts
│
├── whatsapp/
│   ├── gateway.ts
│   ├── whatsappd-gateway.ts
│   └── observation-mapper.ts
│
├── conversation/
│   ├── contract.ts
│   ├── scheduler.ts
│   ├── context-builder.ts
│   ├── tools.ts
│   ├── prompt.ts
│   └── pi-conversation-agent.ts
│
├── tasks/
│   ├── contract.ts
│   ├── coordinator.ts
│   └── updates.ts
│
├── worker/
│   ├── contract.ts
│   ├── tools.ts
│   ├── prompt.ts
│   └── pi-worker.ts
│
├── memory/
│   ├── contract.ts
│   ├── episode-builder.ts
│   ├── ontology.ts
│   ├── tools.ts
│   ├── prompt.ts
│   └── pi-memory-analyst.ts
│
├── pi/
│   ├── run.ts
│   ├── models.ts
│   └── skills.ts
│
└── evals/
    ├── contract.ts
    ├── runner.ts
    ├── conversation/
    ├── worker/
    ├── memory/
    └── journeys/
```

Directories should be created as behavior is implemented. Empty architecture
scaffolding is not a deliverable.

## Dependency direction

```text
main / ambient composition
          |
          +--> WhatsApp gateway ------> whatsappd
          |
          +--> schedulers/coordinators
          |         |
          |         +--> repositories
          |         +--> role agents
          |
          +--> role agents -----------> Pi runtime
          |         |
          |         +--> role tools --> services/repositories
          |
          +--> repositories ----------> Ambient database
          |
          +--> evaluation runner -----> run/evaluation repositories
```

Role agents never receive a SQL client, `whatsappd` client, or unrestricted host
tool collection.

## Runtime configuration

Models are selected at the application boundary:

```ts
interface ModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly thinking: "off" | "low" | "medium" | "high";
  readonly maxOutputTokens: number;
}

interface AgentModelConfig {
  readonly conversation: ModelConfig;
  readonly worker: ModelConfig;
  readonly memory: ModelConfig;
  readonly evaluator?: ModelConfig;
}

interface AmbientConfig {
  readonly accountId: string;
  readonly whatsappDirectory: string;
  readonly databaseUrl: string;
  readonly models: AgentModelConfig;
  readonly conversation: ConversationSchedulingConfig;
  readonly tasks: TaskSchedulingConfig;
  readonly memory: MemorySchedulingConfig;
}
```

Environment variables, configuration files, or later database-owned agent
definitions may populate these values. Role agents only receive resolved
configuration.

The first inexpensive live model may be `qwen3.6-flash`, but that choice is
configuration rather than architecture.

Each persisted run stores a model snapshot:

```ts
interface ModelSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly maxOutputTokens: number;
}
```

This allows later evaluation to compare model and prompt revisions.

## Run-scoped tools

Authority is established when one agent run is constructed:

```ts
interface AgentRunScope {
  readonly runId: string;
  readonly agentId: string;
  readonly role: "conversation" | "worker" | "memory";
  readonly conversationId?: string;
  readonly taskId?: string;
}
```

There is initially no generic permission language or runtime grant engine.
Explicit role factories are easier to understand and audit:

```text
createConversationTools()
createWorkerTools()
createMemoryTools()
```

### Scoped Conversation tools

The Conversation Agent sees:

```text
send_message
recall
start_task
get_task
list_tasks
```

`send_message` accepts only the message content:

```ts
interface SendMessageInput {
  readonly text: string;
}
```

The host binds `scope.conversationId`. The model cannot choose another chat.

### Scoped Worker tools

A Worker receives only the tools selected for that task definition. A Worker that
needs cross-conversation authority may receive a tool whose schema includes a
conversation identifier; a Worker that does not need that authority must not
receive it.

### Scoped Memory tools

The Memory Analyst receives bounded search, inspection, and patch interfaces. It
never receives arbitrary SQL access.

## Database boundaries

Ambient uses two separate physical databases, even when both use SQLite/libSQL:

```text
data/
├── whatsapp.db
└── ambient.db
```

### WhatsApp database

The WhatsApp database is owned entirely by `whatsappd` and contains channel
infrastructure:

- credentials and session data;
- native chats, contacts, and messages;
- synchronization state;
- the replaceable local WhatsApp mirror.

Ambient accesses this state only through the WhatsApp gateway.

### Ambient database

The Ambient database is the durable product authority:

- immutable Observations;
- ingestion cursor and native identity deduplication;
- Conversation Inbox items;
- conversation pending and consumed ranges;
- agent definitions and selected skills;
- role-specific run inputs and results;
- tool calls and outcomes;
- Tasks, Worker attempts, results, and artifacts;
- Episodes and Episode Observations;
- Entities and Identity Links;
- Predicate Definitions;
- Claims and Evidence;
- Memory Patches and validation outcomes;
- evaluation runs, results, and annotations.

The WhatsApp mirror may be rebuilt without deleting Ambient evidence, tasks,
memory, runs, or evaluations.

## Repository access

The host and deterministic services use repositories directly:

```ts
interface AmbientRepositories {
  readonly observations: ObservationRepository;
  readonly inbox: ConversationInboxRepository;
  readonly conversations: ConversationRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly episodes: EpisodeRepository;
  readonly memory: MemoryRepository;
  readonly evaluations: EvaluationRepository;
}
```

Agents use role tools whose implementations call these repositories. Models never
receive repositories or database connections.

All three agents share the same Ambient database through distinct role-specific
interfaces.

## WhatsApp gateway and observations

WhatsApp is the first concrete channel and does not require a generic channel
framework.

```ts
interface WhatsAppGateway {
  start(onMessage: (message: NativeWhatsAppMessage) => Promise<void>): Promise<void>;
  sendText(conversationId: string, text: string): Promise<SendReceipt>;
  stop(): Promise<void>;
}
```

The adapter:

1. resumes the authenticated `whatsappd` account;
2. receives ordered native messages;
3. maps supported inbound messages to immutable Observations;
4. deduplicates by account and native message identity;
5. inserts one Conversation Inbox item for each accepted message;
6. forwards outbound text through `whatsappd`;
7. persists accepted outbound effects independently of agent terminal results.

```ts
interface Observation {
  readonly id: string;
  readonly source: "whatsapp" | "worker";
  readonly nativeId: string;
  readonly conversationId?: string;
  readonly occurredAt: string;
  readonly kind: "message" | "task_request" | "worker_result" | "conversation_report";
  readonly payload: unknown;
}
```

The exact payload types remain source-specific and schema-decoded.

## Conversation Inbox

Conversation is triggered by durable conversational stimuli, not only messages:

```ts
type ConversationInboxKind = "message" | "task_update";

interface ConversationInboxItem {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: ConversationInboxKind;
  readonly referenceId: string;
  readonly createdAt: string;
  readonly consumedByRunId?: string;
}
```

Message items reference Observations. Task-update items reference durable task
updates. The scheduler coalesces inbox items into one immutable Conversation run
input.

## Conversation scheduling and coalescing

The scheduler, not the agent, owns timing and single-flight execution.

```ts
interface ConversationSchedulingConfig {
  readonly debounceMs: number;
  readonly maximumWaitMs: number;
  readonly leaseMs: number;
  readonly maximumItemsPerRun: number;
}

interface ConversationScheduleState {
  readonly conversationId: string;
  readonly firstPendingAt?: string;
  readonly latestPendingAt?: string;
  readonly dueAt?: string;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
}
```

### Sliding debounce

When an inbox item arrives:

```text
dueAt = latestPendingAt + debounce
```

If another item arrives before `dueAt`, the due time slides forward.

### Maximum wait

A busy conversation must not postpone indefinitely:

```text
dueAt = min(
  latestPendingAt + debounce,
  firstPendingAt + maximumWait
)
```

### Immutable claimed ranges

When work becomes due, the scheduler atomically:

1. obtains a single-flight lease for the conversation;
2. selects the oldest bounded contiguous pending inbox range;
3. creates the Conversation run and stores its exact input references;
4. marks those items as claimed by that run;
5. invokes the Conversation Agent.

Items arriving during the run remain pending for the next run. They never mutate
the active input.

### Completion and recovery

On success, the coordinator marks the claimed inbox range consumed. On failure,
the durable run records the failure and the range becomes eligible for retry
according to an explicit retry decision.

Timers are not authoritative. Pending items, due times, leases, and run ranges
live in the Ambient database and survive restart.

## Conversation Agent

```ts
interface ConversationMessage {
  readonly observationId: string;
  readonly whatsappMessageId: string;
  readonly senderId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly fromAgent: boolean;
}

interface ConversationTaskUpdate {
  readonly updateId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly summary?: string;
  readonly occurredAt: string;
}

interface TaskSummary {
  readonly taskId: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly resultSummary?: string;
}

interface RecalledMemory {
  readonly claimId: string;
  readonly text: string;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
  readonly evidenceObservationIds: readonly string[];
}

interface ConversationInput {
  readonly conversationId: string;
  readonly newMessages: readonly ConversationMessage[];
  readonly taskUpdates: readonly ConversationTaskUpdate[];
  readonly recentMessages: readonly ConversationMessage[];
  readonly activeTasks: readonly TaskSummary[];
  readonly participantMemory: readonly RecalledMemory[];
  readonly conversationMemory: readonly RecalledMemory[];
  readonly instructions: string;
}

interface ConversationResult {
  readonly summary: string;
}
```

The context builder dereferences the claimed inbox range, adds bounded recent
history, active tasks, recalled memory, and configured instructions.

Whether the agent spoke, recalled, or started work is known from persisted tool
outcomes rather than duplicated in `ConversationResult`.

## Task Coordinator

The Task Coordinator is deterministic product orchestration:

```ts
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Task {
  readonly id: string;
  readonly conversationId: string;
  readonly requestedByRunId: string;
  readonly objective: string;
  readonly instructions?: string;
  readonly workerProfile: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}
```

It owns:

- task creation;
- status transitions;
- one active Worker lease per task;
- retry bookkeeping;
- Worker run lineage;
- result and artifact persistence;
- task-update creation;
- delivery of terminal updates to the originating Conversation Inbox.

The initial allowed transitions are:

```text
queued -> running
queued -> cancelled
running -> succeeded
running -> failed
running -> cancelled
failed -> queued       # explicit retry
```

Invalid transitions are rejected by the host.

### Conversation task tools

`start_task` creates a durable queued task and returns immediately:

```ts
interface StartTaskInput {
  readonly objective: string;
  readonly instructions?: string;
}

interface StartTaskReceipt {
  readonly taskId: string;
  readonly status: "queued";
}
```

`get_task` reads one task belonging to the current conversation.

`list_tasks` returns a bounded set of tasks belonging to the current conversation.

The model cannot create a task for another conversation.

### Task updates

The initial wake policy is:

- `queued` is returned directly from `start_task`;
- `running` is queryable but does not wake Conversation;
- `succeeded`, `failed`, and `cancelled` create Conversation Inbox items.

This keeps status available without creating noisy conversational runs.

## Worker Agent

```ts
interface WorkerTask {
  readonly taskId: string;
  readonly conversationId: string;
  readonly objective: string;
  readonly instructions?: string;
  readonly conversationContext: string;
  readonly recalledMemory: readonly RecalledMemory[];
}

interface TaskArtifact {
  readonly id: string;
  readonly kind: "text" | "file" | "url" | "json";
  readonly title: string;
  readonly value: string;
}

interface WorkerResult {
  readonly summary: string;
  readonly detail: string;
  readonly artifacts: readonly TaskArtifact[];
}
```

One configured Worker profile is sufficient initially. The Task Coordinator
selects its model, prompt, skills, and run-scoped tools. The Conversation Agent
supplies the objective but does not grant arbitrary capabilities.

The Worker result is validated and persisted before the task becomes
`succeeded`. A failed or invalid result becomes a failed Worker run and does not
produce a successful task outcome.

Multiple Worker profiles, task decomposition, recursive work, and a model-driven
Executive are later extensions. The durable Task and WorkerResult protocols must
support them without being designed around them.

## Skills

Skills are run resources, not authority:

```ts
interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly supportingFiles?: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}
```

The Ambient database stores selected skills and run snapshots. Pi may receive
run-owned materialized `SKILL.md` files, but the filesystem is only a delivery
mechanism.

Skills may teach a Worker how to perform work. They cannot grant tools or expand
run authority.

## Memory ontology

Memory is evidence-backed structured belief, not a cache of generated summaries.

The irreducible concepts are:

- **Observation** — immutable source evidence.
- **Identity Link** — a native source identity mapped to an Entity.
- **Entity** — a stable person, organisation, team, project, product, place,
  conversation, or external resource.
- **Episode** — an ordered bounded experience assembled from Observations.
- **Predicate Definition** — typing, cardinality, and temporal rules for Claims.
- **Claim** — a typed belief about an Entity.
- **Evidence** — links from Claims to supporting, correcting, or disputing
  Observations.
- **Memory Patch** — one host-validated transaction of semantic operations.

```ts
type EntityKind =
  | "agent"
  | "person"
  | "organization"
  | "team"
  | "project"
  | "product"
  | "place"
  | "conversation"
  | "external_resource";

interface Entity {
  readonly id: string;
  readonly kind: EntityKind;
  readonly canonicalName: string;
}

interface IdentityLink {
  readonly source: "whatsapp";
  readonly nativeId: string;
  readonly entityId: string;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
}

interface EvidenceRef {
  readonly observationId: string;
  readonly role: "supports" | "corrects" | "disputes";
}

type ClaimObject =
  | { readonly kind: "entity"; readonly entityId: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number; readonly unit?: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "json"; readonly value: unknown };

interface PredicateDefinition {
  readonly id: string;
  readonly subjectKinds: readonly EntityKind[];
  readonly objectKind: ClaimObject["kind"];
  readonly cardinality: "one" | "many";
  readonly temporal: boolean;
}

interface ClaimDraft {
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly object: ClaimObject;
  readonly confidence: "low" | "medium" | "high" | "confirmed";
  readonly validFrom?: string;
  readonly validUntil?: string;
}

interface Claim extends ClaimDraft {
  readonly id: string;
  readonly status: "active" | "disputed" | "superseded" | "rejected";
  readonly version: number;
}
```

### Memory operations

```ts
type MemoryOperation =
  | {
      readonly type: "create_claim";
      readonly claim: ClaimDraft;
      readonly evidence: readonly EvidenceRef[];
    }
  | {
      readonly type: "reinforce_claim";
      readonly claimId: string;
      readonly expectedVersion: number;
      readonly evidence: readonly EvidenceRef[];
    }
  | {
      readonly type: "supersede_claim";
      readonly previousClaimId: string;
      readonly expectedVersion: number;
      readonly replacement: ClaimDraft;
      readonly evidence: readonly EvidenceRef[];
    }
  | {
      readonly type: "dispute_claim";
      readonly claims: readonly {
        readonly claimId: string;
        readonly expectedVersion: number;
      }[];
      readonly evidence: readonly EvidenceRef[];
    }
  | {
      readonly type: "close_validity";
      readonly claimId: string;
      readonly expectedVersion: number;
      readonly validUntil: string;
      readonly evidence: readonly EvidenceRef[];
    };

interface PatchMemoryInput {
  readonly operations: readonly MemoryOperation[];
  readonly reason: string;
}
```

The host adds patch ID, Memory run ID, timestamps, and commit state. It validates
evidence existence, entity and predicate compatibility, expected Claim versions,
and transactional consistency.

## Memory Analyst

```ts
interface MemoryJob {
  readonly episodeIds: readonly string[];
  readonly reason: "episode_closed" | "correction" | "reconciliation";
}

interface MemoryAnalysisResult {
  readonly summary: string;
  readonly unresolved: readonly string[];
}
```

Tools:

```text
search_entities
search_claims
search_episodes
inspect_observations
patch_memory
```

`patch_memory` may be called zero or more times in one run. Each call is decoded,
validated, and committed independently. Rejections return concrete errors so the
agent may correct its proposal.

### Episode cadence

Every accepted WhatsApp message, task request, Worker result, and conversational
report may participate in Episode construction.

Episodes close after a configured inactivity window or size threshold. Closed
Episodes create Memory Jobs. This cadence is independent of Conversation
coalescing and of whether the Conversation Agent chose to speak.

## Agent runs and tool ledger

Every role run is persisted before model execution:

```ts
interface AgentRunRecord {
  readonly id: string;
  readonly role: "conversation" | "worker" | "memory";
  readonly agentId: string;
  readonly parentRunId?: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly model: ModelSnapshot;
  readonly promptVersion: string;
  readonly selectedSkillIds: readonly string[];
  readonly input: unknown;
  readonly result?: unknown;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failure?: RunFailure;
}
```

Each tool call stores:

```ts
interface ToolCallRecord {
  readonly id: string;
  readonly runId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: "running" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly failure?: RunFailure;
}
```

Accepted external effects remain accepted if a later model call or terminal result
fails.

Pi sessions and temporary skill resources are disposable and are not resumed as
product state.

## Evaluation system

Evaluation has three layers.

### Runtime invariants

These are executable correctness properties:

- a Conversation-bound tool cannot message another chat;
- one Conversation Inbox item is consumed by at most one successful run;
- one conversation has at most one active Conversation lease;
- one Task has at most one active Worker lease;
- invalid Task transitions are rejected;
- successful Worker results are immutable;
- every active Claim has valid Evidence;
- stale Claim versions cannot be patched;
- model failures cannot undo accepted tool effects.

Invariant failures are bugs, not low model scores.

### Role-specific evaluations

Conversation cases evaluate:

- whether responding or remaining silent was appropriate;
- social tone and instruction following;
- relevant memory use;
- appropriate task creation;
- accurate task status and result reporting;
- avoidance of invented task progress.

Worker cases evaluate:

- satisfaction of the objective;
- usefulness and completeness of detail;
- support from artifacts or evidence;
- uncertainty handling;
- adherence to the granted tool set.

Memory cases evaluate:

- evidence support;
- identity resolution;
- correct reinforcement, dispute, and supersession;
- avoidance of unsupported speculation;
- relevance of later recall.

### End-to-end journeys

Initial journeys include:

```text
message -> Conversation reply or deliberate silence
```

```text
request -> start_task -> acknowledgement -> Worker completion -> report-back
```

```text
status question -> get_task -> accurate status response
```

```text
correction -> Memory supersession -> corrected later recall
```

Evaluation cases may initially live as typed code fixtures. Evaluation runs,
results, annotations, model snapshots, prompt versions, and references to subject
runs are persisted in the Ambient database.

Quality evaluations run asynchronously and do not block live conversation.

Live provider proofs are explicit commands, not part of the default deterministic
test suite.

## Minimal conceptual schema

Exact migrations should follow repository needs, but the initial database must be
capable of representing:

```text
observations
conversation_inbox
conversation_schedule
conversation_run_items
agent_runs
tool_calls

tasks
task_updates
task_worker_attempts
task_artifacts

episodes
episode_observations

entities
identity_links
predicate_definitions
claims
claim_evidence
memory_patches
memory_patch_operations

skills
run_skills

evaluation_runs
evaluation_results
evaluation_annotations
```

The schema should enforce native Observation uniqueness, one-time inbox
consumption, valid task transitions through repository transactions, Worker
single-flight leases, Claim version checks, and referential integrity for
Evidence.

## Initial implementation sequence

### Phase 0: Hard cut

- Preserve authenticated WhatsApp account data and Git history.
- Remove the terminal interface, React/OpenTUI dependencies, action framework,
  UI journeys, rendering helpers, and generic adapter experiments.
- Keep `whatsappd`, its authenticated local mirror, logging, and the project
  toolchain.
- Reintroduce Pi, schema validation, and the Ambient database only when their
  owning backend phases begin.
- Replace the process entry point with an initially small backend lifecycle.

Proof:

- the repository formats, type-checks, and tests;
- the authenticated WhatsApp account data remains untouched;
- no retained module imports removed UI or action frameworks.

### Phase 1: Durable spine

- Add libSQL and schema-validation dependencies for Ambient-owned state.
- Add the Ambient database and migrations.
- Add Observation, Conversation Inbox, Agent Run, Tool Call, Task, and Evaluation
  repositories.
- Add model configuration and run snapshots.
- Add runtime invariant tests for uniqueness, claims, leases, and transitions.

Proof:

- migrations are repeatable;
- restart preserves pending work and run records;
- invariants fail deterministically when violated.

### Phase 2: WhatsApp ingestion and Conversation

- Add the Pi runtime required by the first role-specific agent.
- Implement the `whatsappd` gateway.
- Resume the authenticated account.
- Retain one real or controlled WhatsApp message exactly once.
- Implement durable Conversation coalescing, maximum wait, leases, and claimed
  inbox ranges.
- Implement the Conversation Agent with `send_message` and `recall`.
- Add role-specific Conversation evaluations.

Proof:

- one retained message creates one Conversation run;
- rapid consecutive messages coalesce into one bounded run;
- messages arriving during a run remain for the next run;
- a run replies or deliberately remains silent;
- the scoped send tool cannot target another conversation;
- restart resumes pending work without duplicate consumption.

### Phase 3: Tasks and Worker handoff

- Add `start_task`, `get_task`, and `list_tasks`.
- Implement Task Coordinator transitions, Worker leases, and retry bookkeeping.
- Implement one configured Worker profile and Worker Agent.
- Persist Worker results and artifacts.
- Deliver terminal task updates to the originating Conversation Inbox.
- Add role-specific Worker and handoff evaluations.

Proof:

- Conversation starts a task and immediately receives a queued receipt;
- Worker claims and completes it exactly once;
- Conversation can query running state;
- terminal completion creates one Conversation update;
- Conversation reports the persisted result without inventing details;
- restart between creation, execution, and report-back loses no state.

### Phase 4: Episodes and Memory

- Build Episodes from messages, task evidence, Worker results, and reports.
- Add the ontology schema and patch validation.
- Implement Memory Analyst search, inspection, and patch tools.
- Add deterministic indexed recall to Conversation and Worker context.
- Add Memory evaluations.

Proof:

- evidence creates or reinforces a Claim;
- a correction supersedes the previous Claim with version checks;
- later relevant Conversation context receives the corrected Claim and Evidence;
- unsupported patches are rejected transactionally.

### Phase 5: Evaluation loop

The evaluation spine exists from Phase 1. This phase adds comparative operation:

- run cases across model and prompt versions;
- persist metrics and annotations;
- compare regressions by role and journey;
- gate configuration changes on selected invariant and quality thresholds.

Proof:

- the same retained case can be replayed against two configurations;
- results identify the exact model, prompt, skills, tools, and source run;
- a known regression is detected before configuration promotion.

## Explicitly outside the initial core

- generic orchestration frameworks;
- a universal Agent domain class;
- unrestricted database or shell tools for role agents;
- generic channels before a second real channel exists;
- recursive Workers;
- model-driven multi-Worker decomposition;
- a reusable skill marketplace or lifecycle product;
- schedules unrelated to retained conversational or task work;
- multi-account support;
- elaborate grant languages, sandboxes, or network policy systems;
- dashboards and operational control planes;
- Pi JSONL as durable authority;
- filesystem profiles as durable authority;
- hot mutation of active runs.

These may be added only through the durable protocols established here.

## Definition of the first complete Ambient

The first implementation is complete when:

1. an authenticated WhatsApp account resumes;
2. inbound messages are retained exactly once;
3. Conversation coalesces and consumes durable inbox ranges;
4. Conversation can respond, recall, start work, and query work;
5. a Worker completes durable tasks and returns inspectable results;
6. terminal task updates return to the correct conversation;
7. Memory maintains evidence-backed Claims and corrections;
8. corrected memory appears in a later relevant run;
9. every agent run, tool effect, task transition, and evaluation is inspectable;
10. restart at any boundary does not lose accepted work or duplicate effects.
