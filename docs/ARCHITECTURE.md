# Architecture map

> This is the **code taxonomy** — which package owns what. For the definitive
> description of how the agentic system _works_ (the Brain, Speakers, the Graph, the
> Digest, the control loop), see [`SYSTEM-ARCHITECTURE.md`](./SYSTEM-ARCHITECTURE.md).
> For the detailed path from Source Archives through knowledge-ready Attention and Work,
> see [`INFORMATION-TO-ACCOUNTABILITY.md`](./INFORMATION-TO-ACCOUNTABILITY.md).

The ratified taxonomy (#117 → #131, extended by #372): three packages, three apps, one arrow
diagram — enforced, not aspirational (`tests/speaker/hard-cut.test.ts`).

```mermaid
graph TD
  subgraph apps
    CLI["apps/cli<br/>operate the installation"]
    SRV["apps/runtime<br/>Flue build root — hosts Speaker"]
    WEB["apps/web<br/>the operator console —<br/>reaches the runtime over HTTP,<br/>imports nothing internal"]
  end
  subgraph packages
    AG["agents<br/>everything that thinks:<br/>agents own identity,<br/>capabilities are shared"]
    INST["installation<br/>on-disk state + lifecycle<br/>of one running install"]
    ENG["engine<br/>agent-agnostic conversation<br/>machinery — imports nothing internal"]
  end
  TS["test-support<br/>fakes + eval battery<br/>(may import anything)"]
  WEB -.->|"HTTP: /api/ on the control plane"| CLI
  CLI --> INST
  CLI --> ENG
  SRV --> AG
  SRV --> INST
  SRV --> ENG
  AG --> ENG
  INST --> AG
  INST --> ENG
```

**Rules** (verbatim from the hard-cut test): engine → nothing internal; agents → engine;
installation → agents+engine; apps/runtime → all packages; apps/cli → installation+engine
(**never** agents); **apps/web → nothing internal**; test-support → anything. Additionally:
capabilities may never import from an agent folder, and no package may publish a `./*` wildcard
export.

`apps/web` is the strictest row on the list, tied with `engine`. The console is a browser
application: it reaches the runtime only over HTTP, through the control-plane API defined in
`apps/cli/src/control-plane.ts`, so it has no reason to import an internal package and no way to
use one. A future need for a shared type is a reason to re-open that row deliberately, not a
reason to have left it off. Its built assets ship inside the published package (`dist/web`), and
the control plane serves them — the shell unauthenticated, everything under `/api/` gated (#372).

## How information becomes work

The accepted conceptual path is:

```text
Source Archive / Happening
  → deterministic facts and Scribe semantic projection
  → Graph knowledge floor
  → durable Attention Item
  → Brain disposition
  → durable Work Item or direct Effect
  → observable outcome
```

Durable machinery belongs in `engine`; agent identity and judgement policy belong in
`agents`; `apps/runtime` composes provider adapters and the Flue host. The current code has
most of those durable primitives but does not yet connect them in that order. The sequence
below is the **current implementation**, not the accepted target:

```mermaid
sequenceDiagram
  participant WA as WhatsApp (whatsappd)
  participant ENG as engine (Coalescer + intake)
  participant SP as agents (Speaker)
  participant SC as agents (global Scribe clock)
  participant BR as agents (global Brain)
  participant FLUE as Flue runtime
  participant DB as engine (Brain + Surface stores)

  WA->>ENG: ConversationEvent → Conversation Archive (append-only)
  ENG->>ENG: Coalescer: one fiber per chatId,<br/>throttle + settle window → Window
  ENG->>DB: admit live or Historical Replay observations<br/>to one durable evidence-keyed Scribe inbox
  DB-->>SC: claim one bounded chronological<br/>cross-Surface Scribe Batch wave
  SC->>FLUE: bounded stateless attempt<br/>stable batchId + fresh attempt id + current Projection
  SC->>DB: append immutable Evidence Set Attestations<br/>refresh derived Belief Projection
  SC->>DB: admit the durable proposal delta<br/>directly to the Brain up-inbox
  ENG->>SP: WindowDispatcher port → admitWindow (admission, retry, at-least-once)
  SP->>DB: escalate_intent (immutable evidence-backed admission)
  DB->>FLUE: wake one Brain Batch on instance global
  FLUE->>BR: runs the continuing Brain
  BR->>DB: prompt one Surface or record deliberate silence
  BR->>DB: reserve stable Brain work identity
  DB->>FLUE: admit existing bounded Workflow
  FLUE-->>DB: terminal result → durable Brain input
  DB->>FLUE: wake result Batch for Brain reconciliation
  DB->>FLUE: dispatch Directive to the Surface's active Speaker binding
  FLUE->>SP: runs the continuing local Speaker
  SP->>DB: say_directive claims Surface Delivery before transport
  SP->>WA: provider send through whatsapp-participation port
  WA->>ENG: outbound Conversation Archive event
  SP->>DB: durable delivered / failed / Uncertain Outcome
  FLUE-->>SP: lifecycle observations (dispatchId only)<br/>→ Window or Directive correlation
```

The Speaker mounts conversation, Intent escalation, Directive Saying, a work-status pull tool
(`lookup_work`), and read-only Graph tools only. The Brain owns Coder launch, stable work identity,
Flue admission reconciliation, terminal-result admission, the independent choice of reporting
Surface, GitHub events (admitted to the same up-inbox and routed by Brain decision, never
broadcast), and the proactive clock (Scheduled Wake + coalesced Proactive Sweep). The diagram above
is mechanically real, but two arrows are now known architecture gaps: raw GitHub events and
Scribe proposal deltas enter as peer Brain inputs. The accepted target retains each external
Happening, establishes its source-specific knowledge floor, and admits exactly one durable
Attention Item. Brain Batch settlement must then prove a disposition for every claimed
Attention Item. A thin Brain Work Item will sit above existing Effect and Specialist execution
ledgers; those mechanisms are reused, not replaced.

A source-specific readiness policy must also bound semantic projection failure. Exhausting that
finite retry/age budget produces prepared failure evidence and admits the same Happening's
Attention Item; it never leaves the occurrence indefinitely outside the accountability ledger.

## Where things live — quick answers

- **"Any agent needs this"** → `packages/engine`. Precedent: operation-store and input
  contracts moved down in #131.
- **"Durable source, Attention, Batch, Effect, or Work state"** → `packages/engine`.
- **"Source-specific normalization and knowledge-readiness mechanics"** →
  `packages/engine`; model judgement does not belong in the adapter.
- **"A kind of work an agent can do"** → `packages/agents/src/capabilities/<name>/`
  (SKILL.md + tools + port). Shared across agents.
- **"Who an agent is"** → `packages/agents/src/<agent>/` (instructions, composition,
  dispatch). Scribe semantic projection and Brain disposition policy live here.
- **"On-disk state of an install"** → `packages/installation`.
- **Deployables** → `apps/` (cli = operate, server = host). Both are bundled; internal
  packages are compiled in, the server's `package.json` dependency list is the flue-build
  externals manifest.

## Domain vocabulary

`CONTEXT.md` at the repo root is the ratified glossary (Capability, Skill, Window,
Managed Chat, Operation Identity, Uncertain, …). Name things from it; propose additions
there first. For the conceptual system (Brain, Speakers, Graph, Digest, control loop) see
[`SYSTEM-ARCHITECTURE.md`](./SYSTEM-ARCHITECTURE.md).

## Per-package docs

Each workspace has a README: [engine](../packages/engine/README.md) ·
[agents](../packages/agents/README.md) ·
[installation](../packages/installation/README.md) ·
[test-support](../packages/test-support/README.md) ·
[cli](../apps/cli/README.md) · [server](../apps/runtime/README.md)
