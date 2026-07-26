# Re-plan handoff — read this before planning anything

**Written 2026-07-26, from a context window that ran too long.** This exists so a fresh session can
pick up with the full picture and no prior conversation. It **records and enumerates; it decides
nothing.** Every open decision is in §6, unanswered on purpose.

Two things are true at once and must not be confused: the **live rig is healthy right now**, and the
**plan for what to build next has come apart**. Fixing the first did not fix the second.

---

## 0. How to use this document

Read §1 to know what is running. Read §2 for the real reason the DAG stopped — it is not what the
last handoff said. §3–§5 are the problems, in layers. §6 is the only thing that needs a human. §7 is
what was changed on the live box tonight and how to undo it. §8 is a gap in the tooling itself.

**Do not run `/dag:plan` yet.** It will route to `/dag:replan`, and re-planning the web-console chart
in isolation is exactly the mistake this document exists to prevent — see §6.1.

---

## 1. Where the system actually is

### The rig is alive

| | |
|---|---|
| Host | `capxul-vps` — systemd `ambient-agent.service`, port 3737 |
| Data | `~/.ambient-agent/` |
| Deployed build | `ambient-agent 0.4.0`, `dist/server.mjs` sha256 `ceb85c00e7eb…` |
| Model provider | **`opencode-go`** (API key), switched 2026-07-26T05:03Z |
| Health | `ok:true`, `runtime.state:"healthy"`, `whatsapp.phase:"online"` |
| Brain | settling Batches normally — 8–30s each, zero errors |

**The deployed build predates #366, #374 and #375.** Those three merged to `main` on 25 July but were
never deployed. The box is running the `cc88362`-era tree. Any rig proof for those nodes requires a
deploy first.

Model assignment now live (#398 §0's decision; `planner` was unnamed there and took the coder value):

| role | model | thinking |
|---|---|---|
| brain | `deepseek-v4-pro` | high |
| speaker · scribe | `deepseek-v4-flash` | minimal |
| planner · coder · verifier | `kimi-k2.7-code` | medium |

**The API key is not an environment variable** and the product refuses that shape
(`apps/cli/src/program.ts:538`). It lives in `~/.ambient-agent/credentials/model-api-key.json`, mode
0600, referenced from `config.json` by name (`model.credential: "api-key"`). The CLI path demands an
interactive paste and cannot be scripted over ssh; writing the two files directly with the service
stopped is safer anyway, because `ambient-agent config` opens a second WhatsApp client (#311).

### The repository

`main` at `387b744`. Nothing uncommitted. Tier baseline, **run** on a clean
`pnpm install --frozen-lockfile`:

| tier | command | result |
|---|---|---|
| 1 | `pnpm run typecheck` · `pnpm test` | **GREEN** — 959 passed |
| 2 | `pnpm run evals:deterministic` | **RED** — 2 files, 5 tests |
| 3 control-plane | local build + browser | green during the run |
| 3 WhatsApp | the rig | reachable again as of tonight |
| 4 | `ssh` + `application.sqlite` | green |
| 5 | Braintrust `co-worker` | key **is** present on the rig |

> **A baseline is only worth its install.** The first run of this baseline reported tier 1 red and
> tier 2 failing 15 tests. Both were artefacts of a stale `node_modules`. `pnpm install
> --frozen-lockfile` before every tier command, or the baseline lies in both directions.

---

## 2. Why the run actually stopped

Not the provider outage. Not the wedge in §4. The DAG was halted because of a **planning-method
failure**, and it is worth stating in the owner's own words, because it is the sharpest framing:

> *The architecture changed, but the evals weren't up to date. So it was using the evals as proof,
> and it couldn't actually use that.*

Concretely: **pre-flight signed proof contracts without ever running the tier commands.** Tier 2
(`pnpm run evals:deterministic`) had been red on `main` since 23 July — #317 moved issue filing to
the Brain, and `issue-management.eval.ts` still drove the Speaker. Pre-flight signed two days later
and marked the nodes "runnable, t1..t5". #366 and #375 both merged with tier 2 **NOT PROVEN**.

Three instances of one mechanism:

1. **Tier 2 was unachievable the moment it was signed.** #368, #376 and #379 still carry it.
2. **CI gates tier 1 only.** Neither lint nor evals is gated, and both rotted unnoticed.
3. **Tiers 3-WhatsApp, 4 and 5 were never exercised once** in the entire run — and #366, #374, #375
   now all owe them simultaneously.

The plugin-side repair shipped as dag-plugin v0.10.0 (baselining, `dag:halted`, `/dag:replan`,
at-risk cannot survive a signature). **The repo-side repair is #397, and it is scoped too narrowly**
— it names only the issue-management suite, but the base branch also fails
`packages/agents/evals/participation-mechanics.eval.ts:83`, a different file with a different cause.
Tier 2 is one command; it stays red until both pass.

### And a deeper doubt about the evals themselves

The owner's position, recorded verbatim because it changes what "repair" means:

> *The evals themselves are garbage — I don't think we've even designed the evals in the first place.
> I didn't really understand the evals and I just let the agent do his thing.*

So #397 may be the wrong shape entirely. "Repair the eval suite so tier 2 goes green" assumes the
suite measures something worth measuring. That assumption has never been tested. **See §6.4.**

Related, from #398 §2.7: there are **zero Brain evals**, **zero Braintrust datasets**, and production
tracing is payload-thin — 3 of 381 `flue.prompt` trace roots carry an `input`, and all 1,682
`llm:agent` spans carry neither input nor output. **Almost nothing about this system is measurable
today.**

---

## 3. The architectural finding — verified tonight, in no prior document

### The coworker has never learned a single thing from GitHub

Queried against the live graph on the rig:

| source of evidence | attestation references |
|---|---|
| `arrival:` — WhatsApp messages | **556** |
| `config-authorization` | 8 |
| **anything GitHub-sourced** | **0** |

Graph totals: 124 entities, 168 relations, 536 attestations. Authors: `scribe` 385, `migration`
(legacy) 126, `brain` 17, `ingester` 8.

**151 GitHub events have passed through this system and left zero trace.** The coworker does not know
that any issue was opened, any pull request raised, any review submitted. Not "knows and stayed
quiet" — does not know.

### It is not a missing capability

The Brain is given the **full** graph write set — `record_entity`, `record_relation`,
`merge_entities`, `rule_attestation`, `lookup_graph` — via `createBrainGraphTools`
(`packages/agents/src/capabilities/graph/tools.ts:250`, wired at
`packages/agents/src/brain/agent.ts:56`).

It is **never instructed to use them for a GitHub event.** The entire instruction
(`packages/agents/src/prompts/catalog.ts`, `instructions(PROMPT_IDS.brain, …)`) is:

> "A GitHub event is a real happening (an issue opened, a pull request, a review) carrying its
> repository and detail; it is never pre-routed. To route one: `lookup_graph` the repository, follow
> its `works_on` relation to the interested thread, then `prompt_speaker` with that thread's entity
> id as the target… **If no thread works_on the repository, or the target resolves to no Surface,
> `stay_silent`.** Never assume every Surface hears every event."

Route it, or go silent. **Neither branch records anything.** The only graph-write guidance anywhere in
the Brain's instructions concerns *ruling on the Scribe's proposals*, never recording new facts.

There are **zero** `thread --works_on--> repository` edges on the rig (that edge is seeded only from
the optional config field `github.surfaceRepositories`, which is absent). So the routing precondition
could never be satisfied and every GitHub event was structurally guaranteed to end in silence.

### What this reframes

- The **164 `stay_silent` decisions (81% of all effects) were not restraint. They were amnesia.**
- **#398's diagnosis was aimed at the wrong target.** It framed 141 wasted wakes as a *cost* problem
  and proposed gating them out. The owner's framing — which the data supports — is that those events
  were real happenings the coworker should now **know about**, and the bug is that it learned nothing.
- **Volume was never the problem.** 191 wakes in two days is ~4/hour. Nothing is throughput-bound.

---

## 4. The wedge — #400

Independent of everything above. When the ChatGPT/Codex provider began timing out on **24 July**, it
killed a Brain dispatch mid-flight. Flue settled that submission **with an error after one attempt**;
the application's Batch stayed **open forever**. Two guards then conspire:

```ts
// packages/engine/src/brain/inbox.ts:1390
const open = selectOpenBatch.get();
if (open !== undefined) { database.exec("COMMIT"); return hydrateBatch(open); }  // drains nothing
```

```ts
// packages/agents/src/brain/dispatch.ts:29
if (batch === undefined || batch.dispatch !== undefined) return batch;   // returns, silently
```

Every wake re-claimed the same dead Batch; `wakeBrain` returned without re-dispatching, **without
logging anything**. The Brain sat frozen for **38 hours** while `/health` reported `healthy`.

**Cleared by hand tonight. Not fixed in code — it can re-form on the next mid-flight failure.**

This also **corrects #398 §4** (the Rule 3 invariant box), which claims the unconditional wake
*"retries a Batch left claimed-but-undispatched."* It retries a Batch left **undispatched**. A Batch
left **dispatched-and-abandoned** hits guard 2 and is never retried at all. The two states differ by
one nullable column and only one has a recovery path.

**No cheap authoritative fix exists.** The truth lives in Flue's `flue_agent_submissions.status`, but
`@flue/runtime` exposes only `getRun(runId)`, and `runId` and `dispatchId` are different id spaces.
The submission store is reachable only through `@flue/runtime/adapter`, a persistence surface rather
than an application API. Three candidate fixes with trade-offs are written up on #400. **See §6.5.**

---

## 5. Everything else still open

### Carried out of the halted run, never settled

- **#368 and #377 still hold `dag:at-risk`.** Under v0.10.0 an at-risk verdict cannot survive a
  signature — each must be settled or become a de-fog node that blocks it. #377's is unresolved:
  "work in flight" traces to no upstream node.
- **`StoredPrompt` never got a type-design pass** — the assigned reviewer died on a credit limit. It
  is the contract **#379 inherits**.
- **Two known-flaky tests**: `tests/managed/setup-lock.test.ts` (real subprocesses, 15s budget, from
  #369) and **#399** (whatsapp-runtime reaction-window racing a 30ms clock).
- **#366's operational finding**: the CLI must run as the service user on the rig — every command
  opens and seeds the store the runtime holds open, so `sudo ambient-agent doctor` leaves a
  root-owned journal the service user cannot roll back. A read-only diagnostics path is the follow-up.
- **#373's fiber-teardown obligation** ends in `process.exit` and is in no node's criteria.

### From #398, still valid and uncontested

- **No self-authored-event filter.** `packages/engine/src/github/ingress.ts` parses `payload.sender`
  into every draft and never compares it against the coworker's own three GitHub App identities. Its
  own Coder opening a PR wakes it exactly like a human would.
- **A self-winding clock.** `DEFAULT_PROACTIVE_CLOCK_INTERVAL_MS = 5 * 60 * 1000`
  (`apps/runtime/src/host/whatsapp-runtime.ts:328`), hard-coded and absent from the config schema.
- **Shadow state.** The Brain runs as one conversation, `agents/brain/global`, that has never reset —
  **4,678 entries**, and `flue.sqlite` is now **135.6 MB**. Every wake reads ~364,596 tokens to write
  ~180, and ~97% of what it reads is its own accumulated transcript. The Scribe already does this
  correctly with a fresh instance per attempt (`packages/agents/src/scribe/coalescer.ts:123`).
  **This finding is uncontested and survives everything in §3.**

### The state of the two charts

| chart | state |
|---|---|
| **#363** — retire the CLI → web console | **`dag:halted`**. 8 nodes merged; #366 (`15421b9`), #374 (`b3b8e77`), #375 (`ce17090`) are **merged but open**, each owing tiers 3–5 on a rig running an older build. 20 nodes sit behind them. Two at-risk nodes unsettled. |
| **Brain work** (#398) | **never charted.** And its design premise collapsed tonight — see §6.2. |

---

## 6. The decisions — enumerated, not taken

**Nothing below has been decided. Do not decide them by inference from this document.**

### 6.1 Is this a re-plan, or something larger?

The routing table will send `/dag:plan` to `/dag:replan` because #363 carries `dag:halted`. But
`/dag:replan` amends *one chart's* contracts. The owner's position is that the problem is above that:

> *This isn't the final form. This is supposed to be the baseline form — an extendable system. Right
> now we're talking about GitHub and GitHub issues, but it doesn't have to be just GitHub. There are
> primitives we don't even have, that we haven't even modeled — tasks, to-do lists — because we don't
> have the agents for them either.*

**Open:** does #363 get re-planned as a chart, or does the whole effort-level picture get worked out
first (see §8)? Re-planning #363 in isolation would sign a chart whose destination may be wrong.

### 6.2 What is the Brain *for*?

Two incompatible models are live in the codebase and the documents:

- **Model A (implemented):** the Brain decides **whether and whom to speak to**. `stay_silent` is a
  legitimate terminal outcome. GitHub events are routed or dropped.
- **Model B (the owner's):** the Brain's purpose is to **process information and make it retrievable**.
  Speaking is one optional consequence. An event that produces no memory is a failure regardless of
  whether speech was warranted.

Model B makes §3 a severe bug. Model A makes it working-as-designed. **Everything downstream depends
on which is true**, including whether #398's Build B Rule 2 (don't wake for an unclaimed event) is a
saving or a permanent lobotomy.

### 6.3 Whose job is recording a happening?

The owner's instinct, recorded:

> *Is this something the agent should be doing? I don't think so. It sounds like either the regular
> Scribe's job or a special Scribe's job. The Brain shouldn't be doing that.*

Today the Scribe extracts knowledge only from WhatsApp arrivals; GitHub events go straight to the
Brain and produce no knowledge. **Open:** does the Scribe grow a second intake for non-chat surfaces,
does a new specialised Scribe appear, or does the Brain keep it? This is an architectural boundary
question, not a prompt fix.

### 6.4 Routing is **not** an open decision — it is settled canon the code violates

This started as an open question and closed while writing this document. The owner's position tonight:

> *The routing — saying "this thread goes to here" deterministically — was the problem. It should be
> the agent that decides what it wants to do. It might message me in a direct message, it might
> message a group, it might message nobody. It depends on what it knows, its memories, its reasoning
> at the time. Those decisions did need a model.*

**`docs/SYSTEM-ARCHITECTURE.md` already says exactly this**, and has for some time:

> **Why nothing drops.** Because the Brain is the home of last resort. An event that correlates to no
> surface still lands in the inbox; **the Brain decides where it belongs (route it, DM someone, open a
> loop, or deliberately hold it). "Uncorrelated" is a decision the Brain makes, never a silent
> discard.** — §on ingress, `:278`

> **Multiple projects per surface, or multiple surfaces per project.** … the mapping of "which surface
> cares about which project" is **data in the Graph, not hard-wired configuration — the Brain resolves
> it per decision.** — §11, `:601-604`

> **New event sources** (monitors, calendars, CI, external webhooks). … **No new routing concept is
> needed — routing is "the Brain decides," and it already does.** — §11, `:592`

> The Brain chooses **surface and voice** as part of every decision. — `:529`

> the Brain decides which Surface, if any, hears each event — §13 table, `:660`

**So the code is in violation of its own documented architecture, in two places:**

1. `github.surfaceRepositories` seeds the `thread --works_on--> repository` edge
   (`packages/agents/src/capabilities/graph/seed-repositories.ts:66-75`) — hard-wired configuration
   routing, which `:604` explicitly forbids. That file's own author flagged the discomfort in a
   `ponytail:` comment.
2. The Brain's instruction mandates `stay_silent` when the lookup fails — **a silent discard**, which
   `:278` explicitly forbids. Canon says the failure mode is *open a loop or deliberately hold it*,
   both of which imply a memory. §3's zero-GitHub-knowledge finding is this violation's measurable
   consequence.

**And #398 §4.5's provenance routing violates the same canon** — `source_surface_id` is another
hard-wired rule, just keyed differently. It should be rejected on canon grounds, not on preference.

> ### ⚠ This correction has now been made at least twice
> A session on **2026-07-23** recorded the identical finding — that `surfaceRepositories` and
> `file_issue`'s surface resolution are *"DRIFT / a routing shortcut to REMOVE, not the design"*, with
> the note **"NEVER re-propose config-mapped or surface-hardcoded routing."** #398 was written two
> days later and re-proposed exactly that, in a new form. **This is class-recurrence, and the class is
> "a routing rule keeps getting reinvented in config because the Brain was never given what it needs
> to decide."** Treat any future proposal that resolves a Surface from a table as this same defect.

**What remains genuinely open** is not *whether* the Brain decides, but *what it needs in order to
decide well* — which is §6.2 and §6.3, and is the real work. Build A (stateless Brain) is untouched
by any of this and survives.

### 6.5 Do the evals get repaired, or designed?

#397 assumes repair. The owner says they were never designed. **Open:** does tier 2 get fixed as-is
so the chart can be signed, or does "what should this system's evals actually measure" become its own
piece of work? Note #398's finding that two ready-made eval sets already exist and need *exporting*,
not authoring: 191 real Brain decisions in `application.sqlite`, and ~13 moments in WhatsApp history
where the owner stated intended behaviour in his own words.

### 6.6 The remaining concrete calls

| # | decision | notes |
|---|---|---|
| a | **#400 fix mechanism** — staleness bound / boot reconciliation / re-dispatch | three candidates with trade-offs on #400; unfixed means it re-forms |
| b | **The 73 discarded GitHub events** | intact in `brain_github_events`, one `UPDATE` re-queues them; pointless until §6.2 and §6.3 are settled, since today they would produce silence and no memory |
| c | **Deploy #366/#374/#375 to the rig** | required before any tier 3–5 proof; the box runs an older build |
| d | **Sequencing** — web-console chart vs Brain work | unchanged from the original fork, now with §6.1 above it |
| e | **Surviving credit/context exhaustion mid-run** | it already cost a reviewer mid-review (`StoredPrompt`) and ended this session; there is no mechanism for it |

---

## 7. What was changed tonight, and how to undo it

| change | reversible? | how |
|---|---|---|
| Provider → `opencode-go` | yes | `config.json.bak-preopencode-20260725T210315Z` and the matching key-file backup, both on the box |
| Wedge cleared: 1 dead Batch settled | yes | `~/backups/application-prewedgefix-20260726T050502Z.sqlite` — but restoring re-wedges the Brain |
| 73 GitHub events + 2 wakes absorbed into the dead Batch | yes | rows intact with full payloads; `UPDATE brain_github_events SET batch_id=NULL WHERE batch_id='brain-batch:c908eb74…'` |

**Nothing was deleted.** No code was changed. `whatsapp/` was never copied — the map's single-home
constraint held throughout.

**Honest note on the discard.** The reasoning given at the time was "those events were guaranteed to
produce silence, so processing them is waste." That accepted a broken premise as normal. The outcome
is unchanged — draining them would have produced 73 more `stay_silent` and still zero knowledge,
because the instruction never says to record — but the reasoning was wrong and §3 is why.

---

## 8. A gap in the tooling, not just the plan

`effort` is load-bearing vocabulary in the dag plugin — "one chart per effort", the run profile,
`/dag:replan`'s rule for splitting a second map — and **`GLOSSARY.md` never defines it**. Every other
load-bearing term has an entry.

The planning half opens at *"**design tree** — the plan seen as decisions"*, i.e. from a plan that
already exists. `chart` takes "a plan that is already grilled or specced". `grill` sharpens a plan you
have. `/dag:plan` with no chart says *"ask which effort this chart covers, then grill it"* — one
question to the human, and that is the entire discovery phase.

| level | answers | exists? |
|---|---|---|
| **(missing)** | what is this system, what efforts exist, how do they relate | **no** |
| chart / map | what nodes in what order, for **one** destination | yes |
| grill | which decisions inside this plan are unsettled | yes |
| node | one buildable slice and its proof | yes |

A **map is within one effort**; what is missing is the level above it. That is why #363's
"Destination" paragraph was hand-written with no process behind it, and why there is nowhere to put
"tasks and to-do lists are unmodeled primitives" or "GitHub is one surface among several."

**Open (owner's framing): does the plugin need a new top-level move, and is it a distinct thing from
`map`?** The evidence above says yes and yes. It is a change to `dag-plugin`, not to this repo.

---

## 9. Suggested first moves for the fresh session

Deliberately not a plan — the plan is §6.1's to decide.

1. **Read `docs/SYSTEM-ARCHITECTURE.md` §11 and `:270-282` before anything else.** §6.4 shows the
   code is in violation of it, and §11 is explicitly the extensibility section — it already answers
   part of "is this the right architecture for a system that isn't only GitHub" (new event sources,
   new backstage agents, multiple surfaces per project). It does **not** answer the unmodeled-primitive
   question (tasks, to-do lists), which is genuinely new ground.
2. **Then read this file, then #400, then #398** — in that order. #398 is excellent measurement with a
   diagnosis §3 and §6.4 partly invalidate; read it for its numbers, not its conclusions.
3. **Do not run `/dag:plan`** until §6.1 is settled.
4. **Settle §6.2 first.** It gates §6.3 and most of #398. Nothing else is worth planning until "what
   is the Brain for" has an answer. §6.4 is already answered — by the architecture doc, not by a
   fresh decision.
4. Treat the rig as healthy and leave it alone. The only live risk is #400 re-forming, which presents
   as the coworker going quiet while `/health` still reads `healthy` — check
   `SELECT count(*) FROM brain_batches WHERE settled_at IS NULL` before believing any health output.
