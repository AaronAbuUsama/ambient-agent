import { and, eq, notExists } from "drizzle-orm";
import { z } from "zod";
import { modelConfigSchema, type ModelConfig } from "../agent-models";
import type { AmbientDatabaseConnection } from "./database";
import { agentRuns, toolCalls } from "./schema";

const agentRoleSchema = z.enum(["conversation", "worker", "memory", "evaluator"]);
const runStatusSchema = z.enum(["running", "succeeded", "failed"]);
const toolOutcomeSchema = z.enum(["running", "succeeded", "failed"]);
const jsonValueSchema = z.json();

export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  readonly role: z.infer<typeof agentRoleSchema>;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly status: z.infer<typeof runStatusSchema>;
  readonly model: ModelConfig;
  readonly promptVersion: string;
  readonly input: z.infer<typeof jsonValueSchema>;
  readonly result?: z.infer<typeof jsonValueSchema>;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewAgentRun {
  readonly id?: string;
  readonly agentId: string;
  readonly role: AgentRun["role"];
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly model: ModelConfig;
  readonly promptVersion: string;
  readonly input: AgentRun["input"];
  readonly startedAt?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: z.infer<typeof jsonValueSchema>;
  readonly outcome: z.infer<typeof toolOutcomeSchema>;
  readonly output?: z.infer<typeof jsonValueSchema>;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface RunRepository {
  start(input: NewAgentRun): Promise<AgentRun>;
  get(id: string): Promise<AgentRun | undefined>;
  succeed(id: string, result: AgentRun["input"], completedAt?: string): Promise<AgentRun>;
  fail(id: string, error: string, completedAt?: string): Promise<AgentRun>;
  startToolCall(input: {
    readonly id?: string;
    readonly runId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly input: ToolCall["input"];
    readonly startedAt?: string;
  }): Promise<ToolCall>;
  completeToolCall(
    id: string,
    result:
      | { readonly outcome: "succeeded"; readonly output: ToolCall["input"] }
      | { readonly outcome: "failed"; readonly error: string },
    completedAt?: string,
  ): Promise<ToolCall>;
  getToolCall(id: string): Promise<ToolCall | undefined>;
}

function decodeRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    agentId: row.agentId,
    role: agentRoleSchema.parse(row.role),
    conversationId: row.conversationId ?? undefined,
    taskId: row.taskId ?? undefined,
    status: runStatusSchema.parse(row.status),
    model: modelConfigSchema.parse({
      provider: row.provider,
      model: row.model,
      thinking: row.thinking,
      maxOutputTokens: row.maxOutputTokens,
    }),
    promptVersion: row.promptVersion,
    input: jsonValueSchema.parse(row.input),
    result: row.result === null ? undefined : jsonValueSchema.parse(row.result),
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function decodeToolCall(row: typeof toolCalls.$inferSelect): ToolCall {
  return {
    id: row.id,
    runId: row.runId,
    callId: row.callId,
    toolName: row.toolName,
    input: jsonValueSchema.parse(row.input),
    outcome: toolOutcomeSchema.parse(row.outcome),
    output: row.output === null ? undefined : jsonValueSchema.parse(row.output),
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

export function createRunRepository(database: AmbientDatabaseConnection): RunRepository {
  const get = async (id: string): Promise<AgentRun | undefined> => {
    const [row] = await database.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    return row ? decodeRun(row) : undefined;
  };

  const requireRun = async (id: string): Promise<AgentRun> => {
    const run = await get(id);
    if (!run) throw new Error(`agent run "${id}" not found`);
    return run;
  };

  const finish = async (
    id: string,
    update:
      | { readonly status: "succeeded"; readonly result: AgentRun["input"] }
      | { readonly status: "failed"; readonly error: string },
    completedAt = new Date().toISOString(),
  ): Promise<AgentRun> => {
    const [row] = await database
      .update(agentRuns)
      .set({
        status: update.status,
        result: update.status === "succeeded" ? update.result : null,
        error: update.status === "failed" ? update.error : null,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.status, "running"),
          notExists(
            database
              .select({ id: toolCalls.id })
              .from(toolCalls)
              .where(and(eq(toolCalls.runId, id), eq(toolCalls.outcome, "running"))),
          ),
        ),
      )
      .returning();
    if (row) return decodeRun(row);

    const run = await requireRun(id);
    if (run.status === "running") {
      throw new Error(`agent run "${id}" cannot finish with active tool calls`);
    }
    throw new Error(`agent run "${id}" cannot finish from status "${run.status}"`);
  };

  const getToolCall = async (id: string): Promise<ToolCall | undefined> => {
    const [row] = await database.select().from(toolCalls).where(eq(toolCalls.id, id)).limit(1);
    return row ? decodeToolCall(row) : undefined;
  };

  const requireToolCall = async (id: string): Promise<ToolCall> => {
    const call = await getToolCall(id);
    if (!call) throw new Error(`tool call "${id}" not found`);
    return call;
  };

  return {
    async start(input) {
      const model = modelConfigSchema.parse(input.model);
      const id = input.id ?? crypto.randomUUID();
      const startedAt = input.startedAt ?? new Date().toISOString();
      const [row] = await database
        .insert(agentRuns)
        .values({
          id,
          agentId: input.agentId,
          role: input.role,
          conversationId: input.conversationId,
          taskId: input.taskId,
          status: "running",
          provider: model.provider,
          model: model.model,
          thinking: model.thinking,
          maxOutputTokens: model.maxOutputTokens,
          promptVersion: input.promptVersion,
          input: input.input,
          startedAt,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .returning();
      if (!row) throw new Error(`agent run "${id}" was not inserted`);
      return decodeRun(row);
    },

    get,

    succeed(id, result, completedAt) {
      return finish(id, { status: "succeeded", result }, completedAt);
    },

    fail(id, error, completedAt) {
      return finish(id, { status: "failed", error }, completedAt);
    },

    startToolCall(input) {
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

        const id = input.id ?? crypto.randomUUID();
        const startedAt = input.startedAt ?? new Date().toISOString();
        const [row] = await transaction
          .insert(toolCalls)
          .values({
            id,
            runId: input.runId,
            callId: input.callId,
            toolName: input.toolName,
            input: input.input,
            outcome: "running",
            startedAt,
          })
          .returning();
        if (!row) throw new Error(`tool call "${id}" was not inserted`);
        return decodeToolCall(row);
      });
    },

    async completeToolCall(id, update, completedAt = new Date().toISOString()) {
      const [row] = await database
        .update(toolCalls)
        .set({
          outcome: update.outcome,
          output: update.outcome === "succeeded" ? update.output : null,
          error: update.outcome === "failed" ? update.error : null,
          completedAt,
        })
        .where(and(eq(toolCalls.id, id), eq(toolCalls.outcome, "running")))
        .returning();
      if (row) return decodeToolCall(row);

      const call = await requireToolCall(id);
      throw new Error(`tool call "${id}" cannot finish from outcome "${call.outcome}"`);
    },

    getToolCall,
  };
}
