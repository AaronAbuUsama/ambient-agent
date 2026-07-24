# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This is a **single-context** repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the ratified domain vocabulary. Use these words.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. This directory doesn't exist yet; it gets created lazily by `/domain-modeling` when a decision actually gets recorded.
- Broader canon (from `AGENTS.md`): **`docs/SYSTEM-ARCHITECTURE.md`** (what the system is meant to be), **`docs/ARCHITECTURE.md`** (which package owns what), **`STATUS.md`** (what the reset settled).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/            ← created lazily as decisions get recorded
│   └── 0001-*.md
└── packages/, apps/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 — but worth reopening because…_
