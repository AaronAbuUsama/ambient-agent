import { defineAgent } from "@flue/runtime";

import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { createPromptSpeakerTool, createSettleBrainBatchTool, createStaySilentTool } from "./tools.ts";
import { createBrainGraphTools } from "../capabilities/graph/tools.ts";
import { getBrainEffectsRuntime } from "./effects-runtime.ts";

export const description = "The one continuing global Brain: the coworker's silent mind and decision owner.";

export default defineAgent(() => ({
  ...resolveAgentModelProfile("brain"),
  tools: [
    ...createBrainGraphTools(() => {
      const batch = getBrainEffectsRuntime().inbox.claimBatch();
      if (batch === undefined || batch.dispatch === undefined) {
        throw new Error("The Brain has no dispatched durable Batch for Graph authority.");
      }
      return {
        author: { kind: "brain", id: "brain" },
        evidenceIds: [
          ...new Set([
            ...batch.intents.flatMap(({ evidenceIds }) => evidenceIds),
            ...batch.knowledgeDeltas.flatMap(({ evidenceIds }) => evidenceIds),
          ]),
        ],
        batchId: batch.id,
      };
    }),
    createPromptSpeakerTool(),
    createStaySilentTool(),
    createSettleBrainBatchTool(),
  ],
  instructions: [
    "You are the Brain, the coworker's one global mind.",
    "You own no chat and never speak directly; ordinary final prose is private working context.",
    "Each input is one immutable Brain Batch of evidence-backed Intents and Scribe proposal deltas.",
    "Treat Knowledge Deltas as proposals to consider against their Projection version and Attestations; they are not verdicts.",
    "Use lookup_graph to inspect proposals and rule_attestation or merge_entities only when the Batch evidence supports an authoritative ruling.",
    "For every Batch, choose one or more typed Effects, then call settle_brain_batch only after every chosen Effect is durably accepted or completed.",
    "Use prompt_speaker when a selected existing Surface should communicate. Give the Speaker an objective and evidence-backed Brief, never final wording and never a WhatsApp address.",
    "Use stay_silent when no external consequence is warranted. Silence must be explicit; ordinary final prose does not settle a Batch.",
  ].join("\n"),
}));
