# Receipt — node #375, prompt and skill store with customisation tracking

- **Node:** #375 · surface **backend** · branch `agent/coder/issue-375`
- **Proven head:** `b4af0961970a853e9ed386cabf6d2a998b8779a4` (base `21a2905`, which carries #364, #369, #365)
- **Captured by:** the node's teammate. Tiers 3–5 are the orchestrator's, post-merge.

## Tier table

| tier | contract | verdict | evidence |
|---|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green, covering seed, re-seed, preserve-on-upgrade, revert, and invalid-save-refused | **PASS** | §1 |
| 2 integrated | `pnpm run evals:deterministic` green with prompts served from the store | **BLOCKED — pre-existing red on `main`, unchanged by this node** | §2 |
| 3 live (WhatsApp, after merge) | distinctive instruction added through the store, obeyed under a nonce, reverted | orchestrator | §3 |
| 4 readback | store shows customised + seed version, unmarked after revert; archive holds both turns | orchestrator | §3 |
| 5 observed | both turns in Braintrust, the first carrying the edited instruction | orchestrator | §3 |

## 1. Tier 1 — mechanical · 2026-07-25T16:15:09Z → 16:17:00Z

Run against the exact committed head with a clean tree (`git status --short` empty).

```
$ git rev-parse HEAD
b4af0961970a853e9ed386cabf6d2a998b8779a4
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  85 passed | 1 skipped (86)
      Tests  881 passed | 4 skipped (885)
   Duration  96.17s
```

Full tail: `logs/tier1-test.txt`. Baseline on `21a2905` was 880 passed; this node adds 16 tests in
`tests/managed/prompt-store.test.ts` and changes one existing assertion in
`tests/speaker/participation.test.ts` (the Speaker's skill is now resolved, not imported) and two
`ManagedPaths` fixtures (`managedConfigStore` is now a named managed path).

`tests/managed/prompt-store.test.ts` covers, per acceptance criterion:

| criterion | test |
|---|---|
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

## 2. Tier 2 — integrated · 2026-07-25T16:19Z

```
$ pnpm run evals:deterministic          (head b4af096)
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)
```

Identical at the baseline, on an unmodified `main`:

```
$ git switch --detach 21a2905 && pnpm run evals:deterministic
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)
```

Logs: `logs/tier2-evals-head.txt`, `logs/tier2-evals-baseline-21a2905.txt`,
`logs/tier2-evals-per-test.txt`. Same five tests, same failure, both before and after.

The failure is **not** a prompt failure. Every one of the five is the same assertion:

```
"error": { "message": "Tool github_create_issue not found" }
```

The deterministic issue-management suite still drives the **Speaker** through `github_create_issue`
and `github_update_issue`, but issue filing and mutation moved to the **Brain**; the Speaker mounts
neither tool. The suite describes an architecture the code no longer has, and has done since before
this node. Repairing it means rewriting the issue-management eval suite against the Brain, which is
a different node's work.

What tier 2 *does* establish here: the ten passing eval cases run against a live `flue dev` fixture
whose agents — the Speaker, and the fixture's Planner and Verifier surfaces — resolve every
instruction block and skill body from the prompt store, because after this change there is no other
path. There is no compiled-in fallback to drift from: `getPromptStore()` fills an unset slot with an
in-memory store that seeds itself from the same shipped catalog, so "served from the store" is
literally true in the fixture, in unit tests, and in production alike.

**This is the orchestrator's call, not mine to lower.** The contract asks for green; the tree was
not green when this node started, for a reason this node does not touch.

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
