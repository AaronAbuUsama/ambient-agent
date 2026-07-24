# Phase 2 rollout retrospective — the coworker replacement

**Date:** 2026-07-24 · **Scope:** the whole Phase 2 DAG (S1–S12, milestone #11, issue #299),
executed as ~25 PRs (#300–#354) into `integration/coworker-replacement`, cut into `main` via #353.

**Method.** Grounded in two evidence corpora gathered by independent agents, not recollection:

- **Corpus A** — every review comment across PR #349 (11 rounds) + #352/#353/#354, distilled to 30
  distinct findings classified by bug-class, severity, blocking-vs-not, and — the key axis —
  **pre-existing vs fix-induced**. (`scratchpad/retro-corpus-A-reviews.md`.)
- **Corpus B** — the original DAG (planning docs, milestone issues, #299) reconstructed and compared
  against what actually happened per node, plus a written-vs-tacit audit of the method.
  (`scratchpad/retro-corpus-B-plan-vs-reality.md`.)

This document is itself an instance of the practice it recommends: the method under review is *already*
the product of one prior incident (a runaway 135-agent fan-out crash, corrected in the playbook but
never given a standalone postmortem — Corpus B §3). We are continuing that loop, properly this time.

---

## 1. What shipped, and what went right

The rollout **succeeded**: all 12 nodes landed, the branch cut into `main`, and the runtime is
deployed and healthy. Nine of twelve nodes (S1–S3, S4, S5, S7, S8, S9, S12-prep) merged on the first
or near-first pass. The things that worked are not incidental and must survive into the next rollout:

- **The one-agent = one-work-item = one-worktree = one-PR shape held throughout.** #300–#354 map
  cleanly to single specs. No runaway fan-out this time — the correction from the prior incident held.
- **The three-signal merge gate (CI + reviewer-bot + independent cold review) caught real defects
  every single round, with zero false positives from the bot across the whole rollout.** The
  discipline works. Its limitation (below) is not that it misfires — it's that it's a *triage* tool
  being asked to do *diagnosis*'s job.
- **Premise validation demonstrably works when it's actually run.** The one DAG edge that got a
  pre-dispatch premise check — #211's stale blockers #209/#210, corrected at doc-authoring time — is
  the one edge that never caused trouble. Proof of concept for the gate we're missing everywhere else.
- **The security gate held.** S1 (#249) merged and deployed before S6 (#254) wired any transport, exactly
  as the playbook demanded — no cross-org event leak.
- **Live-proof discipline was real and rigorous early.** Wave 1 and S9 (#212) have full nonce-tagged,
  restart-survival proofs in the #299 thread. The discipline existed and was followed — then eroded
  (see FM5). That it worked early is what makes the erosion diagnosable rather than mysterious.

## 2. The headline numbers

- **PR #349 (S10/#211) took 11 review rounds / 8 `CHANGES_REQUESTED` cycles** — ~4× the playbook's own
  stated cap of 2. It was the one node that blew up; the other eleven were fine.
- **Of 30 distinct findings on #349, 15 were fix-induced** — more than half were bugs *introduced by an
  earlier round's own fix*, not present in the original implementation. 13 were pre-existing, 2 unclear.
- **The findings cluster hard.** Seven recurring classes; the two largest — TOCTOU / stale-live-PR-state
  (6 findings, rounds 3→11) and reserve-then-side-effect atomicity (5 findings) — account for a third of
  everything. Each is one disease that surfaced as many symptoms.
- **At merge, #349 still carried unresolved findings**: 5 documented-as-accepted-risk and 3
  unresolved-at-merge, including a P1 (`ingress-wiring-gap`) and residual members of the two biggest
  clusters. "Clean" was clean *relative to the available review signal* — not clean in absolute terms.

---

## 3. Failure modes

### FM1 — Architecture/spec conformance was validated *reactively*, in review, not before code

There was **no pre-execution gate** that walked each node against the §10 invariants and the node's own
written acceptance criteria (Corpus B §4). Validation happened, but node-by-node, *after* code, inside
the PR-review loop. The two most expensive #349 findings were both checkable against the written spec
*before a line was written*:

- **Round 2** — the repair launch path "is not trusted code; arbitrary review events can trigger
  repairs." The spec said explicitly "only Reviewer-App REQUEST_CHANGES on a registered PR launches."
- **Round 9** — the *opposite* failure: "production ingress never invokes the repair path," so the
  feature couldn't fire at all. Same spec criterion, violated the other direction, caught 9 rounds in.

A five-minute design check against the spec's own acceptance list would have caught both. Instead they
cost the two most expensive rounds each. **This is the single highest-leverage miss.**

### FM2 — Whack-a-mole: the reviewer does triage, never diagnosis

The point-reviewer surfaces one symptom at a time and **never names the disease behind a cluster**. The
TOCTOU class was flagged at six different checkpoints across rounds 3–11; the reviewer never once said
"these are the same gap." The orchestrator only noticed at round 11, by eye, and asked for a
consolidation — which was the correct move, five rounds late. There was **no mechanism to switch from
patch-mode to diagnose-mode** when a class recurs. 50% fix-induced findings is the direct symptom:
patching symptoms in a subsystem you haven't diagnosed reliably spawns adjacent symptoms.

### FM3 — The cap of 2 review cycles had no teeth

The rule existed in writing (playbook §6.3). #349 blew through it to 8. **Nothing in the process
noticed or acted** — no escalation, abort, or re-scope path exists for "the cap is blown" (Corpus B §3).
The cap was advisory with no enforcement and no defined consequence.

### FM4 — Fixes broke narrowly instead of completely, and it wasn't self-checked

The fix-induced half of the findings share a shape: the fix addressed the *named* symptom without
covering every branch/caller the same reasoning applies to. Concrete instances from Corpus A:

- `requireExisting` guarded only the "no PR found" branch, not the "wrong PR found" branch (round 6→7).
- The evidence check used `claimBatch()` (whatever's globally open) instead of `input.batchId` (round 3→6).
- The launch-identity fix (round 8) *enabled* two concurrent runs to collide on one workspace (round 10).
- **Even the round-11 consolidation was incomplete** — `verifyLiveContinuation` closed 4 of 6 TOCTOU
  members but missed the `ensureBranch` call site (`recreate-deleted-branch`, unresolved at merge). The
  rung-2 fix itself fell to FM4.

A cheap "enumerate every branch/caller of what this fix touches" self-check would have caught most.

### FM5 — Definition-of-done eroded; "proof" quietly became "green CI"

The playbook is emphatic: "unit and integration tests are not proof; only a live nonce scenario is
'done'." Yet **S4, S5, S7, S8, and effectively S11 merged on green CI with live proof deferred to
"post-deploy" / "the orchestrator"** (Corpus B §2, §3) — and, per the visible record, S11's live
two-chat proof was never run at all. There is **no written rule** for the defer-vs-block decision; it
was made ad hoc, per PR, with no checkpoint. This is the same shape as today's cutover deploy (build +
health proven; live scenario **not** re-run) and as the orchestrator's own real-time "all stale, clean"
call on #349's final round — which was correct against the reviews in hand, but corpus-depth analysis
found residual same-class defects the reviews structurally could not catch. **Triage-clean is not
done-clean, and nothing enforced the difference.**

### FM6 — The paper trail never caught up

All 13 milestone-#11 issues are still GitHub-state `OPEN` despite merged PRs and STATUS.md declaring
Phase 2 substantially complete (Corpus B §6). There is no rule anywhere for closing an issue when its
proof contract is satisfied. The recorded state and the real state diverged silently.

### FM7 — The method is mostly tacit, and improvisations left no durable artifact

What *is* written (one-PR-per-item, the cap, the merge gate, L1–L6) held up. What broke was uniformly
the **tacit** parts (Corpus B §3): the proof-defer decision, the cap-breach response, the
bot-reviewer substitution on #353 (the highest-stakes PR, decided in one line of a PR body). And the
substitute reviews I ran on #352–#354 **posted nothing to the PRs** — the review that actually happened
left no trace on the artifact it reviewed. Corpus A can only see GitHub comments, so from the record,
those three PRs look *unreviewed*.

---

## 4. The two root causes, upstream and downstream

Strip FM1–FM7 down and there are two root causes, at opposite ends of the pipeline:

1. **Upstream — no pre-flight.** The DAG was validated reactively, not before dispatch. Fixes FM1;
   with an issue-lifecycle rule, FM6.
2. **Downstream — the review loop is all triage, no diagnosis, no done-discipline.** It patches
   symptoms without ever diagnosing clusters (FM2), without enforcing the cap as an escalation trigger
   (FM3), without checking fix-completeness (FM4), and without a hard line between triage-clean and
   done-clean (FM5). All tacit (FM7).

## 5. What would have prevented each — the required capabilities

| Failure mode | The capability that prevents it |
|---|---|
| FM1 (reactive conformance) | A **pre-flight**: walk every node against §10 + its own acceptance criteria + its edges *before* dispatch. |
| FM2 (whack-a-mole) | An **escalation ladder** in the run loop: patch → **diagnose the cluster** → stop, with automatic triggers. |
| FM3 (toothless cap) | The ladder's **round-count backstop** — hitting the cap *is* the escalation trigger, not a suggestion. |
| FM4 (narrow fixes) | A **fix-completeness self-check** baked into the fix-brief: enumerate every branch/caller before "done". |
| FM5 (done erosion) | A **proof ledger** + explicit defer-vs-block decision; triage-clean ≠ done-clean is enforced, not tacit. |
| FM6 (paper trail) | **Close-on-proof** issue hygiene, part of the run loop. |
| FM7 (tacit method) | The whole suite, written down; plus "the review verdict posts to the PR." |

## 6. The skill gap, mapped

The team already has strong front-half skills and no back half:

```
CREATE ───────► VALIDATE ──────► RUN ──────────────► REVIEW ──► PROVE ──► CLOSE
grill-me/         ❌ (none)       implement (1 item)   code-      rig       ❌ (none)
to-spec/                          ❌ no DAG-run loop   review     ✓
to-tickets/                       ❌ no ladder         (partial)
wayfinder ✓                       ❌ no diagnosis rung
```

The missing pieces, and where each failure mode lands:

- **`validate-the-dag`** (NEW, pre-flight) — FM1, FM6-partial.
- **`run-the-dag`** (NEW, the execution loop) — carries the escalation ladder (FM2/FM3), the
  fix-completeness check (FM4), the proof ledger and done-discipline (FM5), close-on-proof (FM6), and
  "verdict posts to the PR" (FM7).
- **`diagnose`** (NEW, the ladder's rung-2 engine) — root-cause a *cluster* of findings, name the
  disease, propose the consolidating fix or escalate to stop. Borrows the loop from `diagnosing-bugs`
  but is cluster-oriented, not single-bug. FM2's core.
- **A router** (NEW) — indexes the whole create→validate→run→diagnose→review→prove→close pipeline so
  the pieces find each other, curing the cognitive-load problem `writing-great-skills` warns about.
- **Extensions**, not new skills: `code-review` becomes the merge-gate reviewer that posts its verdict;
  `rig` gains the proof-ledger hook.

The detailed design of these is the **strawman** (`SKILL-SUITE-STRAWMAN.md`) — to be reviewed before
any `SKILL.md` is written.

## 7. Honest boundaries of this retrospective

- The corpora see GitHub artifacts and docs; they cannot see the orchestrator's in-session reasoning or
  the subagent reviews that left no PR comment. Where the two disagreed, this doc trusts the corpora.
- "Fix-induced vs pre-existing" is inferred from commit provenance; 2 of 30 findings are genuinely
  unclear and marked so.
- This is one rollout. The patterns are strong (50% fix-induced, a 6-deep cluster) but n=1 on the
  blow-up node. The skills should be written to be *falsified* by the next rollout, not assumed correct.
