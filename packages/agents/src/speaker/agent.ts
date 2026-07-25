import { defineAgent, type AgentRuntimeConfig } from "@flue/runtime";

import { PROMPT_IDS, storedInstructions, storedSkill } from "../prompts/catalog.ts";
import { createWhatsAppParticipationTools } from "../capabilities/whatsapp-participation/tools.ts";
import { createSpeakerGraphTools } from "../capabilities/graph/tools.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { createEscalateIntentTool } from "../capabilities/intent-escalation/tools.ts";
import { createSayDirectiveTool } from "../capabilities/directive-delivery/tools.ts";
import { createLookupWorkTool } from "../capabilities/delegation/work-tools.ts";

export const description = "A continuing private coworker instance identified by its managed WhatsApp chatId.";

/**
 * The Speaker's runtime configuration. Its instructions and its participation skill body both
 * resolve from the prompt store (#375) at initialization, so an edit to either takes effect on the
 * Speaker's next turn without a release.
 */
export const speakerRuntimeConfig = (id: string): AgentRuntimeConfig => ({
  ...resolveAgentModelProfile("speaker"),
  skills: [storedSkill(PROMPT_IDS.whatsappParticipationSkill)],
  tools: [
    ...createWhatsAppParticipationTools(id),
    createSayDirectiveTool(id),
    createEscalateIntentTool(id),
    createLookupWorkTool(id),
    ...createSpeakerGraphTools(),
  ],
  instructions: storedInstructions(PROMPT_IDS.speaker),
});

export default defineAgent(({ id }) => speakerRuntimeConfig(id));
