import { z } from "zod";

const thinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);

/** The durable provider/model/settings snapshot stamped on every Agent Run. */
export const modelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: thinkingLevelSchema,
  maxOutputTokens: z.number().int().positive(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const modelRoleSchema = z.enum(["conversation", "worker", "memory", "evaluator"]);

export type ModelRole = z.infer<typeof modelRoleSchema>;

const modelMetadataSchema = z.object({
  contextWindow: z.number().int().positive().default(131_072),
  maxTokens: z.number().int().positive().default(32_768),
  reasoning: z.boolean().default(false),
  /**
   * Whether the model can actually look at an image. Declared, not guessed:
   * the harness silently swaps images for a placeholder when a model cannot
   * take them, so an undeclared model must be treated as blind rather than
   * allowed to appear to work.
   */
  vision: z.boolean().default(false),
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
});

export type ModelMetadata = z.infer<typeof modelMetadataSchema>;

/** Capability assumptions for models the document does not describe. */
export const defaultModelMetadata: ModelMetadata = modelMetadataSchema.parse({});

const providerDefinitionSchema = z.object({
  adapter: z.literal("openai-compatible"),
  baseUrl: z.url(),
  /** Secret reference: environment variable names tried in order, or "none". */
  credential: z.union([z.literal("none"), z.object({ env: z.array(z.string().min(1)).min(1) })]),
  /** Optional per-model metadata; unlisted models use the defaults. */
  models: z.record(z.string().min(1), modelMetadataSchema).default({}),
});

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

/** A role profile is the durable snapshot shape with configuration defaults. */
const roleProfileSchema = modelConfigSchema.extend({
  thinking: thinkingLevelSchema.default("off"),
  maxOutputTokens: z.number().int().positive().default(4096),
});

/**
 * The validated models section of the structured configuration document.
 * Provider definitions describe endpoints and secret references; role
 * profiles select a provider, model, and generation settings.
 */
export const modelsDocumentSchema = z.object({
  providers: z.record(z.string().min(1), providerDefinitionSchema),
  roles: z.partialRecord(modelRoleSchema, roleProfileSchema),
});

export type ModelsDocument = z.infer<typeof modelsDocumentSchema>;
