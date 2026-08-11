# Ambient Agent core

Status: proposed reset. This is the only architecture document for the first implementation. Existing documents and types are evidence, not architecture that must be preserved.

## What we are building

Ambient is a durable Agent built around real role-specific agents, not around a generic orchestration framework.

The first two agents are fundamental:

1. **Conversation Agent** — receives WhatsApp conversation context, reasons socially, and acts through WhatsApp and delegation tools.
2. **Memory Analyst** — interprets retained evidence, maintains the memory ontology through tools, and makes that memory retrievable by later Conversation runs.

Executive and Worker remain part of the intended Agent, but they follow after Conversation and Memory establish the real run, skill, tool, persistence, and context patterns.

The two fundamental loops are independent:

```text
WhatsApp -> retained messages -> Conversation context -> Conversation Agent -> WhatsApp tools
                         |
                         +-> Episodes -> Memory Analyst -> memory patch tools -> ontology
                                                                    |
future Conversation context and recall <----------------------------+
```

Conversation does not call Memory Analyst. Memory Analyst does not message Conversation. They communicate through durable observations and memory in the application database.

## Core classification rule

A concept is **fundamental** when removing it either changes what the Agent is or forces us to redesign an agent's input, tools, result, memory, or delegation protocol later.

A concept is **supporting implementation** when it is required to run the product but can be replaced without changing those protocols.

A concept is **later** when it can be added through the established protocols after Conversation and Memory work end to end.

## Shared execution facts

All role agents use Pi, but Pi is an execution engine rather than the domain model. The installed prototype already ran Conversation, Memory, Executive, and Worker-shaped sessions through the same Pi construction mechanics (`d8a8442:docs/research/architecture-reformulation-evidence.md:69-118`).

Each agent owns its own input, tools, prompt/skills, and result:

```ts
interface ConversationAgent {
  run(input: ConversationInput): Promise<ConversationResult>;
}

interface MemoryAnalyst {
  run(input: MemoryJob): Promise<MemoryAnalysisResult>;
}

interface ExecutiveAgent {
  run(input: ExecutiveTask): Promise<ExecutiveResult>;
}

interface WorkerAgent {
  run(input: WorkerTask): Promise<WorkerResult>;
}
```

There is no universal model-produced `RunResult`. The shared Pi adapter may normalize provider lifecycle and failures internally, but it must not erase role-specific results.

All real effects happen through tools while the agent runs. A result summarizes or concludes that agent's reasoning; it does not reproduce its tool calls. In particular, a Memory Analyst result is not a memory patch.

Pi JSONL is not used. The application database owns state, evidence, tool effects, results, and history.

## Skills

Skills are fundamental Pi resources. Conversation, Memory, Executive, and Workers may all have skills.

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

The application stores skills because runs and generated Workers must be able to reference them, but we do not need a general Skill Registry product yet. There is initially no discovery marketplace, promotion workflow, evaluation lifecycle, deprecation state machine, or permission system.

The Pi adapter materializes the exact selected skills into a run-owned resource directory. Pi discovers `SKILL.md` by path and advertises skills only when `read` is active, so resource materialization and a scoped `read` tool are required implementation facts (`d8a8442:docs/research/dynamic-runtime-minimal.md:50-59,71-91`). The filesystem is a Pi delivery mechanism, not the source of truth.

Executive may use `create_skill` to write a task-local Skill and then reference it in a fresh Worker definition. Generated skills contain instructions and resources; they never create tools or authority.

Reusable skill catalog behavior can be added after a generated skill demonstrates real reuse.

## Conversation Agent

The Conversation Agent is the first concrete runtime interface. It is more than `input: string` because ordered messages, participants, memory, and provenance matter.

```ts
interface ConversationMessage {
  readonly observationId: string;
  readonly whatsappMessageId: string;
  readonly senderId: string;
  readonly sentAt: string;
  readonly text: string;
  readonly fromAgent: boolean;
}

interface ConversationInput {
  readonly conversationId: string;
  readonly newMessages: readonly ConversationMessage[];
  readonly recentMessages: readonly ConversationMessage[];
  readonly participantMemory: readonly RecalledMemory[];
  readonly conversationMemory: readonly RecalledMemory[];
  readonly instructions: string;
}

interface ConversationResult {
  readonly summary: string;
}
```

The exact Conversation result may grow only when the real Conversation loop needs another role-specific value. Whether the agent spoke, reacted, recalled, or delegated is known from the tool ledger rather than claimed by the result.

### WhatsApp ingestion

WhatsApp is fundamental to the first Conversation loop, not a hypothetical generic channel.

The existing WhatsApp terminal client supplies inbound data. The Ambient adapter must:

1. read or subscribe to ordered WhatsApp messages;
2. deduplicate them by native identity;
3. store each accepted message as an immutable Observation;
4. form a bounded pending turn without losing ordering;
5. invoke Conversation exactly once for that retained input range;
6. record which range the Conversation run consumed.

The exact adapter must be written against the terminal client's real interfaces. Ambient should not rebuild the client or invent a channel framework.

### Conversation context

Context construction is a core module with a role-specific interface:

```ts
interface ConversationContextBuilder {
  build(conversationId: string, throughObservationId: string): Promise<ConversationInput>;
}
```

It selects the unprocessed contiguous message range, bounded recent messages, participant/conversation memory, and Conversation instructions. It does not pass operational wake events, generic receipts, or a universal `ContextPack` to the model.

Initial memory selection can use deterministic indexed retrieval. Conversation also receives `recall` for bounded follow-up retrieval when injected memory is insufficient.

### Conversation tools

The minimum set is:

```text
send_message
react_to_message
recall
delegate_work          # added when Executive is implemented
```

`send_message` and `react_to_message` use the existing WhatsApp client and persist their invocation/result independently of `ConversationResult`. A later model failure cannot undo an already accepted WhatsApp operation.

## Memory Analyst

Memory is an evidence-backed ontology, not a text-summary cache. Its irreducible concepts are:

- **Observation** — immutable source evidence such as a WhatsApp message.
- **Identity Link** — a source-native identity mapped to an Entity.
- **Entity** — a stable person, organisation, project, product, place, conversation, or resource.
- **Episode** — an ordered bounded experience assembled from Observations.
- **Predicate Definition** — typing, cardinality, and temporal rules for a class of Claims.
- **Claim** — a typed belief about an Entity.
- **Evidence** — links from Claims to the Observations that support, correct, or dispute them.
- **Memory Patch** — one host-validated transaction containing semantic memory operations.

Matters, deep research jobs, identity-merge review, and disclosure policy can be layered onto this ontology later; they do not replace it.

### Core memory types

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
      readonly claims: readonly { readonly claimId: string; readonly expectedVersion: number }[];
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

The host, not the model, adds patch ID, analyst Run ID, timestamps, and commit status.

### Memory Agent protocol

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

Memory Analyst receives:

```text
search_entities
search_claims
search_episodes
inspect_observations
patch_memory
```

`patch_memory` is repeatable. The agent may call it zero or more times during one analysis. Each call is schema-decoded; evidence IDs and entity/claim versions are checked; accepted operations commit transactionally; rejection returns concrete errors so the agent can correct the call.

Memory Analyst then returns `MemoryAnalysisResult`. It never has to reconstruct every patch and host identifier as one terminal object.

### Memory cadence and retrieval

Every retained WhatsApp message enters Episode construction independently of Conversation cadence. Closed or sufficiently large Episodes create Memory Jobs. This avoids one Memory run per message while ensuring Conversation silence does not suppress learning.

Conversation context retrieval reads committed Claims and supporting Evidence. Corrections supersede earlier Claims rather than erasing history. The old branch's typed ontology is useful evidence, but its terminal `MemoryPatchProposal` contract and prompt are superseded (`371d106:packages/memory/model.ts:20-138`; `371d106:packages/memory/runtime.ts:10-12`; `d8a8442:apps/ambient-daemon/prompts/memory-analyst.md:17`).

## Executive and Worker

Executive and Worker are core to the intended product but are implemented after Conversation and Memory prove the real patterns.

Executive receives a task-specific result schema and these initial tools:

```text
create_skill
run_worker
```

`run_worker` accepts an objective, instructions, selected Skills, and a subset of installed host tools. It creates a fresh Pi Worker with its own `WorkerTask` and `WorkerResult`. It does not create another durable social Agent.

Exact Executive/Worker input and result schemas should be designed when their first real journey is built, rather than inheriting the old Task/Job/Attempt state machines.

## Database authority

The database is fundamental. At minimum it must preserve:

```text
agent definitions and selected skills
WhatsApp observations and ingestion cursor
conversation pending/consumed ranges
role-specific run inputs and results
tool calls and their outcomes
Entities and Identity Links
Episodes and Episode Observations
Predicate Definitions
Claims and Evidence
Memory Patches and validation results
```

SQLite/libSQL is the smallest local implementation and is already installed. Exact table boundaries and repositories are implementation details. Pi sessions and filesystem resources are disposable.

## What is core and what is not

| Classification                                            | Concepts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fundamental now**                                       | Conversation Agent; WhatsApp ingestion and tools; Conversation context construction; Memory Analyst; full minimum memory ontology; memory patch tool protocol; role-specific inputs/results; Pi execution; skills; host tools; database authority.                                                                                                                                                                                                                                       |
| **Fundamental product, built after the first two agents** | Executive; runtime-created Worker definitions; Executive-created task-local skills; parent/child run lineage.                                                                                                                                                                                                                                                                                                                                                                            |
| **Supporting implementation**                             | SQLite/libSQL schema; Pi session/resource adapter; model provider configuration; temporary skill materialization; indexing/ranking; logging and schema decoding.                                                                                                                                                                                                                                                                                                                         |
| **Later**                                                 | Reusable Skill Registry product and lifecycle; MCP; schedules/proactive runs; recursive Workers; full Control Plane; multi-account; backfill/media; elaborate grants/policies; network grants/sandboxes; Matters and advanced identity review; dashboards, evals, backup, and repair.                                                                                                                                                                                                    |
| **Discarded or superseded**                               | Universal model-produced `RunResult`; terminal Memory Patch; role-specific effects inside terminal results; generic runtime `start/events/cancel` as the primary domain interface; separate Run/Attempt hierarchy before retries exist; `ContextPack.wakeEvents`; receipt-as-continuation; package-per-role architecture; Pi `AgentHarness`; Pi JSONL; separate Pi/Effect-AI runtimes; filesystem profiles as authority; hot mutation of an active Pi run; the old five-area sequencing. |

## Build order

### 1. Conversation loop

```text
existing WhatsApp client
-> retained ordered Observations
-> pending input range
-> ConversationContextBuilder
-> real Pi Conversation Agent with skills
-> WhatsApp tools
-> ConversationResult and consumed cursor
```

This cut is real when an actual WhatsApp conversation can enter, receive a response or deliberate silence, and be processed once with inspectable context and tool effects.

### 2. Memory loop

```text
retained Observations
-> Episodes
-> real Pi Memory Analyst with search/inspection tools
-> repeated patch_memory calls
-> validated ontology
-> recall/context injection into a later Conversation
```

This cut is real when a correction in WhatsApp supersedes an earlier Claim and the next relevant Conversation receives the corrected memory with its Evidence.

### 3. Executive and Worker loop

```text
Conversation delegation
-> Executive
-> generated task-local Skill
-> runtime-created Worker with selected tools
-> WorkerResult
-> ExecutiveResult
-> later Conversation context/reporting
```

The shared Pi implementation should be extracted only as Conversation and Memory reveal truly identical mechanics. The agents' domain interfaces remain separate.
