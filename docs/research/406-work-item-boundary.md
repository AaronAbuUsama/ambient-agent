# Decision #406 research: the minimal Work Item boundary

## Finding

The code already has a durable **Specialist execution ledger**, despite naming its
projection `ActiveWorkItem`. It does not have a general **Brain responsibility ledger**.
Those are different lifecycles:

```text
Work Item (why the coworker owes an outcome)
  ├─ Brain Effect(s) (typed consequences/outbox deliveries)
  ├─ Specialist launch → milestones → result (one bounded execution)
  ├─ GitHub issue/PR (external work artifact/source truth)
  └─ Scheduled Wake (future reconsideration)
```

A Work Item must survive zero, one, or several execution mechanisms. Therefore the
existing Specialist launch must remain a child execution record rather than becoming the
identity of the responsibility.

## What exists, and why it is not the generic boundary

| Existing state | What it already proves | Why it is not a generic task/to-do |
|---|---|---|
| `brain_specialist_launches` + result + milestones | A provenance-bound Specialist request was durably reserved, accepted into one Flue run, streamed progress, and returned `ok` or `interrupted`. Pending admission and missing terminal results are recoverable. [`packages/engine/src/brain/inbox.ts:34-80`](../../packages/engine/src/brain/inbox.ts#L34), [`packages/engine/src/brain/inbox.ts:638-667`](../../packages/engine/src/brain/inbox.ts#L638), [`packages/agents/src/capabilities/delegation/bridge.ts:27-46`](../../packages/agents/src/capabilities/delegation/bridge.ts#L27) | It requires a Specialist, source Surface and run-shaped input; its only launch states are `pending/accepted`, and terminal state is inferred from one result. One responsibility can span several launches or no workflow at all. `activeWorkItems()` is exactly “accepted launch with no result,” not all open work. [`packages/engine/src/brain/inbox.ts:382-403`](../../packages/engine/src/brain/inbox.ts#L382), [`packages/engine/src/brain/inbox.ts:1379-1389`](../../packages/engine/src/brain/inbox.ts#L1379) |
| Brain Effect | One Brain-chosen consequence is durably recorded before asynchronous delivery; typed downstream code owns execution. [`CONTEXT.md:74-79`](../../CONTEXT.md#L74), [`packages/engine/src/brain/inbox.ts:265-270`](../../packages/engine/src/brain/inbox.ts#L265) | An Effect is an outbox/correlation record, not responsibility. A Work Item can require several Effects, and `stay_silent` or `schedule_wake` can complete while the underlying work remains open. Batch settlement counts accepted Effects/launches, not outcome closure. [`packages/engine/src/brain/inbox.ts:1028-1038`](../../packages/engine/src/brain/inbox.ts#L1028), [`packages/engine/src/brain/inbox.ts:1598-1622`](../../packages/engine/src/brain/inbox.ts#L1598) |
| Scheduled Wake | A crash-safe future reconsideration, idempotently owned by the creating Batch. [`packages/engine/src/brain/inbox.ts:103-118`](../../packages/engine/src/brain/inbox.ts#L103), [`packages/agents/src/brain/tools.ts:243-267`](../../packages/agents/src/brain/tools.ts#L243) | It stores a due time and free-text reason, not an objective, responsibility status, execution, or outcome. It may wake an open loop but cannot be the loop. |
| Graph Commitment | A provenance-bearing social belief that one Person/Agent promised something, with `open/done/dropped` and optional due date. [`CONTEXT.md:240-242`](../../CONTEXT.md#L240), [`packages/agents/src/capabilities/graph/schemas.ts:27-34`](../../packages/agents/src/capabilities/graph/schemas.ts#L27) | It is keyless, confidence-bearing, Scribe-proposed knowledge. Ownerless “someone should” is deliberately not a Commitment. Operational responsibility must not depend on uncertain belief resolution or masquerade as a promise. [`packages/agents/src/capabilities/graph-extraction/skill-body.md:23-30`](../../packages/agents/src/capabilities/graph-extraction/skill-body.md#L23) |
| GitHub Issue / Pull Request | Provider-owned work artifact and fresh source truth; the Graph may project its identity and relationships. [`packages/agents/src/capabilities/graph/schemas.ts:42-46`](../../packages/agents/src/capabilities/graph/schemas.ts#L42), [`packages/agents/src/capabilities/graph/schemas.ts:125-137`](../../packages/agents/src/capabilities/graph/schemas.ts#L125) | Not every task deserves a GitHub artifact; an issue can pre-exist coworker responsibility, and an open/closed provider state does not describe local blocked, dropped, or multi-step responsibility. A PR is often an outcome or execution artifact, not the Work Item itself. |
| Open Loop | The derived condition that Attention, Work, or a Commitment remains unresolved. [`CONTEXT.md:132-136`](../../CONTEXT.md#L132) | A projection is not another mutable ledger or Entity. Persisting it would create synchronization debt with the states from which it is derived. |

The existing work-state tests prove the narrower ledger is good at its actual job:
an accepted Specialist launch is visible until a durable terminal result, survives restart,
and is scoped to the owning Surface. [`tests/delegation/work-state.test.ts:70-125`](../../tests/delegation/work-state.test.ts#L70),
[`tests/delegation/work-state.test.ts:229-268`](../../tests/delegation/work-state.test.ts#L229).
That behavior should be reused, not stretched until its invariants become nullable.

## Minimal Work Item contract

Application-owned state, with the Brain as domain authority:

```ts
type WorkItemStatus = "open" | "in_progress" | "blocked" | "done" | "dropped";

interface WorkItem {
  id: string;                     // stable across retries and execution attempts
  objective: string;              // the outcome the coworker accepted responsibility for
  sourceEvidenceIds: string[];    // why this responsibility exists
  status: WorkItemStatus;
  outcome?: {                     // required for done/dropped
    summary: string;
    evidenceIds: string[];
  };
  createdAt: string;
  updatedAt: string;
}
```

This is the minimum boundary:

- The Brain creates a Work Item only when it accepts operational responsibility; receipt or
  attention alone does not create one.
- Brain ownership is invariant, so an `owner` column is unnecessary.
- A Specialist launch/result/milestone is one execution attempt linked to the Work Item.
- A Brain Effect is one consequence linked to it when relevant, never its lifecycle.
- A GitHub issue/PR is a source or outcome artifact linked by provider identity, never the
  local ledger.
- A Scheduled Wake may refer to an unresolved Work Item but does not change its status.
- A Graph Commitment may motivate or be resolved by work, but the two keep distinct ids.
- `Open Loop` remains a read projection over non-terminal Attention Items, Work Items and
  Commitments.

Do not add priority, tags, assignees, estimates, generic dependencies, or a workflow DSL at
this boundary. Add fields only when a real executable slice needs them.

## Options

### A. Generalize `brain_specialist_launches`

```diff
- specialist TEXT NOT NULL
- run_id TEXT UNIQUE
+ kind TEXT NOT NULL
+ objective TEXT NOT NULL
+ specialist TEXT
+ run_id TEXT
+ status TEXT CHECK (...)
```

This reuses stable ids, provenance, milestones, recovery, and Speaker visibility. But it
collapses responsibility and one execution attempt. Supporting a task with no Specialist or
several refinement launches forces nullable mechanism fields and eventually a second child
model anyway.

### B. Add a thin Brain Work Item ledger; link existing mechanisms

```diff
+ brain_work_items(work_id, objective, evidence_ids_json, status,
+                  outcome_json, created_at, updated_at)
+ brain_specialist_launches.work_item_id -> brain_work_items.work_id
```

Keep Specialist recovery and milestones unchanged. Add links from Effects or external
artifacts only when the first executable path requires them. This matches the architecture:
the Brain owns every work lifecycle, while application stores hold work ledgers and the Brain
stays the authority rather than persistence mechanism.
[`docs/SYSTEM-ARCHITECTURE.md:130-151`](../SYSTEM-ARCHITECTURE.md#L130),
[`docs/SYSTEM-ARCHITECTURE.md:464-512`](../SYSTEM-ARCHITECTURE.md#L464).

### C. Model Work Items as Graph Entities

```diff
- type GraphEntityType = ... | "commitment" | ...
+ type GraphEntityType = ... | "commitment" | "work_item" | ...
```

This would make work easy to query beside people, repositories and commitments. It also
turns operational state into confidence-bearing Attestations and Brain rulings, although the
Graph is explicitly a rebuildable belief projection and the code restricts its current
ontology to eleven Entity types. [`CONTEXT.md:215-228`](../../CONTEXT.md#L215),
[`packages/engine/src/graph/store.ts:6-30`](../../packages/engine/src/graph/store.ts#L6).
Execution integrity would then depend on belief resolution; that is the wrong authority
boundary.

## Grade and recommendation

Scores are 1 (poor) to 5 (strong); a higher blast-radius score means a more contained change.

| Option | Floor-first | Reversibility | Blast radius | Correctness / integrity | Parallelizability | Fit |
|---|---:|---:|---:|---:|---:|---:|
| A. Generalize Specialist launch | 3 | 2 | 2 | 2 | 2 | 3 |
| **B. Thin Brain Work Item ledger** | **5** | **5** | **4** | **5** | **5** | **5** |
| C. Put work in Graph | 2 | 2 | 1 | 1 | 2 | 1 |

**Recommendation: B.** Preserve the proven Specialist execution ledger and add one small
Brain-owned responsibility ledger above it. This is the smallest change that represents a
generic task before dispatch, across multiple attempts, or without GitHub/Flue, while keeping
knowledge, consequences, timers, external artifacts, and operational responsibility in their
proper authorities.
