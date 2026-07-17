# Monorepo cut — live proof

Date: 2026-07-17

Ticket: [#117](https://github.com/AaronAbuUsama/ambient-agent/issues/117)

This records the proof that the monorepo cut changed structure, not behavior: the packed-tarball npx
install on the rig with every smoke station passing, and the full eval battery at the recorded
[#113 baseline](./eval-baseline.md) floors.

## The cut

- `apps/cli` — the CLI **application** (per Aaron's in-session direction: the CLI is cut as an
  application, not a package), with `setup/` folded inside it. The workspace root keeps only the
  publishable `ambient-agent` shell (bin, `dist`, scripts) — no root-level source.
- `packages/core` — composeAmbience (the one composition root, T6 O1), the ambience agent + dispatch
  (together, per T8), capabilities with their skill bundles, coalescer, intake, GitHub ingress,
  managed installation, model, logging, shared, WhatsApp account.
- `packages/server` — the Flue build root: `app.ts`, `db.ts`, agent discovery (re-export of core's
  agent), GitHub channel, WhatsApp runtime host, smoke route.
- `packages/test-support` — fake hosts and repositories, the eval harness, judges, and eval suites.

Boundaries are enforced by `tests/ambience/hard-cut.test.ts`: core imports no sibling; cli and server
share nothing but the `Symbol.for` globalThis handshake (untouched).

**Bundling mechanism** (the load-bearing discovery): `flue build` externalizes exactly the
dependencies declared in its `--root` manifest. `packages/server/package.json` therefore declares
the real npm runtime dependencies but deliberately **not** `@ambient-agent/core`, so core is bundled
into the published `dist/server.mjs` while npm dependencies stay external — the tarball remains
self-contained with an unchanged layout. The CLI bundle pins the same property explicitly with
`pack.noExternal: [/^@ambient-agent\//]`.

**Deferred, documented**: the coalescer stack is NOT part of `composeAmbience` (T6 O1 ratified; O2
deferred). It stays in `runWhatsAppSession` (production) and the fixture's Effect fork (test seams:
injected failure, test debounce).

## Checks

All green locally at the PR tip:

- `pnpm build` — flue server build (agent + channel discovered from `packages/server`) + vp pack CLI
- `pnpm exec vp lint .` — one pre-existing warning (`no-useless-catch` in
  `model/chatgpt-authentication.ts`), no new findings
- `pnpm exec tsc --noEmit` — clean
- `pnpm test` — 377 passed, 3 skipped (39 files), including `tests/packaging/packed-cli.test.ts`
  (npm pack → pnpm install → init/status/start/doctor journeys against the installed tarball)
- `pnpm evals` — see below (authenticated run on the rig)

## Rig

- Host: `code-factory` (user `abuusama`)
- Persistent runtime: tmux session `validate-88`, window `run117`
- Tarball: `$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz`
- Packed artifact SHA-256: `1ee35e74878dea6b4003b28a31521301ea60a6ef39dc78dbd8a3b4d13c2fdf00`
- Data directory: the isolated `$HOME/validate-88/issue126-data` clone (same as the #126 proof; no
  schema change in this PR)
- Runtime health endpoint: `http://127.0.0.1:42069/health`

## npx install transcript

The packed runtime was started with:

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz \
  ambient-agent --data-dir $HOME/validate-88/issue126-data start
```

Health after start:

```json
{"ok":true,"installationId":"CK-jmk8n-7S-fAop5_w8lm","authentication":"chatgpt-oauth",
 "model":"openai-codex/gpt-5.6-luna","provider":"openai-codex",
 "runtime":{"state":"healthy","whatsapp":{"phase":"online"}}}
```

`status --json` (same npx form): `state: ready`, all checks
`application-database:ready · flue-database:ready · whatsapp-session:online ·
github-credential:ready`, `observedRuntime: healthy/online`, uncertain work healthy with 0
mutations, window deliveries 0 pending / 0 failed.

`doctor --json`: exit 0, `state: ready`, `chatgpt: ready`, checks
`application-database:ready · flue-database:ready · whatsapp-session:paired ·
github-credential:ready`.

## Six-station smoke transcript

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz \
  ambient-agent --data-dir $HOME/validate-88/issue126-data smoke --timeout 60000
```

Real output (exit 0):

```text
PASS installation: managed installation ready
PASS chatgpt: authentication ready; live readiness complete
PASS runtime: healthy; WhatsApp online
PASS backlog: 0 pending, 0 failed, no Uncertain work
PASS github: access to AaronAbuUsama/ambient-agent
PASS canary: SMOKE 1506b0797481 settled silent (admission → dispatch → settled-silent)
```

The persistent runtime independently recorded the same nonce and lifecycle
(`$HOME/validate-88/issue117-runtime.log`):

```json
{"operatorEvent":"chat.received","text":"SMOKE 1506b0797481 — ignore","chatId":"120363410063306573@g.us",...}
{"operatorEvent":"agent.settled_silent","windowId":"a9722148-...","dispatchId":"18309592-...",
 "msg":"Ambience settled without saying a WhatsApp message"}
```

## Eval battery vs the #113 baseline

`pnpm evals` ran on the rig from a checkout of the PR tip
(`$HOME/validate-88/issue117-eval-source`, log `issue117-evals-final.log`), authenticated to
Braintrust. Experiment:
[ambient-agent-eval-baseline-2026-07-17T09-53-40-324Z](https://www.braintrust.dev/app/capxul/p/ambient%20agents/experiments/ambient-agent-eval-baseline-2026-07-17T09-53-40-324Z).
Application and judge model unchanged: `openai-codex/gpt-5.6-luna`.

Receipt: deterministic 12 passed (9 live gated); live judged 9 passed (12 deterministic gated) —
identical counts to the baseline receipt.

| Axis                      | Metric                          | Baseline | Floor | This run | Verdict |
| ------------------------- | ------------------------------- | -------: | ----: | -------: | ------- |
| 1 — address forms         | Unsolicited-reply rate          |       0% |   ≤5% |     0.0% | HOLDS   |
| 1 — address forms         | Live address-forms grade        |     100% |   95% |   100.0% | HOLDS   |
| 2 — usefulness            | Addressed-response grade        |     100% |   90% |   100.0% | HOLDS   |
| 2 — usefulness            | Addressed-say rate (mechanics)  |     100% |  100% |   100.0% | HOLDS   |
| 3 — issue capture         | Capture-conversation grade      |     100% |   80% |   100.0% | HOLDS   |
| 3 — issue capture         | Filed-issue receipt rate        |     100% |  100% |   100.0% | HOLDS   |
| 4 — multi-message Windows | Per-concern handling grade      |      80% |   50% |    50.0% | HOLDS   |
| 5 — hard silence          | SMOKE hard-silence rate         |     100% |  100% |   100.0% | HOLDS   |
| 6 — elicitation           | Elicitation-quality grade       |     100% |   80% |   100.0% | HOLDS   |

Axis 4 note, stated plainly: the single judged multi-concern sample graded 0.50 in this run against
an 0.80 baseline sample — at its floor, not above it. The same suite at the branch's previous
commit (identical behavior-relevant code; the two commits differ only by file moves) graded 0.90
(`issue117-evals.log`), confirming what the baseline document already records: this axis's judged
grade is stochastic and its floor deliberately conservative, while the exact no-chatter and
mutation mechanics stay protected by deterministic assertions (all passed in both runs).

## Verdict

Structure changed, behavior didn't: all suites/lint/typecheck green, the packed npx flow runs the
real installation end-to-end with every smoke station passing, and every eval axis meets its
recorded regression floor.
