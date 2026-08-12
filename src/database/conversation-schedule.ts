import { and, asc, eq, inArray, isNull, lte, max, min, notExists, sql } from "drizzle-orm";
import type {
  ClaimConversationRunInput,
  ConversationRunClaim,
  ConversationScheduleState,
  ConversationSchedulingConfig,
} from "../conversation/contract";
import type { AmbientDatabaseConnection } from "./database";
import { decodeConversationInboxItem, type ConversationInboxItem } from "./conversation-inbox";
import type { AgentRun } from "./runs";
import {
  agentRuns,
  conversationInbox,
  conversationRunItems,
  conversationSchedule,
  toolCalls,
} from "./schema";

type AmbientTransaction = Parameters<Parameters<AmbientDatabaseConnection["transaction"]>[0]>[0];
type AmbientExecutor = AmbientDatabaseConnection | AmbientTransaction;

export interface ConversationScheduleRepository {
  reconcile(scheduling: ConversationSchedulingConfig): Promise<void>;
  notify(
    conversationId: string,
    scheduling: ConversationSchedulingConfig,
  ): Promise<ConversationScheduleState | undefined>;
  get(conversationId: string): Promise<ConversationScheduleState | undefined>;
  nextWakeAt(): Promise<string | undefined>;
  renewLease(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly now?: string;
    readonly leaseUntil: string;
  }): Promise<boolean>;
  claimDue(input: ClaimConversationRunInput): Promise<ConversationRunClaim | undefined>;
  succeed(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly result: AgentRun["input"];
    readonly completedAt?: string;
    readonly scheduling: ConversationSchedulingConfig;
  }): Promise<number>;
  fail(input: {
    readonly runId: string;
    readonly leaseOwner: string;
    readonly error: string;
    readonly completedAt?: string;
    readonly scheduling: ConversationSchedulingConfig;
  }): Promise<number>;
}

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

function decodeSchedule(row: typeof conversationSchedule.$inferSelect): ConversationScheduleState {
  return {
    conversationId: row.conversationId,
    firstPendingAt: row.firstPendingAt ?? undefined,
    latestPendingAt: row.latestPendingAt ?? undefined,
    dueAt: row.dueAt ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    activeRunId: row.activeRunId ?? undefined,
  };
}

function dueAt(window: PendingWindow, scheduling: ConversationSchedulingConfig): string {
  const afterDebounce = Date.parse(window.latestPendingAt) + scheduling.debounceMs;
  const maximumWait = Date.parse(window.firstPendingAt) + scheduling.maximumWaitMs;
  return new Date(Math.min(afterDebounce, maximumWait)).toISOString();
}

async function pendingWindow(
  database: AmbientExecutor,
  conversationId: string,
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
): Promise<ConversationScheduleState | undefined> {
  const window = await pendingWindow(database, conversationId);
  if (!window) {
    const [cleared] = await database
      .update(conversationSchedule)
      .set({ firstPendingAt: null, latestPendingAt: null, dueAt: null })
      .where(
        and(
          eq(conversationSchedule.conversationId, conversationId),
          isNull(conversationSchedule.activeRunId),
        ),
      )
      .returning();
    return cleared ? decodeSchedule(cleared) : undefined;
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
    .returning();
  if (!row) throw new Error(`conversation schedule "${conversationId}" was not retained`);
  return decodeSchedule(row);
}

function runFromClaim(
  id: string,
  input: ClaimConversationRunInput,
  conversationId: string,
  items: readonly ConversationInboxItem[],
  startedAt: string,
): AgentRun {
  return {
    id,
    agentId: input.agentId,
    role: "conversation",
    conversationId,
    status: "running",
    model: input.model,
    promptVersion: input.promptVersion,
    input: {
      inboxItems: items.map(({ id: inboxItemId, kind, referenceId }) => ({
        inboxItemId,
        kind,
        referenceId,
      })),
    },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

export function createConversationScheduleRepository(
  database: AmbientDatabaseConnection,
): ConversationScheduleRepository {
  const get = async (conversationId: string): Promise<ConversationScheduleState | undefined> => {
    const [row] = await database
      .select()
      .from(conversationSchedule)
      .where(eq(conversationSchedule.conversationId, conversationId))
      .limit(1);
    return row ? decodeSchedule(row) : undefined;
  };

  const complete = async (
    input:
      | {
          readonly status: "succeeded";
          readonly runId: string;
          readonly leaseOwner: string;
          readonly result: AgentRun["input"];
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
  ): Promise<number> => {
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

      const claimed =
        input.status === "succeeded"
          ? await transaction
              .update(conversationInbox)
              .set({ consumedByRunId: input.runId, consumedAt: completedAt })
              .where(
                and(
                  eq(conversationInbox.claimedByRunId, input.runId),
                  isNull(conversationInbox.consumedByRunId),
                ),
              )
              .returning({ id: conversationInbox.id })
          : await transaction
              .update(conversationInbox)
              .set({ claimedByRunId: null })
              .where(
                and(
                  eq(conversationInbox.claimedByRunId, input.runId),
                  isNull(conversationInbox.consumedByRunId),
                ),
              )
              .returning({ id: conversationInbox.id });

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
      return claimed.length;
    });
  };

  return {
    async reconcile(scheduling) {
      const pending = await database
        .select({ conversationId: conversationInbox.conversationId })
        .from(conversationInbox)
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

    notify(conversationId, scheduling) {
      return database.transaction((transaction) =>
        setPendingWindow(transaction, conversationId, scheduling),
      );
    },

    get,

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

    async claimDue(input) {
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

          const rows = await transaction
            .select()
            .from(conversationInbox)
            .where(
              and(
                eq(conversationInbox.conversationId, candidate.conversationId),
                isNull(conversationInbox.claimedByRunId),
                isNull(conversationInbox.consumedByRunId),
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
          const run = runFromClaim(runId, input, candidate.conversationId, items, now);
          await transaction.insert(agentRuns).values({
            id: run.id,
            agentId: run.agentId,
            role: run.role,
            conversationId: run.conversationId,
            status: run.status,
            provider: run.model.provider,
            model: run.model.model,
            thinking: run.model.thinking,
            maxOutputTokens: run.model.maxOutputTokens,
            promptVersion: run.promptVersion,
            input: run.input,
            startedAt: run.startedAt,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          });
          const [leased] = await transaction
            .update(conversationSchedule)
            .set({
              firstPendingAt: null,
              latestPendingAt: null,
              dueAt: null,
              leaseOwner: input.leaseOwner,
              leaseUntil,
              activeRunId: run.id,
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
            .set({ claimedByRunId: run.id })
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
            .values(rows.map(({ id }, position) => ({ runId: run.id, inboxItemId: id, position })));
          return {
            run,
            items: items.map((item) => ({ ...item, claimedByRunId: run.id })),
          };
        });
      } catch (error) {
        if (error instanceof LeaseLostError || isSqliteBusy(error)) return undefined;
        throw error;
      }
    },

    succeed(input) {
      return complete({ status: "succeeded", ...input });
    },

    fail(input) {
      return complete({ status: "failed", ...input });
    },
  };
}
