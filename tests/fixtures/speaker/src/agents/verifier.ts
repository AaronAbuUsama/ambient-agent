import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import { PROMPT_IDS, storedSkill } from "../../../../../packages/agents/src/prompts/catalog.ts";
import { resolveAgentModelProfile } from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture surface for the Verifier role prose.";
export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  ...resolveAgentModelProfile("verifier"),
  skills: [storedSkill(PROMPT_IDS.verifySkill)],
  instructions: "Activate and follow the verify skill. Drive the runtime surface and return one evidence-backed PASS, FAIL, BLOCKED, or SKIP report.",
}));
