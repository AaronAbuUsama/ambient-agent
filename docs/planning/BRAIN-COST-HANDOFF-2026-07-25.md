# Brain cost & architecture — handoff brief

**Written 2026-07-25.** Input for a fresh session. Everything here is measured against the live rig
(`capxul-vps:~/.ambient-agent`), the Braintrust project `co-worker`
(`ac7f8405-ae21-47ff-b962-7fe70a936fdb`), and this tree at `60532b1`. Estimates are marked.

**Decision already taken by Aaron:** build **A (stateless Brain)** and **B (cheap gate)** together as
one piece of work. **C (decompose into lanes)** is held, not rejected.

---

## 0. How to use this document

Read §1 (state) and §2 (findings) to understand the problem. §3–§4 are the two builds. §5 is what
was held and why. §6 is what must be decided by a human before or during the build. §7 is how to
tell whether it worked.

Nothing in this document has been implemented. No config has been changed. No code has been edited.

---

## 1. Current state

### The rig is down

Every model call has failed since roughly **15:30 UTC on 2026-07-25**. 96 of the last 100 agent runs
errored:

```
Error [FlueError]: prompt failed: Codex SSE response headers timed out after 20000ms
```

The ChatGPT/Codex subscription provider is not responding. WhatsApp messages and GitHub webhooks are
still arriving and queueing normally (`github.ingress.done` still logging); nothing is being reasoned
about. **The coworker is deaf and mute in both managed groups.**

### The provider situation

Aaron has an **`opencode-go`** subscription. That provider is already in pi's built-in catalog and
carries 13 models, all of them relevant:

```
deepseek-v4-flash   deepseek-v4-pro   glm-5.1   glm-5.2
kimi-k2.6           kimi-k2.7-code    minimax-m2.7   minimax-m3
qwen3.6-plus        qwen3.7-max       qwen3.7-plus
mimo-v2.5           mimo-v2.5-pro
```

Switching is a **config change, not a build** — `packages/installation/src/schema.ts:19-24` states
that adding a provider is config, not code.

**One constraint that shapes planning:** `model.provider` is a **single global value**
(`schema.ts:104`). `model.profiles.{brain,speaker,scribe,planner,coder,verifier}` are per-role but
carry only `id` and `thinkingLevel`. So you can vary the *model* per role today, but every role must
sit on the same *provider*. Mixing vendors needs **issue #376 "Provider per agent role"**, open and
unbuilt.

Requires an API key that was not available at the time of writing.

---

## 2. The findings

### 2.1 The Brain dominates everything

Measured over the last healthy window (2026-07-24 11:04–14:59), split by agent instance:

| Agent | Runs | Avg fresh in | Avg cached in | Avg out | Share of all tokens |
|---|---|---|---|---|---|
| **Brain** (`global`) | 82 | **2,622** | **361,794** | 180 | **84.2%** |
| Coder / Reviewer workflows | 11 | 47,563 | 379,904 | 1,343 | 13.3% |
| Speaker | 4 | 11,303 | 119,488 | 124 | 1.5% |
| Scribe | 2 | ~33,500 | ~154,000 | ~770 | 1.0% |

**Every Brain wake reads ~364,596 tokens and writes ~180.** Only 2,622 of what it reads is new.

### 2.2 ~97% of the context is accumulated transcript

| Component | Tokens | Confidence |
|---|---|---|
| Accumulated transcript of prior wakes | ~245,000 | high (residual; mechanism confirmed) |
| Tool definitions (27 tools) | ~4,250 | medium (static estimate, ±30%) |
| Instructions / system prompt (18 lines, 5,732 chars) | ~1,550 | high |
| The batch that woke it | 500–1,500 | high |
| Skills | 0 | high — the Brain loads none |

**Mechanism.** The Brain is dispatched with the hard-coded instance id `"global"`
(`packages/agents/src/brain/dispatch.ts:8,32`). Flue keys one persistent conversation per
`agents/<name>/<id>`, stored in `flue.sqlite`, with **no retention policy, no pruning, no TTL**.

Verified on the rig:

| | |
|---|---|
| Brain conversation streams | **1** (`agents/brain/global`) |
| Entries in it | **4,587** |
| Raw transcript stored | **4.9 MB** |
| Scribe conversation streams (one per attempt) | **218** |

Same framework, two designs. The Scribe uses `scribe-attempt:${randomUUID()}`
(`packages/agents/src/scribe/coalescer.ts:123`) and stays cheap forever.

**Compaction is working as designed and does not solve this.** Threshold is **252,000** tokens
(272,000 context window − 20,000 reserve), and only **8,000** tokens of recent detail survive the
cut. Both are framework defaults; nothing in this repo sets them. The result is a sawtooth: climb to
252k, collapse to ~8k plus a summary, climb again.

### 2.3 It wakes 191 times in two days, almost always holding one item

| Inputs in the Batch | Batches |
|---|---|
| **1** | **179** |
| 2 | 8 |
| 3 | 1 |
| 4 | 2 |
| 6 | 1 |

`claimBatch(limit = 50)` (`packages/engine/src/brain/inbox.ts:1390`) can bundle up to fifty inputs.
It never does, because every admission immediately calls `wakeBrain`
(`apps/runtime/src/host/whatsapp-runtime.ts:372, 389, 404, 497, 503, 539`). Nothing ever waits.

### 2.4 What wakes it, and what it decides

**Inputs (2 days):** 141 GitHub webhooks · 58 self-scheduled sweeps · 48 Scribe knowledge deltas ·
22 chat intents · 6 specialist results.

**GitHub kinds:** 52 `issues.opened`, 49 `pull_request_review.submitted`, 40 `pull_request.opened`.
Only four event shapes are admitted at all (`packages/engine/src/github/ingress.ts:226-232`);
everything else settles `unsupported`.

**Effects:** 164 `stay_silent` (81%) · 19 `prompt_speaker` · 10 `file_issue` · 9 `issue_mutation` ·
1 `schedule_wake`.

**The chat path is healthy and should not be touched:** 641 raw messages → 69 Windows → 22 Intents.
A 29:1 filter, working exactly as designed.

### 2.5 THE BUG — all 141 GitHub wakes were forced to silence

The Brain's routing instruction (`packages/agents/src/brain/agent.ts:77`):

> "To route one: `lookup_graph` the repository, follow its `works_on` relation to the interested
> thread… **If no thread works_on the repository**, or the target resolves to no Surface,
> **`stay_silent`**."

That `thread --works_on--> repository` edge is created from exactly one place: the config field
`github.surfaceRepositories`, consumed by
`packages/agents/src/capabilities/graph/seed-repositories.ts:61-75`. It is optional and defaults to
`[]` (`packages/installation/src/schema.ts:128-131`).

**On the rig the field is absent entirely.** Verified against the live graph rather than the config:

```
works_on relations — all 3:
  person_491e35 → issue_0376cc8b87de
  person_491e35 → issue_077ef0
  person_491e35 → issue_d6759ff198a7

thread entities: 3        thread → repository edges: 0
```

So the routing precondition **cannot be satisfied**, and every GitHub event was structurally
guaranteed to end in silence. Roughly **51 million tokens** spent executing a foregone conclusion.

It was reporting this in plain English 141 times:

> *"The pull-request review event targets AaronAbuUsama/ambient-agent, but Graph has no works_on
> relation routing that repository to an interested thread. Suppressing the event."*

*Limit on this claim:* the instruction mandates silence; code does not enforce it, so a model could
deviate. The 19 non-silent decisions came from chat intents and specialist results, which route
differently.

### 2.6 Two compounding defects

**No self-authored-event filter.** `packages/engine/src/github/ingress.ts` parses `payload.sender`
(login / id / type) into every event draft (lines 405, 431, 483) and **never compares it** against
the coworker's own three GitHub App identities (`credentials/github-{coder,reviewer,planner}.json`).
Its own Coder opening a PR wakes it identically to a human. The chat side already learned this lesson
— `packages/engine/src/coalescer/coalescer.ts:155-157` filters `fromMe` — the GitHub side did not.

**A self-winding clock.** `DEFAULT_PROACTIVE_CLOCK_INTERVAL_MS = 5 * 60 * 1000`
(`apps/runtime/src/host/whatsapp-runtime.ts:328`), hard-coded, absent from the config schema. Every
tick admits a sweep if none is outstanding and then **unconditionally** wakes the Brain
(`whatsapp-runtime.ts:369-379`).

### 2.7 Evals — state of play

29 eval cases exist across Speaker / Scribe / Coder / Reviewer / issue-management. **Zero for the
Brain.** Zero Braintrust datasets, so no experiment is a stable benchmark. Braintrust experiments are
stale (last 2026-07-17).

Production tracing is live but **payload-thin**: of 381 `flue.prompt` trace roots only **3** carry an
`input`, and all 1,682 `llm:agent` spans carry neither input nor output. Tool spans *do* carry full
arguments and results, including every `stay_silent` reason.

Two ready-made eval sets already exist and need exporting, not authoring:
- **191 real Brain decisions** with inputs and outcomes in `application.sqlite`.
- **~13 moments in the WhatsApp history** where Aaron stated the intended behaviour in his own words
  ("you should have responded to this even though it's not a task", "I didn't want you to create the
  issue on Ambient Agents", "this is a duplicate").

---

## 3. Build A — the Brain becomes stateless

### The idea

Stop keeping one conversation forever. Give the Brain a fresh Flue instance per wake — the Scribe's
existing pattern — and push it a reconstructed brief assembled from the knowledge graph and the
durable inbox instead of relying on transcript recall.

### Why it is safe to do this

**No Brain tool reads the transcript.** Every one of the twenty is parameterised by `batchId` and
reads durable storage. `brainGraphContext()` (`packages/agents/src/brain/agent.ts:32-35`) resolves
write authority from `inbox.claimBatch()`, not from conversation state. `settle_brain_batch`
(`packages/agents/src/brain/tools.ts:405-421`) calls `runtime.inbox.settleBatch(input.batchId)` and
invents nothing.

### The change

| File | Change |
|---|---|
| `packages/agents/src/brain/dispatch.ts` | line 8: `readonly id: "global"` → `readonly id: string`; line 32: `id: "global"` → `` id: `brain-wake:${randomUUID()}` ``; extend input with a `context` field |
| `packages/agents/src/capabilities/graph/digest.ts` | add `buildBrainWakeContext(inbox)` mirroring `attachGraphContext` (line 86) but globally seeded — commitments with `overdue`, unfiltered `composeWorkItems`, `pendingScheduledWakes()`, `recentEffects()`. Wrap in the same try/catch as lines 89-101: a graph read must never fail a dispatch |
| `packages/engine/src/brain/inbox.ts` | add `recentEffects(limit)` to the interface (~line 446): one statement over `brain_effects` LEFT JOIN `directive_outcomes`, ordered `created_at DESC` |
| `packages/agents/src/brain/agent.ts` | instructions: the brief is now supplied; `lookup_graph` is for going deeper. Add the Scribe's honest line (`scribe/agent.ts:49`): "you never rely on prior private turns" |

The `wakes` semaphore (`dispatch.ts:19`) **stays**. It is what guarantees one open batch at a time,
which keeps `claimBatch()` unambiguous.

**Not needed:** no `attempt-context.ts` equivalent (the Brain's authority is inbox-derived, not
instance-derived), no orphan-recovery handler, no compaction config (compaction becomes unreachable).

### What must be reconstructed

Four things the transcript currently carries. Three already exist durably:

1. **The Belief Projection** — `computeGraphDigest` / `buildGraphDigest`
   (`packages/agents/src/capabilities/graph/digest.ts:55`) already delivers commitments with an
   `overdue` flag (`packages/engine/src/graph/digest.ts:193-227`). Every Speaker turn gets this
   pushed. The Brain is the only consumer relying on pull-plus-memory.
2. **In-flight work** — `acceptedSpecialistLaunchesWithoutResult()`, `activeWorkItems()`,
   `workMilestones()` (`inbox.ts:396-403`).
3. **Owed reconsiderations** — `pendingScheduledWakes()` (`inbox.ts:419`).
4. **THE GAP — "what I already said, and what came of it."** `effects(batchId)` is scoped to one
   batch, and delivery outcomes live in a third table the Brain never reads: `directive_outcomes`
   (`packages/engine/src/surfaces/delivery.ts:179`, statuses `delivered | failed | uncertain |
   settled_without_say`). This is the one load-bearing job the transcript does, and it is the only
   genuinely new query. It is also *better* than the transcript: the transcript records what the
   Brain asked for; `directive_outcomes` records what actually happened.

Set the Brain digest's own byte cap — the shared `MAX_GRAPH_DIGEST_BYTES` of 64 KiB
(`packages/engine/src/graph/digest.ts:121`) is ~16k tokens, too generous here. **Start at 16 KiB and
treat it as a calibration knob, not a constant** — the right value is an empirical question about
decision quality.

### Cost model (estimate)

| Component | Tokens |
|---|---|
| Static instructions | ~1,550 |
| Tool schemas | ~4,250 |
| Batch payload | 500–1,500 |
| Brain digest (16 KiB cap) | ~2,000–4,000 |
| Open loops + recent effects | ~500–1,500 |
| **Total prompt** | **~9,000–13,000** |

Against today's 364,596 — roughly **28× fewer tokens read**.

**The honest wrinkle.** Cache-read prices at roughly 0.1× fresh, so today's wake in
fresh-equivalents is ≈ 2,622 + 36,179 ≈ **38,800**. The new wake's ~11,000-token prompt is *fresh*
on the first turn, because a new instance has nothing in cache. Fresh tokens per wake therefore rise
from ~2,622 to ~11,000 — about **4×** — while total effective spend falls roughly **60–65%**.
**If any budget, alert, or rate limit is denominated in fresh input tokens, this makes that number
worse while making cost better.** On subscription auth the binding constraint may be rate-limit units
rather than dollars. Check before quoting the 60%.

### Risks

- **Uncommitted reasoning is destroyed.** A hunch that currently firms up over three wakes now
  evaporates at the end of each. Statelessness converts every belief into a write-or-lose decision.
- **Behavioural drift, direction unknown.** The 164 silences are partly the Brain conditioning on its
  own past restraint. The silence rate will move. Nobody knows which way. **This is the single
  biggest risk and only running it will settle it.**
- **Multi-turn escalation arcs degrade first** — `recentEffects` says what it did, not why it
  hesitated.
- **Framework risk to verify, not assume:** Flue re-runs initializers for unsettled durable
  submissions on boot; the Scribe hit this and it cost issue #330 (`scribe/agent.ts:18-26`). Also
  unverified: whether Flue prunes per-instance streams, or whether `flue.sqlite` trades one 4.9 MB
  row-set for thousands of small ones.

**What does NOT break, contrary to expectation:** the ack→work→outcome contract. The skill names its
own mechanism (`capabilities/whatsapp-participation/SKILL.md:28`) — the digest's `workItems` and
`lookup_work`, not memory. `lookup_work` is a **Speaker** tool
(`capabilities/delegation/work-tools.ts:18,40`); the Brain never had it. The arc closes through
durable state.

### Kill condition — run this before writing code

**Replay a sample of real wakes against graph + inbox reads only, and check the reconstructed brief
actually contains what the decision needed.** The graph is thin — 117 entities, 152 relations, 505
attestations from 218 Scribe attempts. If Scribe extraction is missing what the Brain leans on,
statelessness converts a silent extraction gap into visible amnesia. If the brief comes up short,
**fix the Scribe first**; this change is downstream of graph quality.

Also worth doing first: read the 19 `prompt_speaker` decisions in the existing transcript and check
whether they were driven by their own batch or by accumulated cross-wake judgement. If the latter,
the premise of Build A is wrong.

---

## 4. Build B — a cheap deterministic gate in front

### The idea

Do not wake an expensive general reasoner to compute an answer a SQL query already knows. Every rule
below is a string comparison or a row count. None needs a model. None touches `agent.ts`.

### Rule 1 — drop self-authored webhooks

**Where:** `packages/engine/src/github/ingress.ts:490`, immediately before
`admission = await options.admit(event)`. **Not** at the top of `handle` — the `launchReview`
branches (lines 342-370, 445-458) must still fire on the Coder's own PR; that is the review workflow.
Line 490 is the single choke point all four event shapes funnel through, after every side effect.

**Identities:** two of three slugs are already resolved at boot and in scope —
`reviewerProvisioned.appSlug` (`apps/runtime/src/app.ts:105`) and `coderAppSlug`
(`app.ts:73`, currently swallowed into the Coder runtime). Comparison form is established at
`packages/agents/src/capabilities/coder/repair-tool.ts:74`:
``const expectedAuthor = `${reviewerAppSlug.toLowerCase()}[bot]`;``

> ### ⚠ MANDATORY EXEMPTION
> The Brain is explicitly instructed to act on a review from **its own Reviewer App**
> (`agent.ts:84` — `repair_pull_request`). A naive "drop everything we authored" rule **kills the
> change-request repair loop dead**. Rule 1 must read: *drop self-authored events **except**
> `pull_request_review.submitted` authored by the Reviewer slug.* This is the sharpest edge in
> Build B.

**Audit trail is preserved:** settle as `unsupported` with `error: "self-authored by <login>"`. The
`github_ingress_deliveries` CHECK constraint (`ingress-store.ts:99`) already permits it; nine
existing paths already do this. No migration.

*Lazy fallback if plumbing the third (Planner) slug is unwanted:* `payload.sender.type === "Bot"` is
one line and zero wiring. `ponytail:` known ceiling — also silences Dependabot and Renovate.

### Rule 2 — do not wake for an unroutable repository

**Where:** `apps/runtime/src/host/whatsapp-runtime.ts:388`, the
`if (brainReady) void wakeBrain(...)` inside `configureGitHubUpInbox`.

```ts
const repo = graph.resolveIdentity("github", event.repository, "repository");
const routable = repo !== undefined && graph.relationsTo(repo.entityId, "works_on")
  .some((edge) => graph.getEntity(edge.fromId)?.type === "thread");
```

Both calls exist already (`packages/engine/src/graph/store.ts:192,200`). Use the canonical-cased
`event.repository` — the ingress preserves case deliberately because `resolveIdentity` is exact-match
(`ingress.ts:381-386`).

**Critically, this does not drop the event.** It is still admitted durably to `brain_github_events`;
the gate only declines to *wake*. It rides along free on the next wake that happens for another
reason. Zero information loss. This is why it belongs at the wake site, not at ingress.

**It self-heals.** The day `github.surfaceRepositories` is populated, `seedRepositoryFacts` writes the
edge (`seed-repositories.ts:69-72`) and the gate opens on its own. No second knob.

### Rule 3 — suppress a sweep with nothing to sweep

```ts
const hasOpenLoops = () =>
  graph.findEntities({ type: "commitment" }).some((e) => e.properties.status === "open")
  || inbox.pendingScheduledWakes().length > 0
  || inbox.activeWork().length > 0;
```

> ### ⚠ INVARIANT THAT MUST NOT BREAK
> The unconditional wake at `whatsapp-runtime.ts:363-368` is **load-bearing**: it is what retries a
> Batch left claimed-but-undispatched by a prior transient failure. All the `pending*` readers return
> nothing for a claimed batch. Suppressing the wake without preserving this **re-arms a wedge**.
> Requires one new inbox read — `hasOpenBatch()`, two lines over the existing `selectOpenBatch`
> statement (`inbox.ts:1393`). This is the only API addition in Build B.

Pass `hasOpenLoops?: () => boolean` in `BrainInboxOptions` (`inbox.ts:453`), **defaulting to `true`**
so every existing test and the historical-replay path are unchanged.

`ponytail:` naive full scan of commitment entities — single-digit entities today. Add a
`json_extract(properties_json,'$.status')` index past a few thousand.

### Rule 4 — debounce the rest

`packages/engine/src/coalescer/debounce-actor.ts` was already generalised over element type for
exactly this (header cites #149) and is already instantiated twice. A third costs ~15 lines.

**The buffer is discarded** — `claimBatch` drains every pending input regardless of what triggered the
wake, so the buffer is a pure timing token and `flush` just calls `wakeBrain` once.

```ts
type WakeSignal =
  | { kind: "intent" }            // human asked something — never waits
  | { kind: "specialist_result" } // a human is waiting on this — never waits
  | { kind: "github" } | { kind: "knowledge_delta" } | { kind: "clock" };

const brainWakeLoop = debounceActor<WakeSignal, "settled" | "capped" | "urgent">(
  { debounceWindow: Duration.seconds(30), maxWait: Duration.minutes(2), cap: 20 },
  {
    fireNow: (s) => (s.kind === "intent" || s.kind === "specialist_result" ? "urgent" : undefined),
    reasons: { debounce: "settled", maxWait: "capped", capacity: "capped" },
    flush: () => Effect.promise(() => wakeBrain(brainInbox)).pipe(Effect.catchCause(...)),
  },
);
```

`fireNow` is checked before the cap and before any wait (`debounce-actor.ts:67-68`), so
`escalate_intent` → wake stays synchronous. Bridge the six non-Effect call sites with
`Queue.offerUnsafe`, the established pattern from the sibling instantiation
(`packages/engine/src/coalescer/whatsapp.ts:146`).

> ### ⚠ SHARPEST EDGE IN BUILD B
> `flush` must be `Effect.Effect<void>` and `wakeBrain` returns a Promise that can reject. **If a
> transient dispatch failure escapes `flush`, the wake fiber dies and the Brain is wedged
> permanently.** Catch fully inside `flush`.

### Expected reduction (estimate)

| Stage | Wakes | Certainty |
|---|---|---|
| Today | **191** | measured |
| − Rule 1 | 191 → ~106 | estimate — verify with the query below |
| − Rule 2 | ~106 → **50** | **certain** — all 141 GitHub wakes go to zero |
| − Rule 3 | 50 → ~26 | estimate (~52 of 58 sweeps have nothing to sweep) |
| − Rule 4 | ~26 → **~30 total** | estimate, band 25–40 |

**~84% fewer wakes (band 80–87%).**

Verify Rule 1's real value before believing it:

```sql
SELECT json_extract(detail_json,'$.sender.login') AS sender, count(*)
FROM brain_github_events GROUP BY 1 ORDER BY 2 DESC;
```

### What Build B does NOT fix

Every surviving wake still costs ~364,596 tokens. The gate cuts *how often*, never *how much*. It is
a constant-factor win against a rising cost — which is precisely why Build A is being done alongside
it.

---

## 5. Held: Build C — decompose into four lanes

**Not rejected. Held.** Router (GitHub, 57% of inputs) / Curator (Scribe deltas) / Steward (wakes +
specialist results) / Deliberator (chat intents), each with its own model tier — and the per-role
model machinery exists today without #376, since `AGENT_MODEL_ROLES`
(`packages/engine/src/model/pi-subscription.ts:55`) and `AgentModelProfilesSchema`
(`schema.ts:89-96`) are already per-role.

It has an incremental path — rung 1 extracts only the Router, ~1 day, one `ALTER TABLE
brain_batches ADD COLUMN lane`, revertible by reverting one wake call site.

**Why it is held:**

1. **It fights a documented invariant.** `docs/SYSTEM-ARCHITECTURE.md:38` — *"There is exactly one
   mind — the **Brain**"* (verified). That is an ADR-and-re-litigation cost larger than the diff.
2. **Probably premature.** 191 wakes in 2 days is ~4/hour. Nothing is throughput-bound, and there is
   no evidence in the measured data of a single coherence failure or mis-route.
3. **Build A gets most of the same money for one boundary instead of four.**

**Prerequisite if it is ever built:** `brainGraphContext()` currently resolves authority via
`claimBatch()` — "whatever batch is open" (`agent.ts:32-35`). With concurrent lanes that is a race
that lets one lane write attestations under another's evidence set. It must become
`brainGraphContext(batchId)`. **This is NOT a prerequisite for A or B** (the single wake semaphore
keeps it unambiguous) — do not over-build it now.

**C's one insight worth carrying forward regardless:** different input kinds deserve different model
tiers. That becomes cheap once the Brain is stateless.

---

## 6. Open questions for Aaron

1. **Do you want the coworker announcing GitHub activity in the groups?** Filling in
   `surfaceRepositories` switches this on. Until now it has been structurally silent about every PR
   and issue. This is a product decision, not a bug fix, and it changes Rule 2's value: fix the
   config and Build B's saving drops from ~84% to ~20–30%, because a large part of B's measured win
   is efficiently not-doing work that is currently broken.
2. **Which model per role**, once a provider key exists. Suggested starting point: keep the Brain on
   the strongest available (`deepseek-v4-pro` or `qwen3.7-max`), put Speaker and Scribe on
   `deepseek-v4-flash` or `glm-5.1`. Every role must share one provider until #376.
3. **Is the constraint dollars or rate-limit units?** Build A raises fresh tokens ~4× while lowering
   total cost ~60%. If limits are denominated in fresh input, that trade needs checking.
4. **Should trace payloads be turned on?** Prompt inputs are not currently logged, so production
   traces cannot become eval rows without a database join. Turning them on means chat content leaves
   the box — redaction needed first.

---

## 7. How to tell whether it worked

**Deterministic, no model needed — these belong in CI:**

- A burst of N GitHub events produces ≤ 2 Brain wakes.
- A webhook whose sender is one of our own apps produces no wake — **and** a
  `pull_request_review.submitted` from the Reviewer slug still does.
- A sweep tick with no open commitments, no pending wakes and no active work produces no wake — and
  one with a claimed-undispatched batch still does.
- Brain prompt tokens per wake stay under a ceiling (suggest 20,000).
- An `escalate_intent` still wakes synchronously while a webhook is waiting in the debounce.

**Before/after on real traffic:**

Export the **191 recorded Brain decisions** as a fixed dataset, replay them through the new Brain,
and diff the effect sets. Anything that used to speak and now stays silent — or vice versa — is the
behavioural drift Build A warns about. This is only possible *after* Build A, because a stateful Brain
cannot be replayed.

**Cost:** Braintrust project `co-worker`, `flue.prompt` spans, `metadata["flue.usage"]`, grouped by
`metadata["flue.instance_id"]` (`global` = Brain).

---

## 8. Where this slots into the rollout

The active rollout is **#363** (retire the CLI → web console), with #364–#383 beneath it. This work
is orthogonal — it touches the Brain's dispatch and the GitHub ingress, not the CLI or the console —
so it can run in parallel.

Related open issues: **#376** (provider per agent role — unlocks mixing vendors), **#255** (switch on
the observability that already exists), **#316 / #350 / #348 / #351** (eval coverage, all still
valid). **No issue exists yet for a Brain eval harness or for this cost work** — that is the gap on
the board.

---

## 9. Provenance

Investigation was read-only against the live rig and this tree. The three architecture proposals were
produced by independent agents given identical measured facts and told to argue one stance each.
Where a proposal's claim was checkable it was checked — one claim (that `CONTEXT.md` pre-authorises a
Brain push digest) was **not** confirmed: the text describes the Brain seeding extra context into a
*Speaker's* turn, not the Brain receiving one. Do not cite it as precedent.
