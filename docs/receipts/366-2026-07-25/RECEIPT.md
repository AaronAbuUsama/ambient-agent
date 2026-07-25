# Receipt — node #366, migrate configuration and secret readers onto the store

- **Node:** #366 · surface **backend** · branch `migrate-readers-onto-store-366`
- **Proven head:** `afbfb838efb22e165c3dcb1d0b3cc4e24b4f1221` (base `21a2905`, which carries #365, #364 and #369)
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

## 1. Tier 1 — mechanical · 2026-07-25T16:08:07Z → 16:10:00Z

Run against the exact committed head with a clean tree (`git status --short` empty).

```
$ git rev-parse HEAD
afbfb838efb22e165c3dcb1d0b3cc4e24b4f1221
$ git status --short
                                                  (empty)
$ pnpm run typecheck
> tsc --noEmit                                    (no output — clean)
$ pnpm test
 Test Files  85 passed | 1 skipped (86)
      Tests  873 passed | 4 skipped (877)
   Duration  93.24s
```

Base for comparison, `origin/main` at `21a2905`: `84 passed | 1 skipped` files, `865 passed | 4 skipped`
tests. This node adds one file (`tests/managed/configuration-source.test.ts`, 8 tests) and nothing regressed.

The runtime bundle builds from this head:

```
$ pnpm run build:runtime
done built dist/server.mjs
$ shasum -a 256 dist/server.mjs
32dcbd00b848392908d3fb9c013cbfaf83486503b75f202af84d57e11f898820
```

## 2. Tier 1 — the two contract-named assertions

### "A test asserts no production reader resolves a credential file path directly"

`tests/managed/configuration-source.test.ts` → *"leaves every credential-file reader imported only by
the seam"*. It walks every `.ts` file under `apps/cli/src`, `apps/runtime/src`,
`packages/installation/src`, `packages/agents/src` and `packages/engine/src` and asserts that none of

```
readManagedConfig · readManagedGitHubAppCredential · readManagedModelApiKey
readManagedE2BApiKey · readManagedBraintrustApiKey · readManagedControlPlaneCredential
readManagedSecretFile
```

is named anywhere except the seam itself (`configuration-source.ts`), the file half it is built out of
(`configuration.ts`), and `migration.ts` — which reads a *legacy* data directory's config to walk it
forward, an installation that predates the store and has none. The test guards itself: it asserts the
scan found more than 50 files, so a broken walk cannot pass vacuously.

Writers are deliberately out of scope: `atomicWriteManagedConfig`, `writeManagedConfiguration`,
`ensureManagedGitHubWebhookSecret`, the first-run installer and the control-plane token mint all still
write files, because under EMC the files stay authoritative until #367.

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
