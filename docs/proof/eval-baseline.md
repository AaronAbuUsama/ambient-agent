# Eval battery baseline

Issue: [#113](https://github.com/AaronAbuUsama/ambient-agent/issues/113)

Recorded: 2026-07-16

Application and judge model: `openai-codex/gpt-5.6-luna`
Braintrust experiment:
[ambient-agent-eval-baseline-2026-07-16T19-15-11-758Z](https://www.braintrust.dev/app/capxul/p/ambient%20agents/experiments/ambient-agent-eval-baseline-2026-07-16T19-15-11-758Z)

This is the pre-monorepo-split baseline. The deterministic family uses the faux responder and exact event assertions. The
live family sends real coalesced WhatsApp Windows through admission and grades the resulting transcript and effects with
an independent LLM judge against the ratified skill-bundle text.

## Baseline numbers

| Axis                      | Metric                                                            | Baseline | Regression floor |
| ------------------------- | ----------------------------------------------------------------- | -------: | ---------------: |
| 1 — address forms         | Unsolicited-reply rate on chatter/opinion/generic-room prompts    |       0% |              ≤5% |
| 1 — address forms         | Live address-forms grade                                          |     100% |              95% |
| 2 — usefulness            | Addressed-response grade                                          |     100% |              90% |
| 3 — issue capture         | Capture-conversation grade across complete and incomplete reports |     100% |              80% |
| 3 — issue capture         | Deterministic filed-issue receipt rate                            |     100% |             100% |
| 4 — multi-message Windows | Per-concern handling grade                                        |     100% |              50% |
| 5 — hard silence          | SMOKE hard-silence rate                                           |     100% |             100% |
| 6 — elicitation           | Elicitation-quality grade                                         |     100% |              80% |

Axis 4 has the deliberately conservative judged floor: the grade is stochastic, while the exact no-chatter and mutation
mechanics remain protected by deterministic assertions. A future split must preserve or improve these floors; a single
high judged sample is not presented as a deterministic guarantee.

## Run receipt

`pnpm evals` starts isolated fixture processes on a dynamically allocated port and runs both families in sequence. It
requires `AMBIENCE_FIXTURE_DATA_DIR` for the live model. Set `BRAINTRUST_API_KEY` and either
`BRAINTRUST_PROJECT_ID` or `BRAINTRUST_PROJECT_NAME` to record the run-scoped experiment and content-bearing Flue traces
in a reviewed non-production Braintrust project. The project ID takes precedence. Set `BRAINTRUST_EXPERIMENT_NAME` only
when intentionally appending to an existing experiment.

The authenticated baseline receipt was:

- deterministic: 12 passed, 9 live cases gated; all four required mechanics cases passed with exact recorded effects;
- live judged: 9 passed, 12 deterministic cases gated; every recorded axis met its regression floor;
- test execution: 14.66 seconds deterministic + 225.45 seconds live; the combined command remained inside the five-minute
  validation budget.
