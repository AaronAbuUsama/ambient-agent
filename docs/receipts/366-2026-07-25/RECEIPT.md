# Receipt — node #366, migrate configuration and secret readers onto the store

- **Node:** #366 · surface **backend** · branch `migrate-readers-onto-store-366`
- **Proven head:** `5f3594926d5dad5890443aa8758090f5da6bb3bf` (base `21a2905`, which carries #365, #364 and #369)
- **Runtime bundle built from that head:** `dist/server.mjs` sha256 `32dcbd00b848392908d3fb9c013cbfaf83486503b75f202af84d57e11f898820`
- **Tiers 1 and 2 are mine.** Tiers 3, 4 and 5 are the orchestrator's, post-merge, on `capxul-vps`. This
  node never touched the rig.

## Tier table

| tier | contract | verdict | evidence |
|---|---|---|---|
| 1 mechanical | `pnpm run typecheck && pnpm test` green; a test asserts no production reader resolves a credential file path directly | **PASS** | §1, §2 |
| 2 integrated | `pnpm run evals:deterministic` green — model resolution still reaches a working provider | **RED, UNCHANGED FROM BASE** — see §3. The suite is red on `origin/main` at `21a2905` with the identical 5 failures; this node neither caused nor fixed them. | §3 |
| 3 live (WhatsApp, after merge) | deployed to the rig; healthy, nonce-tagged `Tst` message gets a reply | orchestrator | §5 |
| 4 readback | conversation archive holds the nonce event; the store shows every secret kind populated from the seed | orchestrator | §5, `tier4-readback.sh` |
| 5 observed | the nonce turn appears in Braintrust with a resolved model | orchestrator | §5 |

## 1. Tier 1 — mechanical · 2026-07-25T16:37:20Z → 16:38:30Z

Run against the exact committed head with a clean tree (`git status --short` empty).

```
$ git rev-parse HEAD
5f3594926d5dad5890443aa8758090f5da6bb3bf
$ git status --short
                                                  (empty)
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  85 passed | 1 skipped (86)
      Tests  883 passed | 4 skipped (887)
```

Base for comparison, `origin/main` at `21a2905`: `84 passed | 1 skipped` files, `865 passed | 4 skipped`
tests. This node adds one file (`tests/managed/configuration-source.test.ts`, 17 tests) plus a
`deleteSecret` test, and nothing regressed.

**One flake observed and chased down.** An intermediate full run showed
`tests/managed/tenant-credentials.test.ts > serializes model credential rotation across independent
processes` red. It passes in isolation and passed on the immediate re-run of the whole suite; it is a
cross-process write-serialisation timing test, and this node's only change to that file is a
`JSON.parse` guard on a *read* path. Recorded rather than quietly re-run.

The runtime bundle builds from this head:

```
$ pnpm run build:runtime
done built dist/server.mjs
$ shasum -a 256 dist/server.mjs
32dcbd00b848392908d3fb9c013cbfaf83486503b75f202af84d57e11f898820
```

## 2. Tier 1 — the two contract-named assertions

### "A test asserts no production reader resolves a credential file path directly"

**Two** tests in `tests/managed/configuration-source.test.ts`, because one is not enough — the review
showed why.

1. *"leaves every credential-file reader imported only by the seam"*. It walks every `.ts` under
   `apps/{cli,runtime}/src` and `packages/{installation,agents,engine}/src` and asserts no
   `read(Managed|Provisioned)*` export of `configuration.ts` is named outside the seam
   (`configuration-source.ts`), the file half it is built from (`configuration.ts`), and
   `migration.ts` — which reads a *legacy* data directory's config to walk it forward, an
   installation that predates the store and has none. The reader list is **derived from the module**,
   not hand-listed, so a reader added tomorrow is covered the day it appears.
2. *"leaves every credential PATH named only by writers, file-integrity checks and the seam"*. The
   reader-name scan cannot see `readFile(paths.e2bCredential)` — a caller that skips the readers
   entirely, and the likeliest future regression — so the eight credential path properties on
   `ManagedPaths` are scanned too, against a reviewed allowlist. This test **caught a real hit on its
   first run** (`apps/cli/src/inspection.ts → paths.modelApiKeyCredential`); inspection turned out to
   be message interpolation, not a read, and it is allowlisted with that reason recorded.

Both guard themselves: each asserts the scan found more than 50 files, so a broken walk cannot pass
vacuously.

Out of scope, deliberately and now stated in the allowlist rather than left implicit:
- **Writers.** `atomicWriteManagedConfig`, `writeManagedConfiguration`, `ensureManagedGitHubWebhookSecret`,
  the first-run installer, the control-plane token mint. Under EMC the files stay authoritative until #367.
- **File-integrity checks.** `installation.ts` and `diagnostics.ts` inspect mode, symlink, size and
  is-this-valid-JSON on the credential files. That is a property of the *file*, not the value, and has
  no meaning through the store — `doctor` must still be able to say "github-coder.json is world-readable".
- **Error-message interpolation.** `lifecycle.ts`, `agent-sandbox.ts` and `inspection.ts` name a path
  only to tell the operator which file to fix; each resolves the value itself through the seam.

The four per-kind readers that lost their last caller — `readManagedModelApiKey`, `readManagedE2BApiKey`,
`readManagedBraintrustApiKey`, `readManagedControlPlaneCredential` — were **deleted**, not left dead, so
the seam cannot be bypassed by calling something that still happens to exist.

### The SEC-WO leak carried from #365 — verified **non-vacuous**

`tests/managed/configuration-source.test.ts` → *"never puts a corrupted credential's own bytes into the
failure it throws"*. For **each of the eight secret kinds**, it writes bare secret material where the
JSON envelope should be (`sk-live-THIS-MUST-NEVER-APPEAR-IN-AN-ERROR`) — the shape an operator pasting
a raw key, or a truncated write, actually produces — then asserts the thrown error's message, stack and
full own-property serialisation contain neither the value nor its `sk-live` prefix.

Non-vacuity, verified by reverting the guard in `packages/installation/src/configuration.ts` and
re-running:

```
$ pnpm vitest run tests/managed/configuration-source.test.ts -t "never puts a corrupted"
 FAIL  never puts a corrupted credential's own bytes into the failure it throws (SEC-WO)
 - Expected: sk-live
 + Received: SyntaxError: Unexpected token 's', "sk-live-TH"... is not valid JSON
 Tests  1 failed | 7 skipped (8)
```

That is the leak itself, printed by the assertion. The guard was restored and the test passes.

A first draft of this test used a *trailing* corruption (`{"apiKey": "…", `) and passed **with the guard
reverted** — Node 22's V8 only quotes the source when the error is at or near position 0, so that shape
proved nothing. It was replaced with the position-0 shape above, which is also the realistic one.

Review then found the surviving `not.toContain(secretMaterial)` assertion was *itself* vacuous: V8
truncates its quoted window to ~10 characters, so a 41-character sentinel can never appear in full. The
test now also pins the exact refusal (`"Error: The managed private JSON file is malformed."`), which is
immune to the window entirely; the `not.toContain` pair is kept as belt-and-braces.

**Fix-completeness on this defect.** Every `JSON.parse` on a credential path in production code was
enumerated and accounted for:

| site | verdict |
|---|---|
| `packages/installation/src/configuration.ts:49` — the shared decoder for all six credential files | **fixed here** (the defect #365 carried to this node) |
| `packages/engine/src/model/chatgpt-authentication.ts:210` — the ChatGPT file store, still on the seam's fallback read path | **fixed here** |
| `packages/installation/src/tenant-credentials.ts:316` — the libSQL credential row | **fixed here** (#368 deletes this backend; guarded so it is not leaking meanwhile) |
| `packages/installation/src/managed-config-store.ts:67` | already guarded by #365 |
| `packages/installation/src/installation.ts:312` | already safe — `catch` maps `SyntaxError` to a hand-written `json.invalid` diagnostic |
| `packages/installation/src/diagnostics.ts:471,484` | already safe — the `catch` discards the cause entirely |
| `apps/cli/src/program.ts:157` (App triples file) | already safe — `catch` replaces the message |
| `packages/installation/src/migration.ts:110,120` | legacy data directory, no secret in the quoted window; left as-is |

## 3. Tier 2 — integrated · 2026-07-25T16:10:10Z

```
$ pnpm run evals:deterministic
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)

 FAIL  packages/agents/evals/participation-mechanics.eval.ts > records the complete issue capture and its chat receipt
 FAIL  .../issue-management.eval.ts > creates one complete report after duplicate search
 FAIL  .../issue-management.eval.ts > creates one complete feature request with its audience and motivation
 FAIL  .../issue-management.eval.ts > corrects and organizes one existing issue, then acknowledges it once
 FAIL  .../issue-management.eval.ts > redirects an existing report without a create mutation
```

**This is not green, and this node did not make it red.** The same command on a clean checkout of
`origin/main` at `21a2905` — this node's base, with the working tree stashed — produces the byte-identical
failure set:

```
$ git stash -u && git rev-parse HEAD
21a2905…
$ pnpm run evals:deterministic
 Test Files  2 failed | 3 passed | 5 skipped (10)
      Tests  5 failed | 10 passed | 22 skipped (37)
 FAIL  … records the complete issue capture and its chat receipt
 FAIL  … creates one complete report after duplicate search
 FAIL  … creates one complete feature request with its audience and motivation
 FAIL  … corrects and organizes one existing issue, then acknowledges it once
 FAIL  … redirects an existing report without a create mutation
```

Same five tests, same two files, same assertion shapes
(`expected { name: 'github_create_issue', … } to match object { status: 'ok', … }`) — GitHub tool-result
assertions in the Issue Management contract, untouched by this node's diff.

**What the run does establish about this node's concern.** The tier's stated purpose is that *model
resolution still reaches a working provider*. It does: the evals resolve a provider, run, and consume
tokens against it — the failing cases are counted with real usage (`11174 tok | 1 tool`,
`10535 tok | 1 tool`, `15504 tok | 2 tools`) and the model produced real tool calls
(`github_create_issue`, `github_update_issue`). Resolution failure would abort before any of that. Three
eval files pass outright.

The literal "green" bar is not met, and I have not substituted a lower one. Fixing this suite is another
node's work; the orchestrator should treat tier 2 as **unchanged-from-base red**.

## 3b. Independent review — what it found and what changed

Three agents reviewed head `3cf1a04` against the acceptance criteria and proof contract verbatim
(general code review, test coverage, silent-failure hunt). Verdict: **REQUEST CHANGES**. The findings
were real; head `5f35949` is the result. What changed:

**Critical — a genuine regression against AC4, now fixed and pinned by a test.** Seeding recorded a
file failure but left the previous boot's row in the store, and the ChatGPT credential store reads
`source.store` directly rather than through `secret()`. So a deleted or corrupted `chatgpt-oauth.json`
kept resolving off the stale row and `doctor` reported **`ready`** for a credential that was gone —
where it used to report `missing`/`malformed`. The seed now calls `store.deleteSecret(kind)` on a file
failure, so the kind stops resolving through `secret`, through `store`, and in `storedSecretKinds`.
This also makes the **tier-4 readback sound**: before the fix, a kind whose seed failed was still
reported as populated, so tier 4 could not distinguish "seeded" from "left over from a previous boot".

Verified non-vacuous — reverting just the `deleteSecret` call fails two tests, the second reproducing
the reported bug verbatim:

```
$ pnpm vitest run tests/managed/configuration-source.test.ts
 FAIL  stops resolving a credential whose file has been deleted, through every read path
       AssertionError: expected { type: 'oauth', …(3) } to be undefined
 FAIL  reports a corrupted credential as unauthenticated rather than ready
       AssertionError: expected 'ready' not to be 'ready'
 Tests  2 failed | 15 passed (17)
```

**Critical — an infrastructure failure was being blamed on the operator's credential.** The seeding
`try` spanned both the file read *and* `store.writeSecret`, so a `SQLITE_BUSY` from contending with the
running runtime was recorded as that kind's failure and surfaced as *"the managed API key at
…/model-api-key.json is missing or unreadable — paste a fresh key"*, about a key that was fine. The
store write moved outside the catch: the value is already validated against the very schema
`writeSecret` re-checks, so the only thing left to fail there is the database, and that is now loud, at
open, and once.

**Important — the ChatGPT wrapper, three fixes.** The mirror is a cache write and must not fail the
operation it is caching: a login that has already fsynced the file has *succeeded*, so a mirror failure
now drops the row and warns instead of reporting `persistence-failed`. `delete` forgets the store row
**first**, so a partial failure on the revocation path still revokes. And serving the credential from
the store was silently skipping `assertManagedCredentialDirectory` — the credential-substitution guard
that catches a symlinked `credentials/` directory — which now runs on the store path too (the function
is exported from engine for it; TAX's "no `@ambient-agent/` in engine" rule caught the doc comment I
wrote referencing the package by name, which is the rule working).

**Important — a behaviour divergence under SIGHUP.** `refreshConfig` shared its failure state with
`config()`, so one failed reload poisoned configuration reads for the life of the process; before this
seam, `store.current()` kept serving the last good config and only the reload threw. `refreshConfig`
now throws and leaves the last good configuration in place. Pinned by
*"keeps serving the last good configuration when a SIGHUP refresh finds a corrupt file"*.

**Important — the enforcement test proved less than the PR claimed.** See §2: a second path-property
scan was added, the reader list is now derived from the module rather than hardcoded, and the
exemptions are stated with reasons. AC2 is restated honestly in §6.

**Important — coverage.** The store-backed ChatGPT credential store had no test at all; it now has four
(file fallback seeds the store, replace mirrors, refresh mirrors, delete forgets). `deleteSecret` had
none; it now has one, including idempotence and the unknown-kind refusal. The suite went 873 → 883.

**Also fixed:** `withManagedConfigurationSource` closes the handle on the throw path (five call sites
had a bare `close()` that the failure path skipped — and the handle is on a database the running
runtime holds open, so leaking one is lock contention, not just an fd); `failures.has(kind)` rather
than `!== undefined`, so the precedence is structural; and three doc comments that justified
`deleteSecret` by an `ambient-agent auth --forget` command that **does not exist** — the reviewer was
right, `grep` finds no such flag — now state the real reason.

**Accepted, not fixed, and flagged for the orchestrator:** every CLI command now opens and seeds the
store the runtime holds open, which is new blast radius (`busy_timeout` 5000, rollback journal). The
ownership hazard on the rig is real: a `sudo ambient-agent doctor` writes as root and leaves a
root-owned journal the service user cannot roll back. **The CLI must run as the service user on the
rig.** A read-only open path for diagnostics is the right follow-up and is not this node's scope.

## 4. What the seam is, for #367 / #368 / #376

`packages/installation/src/configuration-source.ts`:

```ts
export interface ManagedConfigurationSource {
  readonly paths: ManagedPaths;
  config(): ManagedConfig;                                   // throws what reading config.json threw
  refreshConfig(): Promise<ManagedConfig>;                   // re-read the file → store → snapshot (SIGHUP)
  secret<K extends ManagedSecretKind>(kind: K): ManagedSecret<K>;  // throws what the file reader threw
  storedSecretKinds(): readonly ManagedSecretKind[];         // names only, never values
  readonly store: ManagedConfigStore;
  close(): void;
}

export const openManagedConfigurationSource = (
  paths: ManagedPaths,
  options?: { readonly ephemeral?: boolean },
): Promise<ManagedConfigurationSource>;

export const managedSecretPaths = (paths: ManagedPaths): Readonly<Record<ManagedSecretKind, string>>;
export const readProvisionedGitHubAppCredential = (
  source: ManagedConfigurationSource, role: "coder" | "reviewer",
): GitHubAppCredential;
```

The kinds are `MANAGED_SECRET_SCHEMAS` from #365, quoted not re-derived; `managedSecretPaths` is the one
place a kind is mapped to the file it is seeded from, and a test asserts its keys equal
`MANAGED_SECRET_KINDS` exactly, so a ninth kind cannot be added without a seed path.

**Where #367 cuts.** Delete the seeding loop in `openManagedConfigurationSource` and the
`managedSecretPaths` table, and `readManagedSecretFile` in `configuration.ts` loses its only production
caller. Nothing else in the tree reads those files (§2). The store database is
`ManagedPaths.managedConfigDatabase` — `<root>/managed-config.sqlite`, added by this node so the path is
no longer computed ad hoc in `apps/runtime/src/app.ts`.

**Failure semantics, preserved exactly.** Seeding records per kind whatever the file reader threw and
`secret(kind)` rethrows *that error object*, so `code === "ENOENT"` still discriminates for the control
plane's first-boot mint, and every caller's own wrapping message (`{ cause }` chains naming the path and
the fix command) is unchanged. Seeding itself never throws: an install with no `e2b.json` on a `local`
sandbox still boots, and the failure surfaces at the read, in the caller that needs the value. A recorded
failure always beats a stale stored row, so a file that has gone missing or bad is never papered over by
the last boot's seed — the files remain authoritative (EMC).

## 6. Acceptance criteria, stated honestly

| criterion | verdict |
|---|---|
| The runtime resolves its whole dependency set … through the store | **MET.** config, `github-app:{planner,coder,reviewer}`, `chatgpt-oauth`, `model-api-key`, `e2b`, `braintrust` all resolve through the seam. |
| The setup and diagnostics paths read through the same seam; **no caller reaches a credential path directly any more** | **MET for value reads, which is the honest scope.** Every resolution of a credential's *value* goes through the seam, enforced by two tests. Three classes of caller still name a credential path and are allowlisted with reasons in §2: writers (EMC — the files stay authoritative until #367), file-integrity checks (`doctor` inspecting mode/symlink/size, which has no meaning through the store), and error-message interpolation. Read as "no caller resolves a credential *value* from a path", this is met and mechanically enforced; read literally, the file-integrity checks in `installation.ts` still open credential files, by design. |
| The store is seeded from the files at boot, so an existing installation behaves identically | **MET**, and tested — including rotation and the deleted-file case. |
| A missing or malformed value still fails boot loudly, with the same clarity as today | **MET.** The original error object is rethrown, so `code === "ENOENT"` still discriminates and every caller's wrapping message survives. The two ways review found this was *not* true — a stale row masking a deleted file, and a database failure blamed on the credential — are fixed and pinned. |

## 5. What the orchestrator must run for tiers 3–5

Nothing in this node reached the rig, and nothing here needs it to. To capture the live tiers post-merge:

1. **Deploy** the merged head, then confirm the deployed bundle hash matches what CI built.
2. **Tier 3.** Mint a nonce, `GET /health` for the healthy response, send `TST-366-<nonce>` from the
   independent driver account into `Tst`, screenshot the reply.
3. **Tier 4.** Two queries:
   - the conversation archive on the rig holds the nonce event and its reply — exact message ids;
   - the store shows every secret kind populated from the seed. Run `tier4-readback.sh` in this
     directory on the rig; it prints the populated `kind` rows of `managed_secret` and **never a value**.
     The expected result on the rig is the six kinds that installation has files for: the three
     `github-app:*`, `chatgpt-oauth`, `control-plane`, and `braintrust` if tracing is on. `e2b` and
     `model-api-key` are absent by design — the rig runs the `local` sandbox on the subscription
     provider, so those files do not exist and (per §4) an absent file leaves its kind unstored.
4. **Tier 5.** The nonce turn in Braintrust with a resolved model — trace link.

The store is queryable for populated kinds and boot failures stay loud and legible, so tiers 3–5 are
satisfiable as written.
