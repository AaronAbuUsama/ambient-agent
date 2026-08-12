import { and, asc, eq, gte, inArray, isNull, lte, max, min, notExists, sql } from "drizzle-orm";
import type {
  ClaimConversationWork,
  ConversationClaim,
  ConversationResult,
  ConversationSchedulingConfig,
  ConversationWorkStore,
} from "../conversation/contract";
import type { AmbientDatabaseConnection } from "./database";
import { decodeConversationInboxItem } from "./conversation-inbox";
import { createObservationRepository } from "./observations";
import {
  agentRuns,
  conversationInbox,
  conversationRunItems,
  conversationSchedule,
  conversationSpeakers,
  evaluationPending,
  toolCalls,
} from "./schema";

type AmbientTransaction = Parameters<Parameters<AmbientDatabaseConnection["transaction"]>[0]>[0];
type AmbientExecutor = AmbientDatabaseConnection | AmbientTransaction;

interface PendingWindow {
  readonly conversationId: string;
  readonly firstPendingAt: string;
  readonly latestPendingAt: string;
}

class LeaseLostError extends Error {}

function isSqliteBusy(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    if ("code" in current && current.code === "SQLITE_BUSY") return true;
    current = current.cause;
  }
  return false;
}

function dueAt(window: PendingWindow, scheduling: ConversationSchedulingConfig): string {
  const afterDebounce = Date.parse(window.latestPendingAt) + scheduling.debounceMs;
  const maximumWait = Date.parse(window.firstPendingAt) + scheduling.maximumWaitMs;
  return new Date(Math.min(afterDebounce, maximumWait)).toISOString();
}

/**
 * The presence gate: only a chat with an active `responding` speaker is ever
 * eligible for Conversation work. Observation and Inbox retention are not
 * affected — un-allowed chats keep their evidence but never get a window.
 */
async function respondingSpeaker(
  database: AmbientExecutor,
  conversationId: string,
): Promise<{ attendFrom: string; instructions: string | null } | undefined> {
  const [row] = await database
    .select({
      attendFrom: conversationSpeakers.attendFrom,
      instructions: conversationSpeakers.instructions,
    })
    .from(conversationSpeakers)
    .where(
      and(
        eq(conversationSpeakers.conversationId, conversationId),
        eq(conversationSpeakers.mode, "responding"),
      ),
    )
    .limit(1);
  return row;
}

async function pendingWindow(
  database: AmbientExecutor,
  conversationId: string,
  attendFrom: string,
): Promise<PendingWindow | undefined> {
  const [row] = await database
    .select({
      firstPendingAt: min(conversationInbox.createdAt),
      latestPendingAt: max(conversationInbox.createdAt),
    })
    .from(conversationInbox)
    .where(
      and(
        eq(conversationInbox.conversationId, conversationId),
        isNull(conversationInbox.claimedByRunId),
        isNull(conversationInbox.consumedByRunId),
        gte(conversationInbox.createdAt, attendFrom),
      ),
    );
  if (!row?.firstPendingAt || !row.latestPendingAt) return undefined;
  return {
    conversationId,
    firstPendingAt: row.firstPendingAt,
    latestPendingAt: row.latestPendingAt,
  };
}

async function setPendingWindow(
  database: AmbientExecutor,
  conversationId: string,
  scheduling: ConversationSchedulingConfig,
): Promise<void> {
  const speaker = await respondingSpeaker(database, conversationId);
  const window = speaker && (await pendingWindow(database, conversationId, speaker.attendFrom));
  if (!window) {
    await database
      .update(conversationSchedule)
      .set({ firstPendingAt: null, latestPendingAt: null, dueAt: null })
      .where(
        and(
          eq(conversationSchedule.conversationId, conversationId),
          isNull(conversationSchedule.activeRunId),
        ),
      );
    return;
  }

  const [row] = await database
    .insert(conversationSchedule)
    .values({
      conversationId,
      firstPendingAt: window.firstPendingAt,
      latestPendingAt: window.latestPendingAt,
      dueAt: dueAt(window, scheduling),
    })
    .onConflictDoUpdate({
      target: conversationSchedule.conversationId,
      set: {
        firstPendingAt: window.firstPendingAt,
        latestPendingAt: window.latestPendingAt,
        dueAt: dueAt(window, scheduling),
      },
    })
    .returning({ conversationId: conversationSchedule.conversationId });
  if (!row) throw new Error(`conversation schedule "${conversationId}" was not retained`);
}

export function createConversationWorkStore(
  database: AmbientDatabaseConnection,
): ConversationWorkStore {
  const observations = createObservationRepository(database);

  const finish = async (
    input:
      | {
          readonly status: "succeeded";
          readonly runId: string;
          readonly leaseOwner: string;
          readonly result: ConversationResult;
          readonly completedAt?: string;
          readonly scheduling: ConversationSchedulingConfig;
        }
      | {
          readonly status: "failed";
          readonly runId: string;
          readonly leaseOwner: string;
          readonly error: string;
          readonly completedAt?: string;
          readonly scheduling: ConversationSchedulingConfig;
        },
  ): Promise<void> => {
    const completedAt = input.completedAt ?? new Date().toISOString();
    return database.transaction(async (transaction) => {
      const [schedule] = await transaction
        .select()
        .from(conversationSchedule)
        .where(
          and(
            eq(conversationSchedule.activeRunId, input.runId),
            eq(conversationSchedule.leaseOwner, input.leaseOwner),
            sql`${conversationSchedule.leaseUntil} > ${completedAt}`,
          ),
        )
        .limit(1);
      if (!schedule) {
        throw new Error(
          `conversation run "${input.runId}" does not have an active lease for "${input.leaseOwner}"`,
        );
      }

      const [run] = await transaction
        .update(agentRuns)
        .set({
          status: input.status,
          result: input.status === "succeeded" ? input.result : null,
          error: input.status === "failed" ? input.error : null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.status, "running"),
            notExists(
              transaction
                .select({ id: toolCalls.id })
                .from(toolCalls)
                .where(and(eq(toolCalls.runId, input.runId), eq(toolCalls.outcome, "running"))),
            ),
          ),
        )
        .returning({ id: agentRuns.id });
      if (!run) throw new Error(`conversation run "${input.runId}" is not running`);

      // The durable evaluation signal rides the terminal transition.
      await transaction
        .insert(evaluationPending)
        .values({ runId: input.runId, createdAt: completedAt })
        .onConflictDoNothing();

      await transaction
        .update(conversationInbox)
        .set(
          input.status === "succeeded"
            ? { consumedByRunId: input.runId, consumedAt: completedAt }
            : { claimedByRunId: null },
        )
        .where(
          and(
            eq(conversationInbox.claimedByRunId, input.runId),
            isNull(conversationInbox.consumedByRunId),
          ),
        );

      await transaction
        .update(conversationSchedule)
        .set({ leaseOwner: null, leaseUntil: null, activeRunId: null })
        .where(eq(conversationSchedule.conversationId, schedule.conversationId));
      await setPendingWindow(transaction, schedule.conversationId, input.scheduling);
      if (input.status === "failed") {
        await transaction
          .update(conversationSchedule)
          .set({
            dueAt: new Date(Date.parse(completedAt) + input.scheduling.debounceMs).toISOString(),
          })
          .where(
            and(
              eq(conversationSchedule.conversationId, schedule.conversationId),
              sql`${conversationSchedule.firstPendingAt} IS NOT NULL`,
            ),
          );
      }
    });
  };

  return {
    async reconcile(scheduling) {
      const pending = await database
        .select({ conversationId: conversationInbox.conversationId })
        .from(conversationInbox)
        .innerJoin(
          conversationSpeakers,
          and(
            eq(conversationSpeakers.conversationId, conversationInbox.conversationId),
            eq(conversationSpeakers.mode, "responding"),
          ),
        )
        .where(
          and(isNull(conversationInbox.claimedByRunId), isNull(conversationInbox.consumedByRunId)),
        )
        .groupBy(conversationInbox.conversationId);
      await database.transaction(async (transaction) => {
        for (const { conversationId } of pending) {
          await setPendingWindow(transaction, conversationId, scheduling);
        }
        const inactive = await transaction
          .select({ conversationId: conversationSchedule.conversationId })
          .from(conversationSchedule)
          .where(isNull(conversationSchedule.activeRunId));
        const pendingIds = new Set(pending.map(({ conversationId }) => conversationId));
        for (const { conversationId } of inactive) {
          if (!pendingIds.has(conversationId)) {
            await setPendingWindow(transaction, conversationId, scheduling);
          }
        }
      });
    },

    async notify(conversationId, scheduling) {
      await database.transaction((transaction) =>
        setPendingWindow(transaction, conversationId, scheduling),
      );
    },

    async nextWakeAt() {
      const [row] = await database
        .select({
          dueAt: sql<
            string | null
          >`min(CASE WHEN ${conversationSchedule.activeRunId} IS NULL THEN ${conversationSchedule.dueAt} END)`,
          leaseUntil: sql<
            string | null
          >`min(CASE WHEN ${conversationSchedule.activeRunId} IS NOT NULL THEN ${conversationSchedule.leaseUntil} END)`,
        })
        .from(conversationSchedule);
      const candidates = [row?.dueAt, row?.leaseUntil].filter(
        (value): value is string => value !== null && value !== undefined,
      );
      return candidates.sort()[0];
    },

    async renewLease({ runId, leaseOwner, now = new Date().toISOString(), leaseUntil }) {
      const [renewed] = await database
        .update(conversationSchedule)
        .set({ leaseUntil })
        .where(
          and(
            eq(conversationSchedule.activeRunId, runId),
            eq(conversationSchedule.leaseOwner, leaseOwner),
            sql`${conversationSchedule.leaseUntil} > ${now}`,
            sql`${leaseUntil} > ${now}`,
          ),
        )
        .returning({ conversationId: conversationSchedule.conversationId });
      return Boolean(renewed);
    },

    observations(ids) {
      return observations.getMany(ids);
    },

    async claimNext(input: ClaimConversationWork): Promise<ConversationClaim | undefined> {
      const now = input.now ?? new Date().toISOString();
      const leaseUntil = new Date(Date.parse(now) + input.scheduling.leaseMs).toISOString();
      try {
        return await database.transaction(async (transaction) => {
          const [expired] = await transaction
            .select()
            .from(conversationSchedule)
            .where(
              and(
                sql`${conversationSchedule.activeRunId} IS NOT NULL`,
                lte(conversationSchedule.leaseUntil, now),
              ),
            )
            .orderBy(asc(conversationSchedule.leaseUntil), asc(conversationSchedule.conversationId))
            .limit(1);
          if (expired?.activeRunId) {
            await transaction
              .update(toolCalls)
              .set({
                outcome: "failed",
                error: "conversation lease expired",
                completedAt: now,
              })
              .where(
                and(eq(toolCalls.runId, expired.activeRunId), eq(toolCalls.outcome, "running")),
              );
            await transaction
              .update(agentRuns)
              .set({
                status: "failed",
                error: "conversation lease expired",
                completedAt: now,
                updatedAt: now,
              })
              .where(and(eq(agentRuns.id, expired.activeRunId), eq(agentRuns.status, "running")));
            await transaction
              .insert(evaluationPending)
              .values({ runId: expired.activeRunId, createdAt: now })
              .onConflictDoNothing();
            await transaction
              .update(conversationInbox)
              .set({ claimedByRunId: null })
              .where(
                and(
                  eq(conversationInbox.claimedByRunId, expired.activeRunId),
                  isNull(conversationInbox.consumedByRunId),
                ),
              );
            await transaction
              .update(conversationSchedule)
              .set({ leaseOwner: null, leaseUntil: null, activeRunId: null })
              .where(eq(conversationSchedule.conversationId, expired.conversationId));
            await setPendingWindow(transaction, expired.conversationId, input.scheduling);
          }

          const [candidate] = await transaction
            .select()
            .from(conversationSchedule)
            .where(
              and(isNull(conversationSchedule.activeRunId), lte(conversationSchedule.dueAt, now)),
            )
            .orderBy(asc(conversationSchedule.dueAt), asc(conversationSchedule.conversationId))
            .limit(1);
          if (!candidate) return undefined;

          const speaker = await respondingSpeaker(transaction, candidate.conversationId);
          if (!speaker) {
            // The speaker was silenced after this window was authored; clear it.
            await setPendingWindow(transaction, candidate.conversationId, input.scheduling);
            return undefined;
          }

          const rows = await transaction
            .select()
            .from(conversationInbox)
            .where(
              and(
                eq(conversationInbox.conversationId, candidate.conversationId),
                isNull(conversationInbox.claimedByRunId),
                isNull(conversationInbox.consumedByRunId),
                gte(conversationInbox.createdAt, speaker.attendFrom),
              ),
            )
            .orderBy(asc(conversationInbox.createdAt), asc(conversationInbox.id))
            .limit(input.scheduling.maximumItemsPerRun);
          if (rows.length === 0) {
            await setPendingWindow(transaction, candidate.conversationId, input.scheduling);
            return undefined;
          }

          const runId = crypto.randomUUID();
          const items = rows.map(decodeConversationInboxItem);
          await transaction.insert(agentRuns).values({
            id: runId,
            agentId: input.agentId,
            role: "conversation",
            conversationId: candidate.conversationId,
            status: "running",
            provider: input.model.provider,
            model: input.model.model,
            thinking: input.model.thinking,
            maxOutputTokens: input.model.maxOutputTokens,
            promptVersion: input.promptVersion,
            input: {
              inboxItems: items.map(({ id: inboxItemId, kind, referenceId }) => ({
                inboxItemId,
                kind,
                referenceId,
              })),
              ...(speaker.instructions === null ? {} : { instructions: speaker.instructions }),
            },
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          const [leased] = await transaction
            .update(conversationSchedule)
            .set({
              firstPendingAt: null,
              latestPendingAt: null,
              dueAt: null,
              leaseOwner: input.leaseOwner,
              leaseUntil,
              activeRunId: runId,
            })
            .where(
              and(
                eq(conversationSchedule.conversationId, candidate.conversationId),
                isNull(conversationSchedule.activeRunId),
                lte(conversationSchedule.dueAt, now),
              ),
            )
            .returning({ conversationId: conversationSchedule.conversationId });
          if (!leased) throw new LeaseLostError();

          const claimed = await transaction
            .update(conversationInbox)
            .set({ claimedByRunId: runId })
            .where(
              and(
                inArray(
                  conversationInbox.id,
                  rows.map(({ id }) => id),
                ),
                isNull(conversationInbox.claimedByRunId),
                isNull(conversationInbox.consumedByRunId),
              ),
            )
            .returning({ id: conversationInbox.id });
          if (claimed.length !== rows.length) throw new LeaseLostError();

          await transaction
            .insert(conversationRunItems)
            .values(rows.map(({ id }, position) => ({ runId, inboxItemId: id, position })));
          return {
            runId,
            conversationId: candidate.conversationId,
            items: items.map(({ id, kind, referenceId }) => ({ id, kind, referenceId })),
            ...(speaker.instructions === null ? {} : { instructions: speaker.instructions }),
          };
        });
      } catch (error) {
        if (error instanceof LeaseLostError || isSqliteBusy(error)) return undefined;
        throw error;
      }
    },

    beginTool(input) {
      return database.transaction(async (transaction) => {
        const [run] = await transaction
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, input.runId))
          .limit(1);
        if (!run) throw new Error(`agent run "${input.runId}" not found`);
        if (run.status !== "running") {
          throw new Error(
            `agent run "${input.runId}" cannot start tool calls from status "${run.status}"`,
          );
        }

        const toolCallId = crypto.randomUUID();
        const [row] = await transaction
          .insert(toolCalls)
          .values({
            id: toolCallId,
            runId: input.runId,
            callId: input.callId,
            toolName: input.toolName,
            input: input.input,
            outcome: "running",
            startedAt: new Date().toISOString(),
          })
          .returning({ id: toolCalls.id });
        if (!row) throw new Error(`tool call "${toolCallId}" was not inserted`);
        return { toolCallId: row.id };
      });
    },

    async finishTool({ toolCallId, result }) {
      const completedAt = new Date().toISOString();
      const [row] = await database
        .update(toolCalls)
        .set({
          outcome: result.outcome,
          output: result.outcome === "succeeded" ? result.output : null,
          error: result.outcome === "failed" ? result.error : null,
          completedAt,
        })
        .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.outcome, "running")))
        .returning({ id: toolCalls.id });
      if (row) return;

      const [call] = await database
        .select({ outcome: toolCalls.outcome })
        .from(toolCalls)
        .where(eq(toolCalls.id, toolCallId))
        .limit(1);
      if (!call) throw new Error(`tool call "${toolCallId}" not found`);
      throw new Error(`tool call "${toolCallId}" cannot finish from outcome "${call.outcome}"`);
    },

    complete(input) {
      return finish({ status: "succeeded", ...input });
    },

    fail(input) {
      return finish({ status: "failed", ...input });
    },
  };
}
