import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  defaultModelMetadata,
  modelRoleSchema,
  type ModelConfig,
  type ModelRole,
  type ModelsDocument,
  type ProviderDefinition,
} from "./contract";

/**
 * One role's ready-to-use model binding.
 *
 * Consumed by role agent adapters. The mutable Pi model collection, provider
 * construction, credential values, and endpoint details stay private to the
 * model runtime; the runner exposes only the resolved immutable model, the
 * role's generation settings, and the durable snapshot.
 */
export interface ModelRunner {
  /** The provider/model/settings snapshot retained on Agent Run rows. */
  readonly snapshot: ModelConfig;
  /** The resolved immutable Pi model for agent construction. */
  readonly model: Model<Api>;
  /** The role's live thinking level for agent construction. */
  readonly thinkingLevel: ModelConfig["thinking"];
  stream(context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface ModelRuntime {
  /** The roles this deployment configured, resolved and validated. */
  readonly roles: readonly ModelRole[];
  forRole(role: ModelRole): ModelRunner;
}

function resolveCredential(
  providerId: string,
  definition: ProviderDefinition,
  environment: NodeJS.ProcessEnv,
): { readonly apiKey?: string; readonly source: string } {
  // Pi's OpenAI-compatible adapter refuses an absent key even when the
  // endpoint needs none; "unused" is pi-ai's own placeholder convention.
  if (definition.credential === "none") return { apiKey: "unused", source: "none" };
  for (const name of definition.credential.env) {
    const value = environment[name];
    if (value) return { apiKey: value, source: name };
  }
  throw new Error(
    `model provider "${providerId}" requires one of ${definition.credential.env.join(", ")} in the environment`,
  );
}

function providerModel(
  providerId: string,
  definition: ProviderDefinition,
  modelId: string,
): Model<"openai-completions"> {
  const metadata = definition.models[modelId] ?? defaultModelMetadata;
  const compat = {
    ...(metadata.supportsDeveloperRole === undefined
      ? {}
      : { supportsDeveloperRole: metadata.supportsDeveloperRole }),
    ...(metadata.supportsReasoningEffort === undefined
      ? {}
      : { supportsReasoningEffort: metadata.supportsReasoningEffort }),
  };
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: providerId,
    baseUrl: definition.baseUrl,
    reasoning: metadata.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
    // An always-present compat object would disable Pi's baseUrl
    // auto-detection, so it is attached only when the document sets a flag.
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
  };
}

/**
 * Resolve every configured role once, failing closed on unknown providers and
 * missing credentials. Secret values are read from the environment here and
 * nowhere else in application code.
 */
export function createModelRuntime(
  document: ModelsDocument,
  environment: NodeJS.ProcessEnv = process.env,
): ModelRuntime {
  const models = createModels();
  const runners = new Map<ModelRole, ModelRunner>();

  for (const role of modelRoleSchema.options) {
    const profile = document.roles[role];
    if (!profile) continue;
    const definition = document.providers[profile.provider];
    if (!definition) {
      throw new Error(`model role "${role}" references unknown provider "${profile.provider}"`);
    }

    if (!models.getProvider(profile.provider)) {
      // The stream-time key is the startup-validated one by construction; Pi's
      // envApiKeyAuth would re-resolve its own ambient environment at request
      // time and could diverge from what this fail-closed check validated.
      const credential = resolveCredential(profile.provider, definition, environment);
      const referencedModels = [
        ...new Set(
          Object.values(document.roles)
            .filter((candidate) => candidate.provider === profile.provider)
            .map((candidate) => candidate.model),
        ),
      ];
      models.setProvider(
        createProvider({
          id: profile.provider,
          name: profile.provider,
          baseUrl: definition.baseUrl,
          auth: {
            apiKey: {
              name: `${profile.provider} API key`,
              resolve: async () => ({
                auth: credential.apiKey === undefined ? {} : { apiKey: credential.apiKey },
                source: credential.source,
              }),
            },
          },
          models: referencedModels.map((modelId) =>
            providerModel(profile.provider, definition, modelId),
          ),
          api: openAICompletionsApi(),
        }),
      );
    }

    const model = models.getModel(profile.provider, profile.model);
    if (!model) {
      throw new Error(
        `model role "${role}" resolved no model "${profile.provider}/${profile.model}"`,
      );
    }
    runners.set(role, {
      snapshot: profile,
      model,
      thinkingLevel: profile.thinking,
      stream: (context, options) =>
        models.streamSimple(model, context, {
          ...options,
          maxTokens: profile.maxOutputTokens,
        }),
    });
  }

  return {
    roles: [...runners.keys()],
    forRole(role) {
      const runner = runners.get(role);
      if (!runner) throw new Error(`model role "${role}" is not configured`);
      return runner;
    },
  };
}
