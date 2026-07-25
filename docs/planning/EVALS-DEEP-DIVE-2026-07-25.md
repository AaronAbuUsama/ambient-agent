# Evals deep dive — where we are, how the pieces work, and the system to build

Written 2026-07-25. Everything below is checked against this tree, the live rig
(`capxul-vps`, `~/.ambient-agent/application.sqlite`), and the Braintrust org `The Call`.

---

## The headline

You are much further along than "I don't know where to start". The eval machinery is built
and the production trace pipe is live and flowing. Three specific things are missing, and
they are the reason it doesn't feel like a system:

1. **No evals exist for the Brain** — the agent that makes almost every decision you dislike.
   All 29 existing eval cases test the Speaker, Coder, Reviewer, Scribe and issue tools.
2. **Zero Braintrust datasets.** Experiments log ad-hoc rows and vanish. Nothing is a
   fixed benchmark, so nothing can be compared across a change.
3. **Production traces record what the agent *did*, never what it was *asked*.** Only
   3 of 381 trace roots carry an input payload. The trace is half a row.

Everything else — judges, rubric axes, thresholds, the Braintrust exporter, the observer —
already works. This is a wiring and discipline problem, not a build-from-scratch problem.

---

## Part 1 — What actually exists today

### The agent roster

| Agent | Where | Model profile | Eval cases today |
|---|---|---|---|
| **Brain** (master) | `packages/agents/src/brain/agent.ts` | `gpt-5.6-luna`, thinking **high** | **0** |
| **Speaker** | `packages/agents/src/speaker/agent.ts` | `gpt-5.6-luna`, minimal | 12 |
| **Scribe** (graph extraction) | `packages/agents/src/scribe/agent.ts` | `gpt-5.6-luna`, minimal | 5 |
| **Coder workflow** | `apps/runtime/src/workflows/coder.ts` | planner/coder/verifier, minimal | 5 |
| **Reviewer workflow** | `apps/runtime/src/workflows/reviewer.ts` | minimal | 6 |
| Issue management (capability) | `capabilities/issue-management` | — | 8 |

Evidence: `find packages -name "*.eval.ts"`, `~/.ambient-agent/config.json` on the rig.

The Brain owns `file_issue`, `prompt_speaker`, `stay_silent`, `schedule_wake`, every issue
mutation, and specialist dispatch (`brain/agent.ts:52-70`). It is the decision owner and it
has no eval at all.

### The eval machinery that works

- **Runner** — `scripts/run-evals.ts` boots a Flue fixture app on a random port, then runs
  Vitest against `vitest.evals.config.ts`. Two families: `deterministic` (faux responder,
  fast, free) and `live` (real model, judged).
- **Harness** — `packages/test-support/src/evals/harness.ts` prompts an agent over its
  public HTTP route via `@flue/sdk`, and normalises the reply into
  `{ text, whatsappEvents, githubEvents, githubOperations }` plus a transcript of tool calls.
  Seeds fixtures per case (`resetWhatsApp`, `history`, `githubIssues`).
- **Judges** — `packages/agents/evals/rubric-judges.ts`. Five graded axes, each with a
  quoted ratified criterion, a threshold, and a **separate judge agent** (`rubric-judge`)
  so the grader isn't the model under test. The judge is handed the *actual skill text*
  and told not to reward behaviour the skill doesn't authorise. That is a genuinely good
  design and most teams don't get there.
- **Braintrust export** — `packages/test-support/src/evals/braintrust-reporter.ts`. Each
  graded case calls `recordRubricScore(...)` which logs to a Braintrust experiment and
  accumulates a pass rate; `finishBraintrustReport` throws if an axis misses its threshold.

The ratified axes and their gates:

| Axis | Metric | Threshold |
|---|---|---|
| 1 | address forms (engage / silence) | ≥ 95% |
| 1 | unsolicited reply rate | ≤ 5% |
| 2 | usefulness when addressed empty-handed | ≥ 90% |
| 3 | issue capture is a conversation | ≥ 80% |
| 4 | multi-message windows, one per concern | ≥ 50% |
| 6 | elicitation persistence | ≥ 80% |

### The production trace pipe — live right now

Tracing is **on** and pointed at Braintrust project **`co-worker`**
(`ac7f8405-ae21-47ff-b962-7fe70a936fdb`), configured at
`~/.ambient-agent/config.json → runtime.tracing.enabled: true`, wired through
`packages/engine/src/braintrust.ts` → `apps/runtime/src/app.ts:141`.

Traffic since 2026-07-23: **3,220 spans / 382 traces**, most recent at the time of writing
13:55 today.

What the Brain actually decided, from production spans:

| Tool | Calls |
|---|---|
| `settle_brain_batch` | 169 |
| `stay_silent` | 151 |
| `lookup_graph` | 114 |
| `say` | 24 |
| `prompt_speaker` | 17 |
| `say_directive` | 16 |
| `escalate_intent` | 15 |
| `file_issue` | 10 |
| `submit_review` | 13 |

**The Brain chooses silence on roughly 90% of the batches it settles** (151 `stay_silent`
against 17 `prompt_speaker`). Every one of those carries a natural-language `reason` — for
example:

```json
{ "batchId": "brain-batch:abe9efc0…",
  "reason": "No new evidence or changed loop state is present. Existing scheduled
             follow-up remains sufficient; no duplicate chase is warranted." }
```

That reason string is directly gradeable. This is the single richest untapped eval source
you own.

### The chat corpus

Live rig, `application.sqlite`:

| Table | Rows |
|---|---|
| `conversation_messages` | 641 |
| `conversation_events` | 1,435 |
| `managed_chat_windows` | 69 |
| `brain_intents` | 22 |
| `brain_effects` | 203 |
| `surface_deliveries` | 18 |
| `github_issue_operations` | 22 |

Two managed groups: `120363410063306573@g.us` (TST, 167 msgs) and
`120363428464069244@g.us` (The Call, 79 msgs).

---

## Part 2 — The three gaps, precisely

### Gap 1 — The Brain has no evals, and it is where the failures live

The Speaker is a mouth. The Brain decides whether to speak at all, what to file, which repo,
which labels, whether to dispatch a specialist. Nearly every complaint you have raised in
chat is a Brain decision, and none of them are testable today.

Look at where the eval harness attaches: `createFlueAgentHarness({ agentName: "speaker" })`.
It prompts one agent over HTTP with a synthetic message. The real path is:

```
WhatsApp → intake → coalescer → Window → Speaker(escalate_intent)
                                            ↓
                             Scribe → Brain Batch → Brain
                                            ↓
                        Effects: stay_silent | prompt_speaker | file_issue | dispatch
                                            ↓
                                Speaker(say) → surface_deliveries → WhatsApp
```

Evals sit only on the first and last box. The middle — the decision — is unmeasured.

### Gap 2 — No datasets, so nothing is a benchmark

`list_recent_objects(dataset, "ambient agents")` returns `[]`.

Twelve experiments exist, all from 2026-07-16/17, nine days stale. They were produced by
`recordRubricScore` logging rows *as the suite ran*, meaning the input set was whatever the
test file happened to contain that day. Change the test file and you have changed the
benchmark, so a score movement can't be attributed to the agent.

A benchmark needs a **fixed, versioned dataset** that experiments run *against*. That is
exactly the Braintrust primitive that is unused.

### Gap 3 — Traces are half a row

Verified by query against the `co-worker` project:

| Fact | Value |
|---|---|
| `flue.prompt` trace roots | 381 |
| …of those, carrying an `input` payload | **3** (all compaction spans) |
| `llm:agent` spans | 1,682 |
| …carrying input or output | **0** |
| Tool spans carrying full args + result | **all of them** |

So today's trace tells you *the agent called `stay_silent` with this reason* but never
*here is the Window of messages it was reacting to*. You cannot replay it, and you cannot
turn it into an eval row on its own.

**The fix is cheap and it is already half-done.** The tool span input carries `batchId`.
`brain_batches` in SQLite joins to `brain_intents` → `evidence_ids` → `conversation_events`
→ the actual messages. The join key is already in the trace. Reconstructing the input side
is a script, not a redesign.

---

## Part 3 — The kinds of evals, and which ones you need

People say "evals" for four different things. Keeping them separate is most of the clarity.

| Kind | Question it answers | Cost | Where it belongs |
|---|---|---|---|
| **Deterministic / assertion** | Did it call the right tool with the right args? | free, ms | CI on every PR |
| **Model-graded (LLM judge)** | Was the reply *good* — natural, honest, right length? | ~$, seconds | nightly + before a prompt change |
| **Reference-based** | Does the output match a known-good target? | free | where a golden answer exists |
| **Online / production monitor** | Is the live agent drifting, right now? | ~$ | continuous, sampled from traces |

You have the first two. You have no reference-based evals (no golden set) and no online
monitoring (traces exist but nothing scores them).

### The distinction that matters most for your complaints

Almost everything you have flagged is a **negative** — the agent should have stayed quiet,
should *not* have filed in the wrong repo, should *not* have claimed a DM was impossible.
Negatives are where eval suites quietly fail, because a suite of positive cases tunes the
model toward doing *more*, which is precisely the "robotic, treats everything as a task"
failure you named.

Issue #316 already says this in one line and it is the single most important sentence on
the board:

> The negatives (stayed silent) are asserted as strictly as the positives. A silent-by-default
> rule with only positive tests is untested.

### The judge trap

An LLM judge is itself a model that can be wrong. Two rules keep it honest, and your
existing judge already follows both:

1. **Different model from the one under test** — a model grading itself grades generously.
2. **Give the judge the ratified criterion verbatim**, and tell it not to reward behaviour
   the rule doesn't authorise (`rubric-judges.ts:96`).

The third rule you are missing: **calibrate the judge against human labels.** Score 20 cases
yourself, run the judge on the same 20, and measure agreement. A judge you have not
calibrated is a random number generator with good prose.

---

## Part 4 — Braintrust, and what it's actually for

Braintrust has four primitives. You are using one and a half.

| Primitive | What it is | Your status |
|---|---|---|
| **Logs** | Production traces, continuously ingested | ✅ live, 382 traces, but payload-thin |
| **Datasets** | Versioned `{input, expected, metadata}` rows — the benchmark | ❌ **zero** |
| **Experiments** | One run of a task over a dataset, scored | ⚠️ 12, stale, not dataset-backed |
| **Scorers** | Functions (code or LLM) producing 0–1 per row | ✅ 6 rubric axes, local only |

The workflow it is built for — and the one that turns this into a system:

```
production logs ──(pick a bad trace)──> dataset row ──> experiment ──> score
       ▲                                                                │
       └──────────────── ship the fix, compare runs ◀───────────────────┘
```

The move you are missing is the first arrow. In the Braintrust UI, a logged trace has an
**"Add to dataset"** action. That is the entire tagging mechanism you asked for — you don't
have to build one. You read the live feed, and when the agent does something wrong you click
it into a dataset with the correct behaviour as `expected`.

The two things worth knowing that aren't obvious:

- **Experiments are diffed against a base experiment.** `base_exp_id` is already being set in
  your history. Once experiments run over a *fixed* dataset, Braintrust will show you
  per-row regressions — which cases got worse — not just an aggregate that moved.
- **Scorers can run online, over production logs**, on a sample rate. That is how "is it
  drifting today" gets answered without a human reading chat. This is the endgame, not the
  starting point.

---

## Part 5 — Flue's eval story, and where it stops

Flue deliberately ships no eval library (`docs/reference/flue/docs-guide-evals.md`). It
recommends Sentry's **vitest-evals** and provides a blueprint (`flue add tooling vitest-evals`)
that generated the harness you already have.

What vitest-evals gives you: `describeEval`, normalised transcripts, `toolCalls()`,
`createJudge`/`toSatisfyJudge`, tool replay, a JSON report, a local report UI, and a GitHub
Action for PR annotations.

**Where it stops, for you specifically:** the harness is built around
`client.agents.prompt(agent, instance, { message })` — *one agent, one turn, one HTTP call*.
Your failures are multi-agent and multi-turn: a Window coalesced from five messages, escalated
as an Intent, batched with a GitHub event and a Scheduled Wake, decided by the Brain, delivered
by the Speaker.

The doc names the seam to use:

> To evaluate a workflow instead, create a harness around `client.workflows.invoke(...)` and
> return the workflow result as its output.

So the pattern is available — you need a **second harness** that submits a Brain Batch and
returns the chosen Effects. That harness does not exist yet and is the highest-value thing
to build.

Two capabilities in vitest-evals you are not using and should:

- **`it.for([...])` case tables** — your live suite uses this in one place; a dataset pulled
  from production is exactly a case table.
- **Tool replay** — record real tool results once, replay them deterministically. This turns
  a live-only case into a free CI case.

---

## Part 6 — The labelled failures already sitting in your chat data

You said the intended behaviour is stated in the chats. It is, explicitly, and it is
better labelled training data than anything you would write from scratch. Every row below
is a real message with a real timestamp.

| When | What went wrong | Your words | Becomes |
|---|---|---|---|
| 07-24 10:43 | Zeeshan says "Agent super active here. No delay. Lol." → agent silent | *"your still acting a bit robotic you should have responded to this even though its not a task. remember your a simulacra of a human!"* | **Negative case, Axis 1.** Warm banter directed at the agent ≠ ignorable chatter |
| 07-19 → 07-25 | Four real bug reports in The Call group never captured (Dhuhr/Isha timing drift, athan audio cutting off, "Tap to explore" check-in broken, Android has no notification at all) | *"go back through this whole thread and look for all of the issues that you should have created, there's a couple of them"* | **Proactive capture eval.** Highest-value gap: a working coworker files these unprompted |
| 07-24 10:32 | *"I can't safely identify the GitHub repository"* while `TheCallApp/ios-app` sat in `allowedRepositories` | *"it's strange that you don't know what you have access to"* | **#348.** Capability self-knowledge |
| 07-24 10:49 | *"I'm currently connected to this group only, so I can't initiate private chats"* | *"ok thats not true"* | **False capability claim** — worse than a refusal |
| 07-24 10:58 | Issues filed with no labels, no bug/feature class, requester not tagged | *"you're not saying if it's a bug, if it's a feature… I told you to tag me, you didn't"* | **#350.** Issue-quality eval |
| 07-24 11:00 | Filed on `ambient-agent`; you wanted `TheCallApp/ios-app` | *"I didn't want you to create the issue on Ambient Agents"* | **Repo-target inference eval** |
| 07-24 11:01 | Asked for the template only; agent scoped in the eval work too | *"I don't want you to do the eval work I just want you to create the issue template"* | **Scope-adherence eval** |
| 07-24 11:02 | Instruction not acknowledged | *"did you understand my last message. Can you acknowledge it properly please?"* | **#316 half A.** Ack contract |
| 07-24 11:08 | PR opened with no review acknowledgement | *"even if the reviewer has no issues, there should always be some acknowledgement"* | **#351** |
| 07-25 09:47 | Duplicate issue filed | *"this is a duplicate of this problem here"* | **#350.** `github_search_issues` exists and is not called before filing |
| 07-22 21:50 | No typing indicator | *"you're always supposed to have a typing indicator when you're about to speak"* | Mechanics, not model — deterministic test |
| 07-24 10:47–10:49 | Three near-duplicate messages for one turn | (Axis 4: one message per concern) | **Verbosity / message-count eval** |

**And one golden positive**, which matters just as much because a suite of only-negatives
tunes toward silence:

| 07-24 10:48 | Agent asked for a repro before filing the image issue | *"Well done for not just creating the issue, you need to find out — that's good stuff"* | **Positive case, Axis 6** |

That is 13 cases with human-authored ground truth, extractable today. It is a real starter
dataset and it costs an afternoon, not a research programme.

---

## Part 7 — The system

Five rungs. Each is useful alone; none depends on the one after it.

### Rung 1 — Make the trace a whole row (unblocks everything automatic)

Log the prompt input alongside the tool calls. Two options, and the cheap one is fine:

- **Cheap:** a script that joins Braintrust tool spans → `batchId` → `brain_batches` →
  `brain_intents.evidence_ids` → `conversation_events`, emitting complete
  `{input: Window+Batch, output: Effects}` rows. No runtime change; the join key is already
  in the span.
- **Proper:** attach the Batch digest as the span input in `braintrust.ts`. Redact before
  you do — chat content leaves the box.

Do the cheap one first. It answers whether the rows are worth anything before you touch the
runtime.

### Rung 2 — A Brain harness

The one genuinely new piece of code. Mirror `createFlueAgentHarness`, but submit a Brain
Batch and return the chosen Effects:

```ts
export type BrainEvalOutput = {
  effects: Array<{ kind: "stay_silent" | "prompt_speaker" | "file_issue" | …;
                   payload: JsonValue; reason?: string }>;
  toolCalls: ToolCall[];
};
```

Then `expect(effects.map(e => e.kind)).toEqual(["stay_silent"])` is a free, deterministic
assertion — and the `reason` string is judgeable. Most of your complaints become one-line
assertions the moment this exists.

Note #316's blocker applies here too: the speaker fixture never configures the
intent-escalation runtime, so `escalate_intent` throws before anything is measurable. Fix
the fixture once; it unblocks both.

### Rung 3 — Datasets as the unit of truth

Create three Braintrust datasets in one project (consolidate — `ambient agents` and
`co-worker` being separate is why the evals and the traces don't meet):

| Dataset | Rows | Source |
|---|---|---|
| `participation-golden` | ~40 | the 13 labelled cases above + the existing live suite |
| `issue-quality` | ~20 | the 2026-07-24 filing batch (#345–#351) — real failures with hand-rewritten known-good targets, called out in #350 |
| `brain-decisions` | ~50 | sampled from the 151 `stay_silent` + 17 `prompt_speaker` production decisions |

Every row: `{ input, expected, metadata: { axis, source_trace, labelled_by, date } }`.
Then experiments run *against* a dataset and a score movement means something.

### Rung 4 — The tagging loop (this is the "automated way" you asked for)

You do not need to build a tagging tool. The loop is:

```
live chat → Braintrust logs → you spot a bad trace → "Add to dataset"
   → write the expected behaviour → it is now a permanent regression test
```

Plus the half you *should* automate: a **weekly triage job** that queries production logs
for the shapes that correlate with your complaints, and posts candidates:

- `stay_silent` on a Batch whose Window contains a question mark or a mention → candidate
  missed engagement
- `file_issue` with no prior `github_search_issues` in the same trace → candidate duplicate
- `file_issue` with empty labels or assignees → candidate #350 violation
- more than two `say`/`say_directive` in one Window → candidate Axis 4 violation
- any trace where a human's next message contains "no", "not", "should have", "actually",
  "that's not" within 5 minutes of an agent message → **candidate correction**

That last one is the highest-signal heuristic you have, and it is why the chat corpus is so
valuable: your corrections are timestamped right next to the mistakes. It is a `LIKE` query,
not a research project.

### Rung 5 — Gates and online scoring

- Deterministic evals on every PR (already possible; `pnpm evals:deterministic`).
- Judged evals nightly and before any skill/prompt change, against the fixed datasets.
- Online scorers sampling ~10% of production traces so drift shows up without a human reading
  chat.
- Thresholds already exist per axis. Add one for the Brain once Rung 2 lands.

---

## What I'd do first, in order

| # | Action | Effort | Why first |
|---|---|---|---|
| 1 | Consolidate to one Braintrust project | minutes | Evals and traces currently can't meet |
| 2 | Extract the 13 labelled cases into `participation-golden` | an afternoon | Ground truth already written by you; no new judgement needed |
| 3 | Fix the eval fixture's escalation runtime (#316 blocker) | small | Blocks both halves of the participation policy |
| 4 | Build the Brain harness | a day | Unlocks evals for the agent that makes the decisions |
| 5 | Write the correction-detector query over the chat corpus | hours | Turns 641 messages into a candidate queue automatically |
| 6 | Backfill trace inputs via the `batchId` join | a day | Makes production continuously mineable |

The board is already well-refined for this: **#316** (participation both halves), **#350**
(issue quality + duplicate detection), **#348** (capability self-knowledge), **#351** (review
acknowledgement), **#347** (image handling), **#245** (fabricated review). What is missing
from the board is a Brain-eval harness issue — that is the gap.

---

## Two things I noticed while looking, worth their own tickets

1. **Context is enormous.** Production prompts show `estimatedTokens: 256827` triggering
   compaction, with `totalTokens: 1,152,414` on a single Brain prompt. Cost is reported as
   `0` because it's on the ChatGPT subscription, so nothing is flagging it. That will shape
   behaviour — a Brain reasoning over a compacted 250k context is a different agent from one
   reasoning over a clean Batch.
2. **`direction` in `conversation_messages` is not "who spoke".** Before the second number
   landed (~07-20), Aaron's own messages and the agent's are both `outbound`, because they
   shared a WhatsApp account. Any dataset built from that table needs sender-based
   attribution, not `direction`, or half the early corpus is mislabelled.
