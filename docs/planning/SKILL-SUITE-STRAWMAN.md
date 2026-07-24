# Strawman — the DAG-execution skill suite

**Status: DESIGN SKETCH for you to red-pen. No `SKILL.md` gets written until this is approved.**

Built from the retrospective's two root causes (no pre-flight; review-loop is triage-only) and the
`writing-great-skills` vocabulary. `❓` marks a genuine open decision I want your call on.

## The pipeline and the leading words

```
   CREATE  ──►  VALIDATE  ──►  RUN  ──►  (DIAGNOSE)  ──►  PROVE  ──►  CLOSE
   [exists]     preflight    the loop    the nest        rig+ledger  on-proof
```

Leading words the suite is built on (each a compact concept the model already holds, repeated so it
anchors behaviour cheaply):

- **pre-flight** — the aviation checklist you run *before* the wheels leave the ground. The whole-DAG
  conformance gate. You do not dispatch until pre-flight is signed.
- **triage vs diagnosis** — the two review modes. The bot does triage (one symptom at a time).
  Diagnosis names the disease. The escalation *is* triage → diagnosis.
- **the nest** — the root cause behind a symptom cluster. "Stop hitting moles, find the nest."
- **the tell** — the signal that you're in whack-a-mole and must escalate.
- **proof contract / proof ledger** — the existing L1–L6 discipline, made into a tracked artifact so
  triage-clean can never masquerade as done-clean.

---

## Skill 1 — `validate-the-dag` (NEW, user-invoked) — the pre-flight

**Fills:** FM1 (reactive conformance), FM6-partial. **Runs once**, after `to-tickets` builds the DAG,
before any dispatch. Takes the DAG + the architecture-invariant doc + each node's spec.

Steps, each with a checkable completion criterion:

1. **Invariant conformance, per node.** For each node, name which architecture invariants it touches,
   and confirm the *design* (not the code — there is none yet) will satisfy each. *Done when:* every
   node has an explicit invariant list and a "satisfies / at-risk / re-plan" verdict. The #349
   Brain-routing question would have surfaced here.
2. **Acceptance-criteria checkability.** For each node, confirm its written acceptance criteria are
   things a design can be checked against *now*. Flag any criterion only checkable after code. *Done
   when:* every criterion is marked pre-checkable or deferred-with-reason.
3. **Edge audit.** For each blocking edge, confirm it's real; hunt *hidden* edges — a node depending on
   another's specific implementation choice, not just its merge (the S1↔S2 `surfaceRepositories`
   coupling the original edges missed). *Done when:* every edge is confirmed or a new edge is added.
4. **Provability, per node.** Confirm each node has a concrete, runnable proof contract (which L-layers,
   what nonce, what receipt). A node no one can prove live is a node that isn't done-able. *Done when:*
   every node has a written proof contract, or is explicitly marked "green-CI-only, live-proof-deferred"
   **with a reason and a tracked debt** — never silently.

Output: a signed pre-flight table. Any `re-plan` verdict kicks that node back to CREATE before Wave 1.

## Skill 2 — `run-the-dag` (NEW, user-invoked) — the execution loop

**Fills:** FM2, FM3, FM4, FM5, FM6, FM7. The orchestrator's playbook, made a skill. It absorbs the
tacit method that held (one-PR-per-item, the cap, the merge gate, orchestrator-owns-deploy) **and** the
parts that were missing. Core loop per node:

```
dispatch (self-contained brief) → CI + review-gate → merge → deploy → live-prove → close
                                        │
                                        └── on findings: the escalation ladder ↓
```

### The escalation ladder (the heart of this skill)

Three rungs. You climb the moment any trigger fires — you do not wait for the round-count backstop.

| Rung | Mode | What happens |
|---|---|---|
| **1 — Patch** | triage | Fix the reported defect. Normal for rounds 1–2. |
| **2 — Diagnose** | diagnosis | **Stop patching.** Invoke `diagnose` on the cluster. Output is a consolidating fix, or a "this is a node/spec error" escalation to rung 3. |
| **3 — Stop** | re-plan / human | The node's *spec or premise* was wrong, not just its code. Halt the auto-loop, surface to the human, back to CREATE/VALIDATE. `hunk-review` is the human's tool here. |

**The triggers (what makes you climb to rung 2), earliest-firing first:**

- **The tell (fix-shape).** A finding whose *fix needs a new mechanism*, not a tightened check. The
  sharpest early signal — #349 round 1→2 (building a whole new Brain tool) was this, unheeded.
- **Class-recurrence.** The **same bug-class appears a second time.** The primary trigger. Round 6
  (second TOCTOU) would have pre-empted rounds 7–11.
- **Round-count backstop.** Hit **round 3** regardless. This is FM3's fix: the cap *is* the trigger, not
  a suggestion. `❓ round 3, or your "3–4"?`

**The rung-2 → rung-3 stop line:** `diagnose` returns **code-wrong** (the implementation was wrong →
consolidate and continue) or **node-wrong** (the spec/premise was wrong → stop, re-plan).
`❓ is "code-wrong vs node-wrong" the right cut, or is there a third outcome?`

### The other disciplines baked into the loop

- **Fix-completeness check (FM4).** Every fix-brief ends with: *enumerate every branch/caller the fix's
  reasoning touches; the fix is not done until each is covered.* A one-line rule that kills the
  narrow-fix regression class.
- **Proof ledger (FM5).** Every node carries its proof contract from pre-flight. Merge on green-CI with
  live-proof-deferred is *allowed but logged* as an explicit decision with a named owner and a tracked
  debt — never tacit. **Triage-clean (reviews clean) and done-clean (proof gathered) are separate
  states.** `❓ is deferring live-proof ever OK, or is it always block-until-proven?`
- **Verdict posts to the PR (FM7).** Whatever reviewed it — bot or subagent — posts its verdict *as a
  PR comment*, so the artifact records its own review. Fixes the #352–#354 "looks unreviewed" gap.
- **Close-on-proof (FM6).** When a node's proof contract is satisfied, its issue is closed, same step.

## Skill 3 — `diagnose` (NEW, model-invoked) — the nest-finder

**Fills:** FM2's core. The rung-2 engine. Model-invoked so `run-the-dag` can reach it automatically.
Given a **cluster** of findings + the whole subsystem (not the diff) + the invariants, it answers one
question: *what single design gap generates all of these, and is there one consolidating fix that
closes the class?* Borrows the loop from `diagnosing-bugs` but is **cluster-first**, not single-bug.

Output is one of:
- **A nest + a consolidating fix** — like round 11's shared `verifyLiveContinuation` primitive, but
  produced deliberately at round 3, and *with the fix-completeness check applied to the consolidation
  itself* (so it wouldn't have missed the `ensureBranch` call site).
- **A node-wrong verdict** — the findings trace to a spec/premise error → rung 3.
- **Genuinely independent** — no nest; resume patching, now with confidence.

`❓ new skill, or bend diagnosing-bugs? I lean new — its loop is per-symptom; this is per-cluster.`

## Skill 4 — `dag` (NEW, user-invoked) — the router

**Fills:** FM7. One user-invoked skill that names the others and when to reach for each, so the pile of
skills doesn't land as cognitive load on you (the `writing-great-skills` router pattern). Our own, not
`ask-matt` — it knows *this* pipeline: "building the plan → `to-tickets`; before dispatch →
`validate-the-dag`; executing → `run-the-dag`; a class keeps recurring → `diagnose`; proving on the box
→ `rig`."

## Extensions (not new skills)

- **`code-review`** → the merge-gate reviewer inside `run-the-dag`; must *post its verdict to the PR*.
- **`rig`** → gains the proof-ledger hook so live-proof state is tracked, not narrated.

---

## The decisions I need from you

1. **`❓` Ladder triggers** — all three (the tell / class-recurrence / round-3 backstop), or is that
   over-built? I argue class-recurrence + round-3 is the floor; the tell is sharpest but hardest to
   detect mechanically.
2. **`❓` Round-count backstop** — 3, or your "3–4"?
3. **`❓` Stop line** — is "code-wrong vs node-wrong" the right rung-2→3 cut?
4. **`❓` Proof-deferral** — is merge-on-green-CI-with-deferred-live-proof ever acceptable (logged as
   debt), or always block-until-proven? This is the FM5 policy call and it's genuinely yours.
5. **`❓` `diagnose`** — new skill, or extend `diagnosing-bugs`?
6. **`❓` Scope** — build all four (validate / run / diagnose / router) now, or start with the two that
   would have saved this rollout the most (validate-the-dag + the ladder in run-the-dag) and grow?
