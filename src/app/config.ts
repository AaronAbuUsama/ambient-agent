import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ConversationSchedulingConfig } from "../conversation/contract";
import { modelsDocumentSchema, type ModelsDocument } from "../models/contract";

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

function boolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

const configurationDocumentSchema = z.object({
  models: modelsDocumentSchema,
});

/**
 * Load the structured configuration document (default `./ambient.config.json`,
 * path via AMBIENT_CONFIG). The document is required and validated once; the
 * repository ships the deployment catalogue at the default path. Secret values
 * never live here.
 */
function loadModelsDocument(environment: NodeJS.ProcessEnv): ModelsDocument {
  const path = environment.AMBIENT_CONFIG ?? "./ambient.config.json";
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read configuration file "${path}"`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`configuration file "${path}" is not valid JSON`, { cause: error });
  }
  return configurationDocumentSchema.parse(parsed).models;
}

export interface AppConfig {
  readonly database: {
    readonly url: string;
  };
  readonly models: ModelsDocument;
  readonly conversation: {
    readonly enabled: boolean;
    readonly outboundMode: "loopback" | "conversation";
    readonly instructions: string;
    readonly scheduling: ConversationSchedulingConfig;
  };
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
  const debounceMs = positiveInteger(
    "CONVERSATION_DEBOUNCE_MS",
    environment.CONVERSATION_DEBOUNCE_MS,
    750,
  );
  const maximumWaitMs = positiveInteger(
    "CONVERSATION_MAXIMUM_WAIT_MS",
    environment.CONVERSATION_MAXIMUM_WAIT_MS,
    5_000,
  );
  if (maximumWaitMs < debounceMs) {
    throw new Error("CONVERSATION_MAXIMUM_WAIT_MS must be at least CONVERSATION_DEBOUNCE_MS");
  }
  const outboundMode = environment.CONVERSATION_OUTBOUND_MODE ?? "loopback";
  if (outboundMode !== "loopback" && outboundMode !== "conversation") {
    throw new Error('CONVERSATION_OUTBOUND_MODE must be "loopback" or "conversation"');
  }

  return {
    database: {
      url: environment.AMBIENT_DATABASE_URL ?? `file:${join(resolve(dataDirectory), "ambient.db")}`,
    },
    models: loadModelsDocument(environment),
    conversation: {
      enabled: boolean("CONVERSATION_ENABLED", environment.CONVERSATION_ENABLED, false),
      outboundMode,
      instructions:
        environment.CONVERSATION_INSTRUCTIONS ??
        "Respond naturally and helpfully when a response is useful.",
      scheduling: {
        debounceMs,
        maximumWaitMs,
        leaseMs: positiveInteger(
          "CONVERSATION_LEASE_MS",
          environment.CONVERSATION_LEASE_MS,
          120_000,
        ),
        maximumItemsPerRun: positiveInteger(
          "CONVERSATION_MAXIMUM_ITEMS_PER_RUN",
          environment.CONVERSATION_MAXIMUM_ITEMS_PER_RUN,
          50,
        ),
      },
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
