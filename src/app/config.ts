import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ConversationSchedulingConfig } from "../conversation/contract";
import { modelsDocumentSchema, type ModelsDocument } from "../models/contract";

const configurationDocumentSchema = z
  .object({
    database: z.object({ url: z.string().min(1).optional() }).prefault({}),
    whatsapp: z
      .object({
        accountId: z.string().min(1).default("main"),
        dataDirectory: z.string().min(1).default("./data"),
        historyBackfillLimit: z.number().int().positive().multipleOf(25).optional(),
      })
      .prefault({}),
    conversation: z
      .object({
        enabled: z.boolean().default(false),
        outboundMode: z.enum(["loopback", "conversation"]).default("loopback"),
        instructions: z
          .string()
          .min(1)
          .default("Respond naturally and helpfully when a response is useful."),
        scheduling: z
          .object({
            debounceMs: z.number().int().positive().default(750),
            maximumWaitMs: z.number().int().positive().default(5_000),
            leaseMs: z.number().int().positive().default(120_000),
            maximumItemsPerRun: z.number().int().positive().default(50),
          })
          .prefault({}),
      })
      .prefault({}),
    logging: z.object({ level: z.string().min(1).default("warn") }).prefault({}),
    models: modelsDocumentSchema,
  })
  .refine(
    (document) =>
      document.conversation.scheduling.maximumWaitMs >= document.conversation.scheduling.debounceMs,
    { message: "conversation.scheduling.maximumWaitMs must be at least debounceMs" },
  );

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

/**
 * Read and validate the structured configuration document once at the process
 * boundary (default `./ambient.config.json`, path via AMBIENT_CONFIG; the
 * repository ships the deployment document at the default path). Environment
 * variables are limited to secrets, the document path, and the deployment
 * overrides applied below. Secret values never live in the document.
 */
export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
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
  const document = configurationDocumentSchema.parse(parsed);

  const dataDirectory = environment.WHATSAPP_DATA_DIR ?? document.whatsapp.dataDirectory;
  return {
    database: {
      url:
        environment.AMBIENT_DATABASE_URL ??
        document.database.url ??
        `file:${join(resolve(dataDirectory), "ambient.db")}`,
    },
    models: document.models,
    conversation: document.conversation,
    whatsapp: {
      accountId: document.whatsapp.accountId,
      dataDirectory,
      ...(document.whatsapp.historyBackfillLimit === undefined
        ? {}
        : { historyBackfillLimit: document.whatsapp.historyBackfillLimit }),
    },
    logging: {
      level: environment.WA_LOG_LEVEL ?? document.logging.level,
    },
  };
}
