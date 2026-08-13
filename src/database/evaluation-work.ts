import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type {
  ConversationRunEvidence,
  EvaluationWorkStore,
  MemoryRunEvidence,
  RunEvidence,
} from "../evals/contract";
import type { AmbientDatabaseConnection } from "./database";
import { retainedMessagePayloadSchema } from "../whatsapp/message-payload";
import { agentRuns, evaluationPending, observations, toolCalls } from "./schema";

const memoryRunInputSchema = z.object({
  conversationId: z.string().min(1),
  observationIds: z.array(z.string().min(1)),
});

const memoryRunResultSchema = z.object({
  report: z.string(),
  entitiesCreated: z.number().int().nonnegative(),
  linkedNativeIds: z.array(z.string()),
  claims: z.array(
    z.object({
      claimId: z.string().min(1),
      entityName: z.string(),
      predicateName: z.string(),
      value: z.json(),
      confidence: z.string(),
      evidenceObservationIds: z.array(z.string().min(1)),
    }),
  ),
  patchStatus: z.enum(["applied", "empty"]),
});

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
  const evidence = async (runId: string): Promise<RunEvidence> => {
    const [run] = await database.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw new Error(`evaluation subject run "${runId}" not found`);
    if (run.status === "running") {
      throw new Error(`evaluation subject run "${runId}" is not terminal`);
    }
    if (run.role === "memory") return memoryEvidence(run);
    if (run.role !== "conversation") {
      throw new Error(`evaluation subject run "${runId}" has unevaluated role "${run.role}"`);
    }
    return conversationEvidence(run);
  };

  const memoryEvidence = async (run: typeof agentRuns.$inferSelect): Promise<MemoryRunEvidence> => {
    const input = memoryRunInputSchema.parse(run.input);
    const batch = new Set(input.observationIds);
    const rows = input.observationIds.length
      ? await database
          .select({
            id: observations.id,
            conversationId: observations.conversationId,
            occurredAt: observations.occurredAt,
            payload: observations.payload,
          })
          .from(observations)
          .where(inArray(observations.id, input.observationIds))
          .orderBy(asc(observations.occurredAt), asc(observations.id))
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Linkable identities mirror the memory service: real senders + mentions.
    const senders = new Set<string>();
    const windowMessages: MemoryRunEvidence["windowMessages"][number][] = [];
    for (const row of rows) {
      const parsed = retainedMessagePayloadSchema.safeParse(row.payload);
      if (!parsed.success) continue;
      const payload = parsed.data;
      if (payload.sender) senders.add(payload.sender.id);
      for (const mention of payload.context?.mentions ?? []) senders.add(mention);
      // Quoted replies name the quoted message's author — the same recovered
      // identity the memory service treats as linkable.
      if (payload.context?.quoted?.from) senders.add(payload.context.quoted.from);
      windowMessages.push({
        ...(payload.sender ? { senderId: payload.sender.id } : {}),
        fromMe: payload.fromMe ?? false,
        text: payload.text ?? payload.media?.caption ?? "",
        ...(payload.kind !== undefined && payload.kind !== "text"
          ? { attachment: payload.kind }
          : {}),
      });
    }

    const result = run.result === null ? undefined : memoryRunResultSchema.safeParse(run.result);
    const applied = result?.success ? result.data : undefined;
    const appliedClaims = (applied?.claims ?? []).map((claim) => {
      const cited = claim.evidenceObservationIds.map((id) => byId.get(id));
      return {
        claimId: claim.claimId,
        entityName: claim.entityName,
        predicateName: claim.predicateName,
        value: claim.value,
        confidence: claim.confidence,
        evidenceObservationIds: claim.evidenceObservationIds,
        evidenceTexts: cited.flatMap((row) => {
          if (!row) return [];
          const parsed = retainedMessagePayloadSchema.safeParse(row.payload);
          if (!parsed.success) return [];
          return [parsed.data.text ?? parsed.data.media?.caption ?? ""];
        }),
        grounded: claim.evidenceObservationIds.every((id) => batch.has(id)),
        inConversation: cited.every((row) => row?.conversationId === input.conversationId),
      };
    });

    return {
      role: "memory",
      runId: run.id,
      ...(run.conversationId === null ? {} : { conversationId: run.conversationId }),
      status: run.status === "succeeded" ? "succeeded" : "failed",
      promptVersion: run.promptVersion,
      batchObservationIds: input.observationIds,
      batchSenderIds: [...senders],
      windowMessages,
      appliedClaims,
      linkedNativeIds: applied?.linkedNativeIds ?? [],
      patchStatus: applied ? applied.patchStatus : "none",
      ...(run.error === null ? {} : { error: run.error }),
    };
  };

  const conversationEvidence = async (
    run: typeof agentRuns.$inferSelect,
  ): Promise<ConversationRunEvidence> => {
    const runId = run.id;
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
      role: "conversation",
      runId,
      ...(run.conversationId === null ? {} : { conversationId: run.conversationId }),
      status: run.status === "succeeded" ? "succeeded" : "failed",
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
