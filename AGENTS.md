# Ambient Engineering Guide

Ambient is a backend-only system for durable conversational work over WhatsApp.
Its implementation must be easy to understand, change, and extend without
requiring a reader to reconstruct the application from dozens of mechanisms.

This file is the root engineering contract for the repository. More specific
`AGENTS.md` files may add local rules, but they must preserve the architecture
and dependency direction defined here.

## Working practice

Follow
[`docs/canon/delivery-practice.md`](./docs/canon/delivery-practice.md) for
planning and sequencing work under uncertainty.

Non-negotiable operating rules:

- plan one active vertical slice in detail;
- keep only a lightly named likely next slice and unordered future themes;
- classify unknowns as decide now, spike, learn by building, or deliberately
  defer;
- preserve proven invariants during architecture rescue;
- do not combine a broad restructure with a major new product capability;
- require a deterministic proof gate before declaring a slice complete;
- stop and review after each slice before selecting the next one;
- promote a pattern into shared architecture only after multiple real slices
  prove that it is genuinely shared, unless it is already a product invariant.

[`docs/status/current-state.md`](./docs/status/current-state.md) owns the active
rescue ledger and slice brief. Update it after each completed slice. Do not
create a large master implementation specification or treat distant themes as
committed phases.

## Design standard: deep modules

Prefer **deep modules**, in the sense described by John Ousterhout in
_A Philosophy of Software Design_: a small, stable interface should hide a
substantial amount of implementation complexity.

File count is not the goal. Architectural compression is.

A good module:

- has one clear owner and one reason to change;
- exposes a small API stated in product or domain language;
- hides transport, framework, persistence, lifecycle, retry, and protocol detail;
- makes invalid states difficult or impossible to represent;
- can be understood without following a long forwarding chain;
- absorbs new implementations without forcing unrelated callers to change.

A shallow module is a warning sign. Do not add a file, interface, factory, or
wrapper that merely renames or forwards another implementation's details.

Before adding an abstraction, answer:

1. What complexity does it hide?
2. Who owns the invariant?
3. How does this reduce what callers must know?
4. Will adding the next provider, role, channel, or tool require editing this
   caller?

If the answers are unclear, stop and redesign before coding.

## Product model

Ambient is not a generic multi-agent framework. It is one entity with four fixed
agent kinds:

1. **Root Agent**
   - Owns Ambient's identity, attention, commitments, cross-thread synthesis,
     delegation, initiative, and capability direction.
   - Does not normally communicate by bypassing a Conversation Agent.
2. **Conversation Agent**
   - Is a durable, situated representative assigned to one WhatsApp
     conversation.
   - Owns that thread's audience, disclosure boundary, relationship, mandate,
     and locally autonomous conversational behaviour.
3. **Worker Agent**
   - Performs one bounded objective with selected skills and scoped tools or MCP
     capabilities.
   - May be a one-off specialist or an instance of a reusable definition created
     or refined by the Root.
4. **Memory Agent**
   - Interprets retained evidence and maintains evidence-backed continuity.
   - Never receives unrestricted database access and does not own Ambient's
     global intentions.

These fixed kinds have different workflows. The Root may dynamically create and
revise durable Conversation, Worker, and Memory instances, definitions,
assignments, skills, and capability bundles.

Schedulers, task state machines, lease coordinators, and retry services are
deterministic infrastructure, not additional agent personas.

Evaluation is a cross-cutting subsystem, not a peer that participates in product
control flow. It observes durable evidence and must not become the authority for
whether an effect occurred.

## The internal programming model

Small external APIs are necessary but not sufficient. Ambient must also have a
clear internal model for defining agent kinds, durable instances, assignments,
runs, capabilities, and communication protocols. The normative product
ontology is
[`docs/canon/product-model.md`](./docs/canon/product-model.md). Canonical module
and protocol ownership is
[`docs/canon/architecture.md`](./docs/canon/architecture.md).

### Role modules

Each agent kind owns:

- its domain vocabulary and contracts;
- its bounded input;
- its prompt and model policy;
- its allowed tools;
- its terminal result;
- its runtime invariants and evaluation cases;
- the persistence ports required to perform its work.

Do not create a universal domain `Agent`, generic role superclass, generic tool
bag, or model-produced universal `RunResult`. Shared Pi mechanics may be reused
behind adapters, but role behavior remains explicit.

Representative contracts:

```ts
interface ConversationAgent {
  run(
    input: ConversationInput,
    tools: ConversationTools,
    signal: AbortSignal,
  ): Promise<ConversationResult>;
}

interface WorkerAgent {
  run(input: WorkerInput, tools: WorkerTools, signal: AbortSignal): Promise<WorkerResult>;
}

interface MemoryAgent {
  run(input: MemoryInput, tools: MemoryTools, signal: AbortSignal): Promise<MemoryResult>;
}
```

These interfaces belong to their agent-kind modules. Pi, Drizzle, libSQL, WhatsApp,
and provider-specific types must not appear in them.

Keep these durable concepts distinct:

- **agent kind**: Root, Conversation, Worker, or Memory execution semantics;
- **agent definition**: versioned behaviour, skills, capabilities, and model
  policy;
- **agent instance**: one durable identity using a definition;
- **assignment**: an ongoing or finite responsibility;
- **run**: one bounded invocation with immutable input and capability snapshots;
- **capability**: a scoped tool, MCP, skill, credential reference, and its
  constraints.

Do not collapse Conversation into Conversation Agent, assignment into run, or
agent definition into provider configuration.

### Durable protocols between roles

Agents do not rely on hidden in-memory calls to coordinate. Responsibility and
results move through retained records owned by deterministic services:

```text
WhatsApp accepted input
  -> Observation + Conversation Inbox
  -> Conversation Service
  -> Conversation Agent

Root attention or commitment
  -> Conversation, Worker, or Memory assignment
  -> specialized agent instance
  -> private report, result, evidence, or escalation
  -> shared Root agenda

Granted Conversation delegation
  -> bounded Worker assignment
  -> Worker Agent
  -> durable Worker result
  -> originating Conversation Inbox
  -> Conversation Agent

Observations + task evidence
  -> Episode or Memory Job
  -> Memory Agent
  -> evidence-backed ontology patch
  -> later Root, Conversation, or Worker recall
```

Every handoff must be durable before the next role runs. In-memory callbacks,
timers, active model sessions, and process-local queues may accelerate work, but
they are never the authority.

The Root need not model-call on every mechanical transition. A Conversation
Agent may directly create a narrow Worker assignment when its durable mandate
and capability bundle permit it. The assignment and result must remain visible
in the Root's shared world and agenda.

For every new cross-role behavior, document:

1. the retained record that represents the handoff;
2. the deterministic service that owns its state transition;
3. the consumer that claims it;
4. the idempotency or deduplication key;
5. its retry and recovery semantics;
6. the evidence proving any external effect.

If a proposed feature cannot answer all six, its protocol is incomplete.

## Target module boundaries

The desired dependency graph is:

```text
main
  -> createAmbient(config)
       -> models/         model runtime and provider adapters
       -> whatsapp/       channel gateway and accepted-source ingestion
       -> root/           attention, agenda, synthesis, and assignments
       -> conversation/   conversation service and role agent
       -> assignments/    deterministic assignment state and routing
       -> worker/         worker role agent
       -> memory/         memory agent, ontology, and recall protocol
       -> storage/        durable adapters for role-owned ports
       -> evals/          asynchronous evidence evaluation
```

Only create directories as real behavior arrives. Do not create empty
architecture scaffolding.

### Ambient

`createAmbient(config)` is the sole production composition root. It opens and
owns internal resources and returns one lifecycle facade:

```ts
interface Ambient {
  start(): Promise<void>;
  wait(): Promise<AmbientExit>;
  stop(): Promise<void>;
}
```

`main.ts` handles process concerns only: load configuration, create Ambient,
start it, wait for termination, and stop it.

Do not expose a public bag of the database, WhatsApp controller, schedulers,
agents, or repositories. Operational and proof capabilities must be explicit,
narrow interfaces rather than leaked internals.

### Models

The model subsystem is one deep module. Callers choose a role; they do not
construct providers:

```ts
interface ModelRuntime {
  forRole(role: ModelRole): ModelRunner;
}
```

The module privately owns:

- provider definitions and aliases;
- Pi provider/model construction;
- transport protocol adapters;
- endpoint normalization;
- authentication and secret lookup;
- model capability metadata;
- startup validation and model resolution;
- caching or reuse of provider/model clients.

Keep these concepts separate:

- **adapter**: executable support for a protocol;
- **provider definition**: data describing an endpoint and credential source;
- **role profile**: data selecting a provider, model, and generation settings;
- **credential value**: a secret supplied by the deployment.

Adding another OpenAI-compatible provider should normally be a configuration
change, not an edit to generic application code.

Role agents receive a ready-to-use `ModelRunner` or similarly narrow binding.
They must not receive environment access, provider registries, mutable Pi model
collections, API keys, base URLs, or parallel configuration objects that must be
kept in sync.

### WhatsApp

WhatsApp must be hidden behind Ambient-owned product boundaries. `whatsappd`
runtime, client, backend, retained mirror, accepted log, session recreation,
and operation queue are adapter details.

The production lifecycle should need only the host service:

```ts
interface WhatsAppService {
  start(): Promise<void>;
  waitForFailure(): Promise<WhatsAppFailure>;
  stop(): Promise<void>;
}
```

Agent roles receive narrower capabilities bound to their audience and run. A
Conversation Agent may receive `ConversationMessaging`, reactions, or later
media capabilities, but never the host service or an arbitrary destination.
Reuse `whatsappd`'s typed durable operation vocabulary behind these scoped
capabilities rather than copying it into a generic application command union.

Health observation, history indexing, and proof-only destination discovery may
use separate narrow ports. Do not expose a broad concrete controller merely
because it already contains those methods.

### Services and durable stores

Organize persistence APIs around transactional invariants, not one public
repository per table.

Examples:

- `WhatsAppIngestionStore` owns cursor advancement, Observation retention,
  Inbox creation, deduplication, and the durable scheduling signal.
- `ConversationWorkStore` owns notification, bounded claims, leases, Agent Run
  creation, tool evidence, completion, release, retry, and recovery.
- `AssignmentStore` owns durable responsibility, routing, status transitions,
  leases, results, and attention handoffs through deterministic services.
- `MemoryStore` persists evidence and ontology state through Memory-owned
  contracts.

One durable transition must have one authoritative mutation path. Avoid
overlapping repository APIs that can independently modify the same aggregate.

Domain modules own contracts; storage modules implement them. Domain contracts
must not import Drizzle rows or concrete database repository types.

### Evaluations

Runtime invariants may be checked synchronously when they are required for safe
completion. Quality evaluation should consume durable run evidence
asynchronously and must not block the live Conversation or Worker path.

### Proofs

Proofs exercise the same Ambient composition as production with explicit safety
overrides and read-only evidence access.

They must not:

- reconstruct production schedulers or agents;
- duplicate provider or credential policy;
- open raw schema access when a proof read model can express the query;
- weaken or bypass the final side-effect guard.

## Configuration policy

Use a validated YAML or JSON configuration document for structured application
configuration. Environment variables should normally be limited to:

- the configuration file path;
- secret values;
- a small number of deployment-level overrides.

Do not create a matrix of per-role environment variables for providers,
protocols, endpoints, capabilities, and generation settings.

Configuration should distinguish provider definitions from role selections:

```yaml
providers:
  qwen-plan:
    adapter: openai-compatible
    baseUrl: https://example.invalid/v1
    credential:
      env: QWEN_TOKEN_PLAN_API_KEY

  vibe:
    adapter: openai-compatible
    baseUrl: http://127.0.0.1:8317/v1
    credential: none

roles:
  conversation:
    provider: qwen-plan
    model: qwen3.6-flash
    thinking: off
    maxOutputTokens: 4096
```

Parse and validate configuration once at the application boundary. Fail closed
with precise validation errors. Never persist credential values in Agent Runs,
logs, evaluations, or proof output.

## TypeScript standard

Write TypeScript that is precise, unsurprising, and worthy of the standards
associated with Matt Pocock's teaching.

### Non-negotiable rules

- Do not use `any`, including explicit `any`, implicit `any`, `Model<any>`,
  `Record<string, any>`, or `as any`.
- Treat external and decoded data as `unknown`, then narrow it with schemas,
  predicates, or exhaustive checks.
- Do not silence uncertainty with broad type assertions. Assertions are allowed
  only at a proven boundary where TypeScript cannot express an invariant, and
  must be narrow and documented.
- Prefer discriminated unions over boolean flag combinations and optional-field
  state machines.
- Make illegal states unrepresentable where practical.
- Use exhaustive `switch` statements with a `never` check for closed unions.
- Use branded or opaque identifiers where mixing IDs would be dangerous.
- Preserve literal information with `satisfies` and `as const` when useful;
  avoid widening everything to `string`.
- Prefer immutable inputs and readonly domain values.
- Validate configuration, database JSON, model output, and third-party payloads
  at their boundaries.
- Keep side effects at the edges and domain transitions explicit.
- Prefer dependency injection through narrow required interfaces, not optional
  fallback hooks that fail only at runtime.
- Do not export a type, function, or class merely for testing. Test through the
  real boundary or extract a genuinely owned module.
- Avoid stringly typed provider, role, status, and tool behavior when a closed
  union or validated identifier is available.
- Do not introduce parallel representations that must agree. Normalize once.

### Type ownership

- Role contracts live with the role.
- Provider-neutral model contracts live in `models/`.
- Persistence adapters depend on role-owned ports, never the reverse.
- Third-party framework types stop at their adapter.
- Shared types must represent a genuinely shared domain concept, not merely
  avoid an import.

## Implementation discipline

Before implementing a feature:

1. State the owning module.
2. State the durable records and invariants involved.
3. State the smallest public API needed.
4. Draw the dependency direction.
5. Identify which third-party details are hidden.
6. Explain how restart, retry, duplication, and partial failure behave.

During implementation:

- Prefer completing one vertical durable slice over scaffolding future roles.
- Preserve authenticated WhatsApp state and retained product databases.
- Treat timers and callbacks as wake-up hints, not durable truth.
- Persist external effects through idempotent operations.
- Keep destination selection outside model control.
- Match existing proven durability semantics unless intentionally replacing
  them with a stronger invariant.

Before finishing:

- Confirm the feature can be explained through a short role/protocol flow.
- Check that adding the next implementation does not require editing unrelated
  callers.
- Search for duplicate mutation paths and duplicated policy.
- Run focused tests, then the full repository validation.
- Report skipped validation and unresolved architectural debt honestly.

## Architectural stop conditions

Stop and seek or perform a redesign before proceeding when:

- a feature adds another parallel configuration graph;
- a composition root must understand provider or channel internals;
- a proof must rebuild production wiring;
- one durable aggregate has multiple public mutation paths;
- role modules import concrete database or third-party framework types;
- a scheduler accumulates persistence, tools, effects, evaluation, and model
  construction;
- adding a provider or role requires broad edits across generic files;
- an abstraction increases the number of concepts without hiding complexity;
- the implementation is correct but cannot be explained simply.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
