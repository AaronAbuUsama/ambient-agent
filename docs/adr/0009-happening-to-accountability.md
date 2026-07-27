# Processing a happening requires knowledge, attention, and accountable work

Accepted for the target architecture. The complete explanation, walkthroughs, failure
model, and current implementation distance are in
[`../INFORMATION-TO-ACCOUNTABILITY.md`](../INFORMATION-TO-ACCOUNTABILITY.md).

Receiving an external event is not proof that the coworker processed it. One ordered,
knowledge-first path retains the Happening in its provider-specific Source Archive,
establishes its minimum knowledge floor, and admits exactly one knowledge-ready Attention
Item for Brain judgment. The Brain never consumes an unprepared provider callback, while
the Graph remains durable memory rather than an occurrence queue or provider mirror.

Facts explicit in source records are appended by deterministic ingesters. The global Scribe
remains a separate asynchronous semantic projector for ambiguous meaning; routine proposals
update the Graph without automatically waking the Brain. The Brain rules on knowledge,
dispositions Attention, and owns any resulting Work Item through observable closure; its
ordinary Graph surface does not extract Entity or Relation proposals.

An Attention Item references its Happening evidence and the fact Attestations or Projection
version that made it knowledge-ready. Pending Attention is queue-like, but the record remains
durable after it is held, transferred, or resolved. Claims and state transitions are append-only;
the current state is a rebuildable projection, so reopening never overwrites an earlier Batch
claim or disposition. `stay_silent` records only that no external communication is warranted
and cannot settle Attention; Graph beliefs cannot substitute for operational work state.

Every source readiness policy also sets a finite projection-attempt or elapsed-time budget.
Exhaustion records a terminal projection-failure fact and admits the same Happening's Attention
Item for explicit Brain disposition. A later successful projection enriches that obligation
rather than creating a duplicate.

Already meaningful internal inputs first correlate to an existing Attention Item, Work Item,
Effect, or Directive. When judgement is owed but no durable owner exists, trusted code admits
internal-source Attention that references the durable input plus its schema and validation
policy. It does not fabricate a provider Happening or Graph projection to satisfy the external
readiness contract.

## Settled implementation boundaries

- A thin source-neutral Happening registry owns stable identity and provenance pointers. It
  does not duplicate provider payloads; provider-specific Source Archives remain payload
  truth.
- A terminal Brain dispatch releases only its application-owned execution attempt, correlated
  through Flue's public terminal events. The same immutable Brain Batch and exact Attention
  membership retry with bounded backoff; execution failure never manufactures settlement.
- A terminal mechanism result is not automatically a completed Work Item. Trusted code may
  close Work only when the result matches an exact completion outcome bound in advance.
  Ambiguous, interrupted, uncertain, or otherwise unmatched results return for Brain
  judgment. Work closure and resolution of its transferred Attention are one transaction.

## Initial cutover

The first rollout is a clean-room reset, not a historical accountability migration. There
are no production users or obligations to preserve. Before enabling the new path, execution
will inventory and then clear the existing development runtime state: provider archives,
Graph projections and attestations, Scribe and Brain queues, Batches, Effects, deliveries,
Flue conversations and execution records, and other derived operational ledgers. Code,
migrations, GitHub planning history, test fixtures, and proof receipts are not runtime state
and remain. Deployment configuration, credentials, provider authentication sessions, and
configured source/surface authorization also remain so the reset does not become a needless
re-pairing or secret-rotation exercise.

The new Happening, Graph, Attention, and Work history begins from the first fresh post-reset
source event. Historical Replay remains a supported architectural capability for future real
archives; it is not part of this initial migration.

## Rejected

- Raw Happenings and later knowledge deltas as independent peer inputs to the Brain.
- Treating a Graph change as the occurrence identity or using the Graph as the Brain queue.
- Collapsing semantic extraction, authoritative rulings, Attention, and action into the Brain.
- Waking the Brain for every routine Scribe projection.
- Duplicating provider payloads in a universal Happening archive.
- Retrofitting accountable Attention onto pre-architecture development history.
- Treating execution completion, prompt acceptance, or a Scheduled Wake as Work completion.
