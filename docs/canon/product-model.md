# Ambient Product Model

Status: working product ontology.

This document defines what Ambient is before defining how it is implemented.
It separates settled product principles from open design questions so that
implementation can proceed without prematurely freezing the wrong mechanics.

Ambient should be made as simple as possible, but no simpler. Simplicity means
the smallest coherent set of concepts capable of sustaining the intended
product. It does not mean removing distinctions that the product depends on.

## Product thesis

> Ambient is one persistent, autonomous digital colleague whose primary
> environment is WhatsApp. Its Root Agent creates and directs durable,
> specialized agent instances. Conversation Agents manage situated
> relationships, Workers perform bounded objectives, and Memory Agents maintain
> continuity. Their coordination is visible through durable assignments,
> records, and evidence rather than hidden calls.

Ambient is not merely:

```text
message -> model -> tools -> response
```

Model loops and tools are implementation mechanisms. The product emerges from
their combination with persistent identity, cross-thread awareness, durable
responsibility, situated conversation, delegation, capability development, and
autonomous re-entry.

## WhatsApp is the environment

WhatsApp is not initially one interchangeable channel behind a generic event
framework. It is Ambient's primary social environment:

- people and relationships appear there;
- direct messages and groups establish distinct audiences;
- work and commitments arise there;
- Ambient develops conversational continuity there;
- Ambient reports progress, asks questions, and follows up there.

GitHub, email, calendars, and other sources may later extend Ambient's
perception and ability to act. They do not initially have the same product
meaning as WhatsApp.

The Root Agent does not normally speak directly through WhatsApp. Ambient speaks
through a Conversation Agent assigned to the relevant conversation. This keeps
audience, disclosure, tone, history, and relationship management inside the
situated agent that owns them.

The Root may eventually have narrow administrative WhatsApp capabilities, such
as discovering a conversation or requesting that a new conversational presence
be established. Those capabilities must not become an unrestricted bypass around
Conversation Agents.

## One entity, several forms of agency

Ambient is one entity, not a society of unrelated agents.

```text
Ambient
  |
  +-- Root Agent
  |     identity, attention, intentions, commitments,
  |     synthesis, delegation, initiative, capability direction
  |
  +-- Conversation Agent instances
  |     situated social presence in individual WhatsApp conversations
  |
  +-- Worker Agent instances
  |     bounded objective-oriented specialists
  |
  +-- Memory Agent instances
        evidence interpretation and continuity maintenance
```

These kinds are opinionated because their workflows are qualitatively
different. They must not be collapsed into one universal agent abstraction.

Within each kind, Ambient may create durable instances dynamically. The system
is fixed in its small set of agency semantics and flexible in the purposes,
instructions, skills, capabilities, and assignments of individual instances.

## Fixed agent kinds

### Root Agent

The Root Agent is the enduring locus of Ambient's:

- identity and character;
- attention and priorities;
- intentions and commitments;
- cross-conversation synthesis;
- delegation and follow-through;
- proactive behaviour;
- capability creation and refinement;
- responsibility for the system as a cohesive whole.

The Root owns an ongoing logical loop:

```text
perceive durable changes
  -> update understanding
  -> review attention, goals, and commitments
  -> decide whether anything deserves action
  -> create or update assignments
  -> direct a Conversation Agent, Worker, or Memory Agent
  -> observe durable outcomes
  -> reassess, wait, or continue
```

This does not require an uncontrolled polling model call. Deterministic runtime
machinery decides when a durable condition warrants waking the Root. The Root
owns judgement; the runtime owns reliable awakening, leases, retries, and
effects.

The Root does not need to mediate every mechanical transition. A granted
Conversation Agent may create a narrow Worker assignment directly, and the
Worker result may return to that Conversation Agent. Such activity must remain
visible to the Root through the shared durable world.

### Conversation Agent

A Conversation Agent is a durable, situated representative of Ambient assigned
to one WhatsApp conversation.

It owns:

- the local audience and disclosure boundary;
- the thread's purpose, norms, and conversational history;
- relationship continuity within that thread;
- how Ambient's personality is expressed locally;
- an ongoing assignment or mandate for the conversation;
- deciding whether, when, and how to speak;
- bounded delegation explicitly allowed by its assignment;
- reporting relevant progress and private conclusions.

It may be created or updated by the Root when:

- a new group or direct conversation becomes relevant;
- Ambient is asked to establish a new conversation;
- a thread needs an explicit purpose or specialist behaviour;
- an ongoing responsibility changes;
- new skills or bounded capabilities become appropriate.

A Conversation Agent has its own execution semantics:

```text
new conversation events or an assignment update
  -> debounce and coalesce
  -> build curated thread, participant, memory, and assignment context
  -> run one bounded agent turn
  -> perform zero or more conversation-scoped tools
  -> persist a private terminal report
```

Conversation-scoped tools may eventually include:

- send one or more messages;
- react to messages;
- recall relevant memory;
- inspect or update its assignment;
- create a permitted bounded Worker assignment;
- inspect delegated work;
- report a conclusion or escalation to the Root.

The model's terminal response is never automatically posted to WhatsApp. It is
a private result: a bounded thought, summary, status report, or recommendation
retained as evidence for the Conversation Agent and potentially for the Root.
Only successful conversation tool outcomes prove that Ambient communicated.

A Conversation Agent has meaningful local autonomy. It is not a puppet invoked
only to phrase a sentence dictated by the Root. The Root establishes its
identity, mandate, constraints, and capabilities; the Conversation Agent manages
the ongoing situated relationship within those bounds.

### Worker Agent

A Worker Agent is objective-oriented rather than relationship-oriented.

It receives:

- one bounded objective;
- relevant evidence and context;
- completion criteria;
- a selected model profile;
- selected skills;
- scoped tools or MCP capabilities;
- reporting and artifact requirements.

Its execution semantics are approximately:

```text
assignment + evidence + capabilities
  -> perform bounded work
  -> persist tool outcomes, artifacts, and evidence
  -> produce a private terminal result
  -> complete, fail, pause, or request clarification
```

A Worker may be:

- a coding agent;
- a researcher;
- a GitHub issue filer;
- a supplier investigator;
- a one-off specialist assembled for one assignment;
- a reusable specialist whose definition is refined over time.

The Root may create or revise Worker definitions by combining instructions,
skills, MCP servers, tool scopes, model profiles, and completion criteria.
Ambient is therefore not limited to a hardcoded integration-specific Worker
class for every future capability.

### Memory Agent

A Memory Agent is a specialized evidence analyst, not Ambient's central mind and
not a generic Worker with database access.

It receives bounded retained evidence and may:

- resolve or propose identity links;
- construct episodes;
- compare evidence with current beliefs;
- identify contradictions and supersession;
- create host-validated ontology patches;
- qualify confidence and provenance;
- preserve audience or sensitivity constraints.

Its execution semantics are approximately:

```text
bounded evidence + current ontology view
  -> analyze
  -> use bounded inspection and patch tools
  -> persist validated memory changes
  -> produce a private terminal report
```

Memory preserves continuity for the Root, Conversation Agents, and Workers. It
does not itself decide Ambient's priorities or speak to people.

## Deterministic runtime services are not agents

The following are essential but are not product personas or intelligent peers:

- inbox schedulers;
- attention wake-up machinery;
- task and assignment state machines;
- lease and retry coordinators;
- operation queues;
- idempotency enforcement;
- capability and tool binding;
- evaluation runners;
- persistence adapters.

These services make agent decisions durable, safe, and recoverable. They should
be named for the invariant they own, not elevated into an artificial agent role.

## Core ontology

The initial ontology should remain small. The following distinctions appear
irreducible.

### Agent kind

One of the fixed execution semantics:

```text
root | conversation | worker | memory
```

Kinds are product concepts, not provider or model choices.

### Agent definition

A versioned specification for how an agent instance behaves:

- kind;
- name and purpose;
- instructions and personality;
- skills;
- capability policy;
- model profile;
- workflow-specific settings;
- revision and provenance.

A definition does not represent active responsibility or one model invocation.

### Agent instance

A durable manifestation of an agent definition:

- stable identity;
- agent kind;
- lifecycle status;
- creator or owning Root;
- active definition revision;
- associated conversation, when applicable;
- current assignments;
- creation and retirement evidence.

Examples:

```text
Root Agent: Ambient
Conversation Agent: Rex direct
Conversation Agent: Product feedback group
Worker Agent: GitHub bug filing specialist
Memory Agent: account memory analyst
```

### Conversation

A native WhatsApp thread and its audience boundary:

- native identity;
- direct or group form;
- participants and known identities;
- retained observations;
- purpose and social context;
- assigned Conversation Agent, if one exists.

The Conversation and its Conversation Agent are separate concepts. The
conversation exists as part of WhatsApp even before Ambient decides to create a
managed conversational presence there.

### Assignment

A durable responsibility given to an agent instance:

- objective or mandate;
- completion or continuation criteria;
- priority;
- relevant evidence;
- parent assignment or originating concern;
- expected reporting destination;
- lifecycle state;
- temporal constraints;
- capability requirements.

Assignments may be:

- finite, such as filing one bug;
- conversationally extended, such as qualifying one supplier;
- ongoing, such as managing a product-feedback group;
- recurring, such as reviewing unresolved commitments.

An assignment is not the same as one run. One assignment may produce many runs
and may survive restarts, model failures, and long periods of waiting.

### Run

One bounded invocation of one agent instance under:

- an immutable input snapshot;
- one definition revision;
- one model snapshot;
- one capability snapshot;
- one lease;
- retained tool calls and outcomes;
- one private terminal result or failure.

Runs are execution evidence. They are not agent identity or durable
responsibility.

### Capability

A bounded ability that may be granted to an agent run or definition:

- an Ambient-owned tool;
- an MCP server or selected MCP tools;
- a skill or instruction resource;
- a credential reference;
- scope constraints;
- side-effect and evidence requirements.

The first implementation should avoid a general permission language. Explicit
capability bundles and role-specific factories are preferable until concrete
needs justify more machinery.

### Durable handoff

A retained record through which responsibility or information moves between
agents:

- assignment creation or update;
- Conversation Inbox item;
- Worker result;
- Root attention item;
- Memory job;
- private agent report;
- operation outcome;
- artifact or evidence link.

Agents do not depend on hidden direct calls to each other. A service may perform
efficient direct orchestration, but the handoff must exist durably and remain
inspectable.

### Shared world and agenda

The Root needs a durable view spanning:

- people and identity links;
- conversations and audiences;
- agent instances and definitions;
- assignments and commitments;
- work status and results;
- memory claims and evidence;
- available capabilities;
- unresolved attention items.

This is not necessarily one table, one prompt, or one enormous context window.
It is the coherent product state from which bounded Root context can be built.

## Communication and routing

The invariant is stronger than any one routing topology:

> Every meaningful delegation, result, escalation, and communication intent is
> durably represented and visible to the relevant owner.

Two routing forms may both be valid.

### Root-mediated routing

Use Root mediation when work affects:

- global priorities or commitments;
- several conversations;
- capability creation or modification;
- sensitive or high-impact action;
- unclear ownership;
- substantial cost or risk.

```text
Conversation Agent private report
  -> Root attention item
  -> Root decision
  -> Worker or Conversation assignment
```

### Granted direct routing

A Conversation Agent with an explicit ongoing mandate may create a narrowly
scoped Worker assignment directly:

```text
Conversation Agent
  -> durable Worker assignment
  -> Worker
  -> durable result routed to the originating Conversation Agent
  -> Conversation Agent decides how to communicate locally
```

The Root need not model-call for every transition, but the assignment, result,
and commitment state remain visible in its shared agenda.

The choice between these forms should be made by explicit responsibility and
capability rules, not by accidental module coupling.

## Autonomy and attention

Ambient must be capable of initiating action without a new inbound message.

Possible durable wake reasons include:

- a new conversation event;
- a Worker or operation result;
- an assignment deadline;
- an unresolved commitment requiring follow-up;
- a failed or blocked action;
- new external evidence;
- a periodic review of attention and priorities;
- a capability becoming available or invalid.

Autonomy does not mean activity for its own sake. Valid Root decisions include:

- act now;
- direct a Conversation Agent;
- delegate work;
- request clarification;
- revise an assignment;
- wait until a durable condition changes;
- deliberately do nothing.

Restraint, audience awareness, and respect for interruption are part of behaving
like a colleague.

## Essential and accidental complexity

### Essential complexity to preserve

- one persistent identity across contexts;
- cross-thread synthesis without privacy leakage;
- thread-specific audience and disclosure boundaries;
- Root-level attention, intention, and initiative;
- durable long-running conversational mandates;
- durable delegated work and partial-failure recovery;
- fixed specialized agent workflows;
- dynamically composed Worker capabilities;
- evidence-backed memory with confidence, provenance, contradiction, and
  supersession;
- proof of real external effects;
- bounded proactivity.

### Accidental complexity to reject

- a universal multi-agent framework;
- generic Agent superclasses;
- mandatory Root model calls for every state transition;
- direct hidden agent-to-agent calls;
- generic event buses before concrete protocols require one;
- one Worker class per integration;
- a full policy language before explicit capability bundles become inadequate;
- one public repository per table;
- duplicate composition roots;
- generic channel abstractions that erase WhatsApp's product meaning;
- configuration graphs that repeat the same facts;
- empty scaffolding for imagined future subsystems.

The goal is not minimum code. It is minimum conceptual machinery capable of
producing the intended continuity of agency.

## Product journeys

These journeys test whether the ontology is sufficient. They illustrate product
semantics without freezing exact implementation details.

### Journey 1: supplier qualification

Objective: determine whether a list of suppliers carries a specific product.

1. The owner gives the Root the qualification objective and supplier evidence.
2. The Root creates one parent assignment and decides which suppliers require
   new or existing WhatsApp conversations.
3. For each supplier conversation, the Root creates or updates a Conversation
   Agent definition and instance with:
   - the qualification mandate;
   - elicitation guidance;
   - disclosure constraints;
   - relevant product facts;
   - completion and escalation criteria.
4. Each Conversation Agent independently manages a potentially multi-turn
   exchange, waiting between messages without losing its assignment.
5. Its private terminal reports and durable assignment updates record progress;
   only message tool outcomes prove what was sent.
6. When enough evidence exists, the Conversation Agent completes or escalates
   its assignment.
7. The Root synthesizes the supplier results across conversations and directs
   the appropriate Conversation Agent to report the final conclusion.

This journey requires long-running Conversation assignments, Root synthesis,
durable waiting, and cross-conversation aggregation. It does not require a
generic workflow engine.

### Journey 2: customer feedback to GitHub issue

Objective: manage a customer-feedback group and reliably file actionable bugs.

1. The Root assigns a durable product-feedback mandate to the group's
   Conversation Agent.
2. A customer reports a problem.
3. The Conversation Agent uses its local context and elicitation skill to ask
   focused follow-up questions over one or more turns.
4. Once the completion criteria are met, the Conversation Agent creates a
   narrowly scoped Worker assignment to file the issue, if its capability bundle
   grants this route. Otherwise it escalates the proposed assignment to the Root.
5. A GitHub-capable Worker receives only the validated bug evidence and the MCP
   or tools needed to inspect duplicates and create the issue.
6. The Worker persists the issue URL and operation evidence in its result.
7. The result returns durably to the originating Conversation Agent and remains
   visible to the Root.
8. The Conversation Agent decides how to tell the group that the issue was
   filed, using its local tone and audience knowledge.

This journey does not require the Worker to message WhatsApp or the Root to
personally phrase every response.

### Journey 3: continuity with Rex across threads

Objective: make Ambient feel like one colleague when Rex appears in a group and
in a direct conversation.

1. WhatsApp observations identify Rex through native identities and
   evidence-backed identity links.
2. The Memory Agent maintains qualified shared knowledge about Rex, projects,
   preferences, and commitments.
3. Each Conversation Agent receives:
   - its own thread history and assignment;
   - relevant shared memory;
   - audience-specific disclosure constraints;
   - Root-level commitments relevant to that conversation.
4. A private fact learned in Rex's direct chat may inform Root understanding but
   is not automatically disclosed in the group.
5. A group commitment may create a Root attention item or shared assignment.
6. The Root can synthesize that both threads concern the same person and work,
   then direct the appropriate Conversation Agent without making the
   Conversation Agents identical or sharing raw context indiscriminately.

This journey requires identity continuity, shared memory, Root synthesis, and
strict audience boundaries. A single global transcript or vector search is not
sufficient.

## Settled principles

The following are established unless new product evidence disproves them:

1. Ambient is one entity with one Root Agent.
2. WhatsApp is its initial primary environment.
3. The Root does not normally communicate by bypassing Conversation Agents.
4. Root, Conversation, Worker, and Memory are fixed specialized agent kinds.
5. Agent instances, definitions, assignments, and runs are distinct durable
   concepts.
6. Conversation Agents are durable and locally autonomous within a Root-defined
   mandate.
7. Conversation terminal responses are private results, not outbound messages.
8. Workers are dynamically composable specialists with bounded objectives.
9. Memory Agents maintain evidence-backed continuity and do not own global
   intention.
10. Deterministic services own scheduling, leases, retries, permissions, and
    effect enforcement.
11. Agents coordinate through durable handoffs and evidence.
12. The Root may observe granted direct delegation without mediating every
    mechanical transition.
13. Structured configuration and definitions are data; secrets remain external.
14. The architecture should preserve essential product complexity while
    rejecting generic-framework complexity.

## Open design questions

These questions should remain open until journeys and implementation evidence
justify an answer:

1. What durable events or attention policy should wake the Root?
2. How is Root context selected without constructing one unbounded global
   prompt?
3. When is a Conversation Agent created automatically, and when does the Root
   explicitly create it?
4. Can one Conversation have multiple sequential Conversation Agent instances,
   or exactly one enduring instance with revised definitions?
5. Which assignment transitions require Root approval?
6. Which narrow Worker assignments may a Conversation Agent create directly?
7. How are capability bundles represented before a richer permission model is
   justified?
8. How does the Root create, test, approve, and retain a reusable Worker
   definition assembled from skills and MCPs?
9. What information classes and audience rules prevent cross-thread disclosure?
10. How are private terminal reports summarized, retained, and surfaced without
    becoming an unbounded internal monologue?
11. When should the Root proactively initiate a conversation, and what restraint
    policy governs interruption?
12. Which current database concepts can be migrated into this ontology without
    losing the already proven ingestion and Conversation durability invariants?

These are product-design questions, not invitations to pre-build a generic
framework. Resolve them through concrete journeys and the smallest viable
vertical slices.

## Standard for future planning

Any future implementation plan must identify:

- the agent kind and instance involved;
- the durable assignment or mandate;
- the wake reason;
- the bounded run input;
- the capabilities granted;
- the durable handoffs produced;
- the owner of each state transition;
- the audience and disclosure boundary;
- restart, retry, and idempotency behaviour;
- the evidence that proves external effects.

If a proposed slice cannot be explained in these terms, the product model or the
slice is not yet sufficiently understood.
