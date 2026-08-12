import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { ConversationRunEvidence, EvaluationWorkStore } from "../evals/contract";
import type { AmbientDatabaseConnection } from "./database";
import { agentRuns, evaluationPending, observations, toolCalls } from "./schema";

const runInputSchema = z.object({
  inboxItems: z.array(
    z.object({
      inboxItemId: z.string().min(1),
      kind: z.enum(["message", "task_update"]),
      referenceId: z.string().min(1),
    }),
  ),
  instructions: z.string().optional(),
});

const messagePayloadSchema = z.looseObject({
  sender: z.looseObject({ id: z.string().min(1) }),
  text: z.string(),
});

const sendInputSchema = z.looseObject({ text: z.string() });
const sendOutputSchema = z.looseObject({ operationId: z.string().optional() });
const resultSchema = z.looseObject({ summary: z.string() });

export function createEvaluationWorkStore(
  database: AmbientDatabaseConnection,
): EvaluationWorkStore {
  const evidence = async (runId: string): Promise<ConversationRunEvidence> => {
    const [run] = await database.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw new Error(`evaluation subject run "${runId}" not found`);
    if (run.status === "running") {
      throw new Error(`evaluation subject run "${runId}" is not terminal`);
    }
    const input = runInputSchema.parse(run.input);

    const messageIds = input.inboxItems
      .filter(({ kind }) => kind === "message")
      .map(({ referenceId }) => referenceId);
    const retained = messageIds.length
      ? await database
          .select({ id: observations.id, payload: observations.payload })
          .from(observations)
          .where(inArray(observations.id, messageIds))
      : [];
    const byId = new Map(retained.map((row) => [row.id, row.payload]));
    const newMessages = messageIds.map((id) => {
      const payload = byId.get(id);
      if (payload === undefined) {
        throw new Error(`evaluation subject observation "${id}" not found`);
      }
      const message = messagePayloadSchema.parse(payload);
      return { senderId: message.sender.id, text: message.text };
    });

    const calls = await database
      .select()
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, runId),
          eq(toolCalls.toolName, "send_message"),
          eq(toolCalls.outcome, "succeeded"),
        ),
      )
      .orderBy(asc(toolCalls.startedAt))
      .limit(1);
    const send = calls[0];
    const reply = send
      ? {
          text: sendInputSchema.parse(send.input).text,
          ...(() => {
            const operationId = sendOutputSchema.parse(send.output ?? {}).operationId;
            return operationId === undefined ? {} : { operationId };
          })(),
        }
      : undefined;

    const summary =
      run.status === "succeeded" && run.result !== null
        ? resultSchema.parse(run.result).summary
        : undefined;

    return {
      runId,
      ...(run.conversationId === null ? {} : { conversationId: run.conversationId }),
      status: run.status,
      promptVersion: run.promptVersion,
      itemCount: input.inboxItems.length,
      newMessages,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(reply === undefined ? {} : { reply }),
      ...(summary === undefined ? {} : { summary }),
      ...(run.error === null ? {} : { error: run.error }),
    };
  };

  return {
    async claimNext({ leaseOwner, leaseMs, now = new Date().toISOString() }) {
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const claimed = await database.transaction(async (transaction) => {
        const claimable = or(
          isNull(evaluationPending.leaseUntil),
          lte(evaluationPending.leaseUntil, now),
        );
        const [candidate] = await transaction
          .select({ runId: evaluationPending.runId })
          .from(evaluationPending)
          .where(claimable)
          .orderBy(asc(evaluationPending.createdAt), asc(evaluationPending.runId))
          .limit(1);
        if (!candidate) return undefined;
        const [leased] = await transaction
          .update(evaluationPending)
          .set({ leaseOwner, leaseUntil })
          .where(and(eq(evaluationPending.runId, candidate.runId), claimable))
          .returning({ runId: evaluationPending.runId });
        return leased?.runId;
      });
      if (!claimed) return undefined;
      // Assembled outside the claim transaction: a broken subject keeps its
      // lease and cools down instead of hot-looping the claimer.
      return evidence(claimed);
    },

    async complete(runId) {
      await database.delete(evaluationPending).where(eq(evaluationPending.runId, runId));
    },
  };
}
