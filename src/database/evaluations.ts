import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AmbientDatabaseConnection } from "./database";
import { evaluationAnnotations, evaluationResults, evaluationRuns } from "./schema";

const evaluationRoleSchema = z.enum(["conversation", "worker", "memory", "journey"]);
const evaluationStatusSchema = z.enum(["running", "succeeded", "failed"]);
const jsonValueSchema = z.json();

export interface EvaluationRun {
  readonly id: string;
  readonly role: z.infer<typeof evaluationRoleSchema>;
  readonly subjectRunId?: string;
  readonly evaluatorRunId?: string;
  readonly caseId: string;
  readonly status: z.infer<typeof evaluationStatusSchema>;
  readonly configuration: z.infer<typeof jsonValueSchema>;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface EvaluationRepository {
  start(input: {
    readonly id?: string;
    readonly role: EvaluationRun["role"];
    readonly subjectRunId?: string;
    readonly evaluatorRunId?: string;
    readonly caseId: string;
    readonly configuration: EvaluationRun["configuration"];
    readonly startedAt?: string;
  }): Promise<EvaluationRun>;
  get(id: string): Promise<EvaluationRun | undefined>;
  finish(
    id: string,
    result:
      | { readonly status: "succeeded" }
      | { readonly status: "failed"; readonly error: string },
    completedAt?: string,
  ): Promise<EvaluationRun>;
  recordResult(input: {
    readonly id?: string;
    readonly evaluationRunId: string;
    readonly metric: string;
    readonly score?: number;
    readonly passed?: boolean;
    readonly detail: z.infer<typeof jsonValueSchema>;
  }): Promise<void>;
  annotate(input: {
    readonly id?: string;
    readonly evaluationRunId: string;
    readonly label: string;
    readonly value: string;
    readonly createdAt?: string;
  }): Promise<void>;
}

function decode(row: typeof evaluationRuns.$inferSelect): EvaluationRun {
  return {
    id: row.id,
    role: evaluationRoleSchema.parse(row.role),
    subjectRunId: row.subjectRunId ?? undefined,
    evaluatorRunId: row.evaluatorRunId ?? undefined,
    caseId: row.caseId,
    status: evaluationStatusSchema.parse(row.status),
    configuration: jsonValueSchema.parse(row.configuration),
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    error: row.error ?? undefined,
  };
}

export function createEvaluationRepository(
  database: AmbientDatabaseConnection,
): EvaluationRepository {
  const get = async (id: string): Promise<EvaluationRun | undefined> => {
    const [row] = await database
      .select()
      .from(evaluationRuns)
      .where(eq(evaluationRuns.id, id))
      .limit(1);
    return row ? decode(row) : undefined;
  };

  const requireRun = async (id: string): Promise<EvaluationRun> => {
    const run = await get(id);
    if (!run) throw new Error(`evaluation run "${id}" not found`);
    return run;
  };

  return {
    async start(input) {
      const id = input.id ?? crypto.randomUUID();
      const startedAt = input.startedAt ?? new Date().toISOString();
      const [row] = await database
        .insert(evaluationRuns)
        .values({
          id,
          role: input.role,
          subjectRunId: input.subjectRunId,
          evaluatorRunId: input.evaluatorRunId,
          caseId: input.caseId,
          status: "running",
          configuration: input.configuration,
          startedAt,
        })
        .returning();
      if (!row) throw new Error(`evaluation run "${id}" was not inserted`);
      return decode(row);
    },

    get,

    async finish(id, update, completedAt = new Date().toISOString()) {
      const [row] = await database
        .update(evaluationRuns)
        .set({
          status: update.status,
          error: update.status === "failed" ? update.error : null,
          completedAt,
        })
        .where(and(eq(evaluationRuns.id, id), eq(evaluationRuns.status, "running")))
        .returning();
      if (row) return decode(row);

      const run = await requireRun(id);
      throw new Error(`evaluation run "${id}" cannot finish from status "${run.status}"`);
    },

    async recordResult(input) {
      await database.insert(evaluationResults).values({
        id: input.id ?? crypto.randomUUID(),
        evaluationRunId: input.evaluationRunId,
        metric: input.metric,
        score: input.score,
        passed: input.passed,
        detail: input.detail,
      });
    },

    async annotate(input) {
      await database.insert(evaluationAnnotations).values({
        id: input.id ?? crypto.randomUUID(),
        evaluationRunId: input.evaluationRunId,
        label: input.label,
        value: input.value,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
    },
  };
}
