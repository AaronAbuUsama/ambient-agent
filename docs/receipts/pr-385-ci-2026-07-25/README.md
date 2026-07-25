# Receipt — PR #385 CI fix: the console scaffold forked `@flue/runtime`

**PR:** [#385](https://github.com/AaronAbuUsama/ambient-agent/pull/385) ·
**proven head:** `af47e1d7b541bc55f7ccb018eb6bb2cbf59ef76e` ·
**red head:** `82ad173` ·
**control:** `origin/main` `3641dfb`
**Date (UTC):** 2026-07-25 · **Surface:** tooling / build

Not a DAG node — this is a CI repair on a chore PR, so it has no node proof contract. The tiers below
are the map's proof profile applied to what this change actually touches, with every unreached tier
reported as **N/A** and its reason, never promoted.

## Run identifiers

There is **no behavioural nonce** for this change, and inventing one would be theatre: nothing
user-visible changed, and no value travels a code path. The fresh per-run identifiers that *do* tie this
evidence to this run are the commit sha and the CI run ids below, none of which existed before it.

| identifier | value |
|---|---|
| proven commit | `af47e1d7b541bc55f7ccb018eb6bb2cbf59ef76e` |
| CI run (green, this head) | [30155558333](https://github.com/AaronAbuUsama/ambient-agent/actions/runs/30155558333) — Node 22 job `89672825634`, Node 24 job `89672825648` |
| CI run (red, prior head `82ad173`) | [30152469984](https://github.com/AaronAbuUsama/ambient-agent/actions/runs/30152469984) — Node 22 job `89665054162`, Node 24 job `89665054151` |

## Tier table

| tier | verdict | what was run | evidence |
|---|---|---|---|
| 1 mechanical | **PROVEN** | `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm vitest run tests/speaker/braintrust.test.ts` | [`logs/tier1-install.txt`](logs/tier1-install.txt), [`logs/tier1-typecheck.txt`](logs/tier1-typecheck.txt), [`logs/tier1-braintrust-test.txt`](logs/tier1-braintrust-test.txt) |
| 1 mechanical (CI, authoritative) | **PROVEN** | full suite on Node 22 + Node 24 | run [30155558333](https://github.com/AaronAbuUsama/ambient-agent/actions/runs/30155558333), both jobs pass (1m39s / 1m47s) |
| 2 integrated | **PRE-EXISTING FAILURE — not this change** | `pnpm run evals:deterministic` at this head *and* at `origin/main` | [`logs/tier2-evals-head.txt`](logs/tier2-evals-head.txt) vs [`logs/tier2-evals-main-control.txt`](logs/tier2-evals-main-control.txt) — the same 5 tests fail identically at both heads |
| 3 live | **N/A** | — | This change alters pnpm workspace membership only. No runtime code, no route, no agent behaviour; there is no live state for it to alter. |
| 4 readback | **PROVEN** | the durable lockfile delta, exact peer-keyed snapshot keys | [`logs/tier4-lockfile-readback.txt`](logs/tier4-lockfile-readback.txt) — 2 snapshots → 1, and `git diff origin/main -- pnpm-lock.yaml` is empty |
| 5 observed | **N/A** | — | No model traffic. |

## What was wrong

`apps/*` is a workspace glob in `pnpm-workspace.yaml`, so the tracked `apps/web` scaffold became a
workspace member and brought its own toolchain — `typescript: ~6`, `vite: ^8` — neither routed through
the root catalog (`typescript: ^5.7.2`).

That re-keyed pnpm's peer resolution. `apps/runtime`'s `flue` dependency resolved against
`typescript@6.0.3` while the root importer stayed on `5.9.3`, so the lockfile grew a **second**
peer-keyed `@flue/runtime@1.0.0-beta.9` snapshot:

```
82ad173  pnpm-lock.yaml:6731  '@flue/runtime@…(typescript@5.9.3)…'
82ad173  pnpm-lock.yaml:6766  '@flue/runtime@…(typescript@6.0.3)…'   ← the fork
```

Two module instances is why the failure was *asymmetric*. In `tests/speaker/braintrust.test.ts`:

- `vi.mock("braintrust", …)` applied — the `braintrust` package has no `typescript` peer, so it never
  forked. `expect(initLogger).toHaveBeenCalledWith(...)` passed.
- `vi.mock("@flue/runtime", …)` did **not** apply to the instance
  `packages/engine/src/braintrust.ts` imported. `expect(observe).toHaveBeenCalledTimes(1)` saw 0.

`configureBraintrustTracing` still reached `return true`, which is the tell: `observe` *was* called —
just the real one, not the mock.

## The fix

One line plus a lockfile revert. `apps/web` is excluded from the workspace; the scaffold stays tracked
in git, it is simply not a member yet. #372 makes it one deliberately, when it wires the build, ships
the assets inside the published package, and adds `apps/web/src` to the boundary list in
`tests/speaker/hard-cut.test.ts`.

## Chain of evidence

Three independent tiers converge on the same fact, and a control head rules out coincidence:

1. **Tier 4** shows the mechanism directly in the durable artifact — two peer-keyed snapshots at
   `82ad173`, one at `af47e1d`, and the lockfile now byte-identical to `origin/main`.
2. **Tier 1** shows the consequence gone — the exact assertion CI failed on (`braintrust.test.ts:26`)
   passes 4/4, and `typecheck` exits 0.
3. **CI** shows it on clean runners, both Node majors, from the committed head — not from my tree.
4. **The `origin/main` control** shows the one remaining red tier (evals) failing identically without
   this change, so it cannot be attributed to it.

## Known-not-proven

- **Tier 2 evals fail at both heads** — 5 tests in `issue-management.eval.ts` and
  `participation-mechanics.eval.ts`, all asserting a `github_*` tool result is `status: 'ok'`.
  Consistent with absent local GitHub App credentials. **Pre-existing on main, out of scope here, and
  not fixed by this PR.**
- **`tests/managed/tenant-credentials.test.ts` timed out locally** at 15s under full-suite parallel
  load, and passes alone in 1.2s. Green in CI on both Node majors. Local contention; also a test #368
  deletes.

## Irreversible footprint

None outside git. No live service touched, no message sent, no credential rotated, no published
artifact. The durable records this run created: commit `af47e1d` on `chore/track-web-console`, CI run
30155558333, this receipt, and a comment on PR #385.
