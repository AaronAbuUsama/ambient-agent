# Evaluation primary-source notes

Retrieved 2026-07-26. This is an original annotated guide to the first-party sources used by
the Ambient Agent evaluation methodology. It preserves provenance and the applicable local
dependency evidence without copying full web articles.

The repository's Apache-2.0 Flue mirror remains under
[`docs/reference/flue`](../flue/INDEX.md); it is linked here instead of duplicated.

## Copyright and license disposition

| Source                               | Terms found                                                                                                                                                                | Local treatment                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Flue documentation and source        | The [`withastro/flue` repository](https://github.com/withastro/flue) is Apache-2.0. The existing local mirror is preserved under the repository's vendored-doc convention. | Link the mirror and pin the inspected upstream source commit.                                                            |
| Braintrust documentation             | No documentation-content license was located on the cited pages. The installed `braintrust@3.17.0` package declares MIT; current upstream source declares Apache-2.0.      | Original capability notes and direct links only; no full-page copy. Distinguish installed package from current upstream. |
| Anthropic articles and platform docs | No reuse license was located on the cited pages.                                                                                                                           | Original annotated roadmap and direct links only; no full-page copy and no quotations.                                   |
| vitest-evals                         | The [`sentry/vitest-evals` repository](https://github.com/getsentry/vitest-evals) is Apache-2.0.                                                                           | Original notes against installed 0.14.0 and current first-party docs; no dependency or vendored-source change.           |

## Flue

Primary sources:

- [Evaluations guide](https://flueframework.com/docs/guide/evals/) and
  [source at inspected commit](https://github.com/withastro/flue/blob/b814b82b2ce45dc941c77bb010140070e1bd48d5/apps/docs/src/content/docs/guide/evals.md)
- [Observability guide](https://flueframework.com/docs/guide/observability/) and
  [events reference](https://flueframework.com/docs/api/events-reference/)
- [Workflows guide](https://flueframework.com/docs/guide/workflows/) and
  [workflow SDK](https://flueframework.com/docs/sdk/workflows/)
- [Braintrust integration](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
- [vitest-evals integration](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)

Inspected upstream source commit:
[`b814b82b2ce45dc941c77bb010140070e1bd48d5`](https://github.com/withastro/flue/commit/b814b82b2ce45dc941c77bb010140070e1bd48d5).
Installed Ambient Agent packages are `@flue/runtime@1.0.0-beta.9`,
`@flue/sdk@1.0.0-beta.9`, and `@flue/cli@1.0.0-beta.9`.

Relevant findings:

- Flue deliberately does not define an application evaluation framework. Ordinary logic uses
  ordinary tests; full agent/workflow loops can be driven through the same public in-process
  or HTTP SDK surfaces used by the application.
- A fresh conversation or workflow run per case prevents state leakage. Outcomes and
  observable effects are safer assertions than exact generated text.
- Deterministic assertions should decide exact behavior. Model judges are for semantic
  variation.
- `vitest-evals` supplies execution/reporting conventions. Braintrust tracing is independent;
  it does not create cases, assertions, or release gates.
- Flue observation events expose runs, model turns, tools, tasks, compaction, usage, cost, and
  correlation ids. The live observer is process/isolate scoped; durable application/SDK
  records remain necessary for replay and outcome truth.
- Events and traces are content-bearing. Application masking, retention, and access policy
  remain the application's responsibility.

Local mirror:
[`evals`](../flue/docs-guide-evals.md),
[`observability`](../flue/docs-guide-observability.md),
[`workflows`](../flue/docs-guide-workflows.md),
[`events`](../flue/docs-api-events-reference.md),
[`Braintrust`](../flue/docs-ecosystem-tooling-braintrust.md), and
[`vitest-evals`](../flue/docs-ecosystem-tooling-vitest-evals.md).

## Braintrust

Primary sources:

- [Evaluation overview](https://www.braintrust.dev/docs/evaluate)
- [Datasets and versions](https://www.braintrust.dev/docs/annotate/datasets)
- [Run evaluations](https://www.braintrust.dev/docs/evaluate/run-evaluations)
- [Compare experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments)
- [Write scorers](https://www.braintrust.dev/docs/evaluate/write-scorers)
- [Online scoring](https://www.braintrust.dev/docs/evaluate/score-online)
- [Advanced tracing and masking](https://www.braintrust.dev/docs/instrument/advanced-tracing)
- [Provider benchmark recipe](https://www.braintrust.dev/docs/cookbook/recipes/ProviderBenchmark)
- [Human review scores](https://www.braintrust.dev/docs/admin/projects)

Installed evidence:

- `braintrust@3.17.0` declares MIT in its installed package.
- Its TypeScript API exposes versioned/snapshotted datasets, trial indexes and counts,
  experiment baselines, scorers and classifiers, project/experiment logging,
  `braintrustFlueObserver`, and `setMaskingFunction`.

Relevant findings:

- A dataset row has input, optional expected output, and metadata. Dataset versions/snapshots
  can be pinned; experiment comparisons must use the same dataset identity/version.
- Experiments are immutable evaluation records. Repeated trials are represented explicitly
  and comparisons can group matching inputs/trials.
- Scorers may be deterministic code or model-based. Classifiers label examples/traces and
  should not be confused with a release score.
- Online scoring samples production traces asynchronously. It is useful for candidate mining,
  not automatic ground truth.
- The global masking function applies across logged inputs, outputs, expected values,
  metadata, and context. It must be installed before export and tested against the actual
  payload shapes.
- Provider/model performance is workload-specific. A valid comparison fixes the workload and
  measures quality, cost, and speed rather than importing a general leaderboard.

Boundary: Braintrust is a dataset, experiment, scoring, comparison, tracing, and review
surface. Ambient Agent must own architecture epochs, case policy, privacy admission, hard
gates, and release decisions.

## Anthropic agent-evaluation roadmap

Primary sources:

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  (published 2026-01-09)
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [A statistical approach to model evaluations](https://www.anthropic.com/research/statistical-approach-to-model-evals)
- [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)

Annotated roadmap:

1. Start from observed failures, support/operator corrections, and domain-expert designed
   boundaries.
2. Define a task/case, repeated trial, full transcript/trace, environment outcome, grader,
   harness, and suite separately.
3. Evaluate multi-turn agents through both their process evidence and resulting environment
   state; final prose alone is insufficient.
4. Use deterministic code graders wherever possible, model graders for legitimate semantic
   variation, and humans to establish and audit subjective ground truth.
5. Separate capability measurement from regression protection. Behaviors that become
   reliably solved may graduate into regressions.
6. Keep tasks unambiguous and prove the fixture and graders with a reference solution or
   known-good run. Persistent zero scores may mean the evaluation is broken.
7. Balance positive and negative cases and use isolated, stable environments.
8. Calibrate model graders against domain experts, allow insufficient-evidence results, score
   dimensions separately, and inspect transcripts.
9. Grade outcomes rather than unnecessarily rigid tool paths.
10. Combine offline evaluation with production monitoring, user feedback, and systematic
    human review.
11. For model comparisons, account for sampling error and correlation: retain repeated
    samples, report uncertainty, and prefer paired differences on the same cases.

## vitest-evals

Primary sources:

- [Official documentation](https://vitest-evals.sentry.dev/)
- [Custom harness guide](https://vitest-evals.sentry.dev/docs/harnesses/custom/)
- [Tool replay guide](https://vitest-evals.sentry.dev/docs/tool-replay)
- [Repository](https://github.com/getsentry/vitest-evals)

Installed version: `vitest-evals@0.14.0`, Apache-2.0. The current first-party documentation
describes 0.15.0, so current web examples must be checked against the installed declarations
before implementation.

Relevant findings:

- A custom harness can wrap an application service, workflow, CLI, or bespoke agent runtime.
- Normalized JSON-serializable sessions, tool calls, usage, timings, and artifacts let several
  judges inspect one trial without rerunning it.
- The package supplies Vitest integration, judges, JSON reports, and a local report viewer.
- Tool replay records selected local tool or service calls while leaving the model interaction
  live. Its modes and sanitization are harness-owned plumbing, not an application truth store
  or a replay of the whole Coworker. Ambient Agent still needs controlled
  provider/application fixtures and durable owner readbacks.

Boundary: keep Vitest as the test runner and use a custom vitest-evals harness only after the
case contract and one current-epoch runtime seam exist. No new framework is warranted.
