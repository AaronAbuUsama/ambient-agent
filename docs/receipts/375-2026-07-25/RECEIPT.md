# Receipt — node #375, prompt and skill store with customisation tracking

- **Node:** #375 · surface **backend** · branch `agent/coder/issue-375`
- **Proven head:** see §1 (base `15421b9`, which carries #366's single resolution seam)
- **Captured by:** the node's teammate. Tiers 3–5 are the orchestrator's, post-merge.

Two heads were proven and superseded before this one; **only the run below is reported**, because
the head that was proved must be the head that merges.

1. `b4af096` — superseded by the independent review, which found that `getPromptStore()` self-filled
   an unbound slot: a boot-order mistake would have served prompts from a private in-memory store
   while operator edits landed in the durable file, silently. That plus four other findings are
   fixed; §7 lists them.
2. `f3ea299` / `95cc598` — superseded by the rebase onto `15421b9` (#366), which moved every
   configuration and secret reader onto `packages/installation/src/configuration-source.ts`. The
   prompt store now rides that seam rather than opening the database beside it; §8 covers the rebase.

## Tier table

| tier | contract | verdict | evidence |
|---|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green, covering seed, re-seed, preserve-on-upgrade, revert, and invalid-save-refused | **PASS** | §1 |
| 2 integrated | `pnpm run evals:deterministic` green with prompts served from the store | **NOT PROVEN** — owner ruling, see §2 | §2 |
| 3 live (WhatsApp, after merge) | distinctive instruction added through the store, obeyed under a nonce, reverted | orchestrator | §3 |
| 4 readback | store shows customised + seed version, unmarked after revert; archive holds both turns | orchestrator | §3 |
| 5 observed | both turns in Braintrust, the first carrying the edited instruction | orchestrator | §3 |

## 1. Tier 1 — mechanical · 2026-07-25T17:33Z → 17:34:21Z

Run against the exact committed head with a clean tree (`git status --short` empty), after the
rebase onto `15421b9`.

```
$ git rev-parse HEAD
6e1b11a1976f0ccae40c05dc642e07cb0b59da70
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  88 passed | 1 skipped (89)
      Tests  932 passed | 4 skipped (936)
   Duration  75.18s
```

`6e1b11a` is every line of code that merges. The only commit after it is this receipt, which touches
`docs/receipts/375-2026-07-25/` and nothing else — verifiable with
`git diff --stat 6e1b11a..HEAD`. A commit cannot state its own hash, so the code head is named here
and the branch head is reported to the orchestrator alongside the CI run that covers it.

Full tail: `logs/tier1-test.txt`. This node adds 21 tests in `tests/managed/prompt-store.test.ts`,
changes one existing assertion in `tests/speaker/participation.test.ts` (the Speaker's skill is now
resolved, not imported), and no longer adds a `ManagedPaths` entry — #366 landed the same path as
`managedConfigDatabase`, so the rebase drops this node's redundant `managedConfigStore`.

**One local flake, disclosed:** on an earlier attempt at this same head,
`tests/managed/tenant-credentials.test.ts > serializes model credential rotation across independent
processes` timed out at 15s. It spawns two `tsx` child processes and is timing-sensitive on a loaded
machine. It reproduces **identically on clean `main` (`15421b9`)** with none of this node's changes
present, so it is environmental and not attributable here; it passes in the clean run reported above,
and CI is green at this head on both Node 22 and Node 24.

`tests/managed/prompt-store.test.ts` covers, per acceptance criterion:


| criterion | test |
|---|---|
| instructions and skill bodies for every role resolve from the store | additionally, "leaves no agent prose compiled into an agent module" reads every agent module and refuses a literal `instructions:` / `skills: [` that does not go through the store — the assertion that catches a role added *without* a catalog entry |
| shipped files seed the store on first boot | "seeds every shipped entry on first boot and records the version it was seeded from" |
| an untouched entry re-seeds when the shipped version changes | "re-seeds an untouched entry when the shipped version changes" |
| an edited entry is preserved across that upgrade and marked customised | "preserves an edited entry across the upgrade, marks it customised, and keeps the divergence visible" |
| an edited entry can be reverted | "reverts an edited entry to the shipped body and clears the customised mark"; "keeps an edited skill body mountable and reverts it" |
| an entry records the version it was seeded from | asserted in all four of the above (`seededVersion` vs `shippedVersion`) |
| an invalid skill body is refused on save | "refuses an invalid skill body on save and leaves the stored body whole" (four invalid shapes: no frontmatter, missing name, illegal name shape, malformed YAML) |
| **negative:** a failed save never leaves a partially written prompt | same test — after every refusal, `resolve` still returns the whole shipped body, the entry is still not customised, and `resolveSkill` still builds a reference. Also "refuses empty instructions and an unknown entry rather than guessing". |
| instructions and skill bodies for every role resolve from the store | "covers every mounted role and skill in the shipped catalog" (the store's ids equal `PROMPT_IDS` exactly), plus one resolution test per role: Speaker, Brain, both Scribe configurations, Planner/Coder/Verifier profiles, Reviewer |

Durability and the operator surface are covered separately: "survives a restart and keeps the
customised mark across it" (a real SQLite file, closed and reopened, re-seeded with a newer shipped
version) and "lists, edits, refuses, and reverts against a seeded data directory" (`runCli`).

## 2. Tier 2 — integrated · **NOT PROVEN** (owner ruling) · 2026-07-25T17:34Z

```
$ pnpm run evals:deterministic          (head 6e1b11a)
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)
```

Identical at the baseline, on an unmodified `main`:

```
$ git switch --detach 21a2905 && pnpm run evals:deterministic
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)
```

**Ruling:** the orchestrator reproduced this on clean `main` (`a7cedb1`) — same 5 failed / 10 passed
/ 22 skipped — and traced the cause to PR **#317** (`f06208b`, 2026-07-23), which moved the issue
tools to the Brain while `issue-management.eval.ts:7` kept driving
`createFlueAgentHarness({ agentName: "speaker" })` and asserting `github_create_issue`. Nothing
caught it because **CI never runs the evals**. The owner has ruled: **merge with tier 2 recorded NOT
PROVEN**, with the eval repair filed as its own node. It is not charged to this node, and this node
was not asked to fix it.

Logs: `logs/tier2-evals-head.txt`, `logs/tier2-evals-baseline-21a2905.txt`,
`logs/tier2-evals-per-test.txt`. Same five tests, same failure, both before and after.

The failure is **not** a prompt failure. All five fail the same way — a tool call the Speaker cannot
serve — across two files: four in `issue-management.eval.ts` (three on `github_create_issue`, one on
`github_update_issue`) and one in `participation-mechanics.eval.ts`, whose error body is explicit:

```
"error": { "message": "Tool github_create_issue not found" }
```

The deterministic issue-management suite still drives the **Speaker** through `github_create_issue`
and `github_update_issue`, but issue filing and mutation moved to the **Brain**; the Speaker mounts
neither tool (`tests/speaker/issue-management.test.ts:1045` asserts exactly that absence). The suite
describes an architecture the code no longer has, and has done since before this node. Repairing it
means rewriting the issue-management eval suite against the Brain, which is a different node's work.

What tier 2 *does* establish here: the ten passing eval cases run against a live `flue dev` fixture
whose agents — the Speaker, and the fixture's Planner and Verifier surfaces — resolve every
instruction block and skill body from the prompt store, because after this change there is no other
path. The fixture binds its own store explicitly (`tests/fixtures/speaker/src/app.ts`), seeded from
the same shipped catalog through the same code; nothing is auto-filled and nothing is stubbed. The
Planner and Verifier prose evals in particular now grade the catalog's shipped instructions rather
than a fixture-local copy of them, which is what makes "the evals still describe what runs" true for
those two roles rather than merely claimed.

The contract asked for green; the tree was not green when this node started, for a reason this node
does not touch. It was reported rather than lowered, and the ruling above is what settled it.

## 3. Tiers 3–5 — what the orchestrator runs, post-merge

The store is reachable without a redeploy. On the rig, after deploying the merged head:

```
# 0. the roster, with each entry's customised state and seed version
ambient-agent prompt list

# 1. take the shipped Speaker instructions, append the nonce instruction, save it
ambient-agent prompt show instructions:speaker > /tmp/speaker.txt
printf '\nWhenever you reply in this chat, end the message with the exact token %s.\n' "$NONCE" >> /tmp/speaker.txt
ambient-agent prompt set instructions:speaker /tmp/speaker.txt
#   → "Saved instructions:speaker; it is now customised (seeded from <version>)."

# 2. send the nonce-tagged message into Tst; the reply must carry $NONCE  (tier 3, before/after)

# 3. tier 4 readback — customised, with the seed version
ambient-agent prompt list --json | jq '.[] | select(.id=="instructions:speaker")'
#   → { "customised": true, "seededVersion": "<v>", "shippedVersion": "<v>", ... }

# 4. revert, then send a second nonce-tagged message; the reply must NOT carry the token
ambient-agent prompt revert instructions:speaker
ambient-agent prompt list --json | jq '.[] | select(.id=="instructions:speaker") | .customised'
#   → false
```

No restart is needed between any of these steps: the agent initializer resolves from the store on
every session initialization, and the CLI writes the same 0600
`~/.ambient-agent/managed-config.sqlite` the runtime reads. Tier 5 needs no extra action — both turns
trace to Braintrust as any turn does, and the first carries the edited instruction in its system
prompt.

`ambient-agent prompt` reads and writes entries but never creates them; the runtime is the process
that carries the shipped catalog and seeds at boot. Against a data directory the runtime has never
booted, `prompt list` says the store is empty rather than inventing entries.

**Run the CLI as the service user.** The store is a 0600 file owned by whoever created it, and
`createManagedConfigStore` chmods it on open. `sudo -u <service-user> ambient-agent prompt …` — a
root or foreign-user invocation either fails with `EPERM` or leaves a file the service cannot open.

## 7. What the independent review changed

Five reviewers ran against `b4af096`. Fixed here:

| finding | fix |
|---|---|
| `getPromptStore()` self-filled an unbound slot, so a boot-order mistake would serve in-memory prompts while operator edits went to the durable file, silently | it throws now, like every sibling `createFlueGlobal` singleton; tests and the eval fixture bind explicitly via `configureEphemeralPromptStore` |
| `resolve()` never re-validated an `instructions` row, so a corrupted row served an empty system prompt silently | `resolve` re-validates on read, matching what `resolveSkill` already did |
| the frontmatter parser used js-yaml's default schema where Flue uses `FAILSAFE_SCHEMA`, so `name: yes` parsed as a boolean and was refused with a misleading message | parses with `FAILSAFE_SCHEMA`, the same predicate Flue applies |
| a shipped entry that changed `kind` kept the customised body, producing a row whose body did not match its kind — failing at the next agent turn instead of at save | a kind change re-seeds; the edit is not portable across kinds |
| the eval fixture's Planner and Verifier kept a second, divergent copy of role prose | both take `storedInstructions(...)` from the catalog |
| the "every role" assertion only proved the catalog agreed with itself — hardcoding a role's prompt broke nothing | a source-level guard refuses a literal `instructions:`/`skills: [` in any agent module that does not go through the store. Mutation-checked: hardcoding the coder coordinator fails it. |
| the SQLite adapter's unknown-kind guard, the double-seed no-op, and cross-process visibility were untested | three tests added, including one that writes a corrupt row with a raw `DatabaseSync` and one that proves a second process's edit is visible to an already-open store — the "no restart" claim |
| stale `SKILL.md` paths in `PROVENANCE.md`, `packages/agents/README.md`, `packages/agents/package.json` | corrected |

Not fixed, deliberately: WAL journal mode (rollback journal is fine at prompt-edit frequency),
memoizing skill construction per agent turn (not on any profile yet), and a build-version stamp to
detect a stale CLI validating against a newer runtime's rules (real, but its own node's work).

## 8. The rebase onto #366

`main` moved to `15421b9` (#366, the single resolution seam) while this node was finishing, and the
PR went `CONFLICTING`. Resolved **through** the seam rather than around it:

| conflict | resolution |
|---|---|
| `paths.ts` — both nodes added the same path under different names | #366's `managedConfigDatabase` wins; this node's `managedConfigStore` is dropped as redundant, along with its two test fixtures. Its doc comment now records that the prompt store shares that file and that two processes open it. |
| `managed-config-store.ts` — #366 added `deleteSecret`, this node added `promptRows` | both kept; the additions are orthogonal |
| `apps/runtime/src/app.ts` — #366 stopped opening a store here (the CLI opens the seam and passes it in) | the prompt store binds from `source.store.promptRows`. **No second store is opened**, which is strictly better than the pre-rebase code: one file, one opener, one seam. |
| `apps/cli/src/prompt-store.ts` — opened the database itself | now `withManagedConfigurationSource(paths, …)`, #366's own helper, which is exactly the open/use/close this node had written by hand. The four `prompt` commands became async. |

The `SKILL.md` → `skill-body.md` rename survived intact: all six documents plus the `raw-md.d.ts`
replacement for `flue-skill.d.ts` are present, `pnpm run build:dist` still succeeds (exercised by
`tests/packaging/packed-cli.test.ts`, green), and the seeding path that forced the rename is
unchanged — #366 touched credential readers, not the skill-import path.
