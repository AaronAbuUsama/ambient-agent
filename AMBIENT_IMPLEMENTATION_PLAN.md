# Ambient implementation plan

Status: accepted high-level implementation sequence.

This document turns the architecture in [`plan.md`](./plan.md) into an iterative
delivery plan. `plan.md` remains the authority for what Ambient is; this document
describes how to build it without pausing the working WhatsApp client or committing
early to abstractions the first real agent loops have not yet justified.

## Delivery principles

### Actions are the capability boundary

An action is the canonical implementation of an application capability. Humans,
agents, system processes, and tests invoke the same typed action through the
`agentic-tui-kit` action registry.

```text
keyboard / pointer / palette ─┐
system process ───────────────┼── Action Registry ── application service ── effect
Pi agent ─────────────────────┤
tests ────────────────────────┘
```

Pi tools adapt actions; they do not reproduce action behavior. Action input and
output schemas, availability checks, policy, side-effect classification, and
invocation records remain authoritative.

Human-agent parity means that an application capability does not get an
agent-only imitation. It does not mean every role agent receives every action.
Each role receives an explicit least-privilege action grant.

### The semantic runtime does not depend on a terminal

The action registry and application runtime must be constructible and usable
headlessly. Mounting the OpenTUI renderer is one host for that runtime, not its
owner and not a requirement for Conversation or Memory work to proceed.

### The database is durable authority

The application database owns observations, consumed ranges, role-specific run
inputs and results, action/tool outcomes, episodes, ontology state, memory
patches, and selected skills. Pi sessions and materialized skill directories are
disposable execution resources.

### Conversation and Memory remain role-specific

Conversation Agent and Memory Analyst have different inputs, actions, prompts,
skills, and results. Shared Pi construction should be extracted only after both
implementations reveal genuinely identical mechanics.

### Every phase ends in working proof

Each phase must leave the existing WhatsApp workbench working and add a narrow
test or journey proving the new behavior. A phase is not complete while its
tests, `vp check`, or the relevant end-to-end proof fails.

## Intended dependency direction

```text
process host / terminal
          |
          v
application composition
          |
          +── action registry
          |       |
          |       +── WhatsApp actions ── WhatsApp session/gateway
          |       +── Conversation actions ── conversation services
          |       +── Memory actions ── memory services
          |
          +── WhatsApp ingestion ── application database
          +── Conversation Agent ── Pi adapter
          +── Memory Analyst ── Pi adapter
          +── TUI panels and controls
```

UI components may invoke actions and read application state. They must not own
WhatsApp, Conversation, Memory, or database lifecycles. Pi tools may invoke
granted actions but must not contain parallel business implementations.

## Provisional source layout

The layout should emerge phase by phase. Do not create empty directories merely
to match this tree.

```text
src/
├── main.tsx
├── app/
│   ├── config.ts
│   ├── create-runtime.ts
│   └── lifecycle.ts
├── actions/
│   ├── pi-action-adapter.ts
│   └── action-ledger.ts
├── whatsapp/
│   ├── actions/
│   ├── session/
│   ├── ingestion/
│   └── tui/
├── conversation/
│   ├── conversation-agent.ts
│   ├── context-builder.ts
│   ├── turn-coordinator.ts
│   └── pi-conversation-agent.ts
├── memory/
│   ├── actions/
│   ├── ontology.ts
│   ├── episode-builder.ts
│   ├── memory-analyst.ts
│   └── pi-memory-analyst.ts
├── runtime/
│   └── pi/
└── persistence/
    ├── database.ts
    ├── observations.ts
    ├── conversation-runs.ts
    ├── tool-ledger.ts
    ├── episodes.ts
    └── memory.ts

test/
└── support/
```

## Phase 1: Action-first application foundation

### Goal

Make the existing architecture visibly action-first and separate semantic
runtime ownership from terminal rendering without changing user behavior.

### Work

1. Split process startup, application composition, and terminal mounting.
2. Keep `createTuiAppRuntime` usable without mounting a renderer.
3. Move action definitions out of large UI orchestration files.
4. Rename `WhatsAppEngine` to a name that reflects its responsibility, initially
   `WhatsAppSessionController`.
5. Give the top-level application runtime one clear, idempotent disposal path.
6. Split the large WhatsApp action file by capability:
   - connection;
   - messaging and receipts;
   - chat queries/history;
   - workbench navigation.
7. Begin splitting `panel.tsx` into a panel controller, sidebar, and views while
   preserving the existing action paths.
8. Move QR raster/frame extraction proof helpers out of production source.
9. Centralize environment configuration rather than reading `process.env`
   inside reusable classes.

### Proof gate

- The existing journey still pairs, syncs, opens a chat, and sends.
- Keyboard, pointer, palette, direct test, and agent-context invocation reach
  the same registered actions.
- The semantic runtime can be created and exercised headlessly.
- Runtime disposal releases the WhatsApp client, runtime, and backend exactly
  once from the caller's perspective.
- `vp check` and `vp test` pass.

## Phase 2: Pi-to-action bridge

### Goal

Prove that the installed Pi SDK can call existing application actions without a
second implementation of those capabilities.

### Work

1. Build a small adapter from `ActionRegistry.asTools(agentContext)` to Pi
   `defineTool` definitions.
2. Preserve action descriptions, schemas, availability failures, and structured
   results through the adapter.
3. Create a controlled Pi session using:
   - `createAgentSession`;
   - an in-memory Pi session manager;
   - an explicit system prompt;
   - no default coding tools;
   - only an explicit action allowlist.
4. Begin with read-only actions such as listing chats or reading connection
   status.
5. Record the Pi run ID as the action actor ID and `agent` as the invocation
   source.
6. Exercise the framework action policy for agent invocations.

### Proof gate

- Pi selects and invokes an existing registered action.
- The action ledger records `actor.kind: "agent"` and the correct run ID.
- The same action can be invoked through a human or test context.
- Invalid model-generated input is rejected by the action schema.
- Unavailable and denied actions return useful tool errors.
- No Pi adapter code talks directly to WhatsApp or persistence.

## Phase 3: Application database and WhatsApp observations

### Goal

Retain native WhatsApp messages as immutable application observations exactly
once and in order.

### Work

1. Add the application-owned libSQL schema and migration mechanism.
2. Add immutable Observation storage with native identity and provenance.
3. Add a WhatsApp message mapper that converts real client records into
   application observations.
4. Add idempotent ingestion with a native-identity uniqueness constraint.
5. Persist the ingestion cursor and accepted ordering.
6. Expose a narrow message/event subscription from the WhatsApp session layer;
   do not expose the underlying `whatsappd` client as an application API.
7. Persist action/tool outcomes independently of model terminal results.
8. Keep `whatsappd`'s mirror and the Ambient database conceptually separate:
   the mirror is channel infrastructure; observations are Ambient evidence.

### Proof gate

- A real or deterministic WhatsApp message creates one observation.
- Re-delivery creates no duplicate.
- Multiple messages retain deterministic conversation ordering.
- Restarting ingestion resumes without losing or replaying accepted messages.
- Ingestion works when no TUI is mounted.

## Phase 4: Conversation Agent vertical slice

### Goal

Process one retained WhatsApp input range exactly once with a real Pi
Conversation Agent that can act through shared application actions.

### Work

1. Implement the role-specific types from `plan.md`:
   `ConversationMessage`, `ConversationInput`, and `ConversationResult`.
2. Add pending and consumed observation ranges per conversation.
3. Implement `ConversationContextBuilder`.
4. Add a turn coordinator that claims one contiguous pending range.
5. Implement `PiConversationAgent` with an explicit prompt, model settings, and
   action grant.
6. Grant `whatsapp.send-message` first.
7. Record the exact run input, selected resources, action invocations, result,
   failure, and consumed range.
8. Treat deliberate silence as a successful run outcome.
9. Make already-accepted WhatsApp effects survive a later model failure.

### Proof gate

- A retained inbound message creates one Conversation run.
- The run receives the exact bounded input and provenance.
- Pi may deliberately stay silent or invoke the shared send action.
- A sent reply goes through the same action used by the workbench.
- The consumed range is not processed twice after restart or retry.
- An accepted send remains recorded if the model later fails.

## Phase 5: Skills and role-owned Pi resources

### Goal

Give Conversation runs selected skills through Pi's actual progressive
disclosure mechanism without making the filesystem authoritative.

### Work

1. Add the application `Skill` model from `plan.md`.
2. Store selected skills in the application database.
3. Materialize each run's exact selected skills into a run-owned resource
   directory.
4. Configure Pi's ResourceLoader explicitly for the role.
5. Provide a scoped `read` tool that can only read the materialized resources
   needed by that run.
6. Keep Pi's default `bash`, `edit`, and `write` tools disabled.
7. Persist skill IDs and versions with the run input.
8. Start with one static Conversation skill; do not build a registry product or
   promotion lifecycle.

### Proof gate

- Pi sees the selected skill description.
- Pi can read the selected `SKILL.md` and supporting files.
- Pi cannot read unrelated application or user files through the scoped tool.
- Changing a stored skill affects only later runs.
- A past run remains attributable to the exact skill version it used.

## Phase 6: Episode construction and Memory jobs

### Goal

Turn observations into bounded episodes and durable Memory jobs independently
of whether Conversation spoke.

### Work

1. Add Episode and Episode Observation persistence.
2. Implement deterministic episode boundary rules.
3. Feed every accepted WhatsApp observation into episode construction.
4. Close episodes on defined time, size, or conversation boundaries.
5. Create durable Memory jobs for closed or sufficiently large episodes.
6. Add job claim, retry, and terminal failure state sufficient for one local
   process.

### Proof gate

- Ordered observations produce deterministic episode membership.
- Conversation silence does not suppress episode construction.
- Closed episodes create Memory jobs once.
- Restarting resumes pending Memory jobs without duplicating them.

## Phase 7: Memory ontology and Memory Analyst vertical slice

### Goal

Maintain evidence-backed memory through a real Pi Memory Analyst and repeatable,
host-validated memory actions.

### Work

1. Implement the complete minimum ontology from `plan.md`:
   - Entity;
   - Identity Link;
   - Episode;
   - Predicate Definition;
   - Claim;
   - Evidence;
   - Memory Patch.
2. Implement versioned and transactional memory operations.
3. Define shared actions for:
   - `memory.search-entities`;
   - `memory.search-claims`;
   - `memory.search-episodes`;
   - `memory.inspect-observations`;
   - `memory.patch`.
4. Implement `PiMemoryAnalyst` with only the Memory action grant and selected
   skills.
5. Allow zero or more `memory.patch` calls in one run.
6. Return concrete validation/version errors so Pi can correct a rejected patch.
7. Persist the role-specific `MemoryAnalysisResult` separately from patches.

### Proof gate

- An episode establishes an evidence-backed claim.
- A later correction supersedes rather than erases that claim.
- Stale expected versions reject safely.
- Every accepted patch commits transactionally with its evidence.
- A subsequent Conversation context receives the corrected claim and evidence.

## Phase 8: Recall and observability in the workbench

### Goal

Make Conversation and Memory behavior visible and operable through the same
action-first workbench.

### Work

1. Add deterministic indexed memory retrieval to Conversation context.
2. Add the bounded `memory.recall` action for Conversation follow-up retrieval.
3. Add workbench views for:
   - pending conversation ranges;
   - current and past role runs;
   - action/tool invocation history;
   - episodes and Memory jobs;
   - entities, claims, versions, and evidence;
   - failures requiring human attention.
4. Add actions for retrying or inspecting work rather than embedding behavior
   directly in controls.
5. Apply role-aware policy to destructive or operational actions.

### Proof gate

- A human can inspect why a Conversation run received a memory.
- A human and an authorized agent can invoke the same operational action.
- Failures are visible without reading raw database rows or Pi internals.
- Retrieval is bounded and returns provenance with remembered claims.

## Phase 9: Executive and Worker

### Goal

Add delegation only after Conversation and Memory have established the real
action, run, skill, persistence, and Pi patterns.

### Work

1. Extract only the Pi construction mechanics proven identical by Conversation
   and Memory.
2. Define the first real `ExecutiveTask` and `ExecutiveResult`.
3. Add `create_skill` and `run_worker` actions/tools.
4. Store task-local generated skills in the application database.
5. Create fresh Worker sessions with explicit objectives, selected skills, and
   an action/tool subset.
6. Persist parent/child run lineage and later reporting to Conversation.
7. Do not add recursive Workers until a concrete journey requires them.

### Proof gate

- Conversation delegates a concrete task.
- Executive creates or selects a task-local skill.
- A fresh Worker receives only its granted capabilities.
- Worker and Executive results are persisted with lineage.
- A later Conversation run can report the durable outcome.

## Immediate milestones

The first implementation cycle should stop after each of these milestones for
review.

### Milestone A: Clean action-first foundation

Complete Phase 1. No new Ambient behavior is required. The deliverable is a
clear semantic runtime, explicit action ownership, smaller WhatsApp/TUI modules,
and unchanged user behavior.

### Milestone B: Pi invokes an existing action

Complete Phase 2. The deliverable is a deterministic integration test proving
the Pi-to-action bridge and actor-aware invocation record.

### Milestone C: One retained message, one Conversation run

Complete Phases 3 and 4 only to the narrowest real vertical slice. The
deliverable is an inbound WhatsApp observation processed once by Conversation,
with deliberate silence or a reply through the shared send action.

## Validation policy

For every implementation phase:

1. Run the narrowest relevant unit and journey tests during development.
2. Run `vp check`.
3. Run `vp test`.
4. Run any phase-specific proof script or headless journey.
5. Inspect the action invocation records for actor, source, input, output, and
   failure behavior.
6. Do not advance while the existing WhatsApp journey regresses.

Live WhatsApp proof is required only when a phase changes the real session or
ingestion boundary. Pure persistence, Pi adapter, and Memory behavior should be
provable deterministically first.

## Deferred deliberately

The following are not part of the initial phases unless a proven journey
requires them:

- a generic agent/orchestration framework;
- a universal model-produced run result;
- a package per agent role;
- Pi JSONL as application persistence;
- reusable skill marketplace and lifecycle;
- MCP;
- recursive Workers;
- schedules and broad proactive execution;
- multiple WhatsApp accounts;
- elaborate grants, sandboxes, and policy products;
- dashboards beyond the workbench views needed to inspect the first loops;
- advanced Matters and identity-merge workflows.

## Next action

Begin with Milestone A and keep it behavior-preserving. Before moving files,
capture the current module dependency map and existing test commands so every
structural step can be validated against the working WhatsApp journey.
