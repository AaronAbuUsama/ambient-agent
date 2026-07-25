import { defineAgent, type AgentRuntimeConfig } from "@flue/runtime";

import { PROMPT_IDS, storedInstructions } from "../prompts/catalog.ts";
import type { GraphAttestationContext } from "@ambient-agent/engine/graph/store.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import {
  createCreateIssueCommentTool,
  createDeleteIssueCommentTool,
  createFileIssueTool,
  createPromptSpeakerTool,
  createScheduleWakeTool,
  createSetIssueStateTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
  createUpdateIssueCommentTool,
  createUpdateIssueTool,
} from "./tools.ts";
import { createDelegationTools } from "../capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "../capabilities/coder/workflow.ts";
import { createRepairPullRequestTool } from "../capabilities/coder/repair-tool.ts";
import { reviewerSpecialistSpec } from "../capabilities/reviewer/workflow.ts";
import { createBrainGraphTools } from "../capabilities/graph/tools.ts";
import { createIssueReadTools } from "../capabilities/issue-management/tools.ts";
import { getBrainEffectsRuntime } from "./effects-runtime.ts";

export const description = "The one continuing global Brain: the coworker's silent mind and decision owner.";

/**
 * The Brain's Graph-write authority for its currently claimed durable Batch. The Evidence Set
 * allow-lists every id the Batch carries — including each GitHub event's own id, so a GitHub-origin
 * Batch can make provenance-bearing Graph rulings citing that event (mirrors the recordPrompt check).
 */
export const brainGraphContext = (): GraphAttestationContext => {
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
        ...batch.specialistResults.flatMap(({ evidenceIds }) => evidenceIds),
        ...batch.githubEvents.map(({ id }) => id),
      ]),
    ],
    batchId: batch.id,
  };
};

/** The Brain's runtime configuration; its instructions resolve from the prompt store (#375). */
export const brainRuntimeConfig = (): AgentRuntimeConfig => ({
  ...resolveAgentModelProfile("brain"),
  tools: [
    ...createBrainGraphTools(brainGraphContext),
    ...createDelegationTools([coderSpecialistSpec, reviewerSpecialistSpec]),
    createRepairPullRequestTool(),
    createPromptSpeakerTool(),
    // Read-only issue lookups so the Brain can resolve exact issue/comment numbers its own workflow
    // (and its mutation tools) require, before choosing a mutation Effect.
    ...createIssueReadTools(),
    createFileIssueTool(),
    createCreateIssueCommentTool(),
    createUpdateIssueTool(),
    createUpdateIssueCommentTool(),
    createDeleteIssueCommentTool(),
    createSetIssueStateTool(),
    createStaySilentTool(),
    createScheduleWakeTool(),
    createSettleBrainBatchTool(),
  ],
  instructions: storedInstructions(PROMPT_IDS.brain),
});

export default defineAgent(() => brainRuntimeConfig());
