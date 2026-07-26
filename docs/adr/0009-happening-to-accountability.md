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
durable after it is held, transferred, or resolved. `stay_silent` records only that no external
communication is warranted and cannot settle Attention; Graph beliefs cannot substitute for
operational work state.

## Rejected

- Raw Happenings and later knowledge deltas as independent peer inputs to the Brain.
- Treating a Graph change as the occurrence identity or using the Graph as the Brain queue.
- Collapsing semantic extraction, authoritative rulings, Attention, and action into the Brain.
- Waking the Brain for every routine Scribe projection.
