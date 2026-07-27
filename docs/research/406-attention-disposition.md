# #406 research — durable attention disposition

## Finding

The missing invariant is not “every Brain Batch has an Effect.” It is:

> Every Attention Item claimed by a Brain Batch must leave that Batch with an
> explicit durable disposition, and any disposition that continues
> responsibility must name the durable successor that now owns it.

`stay_silent` is orthogonal. It answers only “should a Surface communicate?”
It may accompany dismissal, holding, or transfer, but cannot be the Attention
Item's disposition.

## Current failure path

The current inbox already gives pending judgment a durable home:

- each source row has a nullable `batch_id`, and a Brain Batch has durable
  `settled_at` ([`packages/engine/src/brain/inbox.ts:614`](../../packages/engine/src/brain/inbox.ts#L614),
  [`packages/engine/src/brain/inbox.ts:668`](../../packages/engine/src/brain/inbox.ts#L668));
- `claimBatch()` reuses an existing open Batch and transactionally claims exact
  input membership ([`packages/engine/src/brain/inbox.ts:1390`](../../packages/engine/src/brain/inbox.ts#L1390));
- restart tests prove the same open Batch and membership are recovered
  ([`tests/brain/intent-admission.test.ts:102`](../../tests/brain/intent-admission.test.ts#L102)).

The loss happens at settlement:

```ts
const total = effectCount(batchId) + specialistLaunchCount(batchId);
const pending = unsettledEffectCount(batchId);
const pendingWork = pendingSpecialistLaunchCount(batchId);
if (total === 0 || pending + pendingWork > 0) throw ...
settle.run(settledAt, batchId);
```

[`packages/engine/src/brain/inbox.ts:1598`](../../packages/engine/src/brain/inbox.ts#L1598)

This proves only that the Batch has *some* accepted/completed consequence. It
does not prove which input that consequence covers. A Batch may contain up to
100 unrelated inputs, while one `stay_silent` row is immediately `completed`
and therefore settles all of them
([`packages/engine/src/brain/inbox.ts:1398`](../../packages/engine/src/brain/inbox.ts#L1398),
[`packages/engine/src/brain/inbox.ts:1468`](../../packages/engine/src/brain/inbox.ts#L1468),
[`tests/brain/effects.test.ts:404`](../../tests/brain/effects.test.ts#L404)).

This is the accountability gap:

```text
durable input -> immutable Batch -> one unrelated completed Effect -> settled
                                       ^
                                  stay_silent qualifies
```

### Existing continuation and recovery mechanisms

- A Scheduled Wake is durably inserted with its creating Effect and survives
  restart, but it has only a free-text `reason`; it does not reference the loop
  or Attention Item it reconsiders
  ([`packages/engine/src/brain/inbox.ts:1183`](../../packages/engine/src/brain/inbox.ts#L1183)).
- A Proactive Sweep is coalesced until its Batch settles, but its current prompt
  asks the Brain to inspect Graph commitments/open loops. Application-owned
  Attention Items are not yet in that view
  ([`packages/engine/src/brain/inbox.ts:884`](../../packages/engine/src/brain/inbox.ts#L884),
  [`packages/agents/src/prompts/catalog.ts:94`](../../packages/agents/src/prompts/catalog.ts#L94)).
- Pending prompt, issue-filing, and issue-mutation Effects have boot recovery;
  filings and mutations reconcile by stable operation identity
  ([`packages/agents/src/brain/effects-runtime.ts:61`](../../packages/agents/src/brain/effects-runtime.ts#L61)).
- Accepted specialist work survives as visible work state; terminal or
  interrupted results are admitted back to a later Brain Batch
  ([`packages/agents/src/capabilities/delegation/bridge.ts:27`](../../packages/agents/src/capabilities/delegation/bridge.ts#L27),
  [`tests/delegation/work-state.test.ts:89`](../../tests/delegation/work-state.test.ts#L89)).
- Directive Outcomes are durably recorded after accepted speech, but the
  runtime currently stores them without admitting the outcome back to the
  Brain ([`apps/runtime/src/host/whatsapp-runtime.ts:544`](../../apps/runtime/src/host/whatsapp-runtime.ts#L544),
  [`packages/engine/src/surfaces/delivery.ts:23`](../../packages/engine/src/surfaces/delivery.ts#L23)).

The new state should reuse these recovery owners rather than duplicate them.

## Minimal durable states

```ts
type AttentionState =
  | { kind: "pending" }
  | { kind: "held"; reason: string; wakeId?: string }
  | {
      kind: "transferred";
      target: { kind: "brain_effect" | "work_item"; id: string };
    }
  | {
      kind: "resolved";
      outcome: "dismissed" | "completed" | "superseded";
      reason: string;
    };
```

- **pending** — no accountable decision yet; blocks Batch settlement.
- **held** — the Brain deliberately retains responsibility. It remains an Open
  Loop; a Scheduled Wake may name it, but the wake is a prompt, not the owner.
- **transferred** — responsibility continues under an existing durable Effect
  or Work Item. The successor lifecycle, not the model transcript, determines
  closure or re-admission.
- **resolved** — no responsibility remains; dismissal is explicit and reasoned,
  never inferred from silence.

No separate `open_loop` row is required. An Open Loop remains the projection of
`pending | held`, unresolved transferred successors, unfinished Work Items, and
unfulfilled Commitments, matching the accepted vocabulary in
[`CONTEXT.md` — Information and accountability](../../CONTEXT.md#information-and-accountability).

## Minimal schema seam

Keep the existing source tables and Batch claim machinery. Add one per-input
Attention identity plus append-only claim and transition history rather than
replacing the inbox:

```sql
CREATE TABLE brain_attention_items (
  attention_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('happenings', 'internal_input')),
  internal_input_id TEXT UNIQUE,
  evidence_ids_json TEXT NOT NULL,
  readiness_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (source_kind = 'happenings' AND internal_input_id IS NULL)
    OR
    (source_kind = 'internal_input' AND internal_input_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE brain_attention_happenings (
  attention_id TEXT NOT NULL REFERENCES brain_attention_items(attention_id),
  happening_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (attention_id, happening_id)
) STRICT;

CREATE TABLE brain_attention_claims (
  claim_id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL REFERENCES brain_attention_items(attention_id),
  batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
  claimed_at TEXT NOT NULL,
  UNIQUE (attention_id, batch_id)
) STRICT;

CREATE TABLE brain_attention_transitions (
  transition_id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL REFERENCES brain_attention_items(attention_id),
  claim_id TEXT REFERENCES brain_attention_claims(claim_id),
  transition_kind TEXT NOT NULL
    CHECK (
      transition_kind IN (
        'admitted',
        'reopened',
        'enriched',
        'successor_closed',
        'disposition'
      )
    ),
  from_state TEXT
    CHECK (from_state IS NULL OR from_state IN ('pending', 'held', 'transferred', 'resolved')),
  to_state TEXT NOT NULL
    CHECK (to_state IN ('pending', 'held', 'transferred', 'resolved')),
  transition_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (
    transition_kind = 'disposition'
    OR json_extract(transition_json, '$.kind') = transition_kind
  ),
  CHECK (
    (
      claim_id IS NULL
      AND transition_kind = 'admitted'
      AND from_state IS NULL
      AND to_state = 'pending'
    )
    OR
    (
      claim_id IS NULL
      AND transition_kind = 'reopened'
      AND from_state IN ('held', 'transferred', 'resolved')
      AND to_state = 'pending'
    )
    OR
    (
      claim_id IS NULL
      AND transition_kind = 'enriched'
      AND from_state IS NOT NULL
      AND from_state = to_state
    )
    OR
    (
      claim_id IS NULL
      AND transition_kind = 'successor_closed'
      AND from_state = 'transferred'
      AND to_state = 'resolved'
    )
    OR
    (
      claim_id IS NOT NULL
      AND transition_kind = 'disposition'
      AND from_state = 'pending'
      AND to_state IN ('held', 'transferred', 'resolved')
      AND json_extract(transition_json, '$.kind') = to_state
    )
  )
) STRICT;

CREATE UNIQUE INDEX one_disposition_per_attention_claim
  ON brain_attention_transitions(claim_id)
  WHERE claim_id IS NOT NULL;
```

Trusted external admission inserts the Attention identity, one or more
`brain_attention_happenings` rows, and the initial `pending` transition in one
transaction. The unique `happening_id` constraint prevents any Happening from belonging
to a second Attention Item, including overlapping aggregates. Internal admission instead
requires one unique durable `internal_input_id`; its readiness payload records the input
schema and validation-policy versions, never fabricated Graph projection metadata.

Each Brain Batch appends a claim; its disposition appends one claim-linked transition.
Reopening after a due wake or failed successor appends `held/transferred -> pending`,
and a later Batch appends another claim. No earlier `batch_id` or disposition is cleared
or overwritten. Admission is only `undefined -> pending`; enrichment is state-preserving,
and material enrichment that reopens responsibility appends a separate
`held/transferred/resolved -> pending` transition. The current state is a deterministic
projection over the transition log.

Trusted code validates disposition references:

```ts
dispositionAttention({
  batchId,
  claimId,
  attentionId,
  disposition:
    | { kind: "held"; reason; wakeId? }
    | { kind: "transferred"; target: { kind: "brain_effect" | "work_item"; id } }
    | { kind: "resolved"; outcome; reason },
});
```

For `transferred`, the target must exist and have reached the handoff boundary
already used by settlement: a local/completed Effect, an accepted asynchronous
Effect, or an accepted Work Item. `stay_silent` is explicitly rejected as a
transfer target because it has no downstream accountability owner. A Scheduled
Wake may be attached to `held`, but cannot discharge attention by itself.

Trusted successor closure verifies that the Effect or Work Item matches the target recorded
by the transfer and that its observed result matches the exact completion outcome bound in
advance. It appends `successor_closed` and closes Work or records the accepted Effect outcome
in one transaction. Ambiguous or mismatched results append `reopened` for Brain judgement.

Settlement becomes coverage, not counting:

```ts
const uncovered = attentionClaimsForBatch(batchId)
  .filter(({ claimId }) => dispositionTransitionForClaim(claimId) === undefined);
if (uncovered.length > 0) throw new Error(...);

validateTransferredSuccessors(batchId);
validateExistingEffectsAndWork(batchId);
settle.run(settledAt, batchId);
```

Examples:

```ts
// Irrelevant event: no speech, explicit accountable dismissal.
staySilent(batchId, "No external communication warranted.");
resolveAttention(attentionId, "dismissed", "Bot-authored label echo.");

// Worth revisiting: no speech, but responsibility remains visible.
staySilent(batchId, "Do not interrupt a Surface yet.");
holdAttention(attentionId, "Review after CI finishes.", wakeId);

// Work begins without speech: responsibility moves, not disappears.
staySilent(batchId, "No notification warranted.");
transferAttention(attentionId, { kind: "work_item", id: workId });
```

## Options

| Option | Concrete change | Floor-first | Reversible | Small blast radius | Integrity | Parallelizable | Fit |
|---|---|---:|---:|---:|---:|---:|---:|
| Batch-level disposition | One `brain_batch_disposition` row | 2 | 5 | 5 | 1 | 4 | 3 |
| **Per-input Attention overlay** | Add the table/state/tool and make settlement require full coverage | **5** | **4** | **4** | **5** | **5** | **5** |
| Unified Attention inbox | Replace the five source queues with one first-class Attention queue | 3 | 2 | 1 | 5 | 2 | 3 |
| Graph-only state | Model attention as entities/relations | 1 | 3 | 3 | 1 | 3 | 1 |

Batch-level disposition is insufficient because coalescing destroys coverage.
A unified inbox may later become worthwhile, but is unnecessary to establish
the invariant. Graph-only state gives tentative beliefs authority over
operational responsibility and violates the accepted Graph/Brain boundary.

## Recommendation

Adopt the **per-input Attention overlay** and the four states above. It is the
smallest change that closes the real failure mode while retaining current Batch,
Effect, Work Item, and recovery machinery.

The implementation expedition must include three focused proofs:

1. one silence cannot settle a Batch with any `pending` Attention Item;
2. `held` survives restart, reopens into a later immutable claim without losing
   its earlier disposition, and appears in the proactive open-loop projection;
3. a transferred successor has no invisible gap: it is either still durably
   owned, terminally resolved, or re-admitted for Brain attention.
