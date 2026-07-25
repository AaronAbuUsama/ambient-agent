import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import { PROMPT_IDS, storedSkill } from "../../../../../packages/agents/src/prompts/catalog.ts";
import { resolveAgentModelProfile } from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture surface for the Planner role prose.";
export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  ...resolveAgentModelProfile("planner"),
  skills: [storedSkill(PROMPT_IDS.plannerSkill)],
  instructions: "Plan one issue. Return the requested implementation and behavioral verification artifact. Do not edit files or publish.",
}));
