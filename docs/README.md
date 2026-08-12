# Ambient documentation

Documentation is separated by authority. Keep decisions in canon, changing
facts in status, and diagrams as derived views. Do not let an HTML map become
the only place a decision exists.

## Canon

Canonical documents change only when product evidence or an architectural
decision changes.

### [Product model](./canon/product-model.md)

Defines what Ambient is: one Root-led entity, four fixed agent kinds, durable
instances and assignments, capability boundaries, and WhatsApp as the primary
environment.

### [Architecture](./canon/architecture.md)

Defines:

- target module responsibilities and dependency direction;
- current module dispositions;
- Ambient, model, WhatsApp, Conversation, store, evaluation, and proof
  interfaces;
- durable protocol and transaction ownership;
- Conversation-scoped WhatsApp effects;
- behaviour, architecture, and product frontiers.

### [Delivery practice](./canon/delivery-practice.md)

Defines rolling evidence-driven slices, proof gates, uncertainty
classification, promotion rules, and review points.

## Status

### [Current state and rescue ledger](./status/current-state.md)

Records the proven baseline, completed rescue work, the one active slice, the
likely-next slice, open questions, and the scored rescue-candidate comparison.
Update it after each completed slice or material frontier change.

## Derived maps

Maps explain canon and status visually. Their prose sources remain authoritative.

- [Product and delivery map](./maps/product-and-delivery.html)
- [Module and interface map](./maps/module-and-interface.html)
- [Durable protocol map](./maps/durable-protocols.html)
- [Frontier and rescue map](./maps/frontiers-and-rescue.html)

## Workbench

Ephemeral notes, screenshots, browser captures, and draft experiments belong
under ignored `.factory/workbench/`. Promote a decision into canon or status
before deleting or abandoning the workbench artifact.

## Repository guidance

[`../AGENTS.md`](../AGENTS.md) is the root engineering constitution.
[`../CLAUDE.md`](../CLAUDE.md) is a symlink to the same guidance.

## Archive

[`archive/`](./archive/) retains superseded plans and maps as historical
evidence. Archive files are not current implementation instructions.

## Ownership

| Question                                      | Owner                        |
| --------------------------------------------- | ---------------------------- |
| What is Ambient?                              | `canon/product-model.md`     |
| What modules and protocols are authoritative? | `canon/architecture.md`      |
| How do we build under uncertainty?            | `canon/delivery-practice.md` |
| What exists and what are we doing now?        | `status/current-state.md`    |
| What rules apply to all code?                 | `../AGENTS.md`               |
| How is canon or status visualized?            | `maps/`                      |
| What is temporary investigation?              | `.factory/workbench/`        |
| What did we previously believe?               | `archive/`                   |

Do not create another planning document unless none of these owners can express
the information cleanly.
