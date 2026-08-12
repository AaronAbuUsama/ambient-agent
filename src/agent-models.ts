import { z } from "zod";

const thinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);

export const modelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: thinkingLevelSchema,
  maxOutputTokens: z.number().int().positive(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export interface AgentModelConfig {
  readonly conversation: ModelConfig;
  readonly worker: ModelConfig;
  readonly memory: ModelConfig;
  readonly evaluator?: ModelConfig;
}
