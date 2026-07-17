# Architecture survey — 2026-07-17

Three parallel passes over the whole repo: a deep-module survey (codebase-design
vocabulary) of engine+agents, the same for installation+test-support+apps, and a
ponytail-ultra audit. Report only; nothing applied. Companion docs written the same day:
`docs/ARCHITECTURE.md` + a README per workspace.

## The headline: the codebase's one recurring disease is *ambient wiring*

Every top finding is the same shape: behaviour that should sit behind one constructed
object instead leaks into module-level mutable state plus ordering rules the caller must
know. Six instances of the same pattern:

1. `activity-reporter.ts:283-304` — hidden singleton + 5 free functions + 3 ordering invariants
2. `engine/github/ingress-runtime.ts:11-16` — globalThis configure/get pair
3. `capabilities/issue-management/runtime.ts:39-44` — same pattern, second copy
4. `capabilities/whatsapp-participation/whatsapp-port.ts:39-46` — same pattern, third copy (plus two configure sites at two lifecycle moments)
5. `installation/runtime-dependencies.ts` — two `Symbol.for` slots with a three-step ordering protocol
6. `apps/server/host/whatsapp-runtime.ts:165-171` — a third, undeclared `Symbol.for` status slot

(1–4 are avoidable DI; 5–6 are forced by the CLI/server two-bundle split — keep the
mechanism, own it once.)

## Ranked moves

### T1 — Extract `DispatchCorrelator<C>` into engine; activity-reporter shrinks to ~60 lines
The correlator (lines 27–238: maps, TTL prune, early-buffer + replay, resolver recovery)
is verified agent-agnostic. Proposed interface, 3 methods:
```ts
interface DispatchCorrelator<C> {
  accepted(dispatchId: string, context: C | null): void;   // null = ignore
  recoverWith(resolve: (dispatchId: string) => C | undefined): void;
  subscribe(listener: (event: CorrelatedLifecycleEvent, context: C) => void): () => void;
}
```
Flue `observe()` is wired in the constructor — construction *is* installation, killing the
create/install two-step trap (a dispatch before `app.ts:30` is currently silently lost).
Ambience keeps a thin `AmbienceObserver` subscriber owning the `spoken` set, its own
`chatId → dispatchId` map, and the `operatorEvent` log lines. Removes 4 leaked methods,
5 free functions, and 3 caller-side ordering invariants. **Answers the "why is
activity-reporter in ambience" question permanently.**

### T2 — One slot helper for the six ambient-wiring instances
`createFlueGlobal<T>(symbol)` (~6 lines, engine/shared) replaces the three configure/get
pairs; a `runtimeSlot<T>(name)` in `runtime-dependencies.ts` (get/set/take-once) absorbs
the three `Symbol.for` slots, making the undeclared whatsapp-runtime status slot visible.
~30 lines deleted, one error convention, the ordering invariants named in one place.

### T3 — `observeRuntimeHealth(paths)` in installation
The 5-step probe recipe (read config → read credential → check webhookSecret → derive
installation id → probe with 750ms timeout) is duplicated **verbatim** at
`program.ts:164-175`, `inspection.ts:62-73`, `migration.ts:100-111` (+ a variant in
`smoke.ts:34-48`). One function; the `runtimeHealthFor` test seam keeps working.

### T4 — Unified `inspectInstallation` + one startability predicate
`apps/cli/src/inspection.ts:99-232` is 137 lines of stitching three installation exports
back together — that's installation's missing "inspect everything" interface living in
the CLI. And `program.ts` re-derives "is it startable" three times with hand-copied state
whitelists (:506-514, :548-556, :587-596). One `inspectInstallation(paths, opts)` + one
`installationIsStartable(report)`.

### T5 — Give test-support a real interface; stop the side-door imports
`test-support/package.json` declares `"exports": {}` — every consumer relative-imports
`src/`, and two fakes reach into other packages' internals
(`fake-issue-repository.ts:13-19` imports installation's unexported
`issue-operation-footer.ts`). Declare the five exports; export the footer helper (it IS
part of the repository wire contract) or move it to the agents-side contract module.

### T6 — Kill the duplicated resource dances in the CLI
Three copies of the authenticate→sync→stop→close-archive WhatsApp lifecycle
(`first-run.ts:224-265`, `program.ts` config :309-351, repair :451-489) → one
`withWhatsAppAccount(paths, archive, fn)`. Two secure-tree-copy implementations
(`first-run.ts:61-108`, `migration.ts:31-53`) → one `copySecureTree` in installation.

### T7 — Smaller deepenings
Extract the 87-line `smokeCanary` closure out of `startWhatsAppRuntime` (:298-384);
`braintrust.ts` import-side-effects → explicit `installBraintrustTracing()` beside the
other installs; `parseGitHubRepository` drops its `invalid` callback (4 call sites
simplify); a valibot schema for the health payload (producer `app.ts:51-58` and probe
`runtime-health.ts:54-88` currently share an unowned shape); name the first-run WhatsApp
mode (`"fresh-pairing" | "existing-session" | "imported-store"`) instead of three
interacting flags.

### Verified deep — leave alone
`admission-relay` (model deep module), `managed-chat-inbox`, `conversation-archive`,
`operation-store` (14 caller files), coalescer + ports (real seams, second adapters in
test-support), `installation.ts` staged install, `whatsapp-account`, `uncertain-work`,
`first-run.ts` (deep and correctly seamed — its complexity is real domain complexity),
`createIssueManagementTools` (best module in agents), `dispatch.ts` (the 2-line
pass-through that isn't — it owns the dispatch+report pairing invariant),
`configuration.ts` (atomic write+rollback invisible to callers, which is the point).

## Ponytail-ultra cuts (~180 lines, independent of the moves above)

Top items (full list in the audit output):
- stdlib: `operator-reporter.ts:37-79` hand-rolled ANSI stripper + color table →
  `util.stripVTControlSequences` + `util.styleText` (~40 lines)
- delete: three test-only production methods — `ManagedChatInbox.admissions()`,
  `ConversationArchive.events()`, `GitHubIngressStore.list()`
- shrink: `github-issue-repository.ts:916-952` comment mutations do read-issue +
  paginate-all-comments as a pre-check → one `getComment` + issue_url compare
- delete: `PairingCallbacks.onStatus` (never passed); `UncertainWorkStatus.total/health`
  (derivable); `UncertainWorkRef` parsing for its single category
- reuse: `activity-reporter.ts:41-48` local `errorMessage` duplicates
  `engine/shared/errors.ts` (fold in the extra branch); `chatgpt-authentication.ts:120-129`
  local `pathExists` is byte-for-byte `installation/files.ts`; `first-run.ts:112` chat
  regex duplicates `schema.ts:14-17`; `diagnostics.ts:412` re-declares
  `CredentialComponentState`
- yagni: empty interface mirrors of `RetryPolicy` (×2); `whatsappWindowInput` re-parses
  its own constructed output on every dispatch; `SetupPrompts` alias; compose's `routes`
  context param only the fixture uses
- Clean areas: `engine/shared/*`, `qr.ts`, `logging.ts` core, all sub-40-line files —
  lean, ship.

## Suggested sequencing

1. **T1 + T2** — one PR: the correlator extraction and slot helpers (they touch the same
   wiring); eval-neutral, behaviour-preserving, hard-cut extended to cover the new engine
   module.
2. **T3 + T4 + T6** — one PR: the installation/CLI deepenings (pure dedup + interface
   lift).
3. **Ponytail cuts** — one PR of tiny commits; each is independent.
4. **T5** — with the next test-support touch.
5. **T7** — opportunistic, alongside whatever touches those files.

Gates for every step: full suite green + eval battery at the #113 baseline.
