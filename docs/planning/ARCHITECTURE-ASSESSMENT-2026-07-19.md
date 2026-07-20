# Architecture assessment — 2026-07-19

Measured, not asserted. Built from a full structural index of the tree (7,343 nodes, 12,855
edges), complexity metrics per function, and targeted reads of the load-bearing files. Every
number here is reproducible.

## Verdict

**The codebase is not garbage.** 1,189 non-test functions carry 4,193 total cognitive
complexity; only 28 functions exceed cognitive 25. The complexity is heavily concentrated, and
the concentration is almost exactly where the demolition already points.

The real problem is not code quality. It is that **four unreconciled plans are layered on one
tree**, and no document tells you which one you are looking at.

## The complexity is concentrated, and mostly condemned

| Function | File | Cyclomatic | Cognitive | Fate |
|---|---|---|---|---|
| `createTenantProvisioner` | `apps/api/src/provisioner.ts` | 105 | 288 | **deleted** |
| `reconcileTenant` | `apps/api/src/provisioner.ts` | 83 | 228 | **deleted** |
| `runCli` | `apps/cli/src/program.ts` | 61 | 112 | shrinks |
| `createUncertainWorkController` | `packages/installation/src/uncertain-work.ts` | 41 | 106 | keeps |
| `createCoworkerService` | `packages/api/src/coworker.ts` | 76 | 100 | **rewritten** |
| `createGitHubIngress` | `packages/engine/src/github/ingress.ts` | 38 | 87 | keeps |
| `createChatGptAuthentication` | `packages/engine/src/model/chatgpt-authentication.ts` | 34 | 85 | keeps |
| `createWhatsAppAccount` | `packages/installation/src/whatsapp-account.ts` | 50 | 60 | keeps |

The two worst functions in the entire repository are both in the provisioner and account for
**12% of all cognitive complexity in one file that is already scheduled for deletion**. Removing
container-per-tenant is not just an architectural simplification; it is the single largest
complexity reduction available.

**The riskiest surviving code is `createWhatsAppAccount`** — cyclomatic 50, cognitive 60, and
*zero* live test coverage. Every test injects a fake through its `sessionFactory` seam. It is
simultaneously the most complex thing that survives and the least proven.

## Where the seams are good

The structural index confirms the dependency direction is correct where it matters.

- **`packages/engine` is the deep core.** Highest fan-in in the tree, imports nothing internal.
  Coalescing, intake, GitHub ingress, model glue sit behind small interfaces. This is the part
  worth protecting.
- **`coworker.ts` imports no provider.** Zero references to Dokploy, Turso or HTTP. All three
  external dependencies are already behind injected, optional interfaces (`CoworkerRuntimeSource`,
  `CoworkerModelSource`, `CoworkerLifecycleSource`). **The rewrite does not have to untangle
  infrastructure from business logic — that work is done.**
- **The provisioner is a clean cut.** Only three non-test files import it, all inside `apps/api`.
  Its call cluster has cohesion 0.92 — the highest in the tree, which is what a cleanly
  separable module looks like.
- **Concurrency is enforced in SQL predicates, not read-then-write JS.** The activation CTEs
  re-assert every precondition atomically with the insert. That is the hard part done right and
  it must survive the rewrite.

## Where the seams are missing

`coworker.ts` is a 1,990-line closure holding ~8 responsibilities with no internal seams. Its
external interface is excellent; internally it is undivided.

- The entitlement predicate is **copy-pasted 24 times**.
- `activate` and `applyGitHubConfiguration` are **90% duplicated** across 300 lines, differing in
  three tokens. A divergence between them would be invisible in review.
- `snapshot` is **347 lines** containing six nested ternary ladders.
- **The state machine is implied, never declared.** Four interacting state variables
  (`tenant.status`, `desired_mode`, `desired_state`, operation `status`×`kind`) with legal
  transitions scattered as guards across 14 methods. There is no transition table. Making this
  explicit is the highest-value change in the rewrite.

## What the new model deletes for free

Container-per-tenant forced a distributed-systems vocabulary onto what becomes a function call:

- `uncertain` operation status — the cost of a network call whose outcome you could not observe
- `desired_state` / `observed_state` / `applied_config_version` — a reconciliation loop
- `reconcileOperation`, `reconcileLifecycle` (110 lines), staleness leases
- The entire 128-line HMAC bridge client and its Zod re-validation — you own both sides now

Conservatively **600–700 lines vanish before a single feature is written.** With billing off,
the 24 duplicated entitlement predicates collapse to a plain ownership check.

**Worth keeping:** `operationIdentity` (idempotency), the single-unsettled-operation invariant,
`expectedConfigVersion` (compare-and-swap), and `basisFingerprint` — a SHA-256 over the facts
shown on screen, which answers "did what you reviewed change while you reviewed it?". That last
one is a genuine product guarantee, not deployment scaffolding.

## Two schema constraints block the operator model

Found in migration `0000_melted_silver_sable.sql`:

```sql
CREATE UNIQUE INDEX `tenant_user_unique` ON `tenant` (`user_id`);
```

**One tenant per user.** Correct for SaaS, where a customer has one coworker. Fatal for the
operator admin model, where one operator owns several tenants. `tenant_subscription_unique` and
the `NOT NULL` `subscription_entitlement_id` foreign key encode the same assumption.

These must change before multi-tenant management is possible, and nothing in the previous plan
mentioned them.

## The actual root cause: four unreconciled plans

This is why the tree is disorienting, and it is documented in the repo itself.

| Document | Date | Says |
|---|---|---|
| `WEB-APP-IA.md` | 17 Jul, ratified | A **local supervisor**: `npx ambient-agent` serves a wizard on localhost. Explicitly excludes hosted, auth, and multi-tenant. **Never implemented.** |
| `SAAS-MVP-PLAN.md` | 18 Jul, ratified | A **hosted multi-tenant control plane**: Next.js, better-auth, Polar, one container per tenant. **Implemented as `apps/web` + `apps/api`.** |
| `SAAS-WEBAPP-HANDOFF.md` | 18 Jul | States plainly that the choice between the two "is unratified and is **the load-bearing fork**." It was never resolved. |
| ADR 0023 | 19 Jul | Deletes the web app entirely — resolving the fork by removing both options. |

Four positions, three of them written as settled, none reconciled. ADR 0024 now resolves it: the
hosted app survives as an **operator admin UI**, and the local supervisor concept is formally
dropped (it was never built).

## What this means for the plan

1. Delete the provisioner early — it is the largest complexity win and a clean cut.
2. `coworker.ts` splits along five natural seams, three of which are pure refactors shippable
   *before* any architectural change.
3. Make the tenant state machine explicit as its own step; do not carry the implied one forward.
4. Fix the schema's one-tenant-per-user assumption before building multi-tenant management.
5. Treat `createWhatsAppAccount` as the highest-risk surviving module: most complex, least proven.
