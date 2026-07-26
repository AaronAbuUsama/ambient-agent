# The Coworker — Definitive System Architecture

This is the canonical description of how the coworker agentic system works, written
from first principles as the definitive pattern — not as a change, a migration, or a
diff against any prior shape. It describes the architecture _as designed_.

Read it as the single source of truth for the **conceptual** system: what the agents
are, what the graph and the digest are, how state is owned, how work flows, and where
the system extends. For **code layout** (which package owns what) see
[`ARCHITECTURE.md`](./ARCHITECTURE.md); for **ratified vocabulary** see
[`CONTEXT.md`](../CONTEXT.md). The detailed proof path from external information through
knowledge, Attention, Work, and closure is in
[`INFORMATION-TO-ACCOUNTABILITY.md`](./INFORMATION-TO-ACCOUNTABILITY.md). Where this document
evolves a glossary term, §12 says so explicitly so the language stays cohesive.

> One reading rule: most of this architecture is already realized in code, some of it is
> designed and not yet built. The body describes the definitive system in the present
> tense because that is what it _is_ meant to be. **§13 is the honest map of where the
> implementation stands today and the distance left to close.** Nothing in the body is
> hidden behind "future"; the gap lives in one place.

---

## 1. First principles

Everything below follows from eight principles. If a design question isn't answered by
the sections that follow, answer it by returning to these.

1. **One coworker, many surfaces.** To the people using it, the system is _one_ colleague
   you talk to — with one identity, one memory, one point of view — no matter which chat,
   DM, or channel you reach it through. It is multi-agent under the hood; it is one agent
   in the felt experience. "The coworker" always means the _whole_ system, never any one
   part of it.

2. **Separate deciding from speaking.** The part that _thinks_ and the part that _talks_
   are different things. Thinking is global, deliberate, and slow. Talking is local,
   reactive, and fast. Fusing them produces either a bottleneck or a scatterbrain; keeping
   them apart is the central move of this architecture.

3. **A global mind; local mouths.** There is exactly one mind — the **Brain** — and many
   **Speakers**, each bound to one surface. The Brain owns what is true and what to do.
   A Speaker owns only how to converse in its own room.

4. **State is owned, not scattered.** Durable shared meaning is represented in one
   **Graph** — an append-only Attestation log plus a derived Belief Projection — under one
   authority, the Brain. Knowledge is never a pile of per-chat context that has to be
   reconciled later. There is one ontology and one authority over its interpretation.

5. **Knowledge-ready Attention flows up; decisions flow down.** External occurrences are
   retained as Happenings, projected into the Graph, and admitted as knowledge-ready
   Attention before the Brain judges them. Internal Intents and outcomes enter the same
   accountability loop through their own readiness contracts. The Brain decides, then
   pushes context, directives, and work _down_. This one loop is the routing story, the
   delegation story, and the control story at once.

6. **Non-blocking everywhere.** No part of the system waits on another part to make
   progress. A busy chat is fully _processed_ but not replied-to per message. Starting
   work never freezes a conversation. Slow reasoning never stalls fast reaction.

7. **Nothing real is ever dropped.** Every Happening has source evidence; every accepted,
   in-scope Happening has durable Attention; every claimed Attention Item receives
   an explicit disposition; and every transferred responsibility has a durable successor.
   Silence is a communication decision, never proof that responsibility disappeared.

8. **Knowledge is tentative by default.** Derived meaning is recorded honestly, not
   certainly. An unresolved fact is a low-confidence memory, not a blocked write — and a
   low-confidence memory is a question the coworker may later ask, whose answer raises the
   confidence. The graph self-heals; it is never a store of truth to be protected.

---

## 2. The system at a glance

```mermaid
graph TD
  subgraph world[The world]
    PPL[People in group chats & DMs]
    GH[GitHub]
    EXT[Other event sources<br/>email · calendars · monitors · …]
  end

  subgraph coworker[The Coworker — one agent, multi-agent under the hood]
    subgraph mouths[Local · fast · reactive]
      SP1[Speaker · group room]
      SP2[Speaker · DM]
      SPn[Speaker · …surface n]
    end

    subgraph information[Knowledge and accountability]
      ARCHIVE[(Source Archives<br/>immutable Happenings)]
      INGEST[Deterministic ingesters]
      SCRIBE[Scribe<br/>semantic projection]
      GRAPH[(The Graph<br/>Attestations + Belief Projection)]
      ATTN[(Attention Items<br/>pending · held · transferred · resolved)]
    end

    BRAIN{{The Brain<br/>the mind · the owner · the decider<br/>knowledge-ready inbox · two clocks}}

    subgraph mind[Global · slow · deliberate]
      WORK[(Work Items<br/>operational responsibility)]
    end

    subgraph backstage[Backstage team · distinct GitHub identities]
      CODER[Coder]
      REVIEWER[Reviewer]
      PLANNER[Planner]
    end
  end

  PPL <-->|talk| SP1 & SP2 & SPn
  SP1 & SP2 & SPn -->|conversation stream| ARCHIVE
  SP1 & SP2 & SPn -->|intents ↑| BRAIN
  GH -->|deliveries| ARCHIVE
  EXT -->|events| ARCHIVE

  ARCHIVE -->|explicit facts| INGEST
  ARCHIVE -->|ambiguous meaning| SCRIBE
  INGEST -->|anchored Attestations| GRAPH
  SCRIBE -->|appends low-confidence Attestations| GRAPH
  ARCHIVE -->|Happening evidence| ATTN
  GRAPH -->|minimum knowledge floor| ATTN
  ATTN -->|pending obligations ↑| BRAIN
  BRAIN <-->|appends rulings · reads Projection| GRAPH
  BRAIN -->|hold · transfer · resolve| ATTN
  BRAIN -->|owns lifecycle| WORK
  BRAIN -->|context · directives · which surface ↓| SP1 & SP2 & SPn
  BRAIN -->|dispatch bounded work| CODER & REVIEWER & PLANNER
  WORK -->|executed by| CODER & REVIEWER & PLANNER
  CODER & REVIEWER & PLANNER -->|PRs, reviews, issues| GH
  CODER & REVIEWER & PLANNER -->|results ↑| BRAIN
```

The rest of this document defines every box and every arrow.

---

## 3. The core abstractions

Each abstraction has exactly one job. The power of the system is in the _composition_,
so read these as a set, not a list.

### 3.1 The Coworker

The whole system. The product-level identity — the colleague a team talks to. It has one
name, one memory (the Graph), and one felt point of view. It is realized by all the parts
below working together. **No single part is "the coworker."** In particular, the Brain is
not the coworker — it is the coworker's mind.

### 3.2 The Brain (Master Agent)

The single global mind. There is exactly one, process-wide. It is **silent** in that it is
not bound to any surface and never has "its own chat" — but it is not passive: it speaks
_through_ surfaces it chooses, decides _what to do_, and owns all durable work and meaning.
Application stores hold the inbox, Graph, clocks, and work ledgers; the Brain is their domain
authority rather than their persistence mechanism. Its
responsibilities, each detailed later:

- **Owns the Graph** (§5): it is the single authority over the ontology. It appends
  confirm/overrule/merge rulings and reads the resulting Belief Projection; it never
  rewrites another author's Attestation.
- **Runs the control loop** (§4): its inbox receives knowledge-ready Attention, Intents,
  outcomes, and wakes; the Brain dispositions each accountable input and pushes down.
- **Runs on two clocks** (§6): reactive (events/intents) and proactive (its own cron
  floor + event wakes + self-scheduling). It can wake itself.
- **Owns all work** (§7): every issue, PR, job, and task is dispatched by the Brain, which
  therefore owns each work item's full lifecycle — including where its result returns and
  when a loop (e.g. a PR needing refinement) must be re-kicked.
- **Chooses the surface and the voice** (§8): whether to say something in a group room, as
  a DM, or across rooms — and which Speaker carries it.

The Brain is deliberately kept _out of every hot path_. It reasons and decides; it does
not sit between a person and a reply, nor between the ingestion clock and a graph write.

### 3.3 Speakers (surface mouths)

A Speaker is a **local, fast, reactive conversational agent bound to exactly one
surface.** Its entire job is to converse well in its own room. It is autonomous within
that room — it reacts to its own messages, on its own fast cadence, holding that
conversation's working context across turns — but it is deliberately _dumb about the
wider world_:

- It does **not** create issues, launch jobs, or write the ontology.
- It does **not** know or decide anything cross-surface.
- When conversation implies work or a cross-surface consequence, it **escalates an intent
  up to the Brain** (§7) rather than acting.

A Speaker holds only transient conversational state; all durable meaning it observes flows
up (to the Brain as intent, and to the Scribe as a fact stream). Speakers have autonomy of
_expression_; the Brain has authority over _substance_.

### 3.4 Surfaces

A **surface** is one place the coworker can listen and speak: a group chat, a direct
message with one person, and — by extension — any future channel (§11). Each surface has
stable application identity and exactly one continuing Speaker. Its provider chat address is
a replaceable **Surface Binding**, not the Surface's identity.

Discovery and authorization are separate. Provider sync may observe and archive any chat but
does not activate it. Operator-configured groups seed the registry. To prompt a Speaker, the
Brain selects either an existing Surface or a known Person. Trusted application code resolves a
Person target to an existing direct Surface or atomically materializes an ordinary direct
Surface as part of that same prompt admission; the model never supplies a raw chat address.
This is one routing operation, not a separate "open Surface" effect or DM lifecycle. Intake and
Say both revalidate an active binding and fail closed. Re-pairing the same provider account
preserves Surface/Speaker identity; replacing the account retires old bindings rather than
silently moving them.

### 3.5 The Scribe (global ingestion clock)

The Scribe is the coworker's **asynchronous semantic projector**: one application-owned
global clock that turns ambiguous cross-surface evidence into proposed Attestations. It
forms bounded Scribe Batches and runs bounded concurrent stateless extraction attempts.
Each attempt receives all required context and appends low-confidence claims with trusted
Evidence Sets. It never speaks, holds no external identity or private memory, and writes
_proposals_, not verdicts. Deterministic ingesters append facts explicit in structured
source records; the Brain owns authoritative rulings.

The Scribe is the busiest, most expensive knowledge worker in the system, which is exactly
why its clock is **global** and separate from the Brain. Live ingestion and Historical
Replay form globally ordered cross-surface batches, while bounded concurrency prevents one
slow extraction from becoming a throughput bottleneck. A routine Scribe projection updates
the Graph without automatically waking the Brain; Attention admission decides whether
judgement is owed.

### 3.6 The Graph (the owned ontology)

The Graph is the coworker's **single durable memory**: an append-only log of Attestations
and a deterministic Belief Projection folded from them. It is the derived-meaning layer
above the raw sources (the Conversation Archive locally, providers such as GitHub
remotely), never the source of truth. It holds what the coworker needs cheaply that those
sources cannot answer: **who is who across platforms, what connects to what, the social
facts no external system records, and the permanent evidence trail behind every belief.**
Detailed in §5.

### 3.7 Knowledge-ready Attention (the accountability ledger)

An **Attention Item** is a durable Brain obligation to disposition one or more Happenings
after their minimum knowledge floor exists. It references immutable source evidence plus
the Attestations or Projection version that established readiness; it does not copy the
Graph. Pending Attention is claimable through the Brain inbox. Held, transferred, and
resolved Attention remains durable as accountability history.

The Graph answers “what do we currently believe?” Attention answers “what occurrence are
we still responsible for judging?” A Brain Batch cannot settle until every claimed
Attention Item is held, transferred to a named durable successor, or explicitly resolved.
`stay_silent` settles speech only. Detailed in
[`INFORMATION-TO-ACCOUNTABILITY.md`](./INFORMATION-TO-ACCOUNTABILITY.md).

### 3.8 The Digest (context projection)

The Digest is **not a stored thing and no one deliberately pushes it by default** — it is a
live read-projection of the Graph, computed fresh for a Speaker turn from the identities in
view. It is the cheap, automatic way a Speaker gets relevant memory without asking. The
Brain, when it deliberately pushes, stores only a bounded selection of extra entity seeds;
trusted code recomputes and merges them through the same projector and `graphContext` pipe.
Detailed in §5.4 — the default pull and the Brain's push are one mechanism at two intensities,
not a cached second payload.

### 3.9 Specialists and Bounded Workflows (the backstage team)

Durable work runs in **Bounded Workflows** — finite, autonomous units of work with
validated input, their own run record, and a terminal result. A **Specialist** is the
narrowly-instructed agent inside one such workflow (the Coder, the Reviewer, the Planner).
Specialists are the coworker's **team**: they show up on GitHub as _distinct identities on
purpose_ — the coworker gets work done through a visible team — while the coworker as a
whole remains one felt identity to the people it talks to. A workflow does not pause for
conversation; its result, failures, and rare Milestones return _up to the Brain_.

### 3.10 The Coalescer (the timing layer, no model)

The Coalescer is pure timing with no intelligence. It answers one question — _when has
enough happened to act?_ — and it answers it in two places: for each Speaker (batch a
burst of chat into one Window; an @-mention fires immediately) and for the global Scribe
(batch the fact-stream on a laggy cadence with no immediate-fire). It never decides _what_
to do, only _when_ a batch is ready. Keeping timing modelless is what makes the system
non-blocking and cheap.

---

## 4. The control loop — knowledge-ready Attention up, decisions down

The heart of the system is a single accountability loop. External Happenings take an
ordered knowledge-first path before they enter it.

```mermaid
flowchart TB
  subgraph external["External information"]
    SRC["Source Archive<br/>immutable Happening"]
    FLOOR["Minimum knowledge floor<br/>deterministic facts + semantic projection when required"]
  ATTENTION["Knowledge-ready Attention Item"]
    SRC --> FLOOR --> ATTENTION
  end

  subgraph internal["Already meaningful internal inputs"]
    I1["Speaker Intent"]
    I2["Workflow or Directive Outcome"]
    I3["Scheduled Wake / Proactive Sweep"]
  end

  ATTENTION & I1 & I2 & I3 --> INBOX{{"Brain inbox<br/>coalesced · non-blocking"}}
  INBOX --> DECIDE["Brain judges<br/>reads live Graph + exact evidence"]

  DECIDE --> A1["Disposition each Attention Item<br/>hold · transfer · resolve"]
  DECIDE --> D1["Prompt a chosen Surface or known Person<br/>context + Directive"]
  DECIDE --> D2["Create Work and dispatch execution<br/>Coder / Reviewer / Planner"]
  DECIDE --> D3["Append an Attestation or ruling<br/>confirm · overrule · merge"]
  DECIDE --> D4["Schedule a future wake"]
  DECIDE --> D5["Stay silent<br/>communication only"]
```

**Why one accountability path.** A raw callback and the knowledge later derived from it
are not peer decisions. They are stages of one occurrence becoming judgeable. Source
archives retain what happened, deterministic ingesters and the Scribe establish the
  minimum knowledge floor, and Attention admission creates exactly one accountable
  obligation for every accepted, in-scope Happening. Intents, outcomes, and wakes already
  carry defined meaning and join at the
accountability boundary rather than pretending to be provider events.

**Why non-blocking.** The up-inbox is coalesced (§9) and the Brain reasons off every hot
path. A person waiting for a reply waits on their Speaker, not the Brain. A Speaker
escalating an intent does not block on the Brain's decision — dispatching work is
off the conversational hot path, so the extra hop costs nothing a person can feel.

**Why nothing drops.** Every accepted external occurrence has a Happening in its Source
Archive. Every accepted, in-scope Happening has an Attention Item. An occurrence that
correlates to no Surface still reaches accountable judgement after readiness; the Brain
may route it, create Work, hold it, or explicitly dismiss it. “Uncorrelated” is a decision,
never a silent discard.

**How one decision settles.** Trusted application code claims a bounded immutable set of
ready inbox inputs as one Brain Batch. New arrivals wait for another Batch; crash recovery
reuses the open Batch and exact membership. The Brain chooses consequences through separate
typed tools. Before settlement, every claimed Attention Item must be held, transferred to
a named durable successor, or explicitly resolved. `stay_silent` cannot provide that
coverage. Asynchronous Brain Effects are first recorded in an application-owned durable
outbox, then delivered at least once to the existing Speaker, provider, or workflow seam
with stable application identity. Final settlement validates Attention coverage and
successor existence, then atomically settles the Batch and exactly its claimed inputs; the
model never serves as the receipt ledger.

**How speech flows down.** The Brain sends an authoritative Directive to one selected
Surface's Speaker. It carries a bounded Brief whose important items link to immutable source
evidence. The Speaker must attempt the objective and owns wording and local expression. A
delivered message, known failure, ambiguous delivery, or a Speaker turn that settles without
Saying produces a durable Directive Outcome back to the Brain. Directive input is instruction,
not conversation evidence, so it never enters the Scribe stream.

The Brain selects a stable `surfaceId`, never a provider chat id or an originating chat return
address. Immediately before dispatch and Say, the application resolves and authorizes the
current Surface Binding. Each logical Say records a Surface Delivery before crossing the
provider boundary; provider acknowledgment plus its outbound Conversation Archive event proves
delivery, while an ambiguous result remains Uncertain and is never blindly retried.

---

## 5. State and knowledge — Source Archives, the Graph, the Scribe, the Digest

This is the part of the system most worth getting exactly right, because "global context"
lives here and it is easy to muddle. Source truth, derived belief, and accountable Attention
are distinct durable layers.

```mermaid
flowchart LR
  subgraph sources["Source truth"]
    CA["Conversation Archive"]
    GA["GitHub Event Archive"]
    OA["Other Source Archives"]
  end

  CA & GA & OA -->|explicit structured facts| DET["Deterministic ingesters"]
  CA & GA & OA -->|ambiguous meaning| SCRIBE["Scribe · semantic projection"]
  DET -->|APPEND: anchored claims + Evidence Sets| LOG[(Attestation log<br/>append-only)]
  SCRIBE -->|APPEND: low-confidence claims + Evidence Sets| LOG[(Attestation log<br/>append-only)]
  BRAIN{{The Brain}} -->|APPEND: confirm · overrule · merge| LOG
  LOG -->|deterministic fold| BELIEF[(Belief Projection<br/>entities · relations · identities)]

  CA & GA & OA -->|Happening evidence| READY["Attention admission<br/>minimum knowledge floor"]
  BELIEF -->|readiness facts| READY
  READY --> ATTENTION[(Attention Items)]
  ATTENTION -->|pending obligations| BRAIN
  BELIEF -->|READ: mechanical one-hop projection| DIG[Digest]
  DIG -->|rides on the input as graphContext| SPEAKERS["Speakers"]

  BRAIN -->|READ + JUDGE| BELIEF
  BRAIN -->|deliberate PUSH: bounded extra entity seeds| SPEAKERS
```

### 5.1 What the Graph holds

The Graph has two parts in one application-owned durable store beside the provider-specific
Source Archives:

- **Attestation log** — immutable claims of the form
  `{author, claim, confidence, evidenceSet, timestamp}`. The author is the Scribe, a
  deterministic ingester, or the Brain. Correction and disagreement append another
  Attestation; no claim or provenance is updated or deleted.
- **Belief Projection** — the current typed ontology of entities, relations, and
  cross-platform identities, deterministically folded from the log. It is the only ordinary
  Graph read surface and can be rebuilt from Attestations.

The projection contains:

- **Entities** — typed nodes: Person, Agent, Thread, Topic, Commitment, Repository, Issue,
  PullRequest, Project, Milestone, Goal, with the properties and derived confidence currently
  supported by their Attestations.
- **Relations** — typed directed edges (`discusses`, `works_on`, `made_by`, `blocks`,
  `resolves`, `part_of`, `advances`, …). Every relation exists to power a named read; facts a
  raw source already serves fresh are not duplicated as Graph truth.
- **Cross-platform identity** — one real actor is one node, however many platform handles
  it has. Claims and Brain merge rulings cause a WhatsApp sender and a GitHub login to
  converge on one projected entity. _That convergence is the cross-thread memory._

### 5.2 Confidence — knowledge is tentative by design

Every Attestation carries its author's 0–1 confidence in that one claim. The Belief
Projection derives current confidence from independent supporting Evidence Sets; retrying or
re-reading the same evidence does not amplify belief. Brain rulings are authoritative inputs
to the fold without erasing the observations they confirm or overrule.

Low confidence is not a defect — it is a _question the coworker may raise_. A later answer
adds new evidence and another Attestation. This keeps ingestion honest and fast: the Scribe
never blocks on ambiguity, and the full reasoning trail remains inspectable.

### 5.3 Provenance — every fact knows where it came from

Every Attestation carries a non-empty Evidence Set of immutable raw-source references: which
surface and message, which external delivery, or which provider record. Trusted application
code resolves those references; the model does not invent them. Because the log is
append-only, provenance is permanent rather than overwritten by a later observation.

Provenance is first-class because the Brain reasons _across sources_. It must know whether a
belief came from a group, a DM, a webhook, or another provider both to weigh it and to decide
where a consequence belongs. As the system gains sources (§11), Evidence Sets keep one Graph
coherent across all of them.

### 5.4 The Digest — pull by default, push by decision

The Digest is a **read-projection of the Graph, filtered to what a turn needs**. It exists
at two intensities that share one pipe:

- **Mechanical pull (the default).** On every Speaker turn, deterministic code — _no model,
  no cache_ — seeds from the identities already in view, walks one hop out of the Graph,
  and staples the result onto the Speaker's input. Recomputed live every turn, so a fact
  another surface's ingestion wrote seconds ago is visible now. This is the cheap,
  automatic "relevant memory, for free" that keeps Speakers dumb but not ignorant. Nobody
  decides to send it; it is a live query.
- **Deliberate push (when the Brain acts).** When the Brain routes an event, relays
  cross-surface information, or nudges an open loop, it selects a small bounded set of extra
  entity ids with the Directive. At delivery, trusted code recomputes the normal pull and
  those extra seeds from one Belief Projection version, unions them by stable entity/relation
  identity, and attaches the result through the **same `graphContext` channel**. The model
  never authors Graph rows, confidence, provenance, traversal depth, or a serialized Digest.

The target `graphContext` records its schema version, Projection high-water mark, generation
time, pull/push seed selection, supporting Attestation ids, and any deterministic truncation.
Push uses the existing one-hop walk and named secondary roll-ups; arbitrary depth is not an
escape hatch. The durable Directive stores only seed selection. The computed Digest remains
ephemeral and is recomputed after restart, so it cannot become a stale cache.

Understanding this collapses the earlier confusion: "the digest" and "the Brain pushing
context" are not two systems. They are one context-injection mechanism, one seeded by a fixed
rule and one extended by a decision. The Directive's Brief remains separate: it preserves the
causal source evidence for _this decision_, while Digest is current ambient ontology and may
legitimately change before delivery.

### 5.5 Who appends vs who rules — single _authority_, multiple authors

The Scribe, deterministic ingesters, and Brain are all Attestation authors, but only the Brain
authors rulings:

- A **Scribe attempt appends proposals** off the Brain's clock: low-confidence claims backed
  by trusted Evidence Sets. Concurrent attempts do not coordinate or learn from one another.
  A routine durable delta updates the Graph without automatically waking the Brain.
- A **deterministic ingester appends anchored claims** from provider records when no model
  judgment is required. These claims commonly establish a structured Happening's minimum
  knowledge floor.
- The **Brain appends rulings** — confirm, overrule, merge — while integrating deltas on its
  own clock when authoritative judgement is actually owed. A ruling changes the Belief
  Projection, never another author's history.

The distinction that matters is authority, not sole write access. Making the Brain extract
every proposal would put it in the ingestion hot path. Allowing proposals to overwrite current
state would destroy provenance. Append-only authorship plus one ruling authority avoids both.
Attention admission—not every Graph write—connects knowledge formation to accountable
judgement.

---

## 6. The two clocks — reactive and proactive

A Speaker has one clock: it reacts to its room. The Brain has two, and the second is what
makes the coworker _self-driving_ rather than merely responsive.

```mermaid
flowchart TB
  subgraph reactive[Reactive clock · fast-ish]
    R1[Event arrives] --> R2[Coalesce into up-inbox] --> R3[Brain decides]
  end
  subgraph proactive[Proactive clock · slow · self-driven]
    direction TB
    P0[Cron or boot<br/>runs the durable due scan] --> PI[Brain up-inbox]
    P1[Ordinary durable event/result] --> PI
    P2[Due Scheduled Wake] --> PI
    PI --> P3[Read the Belief Projection + accountability ledgers<br/>find open loops] --> P4[Decide to act unprompted]
  end
```

- **Cron floor.** Deployment cron and boot run the same application-owned sweep. It admits
  one coalesced Proactive Sweep when none is outstanding and admits every due Scheduled Wake;
  it never calls the Brain directly. The floor guarantees liveness if event wiring misses
  something.
- **Event wakes.** Knowledge-ready Attention and workflow outcomes wake the Brain by
  entering its inbox. Routine Graph writes do not. `overdue` and Open Loops are derived read
  signals the Brain observes across the Belief Projection, Attention, and Work ledgers during
  a normal decision or Proactive Sweep.
- **Self-scheduling.** The Brain may create an independently durable Scheduled Wake ("check
  this loop in two hours"). A process timer is only a liveness hint; the application database
  is the source of truth, and boot reconciliation preserves the wake across a crash.

The proactive clock is where the coworker's _initiative_ lives: chasing an overdue
Commitment, reconsidering held Attention, following unfinished Work, or noticing that two
Surfaces need to be connected. A Scheduled Wake prompts reconsideration; it does not own or
close the Open Loop. The clock runs at a deliberately slower cadence than any Speaker —
reasoning is not conversation.

---

## 7. Work — everything routes through the Brain

The coworker's _doing_ (as opposed to its _talking_) is centralized in the Brain. A Speaker
never launches work; it escalates Intent. The Brain owns every Work Item end to end.

```mermaid
sequenceDiagram
  participant P as Person (in a surface)
  participant SP as Speaker (mouth)
  participant BR as Brain (mind + owner)
  participant WF as Bounded Workflow (Specialist)
  participant GH as GitHub

  P->>SP: "we should fix the login bug"
  SP-->>BR: escalate INTENT (not an action)
  Note over BR: creates Work Item W7<br/>objective + evidence + observable outcome
  BR->>WF: dispatch one execution attempt for W7
  WF->>GH: open PR (as the Coder identity)
  WF-->>BR: result ↑ (Durably Terminal) or Milestone
  Note over BR: updates W7; owns the whole lifecycle & return address
  BR->>SP: push result down into the right surface
  GH-->>BR: review "changes requested" (webhook ↑)
  Note over BR: knowledge-ready Attention — Brain keeps W7 open
  BR->>WF: dispatch a follow-up attempt for W7
```

**Why centralize.** Three things fall out of routing all work through the Brain, and the
third is the decisive one:

1. **Speakers stay dumb.** Removing issue-creation and job-launching from the mouth is what
   makes "the Speaker only converses" true rather than aspirational.
2. **The Brain owns the context that goes into work.** It assembles a job's context from
   the Graph it owns — the mouth never had the whole picture anyway.
3. **The Brain owns every loop.** A PR that comes back needing refinement must be re-kicked
   _somehow_. Because the result returns up to the same inbox that launched it, the Brain —
   the one place with provenance, return routing, and the full ontology — owns the entire
   PR/issue/job lifecycle, including re-dispatch. Control of a loop lives where the whole
   picture lives.

**Cost of centralizing** (paid honestly): the Speaker needs one seam — _escalate an intent
without acting_ — inverting a direct tool call into an upward signal. The latency of the
extra hop is irrelevant: launching work is off the conversational hot path and the work
itself takes minutes. Everything else (the Brain being the owner, tracking return
addresses) is already inherent to the Brain's role.

**Responsibility is not execution.** A Work Item is the stable operational objective and
evidence trail. A Brain Effect, Bounded Workflow run, or provider artifact is one mechanism
or attempt beneath it. A Work Item may exist before dispatch, require no Specialist, or span
several refinement attempts. It closes only from an observable outcome. Graph Commitments
remain social beliefs; they never substitute for operational state.

**No-drop under failure.** A launched job that dies without delivering is reconciled: on
boot, any unsettled launch becomes an explicit "interrupted" result the Brain surfaces —
so a crash mid-job is told, never silently lost. This is the same "nothing real is ever
dropped" guarantee (principle 7) applied to work.

---

## 8. Communication and identity — one face, a visible team

Two identity facts hold simultaneously, and the architecture is built to keep both true:

- **To the people it talks to, the coworker is one identity.** One name, one memory, one
  point of view, across every surface. A DM with it and a group room with it are the same
  colleague. This is delivered by the single Brain + single Graph behind all the mouths —
  the Speakers are voices, not separate selves.
- **On GitHub, the team is deliberately distinct.** The Coder, Reviewer, and Planner act
  under their own identities on purpose — the coworker "gets work done through its team,"
  and that team is visible. The backstage multiplicity and the front-of-house singularity
  are not in conflict; they are two views of one system.

The Brain chooses **surface and voice** as part of every decision (§4, D1): say it in the
group room, continue a DM with a specific person, or carry information across rooms. Because a
surface is just a place with a Speaker, "DM someone" and "reply in the group" share one prompt
operation. The target is either an existing stable Surface or a known Person whom trusted code
resolves to the same ordinary Surface registry during prompt admission. Configured groups remain
operator-authorized. Discovery alone never grants participation, and a source Surface is
provenance rather than a forced return address.

Note that no infrastructural role _is_ the identity. Owning a webhook secret, or filing
issues under a particular app, are jobs done by parts of the team; they are not the
coworker's face. The felt identity is the whole coworker, spoken through whichever surface
the Brain chose — never any single backstage app.

---

## 9. How non-blocking is achieved

Principle 6 is load-bearing and worth making concrete. Non-blocking is achieved by three
independent mechanisms, each modelless where it can be:

- **Coalescing** absorbs bursts into batches, so volume never turns into a per-message
  storm — for both Speakers (Windows) and the Scribe (the global fact-stream). Timing
  carries no model, so it is instant and cheap.
- **Off-hot-path reasoning.** The Brain sits on no hot path. A person waits on a Speaker; a
  Speaker escalates without blocking; ingestion writes without waiting on the Brain; the
  Brain reasons on its own clock.
- **Asynchronous work with durable return.** Bounded work is dispatched and forgotten; its
  result returns up to the inbox when Durably Terminal. Nothing waits synchronously on a
  job, and nothing is lost if one dies.

---

## 10. Invariants — what must always hold

These are the properties any change must preserve. They are the first principles restated
as testable guarantees.

| Invariant                  | What it means                                                         | How the architecture secures it                                                 |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **One identity**           | The coworker feels like one colleague across all surfaces             | Single Brain + single Graph behind all Speakers (§8)                            |
| **Single authority**       | Exactly one owner of durable meaning                                  | Brain alone authors rulings; other authors append evidence-backed claims (§5.5) |
| **Non-blocking**           | No part waits on another to progress                                  | Coalescing + off-hot-path Brain + async work (§9)                               |
| **Occurrence-complete**    | Every accepted external occurrence retains stable evidence            | Source Archive + immutable Happening identity (§4, §5)                          |
| **Knowledge-ready**        | The Brain judges prepared evidence, not raw provider callbacks         | Deterministic/Scribe projection before Attention admission (§4, §5)             |
| **Accountability-complete** | Every claimed obligation has one durable disposition                  | Per-Attention coverage; named successor on transfer (§3.7, §4)                  |
| **No silent drop**         | Every Happening, Intent, result, and Open Loop has a durable home      | Source evidence + Attention + Work recovery (§4, §7)                            |
| **Provenance-complete**    | Every derived fact knows its origin                                   | Every Attestation has a permanent non-empty Evidence Set (§5.3)                 |
| **Self-healing knowledge** | Ambiguity never blocks; the graph corrects itself                     | Append-only claims + derived confidence + Brain rulings (§5.2, §5.5)            |
| **Speech is orthogonal**   | Speaking or staying silent cannot discharge unrelated responsibility | Attention disposition is checked separately from Effects (§4)                  |
| **Dumb mouths**            | Speakers converse only; they never act or own state                   | Work + ontology authority live in the Brain (§3.3, §7)                          |
| **Fail-closed surfaces**   | Observation never silently grants participation                       | Active account-scoped binding is revalidated at intake and Say (§3.4, §8)       |
| **Honest delivery**        | Provider acknowledgment, known failure, and ambiguity remain distinct | Surface Delivery + Conversation Archive evidence + Uncertain (§4)               |

---

## 11. Extension points — how the system grows without changing shape

The architecture is designed so that growth is _additive_. New capability slots into an
existing seam; it does not reshape the core. The canonical growth axes:

- **New surface types** (email, Slack, SMS, a web dashboard). A surface is "a place with a
  Speaker." A new channel is a new Speaker type bound to a new surface kind, registered in
  the surface registry. The Brain, Graph, and control loop are untouched — the Brain gains
  a new place it _can_ choose to speak.
- **New event sources** (monitors, calendars, CI, external webhooks). A new source adds a
  provider-specific Source Archive adapter, Happening identity, deterministic facts,
  optional semantic projection, and a minimum knowledge-readiness policy. It then reuses
  the same Attention, Brain disposition, and Work lifecycle (§4 and
  [`INFORMATION-TO-ACCOUNTABILITY.md`](./INFORMATION-TO-ACCOUNTABILITY.md)). It does not add
  a direct arrow from raw callbacks to the Brain.
- **New backstage agents / capabilities** (a Designer, a Researcher, a Deployer). A new
  kind of durable work is a new Bounded Workflow with its own Specialist and GitHub
  identity, dispatched by the Brain like any other. The team grows; the front stays one
  face (§8).
- **New ontology** (entity/relation types). The Graph is typed but the type set is a
  boundary concern, not a structural one — new entity and relation types extend the
  ontology the Scribe proposes and the Brain curates, without changing how any of them
  flow.
- **Multiple projects per surface, or multiple surfaces per project.** Because work routes
  through the Brain and the Graph relates surfaces to repositories/projects explicitly, the
  mapping of "which surface cares about which project" is data in the Graph, not
  hard-wired configuration — the Brain resolves it per decision.

If a proposed extension seems to require reshaping the core loop, that is a signal the
extension is fighting the architecture — re-derive it from §1 first.

---

## 12. Language — how this evolves the ratified glossary

This document reuses [`CONTEXT.md`](../CONTEXT.md) vocabulary verbatim wherever it can
(the Graph, Entity, Relation, Confidence, Provenance, Commitment, Cross-platform identity,
Managed Chat, Surface Inbox, Window, Coalescer, Capability, Skill, Tool, Surface-bound Tool,
Bounded Workflow, Specialist,
Admission, Operation Identity, Durably Terminal, Milestone). It introduces or sharpens a
few terms, which should be ratified back into `CONTEXT.md`:

- **The Coworker** — the whole system as one felt identity. Supersedes any usage that
  treated a single per-chat instance as "the agent." The coworker is the _whole_, never a
  part.
- **The Brain (Master Agent)** — the single global mind, owner, and decider. New;
  the anchor of this architecture.
- **Speaker** — the surface-bound conversational mouth. Sharpens the older per–Managed-Chat
  instance ("Ambience"): it is now explicitly _a mouth, not the whole_, and explicitly
  _dumb_ (converses only; escalates intent; never acts or owns state).
- **Surface / Surface Binding / Surface Delivery** — stable application identity for one
  authorized place with a Speaker; its account-scoped provider address; and durable evidence
  for one logical Say. Discovery is observation, never authorization.
- **Source Archive / Happening** — the provider-specific durable source record and the
  source-neutral identity of one occurrence backed by it. Receipt proves occurrence, not
  knowledge, responsibility, or completion.
- **Deterministic ingester / Scribe** — explicit structured facts are projected by trusted
  code; ambiguous meaning is projected by one global semantic clock driving bounded
  concurrent stateless attempts. Both append evidence-backed claims. Neither owns
  operational responsibility.
- **Attestation / Evidence Set / Belief Projection** — the Graph's persistence and read
  vocabulary. Claims are append-only; current understanding is a rebuildable projection.
- **Attention Item / Open Loop** — a durable knowledge-ready Brain obligation and the
  derived view of unresolved Attention, Work, and Commitments. Pending is claimable queue
  state; held, transferred, and resolved Attention remains accountability history.
- **Work Item** — the Brain's durable operational responsibility across zero, one, or many
  Effects and Bounded Workflow attempts. It is not a Graph belief or execution run.
- **Digest** — one versioned read-projection over one `graphContext` channel. Mechanical pull
  supplies local seeds; deliberate push supplies bounded extra seeds and is recomputed live.
- **Intent escalation** — a Speaker signalling the Brain that conversation implies work or
  a cross-surface consequence, without acting on it.
- **Brain Batch / Brain Effect** — the durable decision boundary and one typed consequence
  leaving it through application-owned admission, distinct from a model turn or Flue id.
  Batch settlement proves per-Attention disposition coverage, not merely that one Effect
  exists.
- **Scheduled Wake / Proactive Sweep** — durable exact reconsideration and the coalesced
  liveness floor; neither is a process timer or a second queue.

---

## 13. Where we are today, and the distance to close

The architecture above is definitive. This section is the honest map of the current
implementation against it — kept in one place so the body can describe the system as it is
meant to be. "Distance" is descriptive, not a plan.

| Abstraction | Definitive architecture | Where the code is today | Distance |
| --- | --- | --- | --- |
| **Source truth / Happenings** | Every accepted external occurrence has immutable provider evidence and one stable Happening identity | The Conversation Archive is an append-only WhatsApp source record. GitHub ingress durably records delivery/event identity before Brain admission. These are provider-specific foundations; there is no source-neutral Happening contract or shared readiness frontier yet | **Define the common Happening/evidence seam without replacing provider archives** |
| **Graph** | Append-only Attestation log + derived Belief Projection | Built in `packages/engine/src/graph/store.ts`: immutable author-attributed Attestations, non-empty Evidence Sets, deterministic projection, deduplication, confidence handling, and evidence-bounded Brain rulings. Speaker and Specialist Graph tools are read-only | **None for the accepted persistence and ruling floor** |
| **Deterministic ingestion** | Explicit structured source facts become anchored Attestations before Attention admission | Deterministic configuration seeding exists, and provider adapters already normalize some records, but GitHub and future structured Happenings do not pass through one declared fact/readiness contract | **Add source-specific deterministic projectors and readiness policies** |
| **Scribe** | One global asynchronous semantic projector; routine proposals update Graph without mandatory Brain judgement | The durable global inbox, chronological cross-Surface batching, bounded stateless attempts, retry/replay, and evidence-backed Attestations exist in `packages/engine/src/scribe/*`. Today every successful proposal delta is also admitted to the Brain, and Historical Replay waits for the owning Brain Batch to settle | **Decouple routine projection from Brain wake and gate only decision-worthy semantic results into Attention** |
| **Attention** | Durable knowledge-ready obligation with pending, held, transferred, and resolved history | Not built. Current source input rows provide pending queue membership and immutable Brain Batch claim membership, but there is no per-input disposition record. Batch settlement proves that some Effect or Specialist launch completed, not that every claimed input was covered; `stay_silent` qualifies | **Add the thin per-input Attention overlay and settlement coverage invariant** |
| **Digest** | Versioned live Graph projection; local pull + bounded Brain-selected seeds over one channel | `graph/digest.ts` computes the bounded no-cache projection used by Speakers, Specialists, and fresh Scribe attempts. Directive seed composition is implemented on the reset line described by `STATUS.md` | **No information-to-accountability change required** |
| **Speaker** | Dumb Surface mouth: converse, escalate Intent, execute Directive speech | Built: local conversation/participation, Intent escalation, Directive-only Saying, and read-only Graph access. Direct work launch and ontology authority are absent | **None for this boundary** |
| **Brain** | Judge knowledge-ready inputs, rule on belief, disposition Attention, own Work, choose speech | The global actor and crash-stable Brain Batch exist. It currently claims mixed Intents, Knowledge Deltas, Specialist Results, raw GitHub events, and wakes; its tools include broad proposal operations alongside rulings. A separate runtime wedge tracked by #400 may also prevent progress even when durable input is pending | **Narrow ordinary Graph mutation to rulings; replace raw/delta peer inputs with Attention; repair #400 independently** |
| **Control loop** | Source truth → knowledge floor → Attention → Brain disposition → Work/Effects → outcome | Intent, Effect, Directive, Scheduled Wake, GitHub ingress, and workflow-result paths are durable. External information currently bypasses the accepted knowledge-first ordering: raw GitHub events and later Scribe deltas are peer Brain inputs | **Rewire admission around one knowledge-ready accountability path** |
| **Two clocks** | Reactive Attention/outcome clock + proactive scan of Graph, Attention, and Work Open Loops | Scheduled Wakes and coalesced Proactive Sweeps enter the existing Brain inbox durably. The proactive prompt currently inspects Graph Commitments; application-owned Attention and generic Work are not yet available to it | **Extend the Open Loop read once Attention and Work exist** |
| **Work / delegation** | Stable Brain Work Item owns an operational objective across effects and zero, one, or many execution attempts | `brain_specialist_launches` and result rows durably own one Specialist execution attempt, recovery, and return. Brain Effects durably own typed consequences. There is no generic Work responsibility identity above those mechanisms | **Add a thin Work Item ledger and link existing execution owners; do not rebuild them** |
| **Surfaces / delivery** | Stable Surface registry, active binding, Directive, and durable delivery outcome | Configured Surfaces, known-Person DM resolution, delivery attempt, provider/archive evidence, and delivered/failed/Uncertain outcomes exist | **Admit relevant Directive Outcomes back into accountability when follow-up judgement is owed** |
| **Specialists / Bounded Workflows** | Distinct backstage identities; finite runs; outcomes return to Brain-owned Work | Coder, Reviewer, and Planner workflows and durable terminal/interrupted return exist | **Link runs to Work Items; no new workflow abstraction** |
| **Coalescer** | Modelless timing for Speakers and semantic projection | Speaker Windows and the Scribe's global quiet-period/cap timing exist | **None for this boundary** |

**Reading the distance.** The durability primitives are real, but the accepted
information-to-accountability architecture is not yet implemented end to end. The reset line
has strong Source Archive, Graph, Scribe, Brain Batch, Effect, wake, delivery, and Specialist
execution foundations. The remaining correction is to order them around knowledge-ready
Attention, prove per-input disposition coverage, and add a thin Work responsibility ledger.
Until that happens, mechanically settled Brain Batches are not proof that every Happening was
processed accountably.
