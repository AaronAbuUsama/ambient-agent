# WhatsApp → GitHub → WhatsApp proof — 2026-07-13

## Scope and safety

- Ran the clean `codex/subscription-only-model` worktree locally with the existing paired WhatsApp session.
- Used ChatGPT subscription authentication with `gpt-5.6-luna` at low reasoning. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` were unset for both runs.
- The live process was restricted to `AaronAbuUsama/wa-bot-sandbox` through both `GITHUB_REPO` and `GITHUB_ALLOWED_REPOS`. No production repository was in scope.
- No session credentials, API keys, or persisted session-state payloads are recorded here.

## What was fixed

1. The detached launcher now accepts the structured result from exactly one `github` child completion, not from the launcher parent. A valid child result is retained even if the parent later has `OUTPUT_SCHEMA_NOT_FULFILLED`.
2. The durable queue persists the result before report-back; only the atomic `reporting` claimant may resume the voice and call `say`.
3. An exact duplicate delegation returns an `already_handled` acknowledgement without a URL. The ledger instructions make the durable report-back the single URL-bearing message owner.

## Local verification

```sh
pnpm test -- tests/gateway/action-ledger.test.ts tests/gateway/delegation.test.ts
pnpm test
pnpm typecheck
source ~/.nvm/nvm.sh && nvm exec 24 pnpm build
```

- Focused gateway tests: 26 passing.
- Full suite: 157 passing.
- Typecheck and Node 24 build: passing.

The focused coverage includes a captured child-completion/parent-failure sequence, report-owner concurrency, restart-before-report, durable ledger replay, exact duplicate suppression, and the injected ambient/addressed coalescer seams.

## Live proof

The first clean run established the receive path: ambient group text was stored in the fresh SQLite database with no job and no outbound message; an addressed non-GitHub request produced one reply with no job.

The first GitHub run created sandbox issue [#6](https://github.com/AaronAbuUsama/wa-bot-sandbox/issues/6), persisted `create_issue` and its URL, and reported it in WhatsApp. Repeating that request created no second job or issue, but the voice agent repeated the URL. That exposed the single-report bug above; it was fixed before the final run.

The final clean run created sandbox issue [#7](https://github.com/AaronAbuUsama/wa-bot-sandbox/issues/7). Its sanitized event sequence was:

1. inbound addressed request `3B3D1C3B7F9511AF11DB`;
2. one durable job `ca84fca895dc39c0fa0e9bddd94e4e04e71a8693dc0b583e6dd98d395751d29b`, observed `pending → running → reporting → done`;
3. outbound acknowledgement `3EB0651A534E209F846FFA`;
4. child result persisted as `create_issue`, number `7`, with the sandbox URL;
5. resumed voice recorded the result before `say` (enforced by the runtime ledger-before-say assertion), then emitted report `3EB01863ABBB9AB1E3B1CD`;
6. inbound exact repeat `3B6D5EE5505BB4CDF740`; outbound URL-free duplicate acknowledgement `3EB0C44941C0245DAAE694`.

The job was created at `2026-07-13 14:04:11` and reached `done` at `2026-07-13 14:04:54`, with one worker attempt.

| Check | Observed result |
| --- | --- |
| Durable job | one row, `done`, one attempt, `create_issue`, issue #7 |
| GitHub | exactly one issue matching the unique title |
| WhatsApp report | exactly one outbound message containing the #7 URL |
| Exact repeat | no second job, no second issue, reply: `This request was already handled; no duplicate issue was queued.` |
| Desktop surface | WhatsApp Desktop showed the issue report and the duplicate acknowledgement |

Both sandbox artifacts (#6 and #7) were closed after verification.

## Boundary

This is a local paired-account proof against the sandbox repository, not a production deployment or a claim that arbitrary WhatsApp accounts are configured. The live ledger ordering was verified by the runtime assertion before the observed report; the serialized session state was deliberately not copied into this report because it can contain private chat context. The next ordinary operation is to review and merge the PR, then deploy through the normal environment-specific path.
