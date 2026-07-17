# Package taxonomy relitigation — handoff

Read this file FIRST on resume, before touching code. It is the single source of truth for
where this decision stands. Nothing has been committed yet — this whole document records an
**analysis and a set of ratified decisions that still need to be turned into commits**, plus
one newly-opened question that is NOT yet resolved.

## Mission

Issue [#117](https://github.com/AaronAbuUsama/ambient-agent/issues/117) did the mechanical
monorepo cut: `apps/cli` + `packages/{core,server,test-support}`. During that review Aaron
ratified landing it as-is and relitigating the package *taxonomy* separately — that relitigation
is issue [#130](https://github.com/AaronAbuUsama/ambient-agent/issues/130), which is open now.

Aaron's complaint, in his own words: `packages/server` is an app, not a package, and shouldn't
sit next to `packages/core` — it belongs next to `apps/cli`. `packages/core` is "everything that
isn't cli/server" dumped into one place — not a monorepo split, a dumping ground. And `managed`
as a name "doesn't make sense" — nobody can tell what it means from the name alone.

This session did the code-grounded analysis for both complaints, got sign-off on a concrete
plan (see **Ratified decisions** below), started drafting a `request-refactor-plan` GitHub issue
for it — then Aaron paused to ask a *further* question that widens scope: **where do `agents/`
and `capabilities/` go?** That question is open, not yet answered. See **Held / next**.

## Ratified decisions (confirmed by Aaron this session)

1. **Split shape: two packages, not one, not three.**
   `packages/core` splits into:
   - **the brain** (stays named `packages/core`) — `composeAmbience`, agent definition/dispatch,
     capabilities, coalescer, intake, GitHub ingress, observer, logging, shared utils.
   - **`packages/installation`** (new) — everything that is the durable, on-disk state and
     lifecycle of one running Ambience on one machine: paths, config, credentials (GitHub +
     ChatGPT OAuth), DB schema/migration, diagnostics/health, WhatsApp account pairing.
   - Rejected a 3-way split (brain / machinery / "platform infra") — issue #130 itself already
     argues this is premature: there's no second consumer of a hypothetical third package, so it
     would be a hypothetical seam, not a real one (per the codebase-design skill's rule: "one
     adapter means a hypothetical seam, two means a real one").
   - **Why "two, not one, not three"**: measured from actual imports (see #130's body) — the
     brain→machinery edge count is 2 (both constants), machinery→brain is 5 (all
     types/adapters, legal in a layered split). Cheap, already measured, no invented complexity.

2. **`packages/server` moves to `apps/server`.**
   Rationale, verified in code this session: `packages/server/package.json`'s own description
   already calls itself "the server application... the Flue build root." Nothing imports
   `@ambient-agent/server` as a library anywhere — only test files reach into it, exactly like
   `apps/cli`. `pnpm-workspace.yaml` already declares `apps/*` as a distinct glob from
   `packages/*` — the repo's own config already encodes the app/package distinction Aaron is
   pointing at; `server` just wasn't living in it.
   - **Blast radius is tiny and already enumerated**: `git mv packages/server apps/server`, then
     exactly 3 literal-string edits — `package.json`'s `build:server` script
     (`--root packages/server` → `--root apps/server`), and two path references inside
     `tests/ambience/hard-cut.test.ts` (the `sourceFiles([...])` list and one boundary-check
     entry). `vite.config.ts` never references `packages/server` (only `apps/cli/src/main.ts`),
     and test imports of `@ambient-agent/server/...` resolve by package name via the workspace
     glob, not by path — so those don't change.

3. **The new package is named `installation`, not `managed`.**
   Rejected `managed` for two reasons: (a) it's vague — "what does managed even mean" — and
   (b) it's a genuine domain-vocabulary collision. `CONTEXT.md` already defines **Managed Chat**
   (a WhatsApp chat explicitly configured for participation) as ratified vocabulary, and
   `intake/managed-chat-inbox.ts` correctly uses that sense. `packages/core/src/managed/` means
   something completely unrelated (local install state) — same word, two unrelated concepts, in
   the same codebase.
   `installation` was chosen because it's not an invented label — it's the CLI's own existing
   verb vocabulary: `ambient-agent init/config/repair/status/doctor` all act on the thing this
   package would own. Traced file-by-file: `paths.ts` (where files live), `configuration.ts` /
   `schema.ts` (the config file), `installation.ts` / `migration.ts` (create/upgrade in place),
   `diagnostics.ts` / `runtime-health.ts` (is it healthy), `chatgpt-authentication.ts` (where the
   model credential lives), and the WhatsApp account/pairing state moving in from
   `core/whatsapp/account.ts`. Every one of those is "the installation."
   `station`, `operator`, `host` (from #130's original candidate list) were all rejected —
   `host` in particular collides with an *existing* directory name (`core/src/host/`, see #4).

4. **`core/src/host/*` (2 files) folds into `core/src/github/*`, same refactor.**
   `host/github-issue-repository.ts` and `host/issue-operation-footer.ts` are Octokit-specific
   GitHub adapter code (the concrete adapter for the `IssueRepository` port), not local-machine
   install state. They were only sitting in `host/` because nobody had given them a proper home.
   Zero internal-core dependents (only wired externally, by `apps/server/src/app.ts` and
   `apps/cli/src/inspection.ts`) — a pure rename, cheap to do now. Left alone, `host/` would
   become a second junk drawer, same mistake as `managed/` under a different name.
   Note: this is a **separate, unrelated** naming collision from #3 — `packages/server/src/host/`
   (whatsapp-runtime.ts, smoke-route.ts) is a *different* "host" sense ("the process that hosts a
   live runtime") that stays as-is; nobody inside that package confuses it with anything else in
   that package, so it was not flagged for a rename.

5. **Two constant-holding files move from `managed/` into `core`, not the other way round**, so
   that the machinery package only ever imports the brain, never the reverse (per #130's original
   edge analysis): `model/pi-subscription.ts` is already in `core` (no move needed — it's
   `managed/database-versions.ts` that needs to move down into `core` proper, since
   `intake/conversation-archive.ts` — a brain file — currently imports the DB schema-version
   constants from it).

6. **`logging/` and `shared/` stay in `core` (brain), not `installation`.**
   This was #130's own open question 5 ("brain-owned, machinery-owned, or wherever importers
   demand"); this session settled it by grep: both are imported *from inside* `core/` itself
   (`ambience/dispatch.ts` imports `logging/agent-activity-reporter.ts`;
   `coalescer/whatsapp.ts`, `github/ingress.ts`, `intake/admission-relay.ts` all import
   `logging/logging.ts`; several brain files import from `shared/`). Moving either to
   `installation` would create a forbidden brain→machinery edge. Settled, not up for debate.

7. **Delivery: one PR, one sequence of tiny commits** (Fowler-style — every commit leaves the
   tree green), covering items 1–6 above. Not split into separate PRs per move.

## What's done

Nothing committed. This was a pure analysis-and-decision session on top of the already-merged
[PR #129](https://github.com/AaronAbuUsama/ambient-agent/pull/129) (#117's mechanical cut).
Current tip: `c58ad65` on `feat/117-monorepo-split` (working tree clean).

An in-progress `request-refactor-plan` interview (skill: `request-refactor-plan`) had gathered
decisions 1–7 above and was about to draft the tiny-commit sequence + file the GitHub issue when
Aaron paused it to ask the open question below. **Resume that skill once the open question is
answered** — do not re-litigate decisions 1–7, they're settled.

## Held / next — THE OPEN QUESTION

Aaron's pause, verbatim intent: *"where did the actual agents go? What's the agents package look
like? How do you do the agents and then the capabilities and all that — where do those go? Let's
think about it properly and holistically."*

This is **not yet answered**. It widens the relitigation beyond #130's original scope (which only
ever considered "brain" as one undifferentiated lump). Grounding gathered so far, to save
re-deriving it:

- **`core/src/agents/ambience.ts`** (1 file) is the actual Flue-discovered agent definition —
  `export default defineAgent(({ id }) => ({ model, skills, tools, instructions }))`. It directly
  imports both capabilities (`capabilities/issue-management/{SKILL.md,tools.ts}`,
  `capabilities/whatsapp-participation/{SKILL.md,tools.ts}`) and `model/pi-subscription.ts`. This
  is where "who Ambience is" gets assembled.
- **`packages/server/src/agents/ambience.ts`** is a **deliberate 3-line re-export stub**, not a
  naming collision to fix: `export { default, description } from "@ambient-agent/core/agents/ambience.ts"`.
  Its own comment cites a prior decision ("T8: dispatch and agents stay together in core") — Flue
  discovers agents by walking each build root's own `src/agents/` directory, so the stub exists
  purely to satisfy that discovery convention while the real definition lives in `core` next to
  `dispatch.ts`, which hard-imports it. **Do not flag this pairing as a problem** the way `managed`
  vs `Managed Chat` or the two `host/` dirs were flagged — it's already intentional and documented.
- **`capabilities/`** is not an ad hoc directory name — `CONTEXT.md` already defines **Capability**
  as ratified domain vocabulary: "A cohesive kind of work the Ambient Agent can perform for the
  group. Capabilities are the canonical way the product grows." There are exactly two today:
  `whatsapp-participation/` (2 files: `whatsapp-port.ts`, `tools.ts`) and `issue-management/`
  (4 files: `operation-store.ts`, `runtime.ts`, `issue-repository.ts`, `tools.ts`, plus each has
  a `SKILL.md`). Both are wired directly and statically into `agents/ambience.ts`'s
  `skills: [...]` / `tools: [...]` arrays — **there is no dynamic capability-discovery or plugin
  mechanism today.** That matters for the open question: splitting each capability into its own
  *package* only pays off if something needs to consume one capability without the other (a
  stripped deployment, independent versioning, a third-party capability). Nothing in the codebase
  needs that today — by the "one adapter is hypothetical, two is real" rule, there ARE two
  capabilities (a real seam exists at the directory level already), but package-level separation
  is a bigger, currently-unproven claim than directory-level separation. This needs to be put to
  Aaron directly, not decided unilaterally.

**Next steps for the fresh session**:
1. Re-ground in code if any doubt: `packages/core/src/agents/`, `packages/core/src/capabilities/`,
   `packages/server/src/agents/`, and grep for every importer of both (same technique used in this
   session: `grep -rln "from [\"'].*capabilities/" packages/core/src packages/server/src apps/cli/src`).
2. Bring Aaron **concrete options in code** (per his standing CLAUDE.md instruction — see
   Gotchas below) for where `agents/` and `capabilities/` land: e.g. (a) leave both inside the
   brain package as directories, just tidied — no new package boundary, since nothing consumes
   them independently yet; (b) `packages/capabilities` as a sibling package to `core`, with `core`
   depending on it — real only if the brain/capabilities edge count and direction supports a
   clean layering; (c) one package per capability (`packages/capability-issue-management`, etc.)
   — almost certainly premature with only 2 capabilities and no plugin loader, flag as likely
   over-engineering unless Aaron has a near-term reason (e.g. a plugin/marketplace roadmap this
   session doesn't know about).
3. Once that's settled, fold the answer into decision list above, then resume the
   `request-refactor-plan` skill: finish the tiny-commit sequence and file the GitHub issue
   (updating #130 in place was one option floated but not chosen — Aaron picked "run
   request-refactor-plan" i.e. a fresh issue with the full plan).

## How-to / conventions to match

- Ground every option in real code (file:line, actual grep output) before presenting choices —
  this is a standing instruction from Aaron's global CLAUDE.md, not specific to this task. He
  explicitly rejected a prior prose/table-heavy answer this session as "non-legible" and asked
  for folder-structure visuals with real file names instead. When re-presenting the
  agents/capabilities options, prefer the same visualize-tool structural approach used earlier in
  this session (an HTML file-tree widget with per-package file lists and a depth/interface-size
  note), not another markdown table.
- Test coverage for this whole relitigation is `tests/ambience/hard-cut.test.ts` — it already
  enforces the `core`/`cli`/`server` import-boundary rules and will need a fourth boundary line
  added for `packages/installation` (and updated paths once `server` → `apps/server`). No new
  test framework or fixtures needed — this is a pure-move refactor, not new behavior.
- Eval-battery gate: any structural refactor here must keep the eval battery at the #113 baseline
  (same gate #117 and #130 both use) — "structure changed, behaviour didn't."

## Gotchas & risks

- **Don't re-litigate decisions 1–7** — they're confirmed by Aaron this session. Only the
  agents/capabilities placement is open.
- **`server/agents/ambience.ts` is not a bug** — see above, it's a Flue-discovery stub, leave the
  re-export pattern alone regardless of what else moves.
- **`packages/server/src/host/`** (whatsapp-runtime.ts, smoke-route.ts) and
  **`packages/core/src/host/`** (being merged into `core/github/` per decision 4) are two
  unrelated "host" senses in two different packages — only the `core` one is being renamed here.
- Main is PR-only (no direct pushes) — this relitigation lands as its own PR against
  `feat/117-monorepo-split` or main per whatever the current base is; check before opening.
- The wildcard `"./*"` export on both `core` and the new `installation` package is a known,
  explicitly out-of-scope gap — moving files does not by itself make either package deep. Curating
  the export surface down to named exports is a **separate**, later design pass. Don't let it
  creep into this refactor's scope; do flag it as an explicit "Out of Scope" line in the
  `request-refactor-plan` issue.

## Key file / context pointers

- Issue [#130](https://github.com/AaronAbuUsama/ambient-agent/issues/130) — the original
  relitigation issue this session built on and is about to supersede/update.
- PR [#129](https://github.com/AaronAbuUsama/ambient-agent/pull/129) — the merged #117 mechanical
  cut this all sits on top of.
- `CONTEXT.md` — domain glossary; defines **Capability**, **Managed Chat**, **Ambience**, etc.
  Check here first before naming anything new.
- `tests/ambience/hard-cut.test.ts` — the boundary-enforcement test to extend.
- `pnpm-workspace.yaml` — already has the `apps/*` / `packages/*` split `server` needs to move into.
- Memory: `monorepo-cut-117.md` (background on #117/#130), this file supersedes it for the
  taxonomy question specifically — update that memory's pointer once this lands.
