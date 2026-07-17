# Legacy audit — 2026-07-17

Ponytail-audit of the monorepo split (branch `feat/117-monorepo-split`), focused on
legacy leftovers. Report only; nothing applied. Fallow was reporting 30 issues at
scan time (49 by end of session — see root cause below).

## Root cause of the Fallow noise: stale config, not 30–49 real problems

`.fallowrc.json` still points at the pre-split tree:

- `entry: ["src/app.ts"]` → now lives at `apps/server/src/app.ts`
- framework `usedExports` pattern `src/agents/**/*.ts` → agents now live under
  `packages/agents/src/` (and `apps/server/src/agents/`)

With a dead entry point Fallow cannot trace reachability, so most findings are
false "unused" positives, and the count grows as the split adds files.
**Fix first, re-run, then triage the real remainder.**

## Legacy code: one family — one-shot migrations that already ran

Ranked biggest cut first. All deletes are gated on the deployment question at the end.

| # | Tag | What | Where | ~Lines |
|---|-----|------|-------|-------|
| 1 | delete | ADR-0015 managed-root move + legacy-runtime liveness probe | `packages/station/src/migration.ts` (189) + `tests/managed/migration.test.ts` (182) | 371 |
| 2 | delete | `LEGACY_APPLICATION_CORE_SCHEMA` / `_OPTIONAL_SCHEMA` pre-versioned-DB sniffing | `packages/station/src/diagnostics.ts:52-119` + most of `tests/managed/diagnostics.test.ts` (319) | ~380 |
| 3 | delete | pi-auth → ChatGPT credential migration thread | `packages/station/src/paths.ts:17,80` · `packages/station/src/schema.ts:7,29` · `packages/engine/src/model/chatgpt-authentication.ts:73-350` (`legacyPath`/`onLegacyMigration` plumbing, ~60 lines) · `packages/station/src/chatgpt-authentication.ts:14-15` · `packages/station/src/installation.ts:624` | ~80 |
| 4 | delete | Inline `RENAME TO *_legacy` SQL table reshapes | `packages/engine/src/github/operation-store.ts:128-138` · `packages/engine/src/intake/managed-chat-inbox.ts:198-209` | ~30 |

**Keep — not legacy debt despite the name:**

- `legacyFooterPattern` in `packages/station/src/issue-operation-footer.ts:11-39` —
  parses old-format footers on GitHub issues that exist forever remotely.
- ADR-0014 legacy-status mapping in `packages/engine/src/github/ingress-store.ts:99` —
  at-least-once semantics for previously recorded statuses.

## Gating decision

Is the VPS the only installation, or does the `ambient-agent` tarball reach machines
we don't control?

- **Single deployment** → verify each migration recorded (`managed_root_migrations`
  row present, no `pi-auth.json` on disk, schema versions stamped), then delete all four.
- **Distributed** → migrations are load-bearing for one more release, then delete.

Net if all four go: roughly −900 lines (source + tests), −0 deps.

## Suggested order (after the in-flight agent lands)

1. Fix `.fallowrc.json` entries → re-run Fallow → triage the real remainder.
2. One cleanup PR deleting the four migration threads (gated on the decision above).

## Actual fallow run (3.6.0, same day)

`npx fallow`: 12 unused files · 6 exports/types · 6 unused deps · 3 unused devDeps · 15 unlisted deps. Triage:

- **False positives from stale config (fix `.fallowrc.json`):** `apps/server/src/app.ts`,
  `apps/server/src/agents/ambience.ts`, `apps/server/src/channels/github.ts` — entry should be
  `apps/server/src/app.ts`, plugin pattern `apps/server/src/agents/**/*.ts`.
- **Reachable only via vitest, needs eval entries/ignores in config:** the 6
  `packages/test-support/src/evals/*` files, `vitest.evals.config.ts`, `tests/fixtures/packed-oauth-fetch.cjs`.
- **Deliberate flue-build layout, not a bug:** all 6 "unused deps" + 15 "unlisted deps" are the same
  finding twice — third-party runtime deps are centralized in `apps/server/package.json` (flue build
  externalizes declared deps; internal packages deliberately undeclared per its description) while
  `packages/*` import them. Either declare per-package too, or `ignoreDependencies` them; decide once.
- **Small real cleanups:** unused `default` export `apps/server/src/db.ts:7`; unused type exports
  `apps/cli/src/inspection.ts:29`, `apps/cli/src/program.ts:95-96`; root devDeps
  `@ambient-agent/{cli,server,test-support}` flagged unused.

## RESOLVED same day: capabilities/skills placement

Aaron ratified: **each agent is its own thing — skills stay inside the agent's folder.**
Per-agent ownership is the point of `packages/agents` ("one folder per agent"); do NOT hoist
skills to a shared `capabilities/` level or a separate package. A hoist option was presented
and explicitly rejected. Agent #2 arrives as a sibling folder owning its own skills; anything
genuinely shared graduates down to `packages/engine` only when a second agent actually needs it
(precedent: #131 already moved operation-store and input contracts down for exactly that reason).

## Open question parked here: activity-reporter placement

`packages/agents/src/ambience/activity-reporter.ts` (304 lines) mixes a generic
Flue-observation↔dispatch correlation mechanism (buffer/replay/TTL maps, module-level
singleton installed from `apps/server/src/app.ts:30`) with WhatsApp-specific
vocabulary (`whatsapp.window` input check, `AmbienceObserver` events, chat-keyed
`spokeForChat`). Only one agent exists today (ambience), so YAGNI says leave it;
the split line for agent #2 is: correlation core → engine, vocabulary stays with
the agent. Related: package-taxonomy relitigation (#130) — agents/capabilities
placement is still open.
