# Status

The canonical description of the system is
[`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) — **the coworker**: one
**Brain** (the mind, the owner, the decider), many dumb reactive **Speakers** (one per
surface), a single global **Scribe**, and one owned **Graph**. Its **§13** is the honest,
always-current map of what is built versus what is designed-but-not-yet-built. Read §13 for
the real frontier; this file is only the one-paragraph orientation.

## Where we are (2026-07-21)

Mid-reset. Three dead pivots — **Eve-era**, **Ambience**, and the **SaaS / multi-tenant**
cutover — have been stripped down to one stable line, and the system is being rebuilt
forward from `SYSTEM-ARCHITECTURE.md`. **One instance, one operator — not multi-tenant**
(tenancy was killed 2026-07-19).

**Already built, and already the definitive shape** (§13): the Graph, the live Digest pull
side, async delegation with durable no-drop return, modelless coalescing, and the
Coder / Reviewer / Planner Specialists as distinct GitHub identities.

**The distance to close is concentration of authority, not new machinery:**

- Introduce the **Brain** as a real actor — single up-inbox, two clocks, owns state + work.
- Consolidate the **Scribe** to one global ingestion clock with explicit per-fact provenance.
- Reduce the **Speaker** to a dumb mouth — remove issue/delegation/ontology-write, add intent escalation.
- Replace GitHub webhook broadcast + drop with the single up-inbox.

## The reset

Order, locked decisions, and the carried-forward DAG items live in
[`docs/planning/RESET-HANDOFF-2026-07-21.md`](docs/planning/RESET-HANDOFF-2026-07-21.md).
Branding is `coworker` (surface only); repo, package, and login names are unchanged for now.
