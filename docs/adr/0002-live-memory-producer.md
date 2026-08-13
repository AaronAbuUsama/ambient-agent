# The live-memory producer: allowed chats digest behind a per-chat cursor

Production runs a memory service that drains durable jobs, but nothing authors
them — Memory v2's windows were proof-authored, so live traffic never enters
memory. Decided on the home-litigation map
([Live-memory producer](https://github.com/AaronAbuUsama/ambient-agent/issues/15),
grilled 2026-08-13): a deterministic producer step inside the memory service
turns live traffic into memory jobs. Job authoring is deterministic forever —
the Root's future lever is the mandate (mode, memory brief), never job rows.

The producer digests **allowed chats in both modes**: a speaker record is the
consent surface for remembering exactly as it is for replying, and this is
what finally gives `listening` its promised meaning (memory only, silent).
Chats without a speaker record stay retained but undigested.

The protocol, against the six-question test:

1. **Retained records.** The memory job (`memory_jobs`, unchanged) remains
   the handoff. A new per-chat **digest cursor** is the producer's watermark:
   digested-through (occurredAt, id), the open job, and an attempt count.
   Deliberately distinct from the activation point — `attendFrom` means
   "answer from here", the cursor means "remembered through here".
2. **Owning service.** The memory service gains a producer step at the head
   of its existing drain: scan chats with a speaker record for due windows,
   author them, then claim and run as today. The ingestion accept hook pings
   the drain as a wake hint; the poll-driven scan is the truth.
3. **Consumer.** The existing claim/run path, unchanged.
4. **Idempotency.** The cursor is the key: the job insert and the cursor's
   open-job fence commit in one transaction, so a window is authored at most
   once and at most one window per chat is ever in flight. Sequential
   windowed digestion (later windows see earlier ontology) stays an
   invariant without touching `claimNext`.
5. **Retry and recovery.** Lease expiry reopens abandoned pending jobs
   (unchanged). A failed job stays terminal; the producer re-authors the same
   window as a new job, at most three attempts, then the chat's digestion
   parks with the failed rows as visible evidence. The cursor advances only
   on done. Restart needs no special handling: the scan is the reconcile.
6. **Evidence.** Job rows, the memory agent run, the per-job patch, and the
   evaluation signal (all existing), plus the cursor row for "how far behind
   is memory".

Trigger policy (config-owned): author a full window when a chat's undigested
backlog reaches the window size (40), otherwise flush the whole tail — any
size — once the oldest undigested observation is 6h old. Both deadlines are
measured from retained data, never a process timer. Cursor origin: the first
producer touch of a chat derives the cursor from its done jobs (Bug Reports'
seven proof-authored windows stay honest); a chat with none starts at zero
and digests its entire retained backlog, windowed — memory wants the
retained past.

## Considered options

- All accepted chats, or responding-only — rejected: digesting unblessed
  chats spends model money and creates memory that cannot be cleanly
  un-known; responding-only starves the speaker's own older context.
- Deriving digested-through from job `input_json` — rejected: it leaves job
  authoring with no idempotency key at all, and the digested set becomes an
  unindexable JSON scan.
- Per-observation pending rows (the `evaluation_pending` shape) — rejected:
  the ingestion transaction would gain a memory concern, and it would be the
  pending-signal pattern's third use before a promotion is earned.
- Reopenable failed jobs — rejected: it reshapes a proven terminal
  aggregate; retry-as-new-record matches the run and patch discipline.
- Snapshotting the mandate's memory brief into job input — rejected: the
  ledger forbids brief machinery before the second memory bed. When briefs
  arrive they join at claim-time input assembly, where the run snapshots its
  immutable input; the job stays observation-ids-only.

## Consequences

- Live windows contain inbound text only: the live observation mapper drops
  media and Ambient's own outbound messages, so a screenshot-heavy report
  digests as silence. Known, named fog on the map — widening live retention
  is its own decision and requires no producer change.
- Blessing a chat that has months of retained observations digests all of
  them, forty at a time. That is intended.
- A parked chat (three failed attempts) resumes only by operator attention
  for now; an auto-unpark cooldown is a later dial, not this protocol.
