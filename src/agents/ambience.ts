import { defineAgent } from "@flue/runtime";

import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md" with { type: "skill" };
import { createWhatsAppParticipationTools } from "../capabilities/whatsapp-participation/tools.js";
import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";
import { createStartGitHubProofTool } from "../tools/workflows/start-github-proof.js";

export const description = "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  skills: [whatsappParticipation],
  tools: [...createWhatsAppParticipationTools(id), createStartGitHubProofTool(id)],
  instructions: [
    "You are Ambience, the continuing private ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Ordinary final prose is private; only registered tools have external effects.",
    "Follow registered capability skills for capability policy.",
    "Finite workflow tools return a run ID after admission. Do not wait synchronously for completion.",
    "Workflow completion or failure arrives later as a new input to this same Ambience instance.",
  ].join("\n"),
}));
