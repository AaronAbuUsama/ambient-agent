import { configureEphemeralPromptStore } from "../packages/engine/src/prompts/store.ts";

/**
 * Every test file gets its own in-memory prompt store (#375). The store is never bound implicitly —
 * `getPromptStore` throws when nothing bound it, so that a production boot which skipped the binding
 * fails loudly instead of quietly serving shipped text from a store no operator can reach. Tests
 * have no composition root, so they bind here, once, rather than in every file that touches an agent.
 *
 * It is a real store seeded from the real shipped catalog on first use, not a stub: the tests
 * resolve prompts through exactly the code production resolves them through.
 */
configureEphemeralPromptStore();
