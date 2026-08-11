import { join, resolve } from "node:path";
import { modelConfigSchema, type AgentModelConfig, type ModelConfig } from "../agent-models";

function historyBackfillLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed % 25 !== 0) {
    throw new Error("WHATSAPP_BACKFILL_LIMIT must be a positive multiple of 25");
  }
  return parsed;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function modelConfig(
  environment: NodeJS.ProcessEnv,
  role: "CONVERSATION" | "WORKER" | "MEMORY" | "EVALUATOR",
): ModelConfig {
  return modelConfigSchema.parse({
    provider: environment[`${role}_MODEL_PROVIDER`] ?? environment.MODEL_PROVIDER ?? "qwen",
    model: environment[`${role}_MODEL`] ?? environment.AMBIENT_MODEL ?? "qwen3.6-flash",
    thinking: environment[`${role}_MODEL_THINKING`] ?? environment.MODEL_THINKING ?? "off",
    maxOutputTokens: positiveInteger(
      `${role}_MODEL_MAX_OUTPUT_TOKENS`,
      environment[`${role}_MODEL_MAX_OUTPUT_TOKENS`] ?? environment.MODEL_MAX_OUTPUT_TOKENS,
      4096,
    ),
  });
}

export interface AppConfig {
  readonly database: {
    readonly url: string;
  };
  readonly models: AgentModelConfig;
  readonly whatsapp: {
    readonly accountId: string;
    readonly dataDirectory: string;
    /**
     * Optional safety limit for loading retained messages into memory.
     *
     * Undefined means backfill the entire local WhatsApp mirror.
     */
    readonly historyBackfillLimit?: number;
  };
  readonly logging: {
    readonly level: string;
  };
}

/** Read process configuration once at the application boundary. */
export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDirectory = environment.WHATSAPP_DATA_DIR ?? "./data";
  return {
    database: {
      url: environment.AMBIENT_DATABASE_URL ?? `file:${join(resolve(dataDirectory), "ambient.db")}`,
    },
    models: {
      conversation: modelConfig(environment, "CONVERSATION"),
      worker: modelConfig(environment, "WORKER"),
      memory: modelConfig(environment, "MEMORY"),
      evaluator: environment.EVALUATOR_MODEL ? modelConfig(environment, "EVALUATOR") : undefined,
    },
    whatsapp: {
      accountId: environment.WHATSAPP_ACCOUNT_ID ?? "main",
      dataDirectory,
      historyBackfillLimit: historyBackfillLimit(environment.WHATSAPP_BACKFILL_LIMIT),
    },
    logging: {
      level: environment.WA_LOG_LEVEL ?? "warn",
    },
  };
}
