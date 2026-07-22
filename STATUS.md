# Status

The canonical description of the system is
[`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) — **the coworker**: one
**Brain** (the mind, the owner, the decider), many dumb reactive **Speakers** (one per
surface), a single global **Scribe**, and one owned **Graph**. Its **§13** is the honest,
always-current map of what is built versus what is designed-but-not-yet-built. Read §13 for
the real frontier; this file is only the one-paragraph orientation.

## Where we are (2026-07-22)

Mid-reset. Three dead pivots — **Eve-era**, **Ambience**, and the **SaaS / multi-tenant**
cutover — have been stripped down to one stable line, and the system is being rebuilt
forward from `SYSTEM-ARCHITECTURE.md`. **One instance, one operator — not multi-tenant**
(tenancy was killed 2026-07-19).

**Already built in reusable form** (§13): the append-only Graph Attestation log and derived
Belief Projection (including the typed query surface), the live Digest
pull side, the reactive Brain conversation loop (Intent → Batch → Directive/silence → Outcome),
stable account-scoped Surfaces, Brain-owned async delegation with durable return, modelless coalescing,
the durable global Scribe clock shared by live and Historical Replay, and the Coder / Reviewer /
Planner Specialists as distinct GitHub identities. Scribe retries now receive trusted Evidence
Sets plus a fresh bounded/versioned Belief Projection and append retry-idempotent proposals;
proposal deltas durably enter the Brain, which now mounts evidence-bounded Graph rulings. The Brain
also owns stable Coder work identity, Flue admission reconciliation, terminal-result intake, and
the independent reporting-Surface choice. Speaker and Specialist Graph access remains read-only.

**The distance to close is concentration of authority, not new machinery:**

- Finish concentrating authority in the **Brain** — route GitHub ingress through its existing
  durable up-inbox and add its proactive clock. Knowledge and Coder work ownership are built.
- Replace GitHub webhook broadcast + drop with the single up-inbox.
- Complete **Surface** routing by resolving known-Person DM targets through the existing
  stable registry and removing the remaining provider-id shortcut.
- Compose bounded Brain-selected seeds over the existing versioned `graphContext` channel.

## The reset — where the code stands (2026-07-21)

The reset is a code-level cut down to **one runtime path** (single-box self-host), done in two layers:

- **Layer 1 — done.** Dropped the dead SaaS / multi-tenant + operator-web stack:
  `apps/{api,web,server}`, `packages/{api,auth,db,env}`, and their tests.
- **Layer 2 — done.** Removed the orphaned hosted/tenant runtime boot (`setup-server`/`setup-app`,
  `TenantRuntime*` setup-boot + operate-bridge, `prepareHostedManagedLayout`). Only
  `ambient-agent start` → `apps/runtime/app.ts` remains.

Both were behaviour-neutral on single-box (all removed code was gated behind unset
`AMBIENT_AGENT_RUNTIME_PROFILE`/`TENANT_DB_URL`); typecheck + full test suite green, and the
single-box build is deployed and healthy.

**Deferred (decisions, not deletes — for the next design pass):**

- Credential/session storage: collapse the file-vs-libsql fork to files-only (`tenant-credentials.ts`).
- Specialist sandbox substrate: `local()` vs Daytona (native in Flue) vs e2b.

Branding is `coworker` (surface only); repo, package, and login names are unchanged for now.
