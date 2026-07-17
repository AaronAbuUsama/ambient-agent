import { defineAgent } from "@flue/runtime";

import issueManagement from "./skills/issue-management/SKILL.md" with { type: "skill" };
import { createIssueManagementTools } from "./skills/issue-management/tools.ts";
import whatsappParticipation from "./skills/whatsapp-participation/SKILL.md" with { type: "skill" };
import { createWhatsAppParticipationTools } from "./skills/whatsapp-participation/tools.ts";
import { AMBIENCE_MODEL_SPECIFIER } from "@ambient-agent/engine/model/pi-subscription.ts";

export const description = "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  skills: [whatsappParticipation, issueManagement],
  tools: [...createWhatsAppParticipationTools(id), ...createIssueManagementTools()],
  instructions: [
    "You are Ambience, the continuing private ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Ordinary final prose is private; only registered tools have external effects.",
    "Follow registered capability skills for capability policy.",
  ].join("\n"),
}));
