import { z } from "zod";
import { assistantText } from "../models/assistant-text";
import type { ModelRunner } from "../models/runtime";
import type { ConversationJudge, ConversationRunEvidence } from "./contract";

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

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("judge returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}

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
