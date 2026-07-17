# @ambient-agent/test-support

Fakes, mocks, and the eval battery. May import anything (the one package with no arrow
restrictions); nothing in production imports it.

## What's here

| Concern | Files | Seam it sits at |
|---|---|---|
| **Fakes** | `fake-whatsapp-host.ts`, `fake-issue-repository.ts` | Second adapters at real seams: `WhatsAppOutboundPort` (production: `apps/server/src/host/whatsapp-runtime.ts` `createWhatsAppHost`) and `IssueRepository` (production: `@ambient-agent/installation/github-issue-repository.ts`). |
| **Coalescer mocks** | `coalescer-mocks.ts` | `Ref`-backed Layers for engine's `EventSource` / `WindowDispatcher` / `WindowStore` ports, so timing tests can inspect exactly what fired. |
| **Managed fixtures** | `managed-installation.ts`, `managed-chat-inbox.ts` | Thin adapters over the *real* `installPreparedManagedData` staging path and the real inbox — tests exercise production code, not parallel implementations. |
| **Eval battery** | `evals/harness.ts`, `evals/rubric-judges.ts`, `evals/braintrust-reporter.ts`, `evals/*.eval.ts` | The Flue agent harness (`@flue/sdk` + vitest-evals), rubric judges reading the capability SKILL.md files, and the Evaluation Scenario suites (issue-management, participation-mechanics, whatsapp-participation; `.live` variants hit real providers). The #113 baseline on this battery gates every structural refactor ("structure changed, behaviour didn't"). |

## Known gap

`package.json` declares `"exports": {}` — consumers import via relative `src/` paths, so
the "test-support → anything" boundary is policed only by the hard-cut test, not by a
declared surface. Flagged in the 2026-07-17 architecture survey.

## Run the evals

`vitest.evals.config.ts` at the repo root drives the `*.eval.ts` suites.
