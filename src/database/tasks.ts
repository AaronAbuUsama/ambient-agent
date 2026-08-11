import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import { tasks, taskUpdates } from "./schema";

export const taskStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export interface Task {
  readonly id: string;
  readonly conversationId: string;
  readonly requestedByRunId: string;
  readonly objective: string;
  readonly instructions?: string;
  readonly workerProfile: string;
  readonly status: TaskStatus;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly resultSummary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface NewTask {
  readonly id?: string;
  readonly conversationId: string;
  readonly requestedByRunId: string;
  readonly objective: string;
  readonly instructions?: string;
  readonly workerProfile: string;
  readonly createdAt?: string;
}

export interface TaskRepository {
  create(input: NewTask): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  listForConversation(conversationId: string, limit?: number): Promise<readonly Task[]>;
  claimNext(input: {
    readonly workerId: string;
    readonly now?: string;
    readonly leaseUntil: string;
  }): Promise<Task | undefined>;
  transition(
    id: string,
    update:
      | {
          readonly to: "succeeded" | "failed";
          readonly leaseOwner: string;
          readonly at?: string;
          readonly resultSummary?: string;
        }
      | {
          readonly to: "queued" | "cancelled";
          readonly at?: string;
          readonly resultSummary?: string;
        },
  ): Promise<Task>;
}

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
};

function decode(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    conversationId: row.conversationId,
    requestedByRunId: row.requestedByRunId,
    objective: row.objective,
    instructions: row.instructions ?? undefined,
    workerProfile: row.workerProfile,
    status: taskStatusSchema.parse(row.status),
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    resultSummary: row.resultSummary ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

export function createTaskRepository(database: AmbientDatabaseConnection): TaskRepository {
  const get = async (id: string): Promise<Task | undefined> => {
    const [row] = await database.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return row ? decode(row) : undefined;
  };

  return {
    create(input) {
      return database.transaction(async (transaction) => {
        const id = input.id ?? crypto.randomUUID();
        const createdAt = input.createdAt ?? new Date().toISOString();
        const [row] = await transaction
          .insert(tasks)
          .values({
            id,
            conversationId: input.conversationId,
            requestedByRunId: input.requestedByRunId,
            objective: input.objective,
            instructions: input.instructions,
            workerProfile: input.workerProfile,
            status: "queued",
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        if (!row) throw new Error(`task "${id}" was not inserted`);
        await transaction.insert(taskUpdates).values({
          id: crypto.randomUUID(),
          taskId: id,
          status: "queued",
          occurredAt: createdAt,
        });
        return decode(row);
      });
    },

    get,

    async listForConversation(conversationId, limit = 50) {
      const rows = await database
        .select()
        .from(tasks)
        .where(eq(tasks.conversationId, conversationId))
        .orderBy(desc(tasks.updatedAt), asc(tasks.id))
        .limit(limit);
      return rows.map(decode);
    },

    claimNext({ workerId, now = new Date().toISOString(), leaseUntil }) {
      return database.transaction(async (transaction) => {
        const [expired] = await transaction
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.status, "running"), lte(tasks.leaseUntil, now)))
          .orderBy(asc(tasks.leaseUntil), asc(tasks.id))
          .limit(1);
        if (expired) {
          const [recovered] = await transaction
            .update(tasks)
            .set({
              status: "queued",
              leaseOwner: null,
              leaseUntil: null,
              resultSummary: null,
              startedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.id, expired.id),
                eq(tasks.status, "running"),
                lte(tasks.leaseUntil, now),
              ),
            )
            .returning({ id: tasks.id });
          if (recovered) {
            await transaction.insert(taskUpdates).values({
              id: crypto.randomUUID(),
              taskId: recovered.id,
              status: "queued",
              summary: "worker lease expired",
              occurredAt: now,
            });
          }
        }

        const [candidate] = await transaction
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.status, "queued"))
          .orderBy(asc(tasks.createdAt), asc(tasks.id))
          .limit(1);
        if (!candidate) return undefined;

        const [claimed] = await transaction
          .update(tasks)
          .set({
            status: "running",
            leaseOwner: workerId,
            leaseUntil,
            startedAt: now,
            updatedAt: now,
          })
          .where(and(eq(tasks.id, candidate.id), eq(tasks.status, "queued")))
          .returning();
        if (!claimed) return undefined;

        await transaction.insert(taskUpdates).values({
          id: crypto.randomUUID(),
          taskId: claimed.id,
          status: "running",
          occurredAt: now,
        });
        return decode(claimed);
      });
    },

    transition(id, update) {
      return database.transaction(async (transaction) => {
        const [currentRow] = await transaction
          .select()
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        if (!currentRow) throw new Error(`task "${id}" not found`);
        const current = decode(currentRow);
        if (!allowedTransitions[current.status].includes(update.to)) {
          throw new Error(`invalid task transition: ${current.status} -> ${update.to}`);
        }

        const at = update.at ?? new Date().toISOString();
        const leaseOwner = "leaseOwner" in update ? update.leaseOwner : undefined;
        if (
          current.status === "running" &&
          (update.to === "succeeded" || update.to === "failed") &&
          (current.leaseOwner !== leaseOwner || !current.leaseUntil || current.leaseUntil <= at)
        ) {
          throw new Error(`task "${id}" does not have an active lease for "${leaseOwner}"`);
        }

        const retrying = current.status === "failed" && update.to === "queued";
        const terminal =
          update.to === "succeeded" || update.to === "failed" || update.to === "cancelled";
        const conditions = [eq(tasks.id, id), eq(tasks.status, current.status)];
        if (leaseOwner) conditions.push(eq(tasks.leaseOwner, leaseOwner));

        const [row] = await transaction
          .update(tasks)
          .set({
            status: update.to,
            resultSummary: retrying ? null : update.resultSummary,
            updatedAt: at,
            startedAt: retrying ? null : current.startedAt,
            completedAt: terminal ? at : retrying ? null : current.completedAt,
            leaseOwner: null,
            leaseUntil: null,
          })
          .where(and(...conditions))
          .returning();
        if (!row) throw new Error(`task "${id}" changed during transition`);

        await transaction.insert(taskUpdates).values({
          id: crypto.randomUUID(),
          taskId: id,
          status: update.to,
          summary: update.resultSummary,
          occurredAt: at,
        });
        return decode(row);
      });
    },
  };
}
