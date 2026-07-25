import { defineAgent, type AgentRouteHandler, type AgentRuntimeConfig } from "@flue/runtime";

import { PROMPT_IDS, storedInstructions, storedSkill } from "../prompts/catalog.ts";
import { createScribeGraphTools } from "../capabilities/graph/tools.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { acceptsScribeDirectToken } from "./direct-access.ts";
import { scribeAttemptContext } from "./attempt-context.ts";

/** Private loopback SDK seam used by the Historical Replay workflow. */
export const route: AgentRouteHandler = async (context, next) => {
  if (!acceptsScribeDirectToken(context.req.header("authorization"))) return context.notFound();
  await next();
};

export const description =
  "One fresh, silent Scribe attempt that proposes shared ontology from a bounded cross-Surface batch; it never speaks or owns memory.";

/**
 * A recovered orphan settles as a tool-less no-op. Production prompts this agent as a durable
 * direct submission keyed by attemptId; if the process is interrupted mid-attempt, Flue recovers
 * that submission on the next boot and re-runs this initializer — but the trusted context lived
 * only in-process and is gone. With no tools mounted the recovered turn cannot touch the Graph, so
 * it settles harmlessly instead of throwing (which left the submission unsettled and re-recovering
 * on every boot, #330). The application ScribeInbox owns durable recovery and re-drives the Batch
 * under a fresh attempt; even if both ran, Attestations are content-addressed and idempotent.
 */
const supersededScribeAttempt = (): AgentRuntimeConfig => ({
  ...resolveAgentModelProfile("scribe"),
  tools: [],
  instructions: storedInstructions(PROMPT_IDS.scribeSuperseded),
});

// Its own model + thinkingLevel on the one shared credential: starts cheap and
// minimal-thinking, latency-free, so it can go heavier if extraction quality demands.
// Only the three ontology tools — no Say, no whatsapp-participation, no issue-management.
export const scribeAttemptRuntimeConfig = (id: string): AgentRuntimeConfig => {
  const context = scribeAttemptContext(id);
  if (context === undefined) return supersededScribeAttempt();
  return {
    ...resolveAgentModelProfile("scribe"),
    skills: [storedSkill(PROMPT_IDS.graphExtractionSkill)],
    tools: createScribeGraphTools(context),
    instructions: storedInstructions(PROMPT_IDS.scribe),
  };
};

export default defineAgent(({ id }) => scribeAttemptRuntimeConfig(id));
