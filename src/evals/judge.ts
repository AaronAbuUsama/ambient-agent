import { z } from "zod";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import { extractJson } from "../models/structured-output";
import type {
  ConversationJudge,
  ConversationRunEvidence,
  MemoryJudge,
  MemoryRunEvidence,
} from "./contract";

const systemPrompt = `You are Ambient's conversation evaluator.

You receive retained evidence of one completed WhatsApp conversation turn: the new inbound messages,
the standing instructions, and either the reply that was sent or the fact that the agent chose
silence. Judge the decision and its quality. Respond with exactly one JSON object and nothing else:

{"replyDecisionAppropriate": boolean, "quality": number, "rationale": string}

- replyDecisionAppropriate: was replying (or staying silent) the right call for these messages?
- quality: 0 to 1. Judge relevance, correctness of register, and brevity for the chosen action.
  Silence that was appropriate scores high; a reply nobody needed scores low.
- rationale: one or two sentences.`;

const verdictSchema = z.object({
  replyDecisionAppropriate: z.boolean(),
  quality: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

/** The narrow run-evidence port the judge needs; satisfied by the run repository. */
export interface JudgeRunStore {
  start(input: {
    readonly agentId: string;
    readonly role: "evaluator";
    readonly conversationId?: string;
    readonly model: ModelRunner["snapshot"];
    readonly promptVersion: string;
    readonly input: unknown;
  }): Promise<{ readonly id: string }>;
  finish(
    id: string,
    result:
      | { readonly status: "succeeded"; readonly result: unknown }
      | { readonly status: "failed"; readonly error: string },
  ): Promise<void>;
}

const promptVersion = "evaluator-judge-v1";

/** Judges one Conversation run with the evaluator-role model, retaining its own run evidence. */
export function createPiConversationJudge(
  runner: ModelRunner,
  runs: JudgeRunStore,
): ConversationJudge {
  return {
    async judge(evidence: ConversationRunEvidence) {
      const subject = {
        newMessages: evidence.newMessages,
        ...(evidence.instructions === undefined ? {} : { instructions: evidence.instructions }),
        action: evidence.reply ? { kind: "reply", text: evidence.reply.text } : { kind: "silence" },
        ...(evidence.summary === undefined ? {} : { privateSummary: evidence.summary }),
      };
      const { id: evaluatorRunId } = await runs.start({
        agentId: "evaluator-judge",
        role: "evaluator",
        ...(evidence.conversationId === undefined
          ? {}
          : { conversationId: evidence.conversationId }),
        model: runner.snapshot,
        promptVersion,
        input: { subjectRunId: evidence.runId, subject },
      });
      try {
        const message = await runner
          .stream({
            systemPrompt,
            messages: [
              { role: "user", content: JSON.stringify(subject, null, 2), timestamp: Date.now() },
            ],
          })
          .result();
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          throw new Error(message.errorMessage ?? `judge model ${message.stopReason}`);
        }
        const verdict = verdictSchema.parse(extractJson(assistantText(message)));
        await runs.finish(evaluatorRunId, { status: "succeeded", result: verdict });
        return {
          evaluatorRunId,
          metrics: [
            {
              metric: "reply_decision",
              passed: verdict.replyDecisionAppropriate,
              detail: { rationale: verdict.rationale },
            },
            {
              metric: "reply_quality",
              score: verdict.quality,
              detail: { rationale: verdict.rationale },
            },
          ],
        };
      } catch (error) {
        await runs
          .finish(evaluatorRunId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => {});
        throw error;
      }
    },
  };
}

const memoryJudgeSystemPrompt = `You are Ambient's memory evaluator.

You receive claims a memory analyst extracted from a WhatsApp conversation, each with the exact
messages it cited as evidence. Judge each claim strictly against ONLY its cited messages. Respond
with exactly one JSON object and nothing else:

{"claims": [{"index": 0, "supported": boolean}], "missedFacts": "one sentence on salient facts the
analyst obviously missed, or an empty string"}

A claim is supported only when its cited messages actually state or clearly imply it.`;

const memoryVerdictSchema = z.object({
  claims: z.array(z.object({ index: z.number().int().nonnegative(), supported: z.boolean() })),
  missedFacts: z.string(),
});

const memoryJudgePromptVersion = "memory-judge-v1";

/** Judges one Memory run's applied claims with the evaluator-role model. */
export function createPiMemoryJudge(runner: ModelRunner, runs: JudgeRunStore): MemoryJudge {
  return {
    async judge(evidence: MemoryRunEvidence) {
      const subject = {
        claims: evidence.appliedClaims.map((claim, index) => ({
          index,
          claim: `${claim.entityName} ${claim.predicateName}: ${JSON.stringify(claim.value)}`,
          confidence: claim.confidence,
          citedMessages: claim.evidenceTexts,
        })),
      };
      const { id: evaluatorRunId } = await runs.start({
        agentId: "evaluator-judge",
        role: "evaluator",
        ...(evidence.conversationId === undefined
          ? {}
          : { conversationId: evidence.conversationId }),
        model: runner.snapshot,
        promptVersion: memoryJudgePromptVersion,
        input: { subjectRunId: evidence.runId, subject },
      });
      try {
        const message = await runner
          .stream({
            systemPrompt: memoryJudgeSystemPrompt,
            messages: [
              { role: "user", content: JSON.stringify(subject, null, 2), timestamp: Date.now() },
            ],
          })
          .result();
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          throw new Error(message.errorMessage ?? `judge model ${message.stopReason}`);
        }
        const verdict = memoryVerdictSchema.parse(extractJson(assistantText(message)));
        const supported = new Map(verdict.claims.map(({ index, supported: s }) => [index, s]));
        const total = evidence.appliedClaims.length;
        const supportedCount = evidence.appliedClaims.filter(
          (_claim, index) => supported.get(index) === true,
        ).length;
        const faithfulness = total === 0 ? 1 : supportedCount / total;
        await runs.finish(evaluatorRunId, { status: "succeeded", result: verdict });
        return {
          evaluatorRunId,
          metrics: [
            {
              metric: "memory_faithfulness",
              score: faithfulness,
              passed: faithfulness >= 0.8,
              detail: { total, supported: supportedCount },
            },
            {
              metric: "memory_missed_facts",
              passed: verdict.missedFacts.trim() === "",
              detail: { missedFacts: verdict.missedFacts },
            },
          ],
        };
      } catch (error) {
        await runs
          .finish(evaluatorRunId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => {});
        throw error;
      }
    },
  };
}
