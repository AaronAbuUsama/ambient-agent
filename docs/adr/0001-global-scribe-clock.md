# Global Scribe clock separates proposal extraction from Brain integration

The Scribe is one application-owned global ingestion clock, not one persistent model conversation. Live arrival and Historical Replay both produce context-bounded, cross-Surface Scribe Batches; bounded concurrent stateless attempts receive a fresh relevant Digest plus lookup, append low-Confidence Attestations with trusted Evidence Sets, and use stable logical batch identity with fresh attempt identity so retries cannot amplify belief.

The Scribe only proposes. Its concurrent attempts do not serialize to learn from one another: their durable changes feed the Brain's coalesced up-inbox, where the one stateful global Brain integrates, reconciles, and appends authoritative rulings with bounded lag. Historical Replay orders observations globally rather than exhausting one chat at a time, and is not complete until both proposal extraction and the replay-created Brain backlog have caught up.

## Considered options

- Per-chat replay with refreshed context was rejected because unprocessed chats cannot yet contribute to that context.
- One serial Scribe call at a time was rejected because it places global integration in the proposal arm and creates an unnecessary throughput and failure bottleneck.
- Unbounded parallel extraction followed by one final Brain pass was rejected because it delays ownership and turns reconciliation into an unbounded dump.

## Consequences

The application owns batching, ordering, retry identity, and bounded concurrency. Scribe attempts may fail and retry independently; the append-only Attestation identity makes their effects idempotent, while durable pending evidence prevents a failed range from being mistaken for a complete replay.
