# Ambient Current State

Status date: 2026-08-12.

This is the rolling rescue and delivery ledger. It records the current truth,
not a distant phase plan.

## Product direction

The current product model is defined in
[`../canon/product-model.md`](../canon/product-model.md). Canonical module and
protocol ownership is defined in
[`../canon/architecture.md`](../canon/architecture.md). Ambient is one Root-led
autonomous entity whose Conversation Agents manage situated WhatsApp
relationships, Workers perform bounded objectives, and Memory Agents maintain
evidence-backed continuity.

## Proven implementation

The existing backend has valuable behaviour that must survive restructuring:

- authenticated WhatsApp state and retained local history are preserved;
- the accepted-source log is followed with a durable cursor;
- live inbound text is retained exactly once as an Observation and Conversation
  Inbox item;
- Conversation work coalesces rapid input into bounded immutable claims;
- leases, retries, expiry recovery, and shutdown abort are durable;
- model runs, tool calls, evaluations, and model snapshots are retained;
- memory recall selects current evidence-backed claims before filtering and
  limiting;
- WhatsApp sends use scoped destinations and durable idempotent operations;
- a real inbound message was processed by Qwen and one guarded reply was sent
  only to the authorized `Tst` group.

These are implementation assets, not proof that the current module boundaries
are correct.

## Current architectural problems

| Area          | Preserve                                                                         | Problem                                                                                                       | Intended boundary                                      |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Application   | Correct startup and reverse-order shutdown                                       | Proofs still bypass the rescued production composition                                                        | One authoritative `createAmbient(config)`              |
| Models        | Successful Qwen run and durable model snapshots                                  | Provider, transport, credentials, role settings, and Pi objects leak across configuration and callers         | One deep `ModelRuntime` resolved at startup            |
| Conversation  | Durable debounce, claims, leases, tools, sends, and recovery                     | Scheduler and repositories divide one state machine across overlapping APIs                                   | `ConversationService` plus one `ConversationWorkStore` |
| WhatsApp      | Session recovery, accepted-source ingestion, retained mirror, durable operations | Concrete controller and callback mechanics leak into composition; Conversation has only an ad hoc text sender | Ambient-owned service plus conversation-bound effects  |
| Persistence   | Proven atomic transactions                                                       | Public repositories are table-shaped and overlap mutation ownership                                           | Stores shaped around transactional invariants          |
| Proofs        | Guarded live destination and retained evidence                                   | Proofs rebuild production wiring and duplicate policy                                                         | Shared Ambient composition with explicit proof ports   |
| Configuration | Secrets stay out of durable runs                                                 | Environment variables are becoming a structured configuration language                                        | Validated YAML or JSON plus external secret values     |

## Completed slice

### Baseline recovery and composition-root rescue

The abandoned provider refactor was removed without changing retained product
data or the proven Phase 2B runtime. The executable baseline was validated before
the lifecycle work continued.

Production now has one authoritative composition root:

```ts
const ambient = await createAmbient(config);
await ambient.start();
const exit = await ambient.wait();
await ambient.stop();
```

`main.ts` no longer receives or coordinates the concrete database, WhatsApp
controller, or Conversation scheduler. The Ambient lifecycle owns startup,
unexpected WhatsApp failure, idempotent shutdown, and cleanup failure reporting.
WhatsApp-specific detachment interpretation remains inside the WhatsApp module.

The post-slice review found and closed two lifecycle defect classes:

- cleanup failure could leave `Ambient.wait()` pending forever;
- WhatsApp failure or shutdown during attachment could still start Conversation.

Proof scripts still use the lower-level resource factory. Migrating them onto the
production composition path remains explicit rescue work rather than being
silently claimed complete.

**Proof**

- `vp check`: clean, 42 source files;
- `vp test`: 58 tests across 11 files;
- focused lifecycle and WhatsApp failure tests: 11 tests;
- `drizzle-kit check`: clean;
- frozen strict-peer installation: clean;
- no live model call or WhatsApp send was performed.

## Mapping cutover completed

The architecture audit now records:

- every current production module with a Keep, Reshape, Merge, Internalize,
  Remove, or Defer disposition;
- target Ambient, model, WhatsApp, Conversation, store, evaluation, and proof
  boundaries;
- dependency direction and forbidden imports;
- transaction and durable-protocol ownership;
- a Conversation-scoped WhatsApp capability model grounded in `whatsappd`'s
  existing typed durable operations;
- proven behaviour, current architecture, and deliberately unimplemented
  product frontiers;
- a scored comparison of the next rescue candidates.

No runtime code changed during this cutover.

## Active slice

### Conversation service and work-store rescue

**Selection**

This slice has the highest leverage because Conversation is the only proven
agent-kind runtime and currently concentrates the most duplicated ownership.
It establishes the domain ports that later model, WhatsApp-effect, proof, and
Root work must consume.

**Product question**

Can the proven Conversation journey be expressed through one coherent service
and one authoritative durable work store without changing live behaviour?

**Journey**

```text
pending Conversation Inbox
  -> one atomic bounded claim and Agent Run
  -> curated Conversation input
  -> bound recall and scoped text effect
  -> retained tool evidence
  -> atomic success, failure, release, retry, or expiry recovery
```

**Owner**

- `ConversationService` owns timing, execution, tools, and process-local wake
  acceleration.
- `ConversationWorkStore` owns claims, leases, Agent Run and tool evidence
  transitions, Inbox consumption or release, retries, and recovery.
- `ConversationAgent` owns only role behaviour through provider-neutral
  contracts.

**Preserved invariants**

- existing debounce and maximum-wait semantics;
- bounded immutable claims and ordered Inbox membership;
- one active fenced lease per conversation;
- no completion with active tool calls;
- consume on success and release on failure;
- expiry recovery and shutdown abort;
- destination remains outside model control;
- WhatsApp operation receipt remains evidence of communication;
- an accepted effect is not erased by later model failure;
- no live model call or outbound send is needed for deterministic proof.

**Non-goals**

- no new provider or Vibe support;
- no structured-configuration migration;
- no additional WhatsApp tools;
- no Root, Worker, assignment, or Memory Agent behaviour;
- no schema redesign beyond what is required to remove overlapping public
  mutation paths;
- no proof-composition rescue.

**Proof gate**

- Conversation contracts import no concrete database types;
- the service depends on one Conversation-owned work-store port rather than
  peer Inbox, Run, and schedule mutation repositories;
- one authoritative transaction path owns claim, completion, failure, and
  expiry recovery;
- context building and tool evidence are internal Conversation concerns;
- all current focused scheduling, failure, lease, idempotency, and recall tests
  continue to pass through the rescued boundary;
- a restart or reconcile test proves pending Inbox work does not depend on the
  process-local ingestion callback;
- full static, test, schema, package, and dead-code validation passes;
- no live model invocation or WhatsApp send occurs.

## Likely next slice

### Model runtime and structured configuration

Once Conversation consumes a narrow provider-neutral runner, replace
provider-specific construction and role/environment configuration with one deep
model module and validated structured configuration. The cut should prove Qwen
and local Vibe outside WhatsApp before any live channel use.

## Rescue-candidate comparison

Scores are 1 (weak) to 5 (strong). Risk is scored inversely, so 5 means lower
implementation risk.

| Candidate                       | Leverage | Interface certainty | Dependency value | Proofability | Risk |  Total |
| ------------------------------- | -------: | ------------------: | ---------------: | -----------: | ---: | -----: |
| Conversation service and store  |        5 |                   5 |                5 |            5 |    3 | **23** |
| Model runtime and configuration |        4 |                   4 |                4 |            4 |    4 | **20** |
| WhatsApp boundary and effects   |        4 |                   3 |                4 |            4 |    2 | **17** |
| Proof composition               |        3 |                   3 |                2 |            5 |    4 | **17** |

Conversation wins because it is already a complete durable vertical path, its
current mutation overlap is demonstrable, and its rescued ports reduce
uncertainty for all three other candidates. Model runtime is likely next because
the Conversation agent currently constructs Qwen/Pi directly and contains
`Model<any>`, but doing it after the Conversation boundary prevents a second
parallel role/runtime graph.

## Product-discovery themes

These are not committed sequential phases:

- Root-managed Conversation presence;
- customer feedback delegated to a bounded GitHub Worker;
- long-running supplier qualification;
- cross-thread continuity with Rex;
- Root attention and proactive commitment review;
- dynamic Worker definitions assembled from skills and MCP capabilities.

Each theme requires its own slice brief when selected.

## Open rescue questions

- What is the smallest useful operational surface returned by Ambient for
  proofs and diagnostics without leaking internal resources?
- Can the existing Conversation scheduler be wrapped first, or must execution
  and timing be separated during the rescue?
- When should history backfill move from WhatsApp session startup to
  Memory-owned indexing?
- Which current tables represent durable product concepts, and which encode the
  old workflow too specifically?
- Which Conversation-bound WhatsApp capability should follow text first:
  reactions, read state, or media?

Resolve these while touching the relevant slice, not in one speculative schema
redesign.
