import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import { PROMPT_IDS, storedInstructions, storedSkill } from "../../../../../packages/agents/src/prompts/catalog.ts";
import { resolveAgentModelProfile } from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture surface for the Verifier role prose.";
export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  ...resolveAgentModelProfile("verifier"),
  skills: [storedSkill(PROMPT_IDS.verifySkill)],
  // The shipped Verifier prose, from the store — see the Planner fixture (#375).
  instructions: storedInstructions(PROMPT_IDS.verifier),
}));
