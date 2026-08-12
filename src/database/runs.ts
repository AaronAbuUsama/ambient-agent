import { eq } from "drizzle-orm";
import { z } from "zod";
import { modelConfigSchema, type ModelConfig } from "../models/contract";
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
  /** Conversation runs are created only by the conversation work store's claim. */
  readonly role: Exclude<AgentRun["role"], "conversation">;
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

/**
 * Run creation for non-conversation roles and retained-evidence reads.
 *
 * Conversation run and tool-evidence transitions are owned exclusively by the
 * conversation work store.
 */
export interface RunRepository {
  start(input: NewAgentRun): Promise<AgentRun>;
  get(id: string): Promise<AgentRun | undefined>;
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

    async get(id) {
      const [row] = await database.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
      return row ? decodeRun(row) : undefined;
    },

    async getToolCall(id) {
      const [row] = await database.select().from(toolCalls).where(eq(toolCalls.id, id)).limit(1);
      return row ? decodeToolCall(row) : undefined;
    },
  };
}
