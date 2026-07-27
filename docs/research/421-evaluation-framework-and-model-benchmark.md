# #421 research — evaluation framework and model-benchmark methodology

## Finding

Ambient Agent should not repair or port its inherited eval suite. The durable foundation is
an **application-owned, architecture-epoch Evaluation Scenario contract**, extending the
ratified term in [`CONTEXT.md` — Agent anatomy](../../CONTEXT.md#agent-anatomy), executed with the already installed
Vitest/vitest-evals and public Flue seams, with Braintrust used for versioned datasets,
experiments, comparison, tracing, and review.

The shared root — the evaluation **nest** — is:

> The repository has no architecture-epoch, owner-attributed Evaluation Scenario contract
> that binds one source occurrence to its knowledge, accountability, execution, and
> user-visible outcomes. Inherited prompts, rubrics, thresholds, and experiment rows are
> symptoms of that missing contract, not a foundation to preserve.

This follows the accepted architecture: receipt alone does not prove knowledge or
responsibility, a mechanically settled Brain Batch does not prove per-Happening
accountability, and the Coworker is the composition rather than one agent
([canon §2](../SYSTEM-ARCHITECTURE.md#2-the-system-at-a-glance),
[canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close)).
Map [#409](https://github.com/AaronAbuUsama/ambient-agent/issues/409) owns the retained
runtime's mechanical, integrated, live, readback, and observed proof ladder. Map
[#410](https://github.com/AaronAbuUsama/ambient-agent/issues/410) owns implementation of the
accountable information path. Evaluation tiers are orthogonal to those proof tiers, and this
research does not move either implementation frontier.

Durable methodology:
[`docs/EVALUATION-METHODOLOGY.md`](../EVALUATION-METHODOLOGY.md).
Primary-source and licensing notes:
[`docs/reference/evaluation/INDEX.md`](../reference/evaluation/INDEX.md).

Committed artifacts:

- [Research finding](./421-evaluation-framework-and-model-benchmark.md)
- [Evaluation methodology](../EVALUATION-METHODOLOGY.md)
- [Annotated primary-source notes](../reference/evaluation/INDEX.md)

## Read from sources versus inferred

**Read from current code and first-party sources:**

- The canon's accountable path and current built/designed boundary.
- The inherited harness, rubrics, thresholds, runner, and Braintrust reporter.
- Installed dependency versions and SDK declarations.
- Flue's public evaluation, workflow, SDK, observation, and tooling boundaries.
- Braintrust's dataset versioning, trials, experiment comparison, scoring, tracing, masking,
  and provider-comparison capabilities.
- Anthropic's external `case`/trial/grader/outcome vocabulary—mapping `case` to Ambient
  Agent's ratified Evaluation Scenario—plus its capability/regression distinction,
  outcome-first grading, human calibration, production feedback loop, and statistical advice.

**Inferred for Ambient Agent:**

- The Evaluation Scenario contract, five-tier evaluation ladder, owner/evidence map,
  architecture-epoch rule, privacy admission, maturity/protected-placement rules, release gates, and
  evaluation expedition below.
- The recommendation to use Braintrust as an analysis/registry surface rather than the
  authority for release or application outcome truth.

## Current-stack inventory

### Architecture and data owners

| Layer                        | Current evidence                                                                                                                                                                       | Evaluation consequence                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source Archives / Happenings | Conversation Archive and durable GitHub receipt foundations exist; a common Happening/readiness seam is designed, not built ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close))              | Existing provider archives remain payload truth. Evaluate receipt and identity at their owner; wait for the common seam before claiming cross-source Happening coverage.    |
| Graph / Scribe               | Append-only Attestations, Evidence Sets, deterministic projection, and Scribe attempts exist; routine Scribe deltas still wake the Brain ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close)) | Grade provenance and projection structurally; grade semantic support separately. Do not make a Scribe score stand in for Attention.                                         |
| Attention                    | Not built; current Batch settlement can be satisfied without per-input disposition ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close))                                                       | No current Evaluation Scenario can prove the target accountable path end to end. Schema/method work can proceed; Attention outcome scenarios depend on #410 implementation. |
| Brain                        | Durable global actor and crash-stable Batch exist; it still claims mixed raw/delta inputs ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close))                                                | Evaluate current recovery primitives honestly, but do not benchmark the designed knowledge-ready judgement path until implemented.                                          |
| Work / Effects               | Typed Effects and Specialist execution ledgers exist; generic Work responsibility is missing ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close))                                             | Evaluate effect/execution integrity at current owners. Whole Work lifecycle scenarios wait for the thin Work ledger.                                                        |
| Surface / Speaker            | Directive-only Saying and durable delivered/failed/Uncertain outcomes exist; Speaker is the local mouth ([canon §13](../SYSTEM-ARCHITECTURE.md#13-where-we-are-today-and-the-distance-to-close))                                  | Deterministically grade authorization and delivery. Use semantic grading only for conversational expression and escalation judgement.                                       |

The durable vocabulary already distinguishes Surface Delivery, Intent, Brain Batch/Effect,
Directive Outcome, Source Archive, Happening, Attention, and Work
([`CONTEXT.md` — The coworker](../../CONTEXT.md#the-coworker)). Evaluation must preserve those authorities.

### Existing evaluation code is archaeology

The inherited harness creates an artificial `eval-*.g.us` instance, seeds old fixture
routes, prompts a named agent or submits a Speaker Window, then collects faux WhatsApp/GitHub
events and conversation history
([`harness.ts`](../../packages/test-support/src/evals/harness.ts#L278)).

Its model judge reads removed capability skill bundles and applies hard-coded participation
axes and thresholds
([`rubric-judges.ts`](../../packages/agents/evals/rubric-judges.ts#L1)).
Its Braintrust reporter mutates one issue-113-era experiment and gates on aggregate
thresholds
([`braintrust-reporter.ts`](../../packages/test-support/src/evals/braintrust-reporter.ts#L1)).
The Vitest config still discovers those old capability eval paths
([`vitest.evals.config.ts`](../../vitest.evals.config.ts#L1)).

These contracts assume the pre-reset agent topology and cannot be treated as current
behavioral truth. Potentially reusable plumbing is limited to generic ideas: fresh instance
per trial, normalized events/usage/timing, and public SDK-driven execution. Reuse must happen
behind a newly ratified Evaluation Scenario contract; no inherited scenario, dataset, scorer,
rubric, threshold, runner mode, or Braintrust experiment is grandfathered.

### Installed tools

| Tool                     |      Installed | Useful boundary                                                                                                             | Gap                                                                                            |
| ------------------------ | -------------: | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Flue runtime / SDK / CLI | `1.0.0-beta.9` | Public in-process and HTTP agent/workflow execution, durable run/conversation reads, runtime events and Braintrust observer | Not an eval framework; live observer is not durable outcome truth or replay                    |
| Vitest                   |       `4.1.10` | Deterministic tests and one familiar runner                                                                                 | No domain Evaluation Scenario contract                                                         |
| vitest-evals             |       `0.14.0` | Custom harness, normalized trial, judges, tool-call views, JSON report                                                      | Current docs describe 0.15.0; harness cannot invent application fixtures/readbacks             |
| Braintrust               |       `3.17.0` | Versioned datasets, experiments, trials, scorers/classifiers, comparisons, online scoring, traces, masking                  | Existing integration configures tracing only; masking and current-epoch eval policy are absent |

Versions are pinned in [`package.json`](../../package.json#L55). The current production bridge
configures Braintrust tracing from Flue events but does not install a masking function
([`braintrust.ts`](../../packages/engine/src/braintrust.ts#L1)).
Runtime model selection already supports provider choice and role-specific model ids while
preserving each role's thinking level
([`model-configuration.ts`](../../apps/cli/src/model-configuration.ts#L58));
the benchmark protocol should record and compare those profiles, not replace them.

## Primary-source conclusions

The annotated source and license record is
[`docs/reference/evaluation/INDEX.md`](../reference/evaluation/INDEX.md). The decisive
boundaries are:

1. **Flue:** drive a full loop through public application surfaces; assert observable effects,
   prefer deterministic checks, and treat Braintrust tracing as independent of Evaluation
   Scenarios and gates.
2. **Braintrust:** pin dataset versions/snapshots, retain repeated trials, compare matching
   scenarios against a baseline, separate scorers from classifiers, use online scoring for
   sampled production triage, and install/test masking before export.
3. **Anthropic:** define its external `case`/trial/grader/transcript/outcome vocabulary
   explicitly; Ambient Agent maps `case` to Evaluation Scenario. Combine deterministic, model,
   and human grading; separate capability from regression; prove scenarios are solvable; grade
   outcomes; calibrate judges; feed production failures back through human review.
4. **Statistics:** repeated trials of the same Evaluation Scenario are correlated. Report
   scenario-level paired differences and uncertainty rather than treating every trial as
   independent.
5. **No new dependency:** the installed stack covers the executable foundation. Adding another
   framework now would create a second runner or registry before the Evaluation Scenario
   contract exists.

## Gap inventory

| Gap                                                     | Consequence                                                      | Required response                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No Evaluation Scenario schema or architecture epoch     | Old assumptions can silently become current gates                | Ratify one repository Evaluation Scenario contract and validator                                                                  |
| No owner-to-evidence policy                             | Transcript scores can impersonate application truth              | Bind each expectation/scorer to its architecture owner and durable readback                                                       |
| No candidate/sanitization/adjudication pipeline         | Production traces risk becoming raw or mislabeled datasets       | Keep raw evidence local; sanitize, adjudicate, and version before dataset admission                                               |
| No judge calibration policy                             | Subjective thresholds can drift with judge model/prompt          | Version one-dimension judges and measure agreement against human adjudication                                                     |
| System-under-test and evaluation controls are not split | Model/provider comparisons can change their measuring instrument | Pin system-under-test role assignments separately from judge/scorer identity, dataset, environment, trials, and baseline          |
| Protected holdout definitions have no separate placement | Repository-visible fixtures and expectations contaminate release holdouts | Commit only opaque manifests and definition hashes; keep fixtures, expected outcomes, scorer inputs, and revealing trial details behind the named access policy |
| Maturity and protected placement are not split          | Access restriction or scenario maturity can be lost              | Keep candidate/capability/regression/retired maturity independent from protected holdout placement and its named access policy    |
| Tracing lacks explicit masking                          | Content-bearing events may leave the application boundary        | Design and test fail-closed masking before evaluation or wider production export                                                  |
| Target Attention/Work path not implemented              | Current E2/E3 suite cannot prove target accountability           | Build schema/policy independently; bind executable path Evaluation Scenarios to #410 nodes when their owner readbacks are present |

## Options

### A. Repair the inherited suite

```diff
- inherited scenarios fail after architecture reset
+ patch fixture routes, agents, rubrics, thresholds and reporter until green
```

This is rejected. It would ratify the wrong unit—an isolated capability-agent prompt—and
launder pre-reset behavior into the new architecture.

### B. Make Braintrust the primary eval platform

```diff
+ upload scenarios and traces first
+ define datasets, judges and release thresholds in Braintrust
```

This provides a fast experiment UI but places architecture epochs, privacy admission, and
application outcome truth behind a vendor surface. Repository review and local reproducibility
would be secondary.

### C. Application-owned Evaluation Scenarios; installed execution and analysis stack

```diff
+ repository Evaluation Scenario schema + architecture epoch + owner readbacks
+ opaque repository manifests for protected holdouts; restricted definitions behind named access policy
+ Vitest/vitest-evals custom harness over public Flue/application seams
+ Braintrust versioned dataset/experiment mirror and comparison
+ human adjudication, sanitization, independent maturity and protected-holdout policy
+ separate system-under-test and evaluation control profiles
```

This keeps the durable claim and gates local while using each installed tool for the boundary
it actually owns.

### D. Adopt another framework

```diff
+ second runner, scenario format, reporting/registry dependency
```

No demonstrated gap warrants this. Reconsider only if the executable foundation exposes a
specific requirement that Vitest/vitest-evals, Flue, Braintrust, and small application code
cannot satisfy.

## Grade and recommendation

Scores are 1 (poor) to 5 (strong); a higher blast-radius score means a more contained change.

| Option                                              | Floor-first | Reversibility | Blast radius | Correctness / integrity | Parallelizability |   Fit |
| --------------------------------------------------- | ----------: | ------------: | -----------: | ----------------------: | ----------------: | ----: |
| A. Repair inherited suite                           |           1 |             2 |            1 |                       1 |                 2 |     1 |
| B. Braintrust-first authority                       |           3 |             3 |            3 |                       2 |                 3 |     3 |
| **C. Application-owned contract + installed stack** |       **5** |         **5** |        **4** |                   **5** |             **5** | **5** |
| D. New framework                                    |           1 |             3 |            2 |                       2 |                 2 |     1 |

**Recommendation: C.** It is the smallest option that can evaluate the real architecture,
keeps sensitive evidence and release authority under application control, and lets independent
work proceed before #409/#410 complete.

## Evaluation expedition DAG (proposal only)

This is a separate expedition. It does not belong inside the #409 retained-runtime repair or
the #410 information-to-accountability implementation.

```mermaid
flowchart TB
  M["E1 Ratify vocabulary, tiers, schema, owner map (#421 docs)"]
  P["E2 Privacy, sanitization, provenance and adjudication contract"]
  B["E3 System-under-test + evaluation control profiles, statistics and release-report contract"]
  V["E4 Evaluation Scenario validator and local evidence format"]
  X["E5 Retire inherited eval entrypoints and gates"]
  T["E6 Braintrust masking and metadata contract"]

  H["A1 Happening and readiness owner readbacks (#410)"]
  A["A2 Attention disposition readbacks (#410)"]
  W["A3 Work/outcome readbacks (#410)"]
  R["A4 Current-epoch controlled scenario harness"]
  S["A5 Seed scenario maturity sets + protected holdout manifests"]
  C["A6 Baseline/challenger benchmark and release gate"]
  O["A7 Production candidate-mining loop"]

  M --> P & B & V
  M --> X
  P --> T
  H & A & W --> R
  V & T --> R
  R --> S --> C
  P & S --> O
```

### Independent of #409 and #410

- **E1:** this methodology and research finding.
- **E2:** privacy, sanitization, provenance, adjudication, protected holdout placement, and retirement policy.
- **E3:** separate configurable system-under-test and evaluation control profile schemas,
  paired-trial statistics, report, baseline/challenger rules, and release gates.
- **E4:** a machine-readable Evaluation Scenario schema validator and local evidence format
  that do not invoke the target runtime.
- **E5:** removal/quarantine of obsolete eval discovery, scripts, scenarios, rubrics,
  thresholds, and the old Braintrust reporter in a separate reviewable PR.
- **E6:** a fail-closed Braintrust masking test and stable correlation metadata contract. Any
  production tracing change still needs its own security review.

### Dependent on #410 implementation (and #409 where it blocks that implementation)

- Owner readbacks for common Happenings, Attention dispositions, generic Work, and outcome
  re-admission.
- The first controlled accountable-path harness and current-epoch Evaluation Scenarios.
- Baseline numbers, regression gates, protected-holdout results, and production candidate automation
  that claim the target architecture.

The expedition should begin with E2/E3/E4 in parallel, not an eval migration. The first
executable target should be three sanitized scenarios—positive, negative, recovery—for one
implemented accountable slice. Growth proceeds owner by owner.

## Decisions remaining for the planning orchestrator

1. Create the separate evaluation expedition and sequence E2/E3/E4 before executable runtime
   scenarios.
2. Choose the architecture decision or canon commit that names epoch 1 after #410's target
   contracts land.
3. Assign the privacy/adjudication owner and protected-holdout access policy.
4. Decide which implemented accountable slice is the first three-scenario executable
   foundation.
5. Schedule obsolete-suite retirement as deletion, not migration.

Issue #421 should remain open for the planning orchestrator to decide whether this research
settles its node.
