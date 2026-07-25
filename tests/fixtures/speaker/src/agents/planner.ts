import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import { PROMPT_IDS, storedInstructions, storedSkill } from "../../../../../packages/agents/src/prompts/catalog.ts";
import { resolveAgentModelProfile } from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture surface for the Planner role prose.";
export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  ...resolveAgentModelProfile("planner"),
  skills: [storedSkill(PROMPT_IDS.plannerSkill)],
  // The shipped Planner prose, from the store — the point of the prose eval is to grade what the
  // real role runs, so this surface must not carry a second, divergent copy of it (#375).
  instructions: storedInstructions(PROMPT_IDS.planner),
}));
