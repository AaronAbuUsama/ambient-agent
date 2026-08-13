import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ambientHome } from "../home/init";
import { modelsDocumentSchema, type ModelsDocument } from "../models/contract";

const configurationDocumentSchema = z
  .object({
    account: z.string().min(1).default("main"),
    // The admin seat the Root occupies at Root v1. Recorded and validated
    // now; consumed by doctor and the Root slice.
    master: z.object({ chatId: z.string().min(1) }).optional(),
    providers: modelsDocumentSchema.shape.providers,
    roles: modelsDocumentSchema.shape.roles,
    database: z.object({ url: z.string().min(1).optional() }).prefault({}),
    whatsapp: z
      .object({
        dataDirectory: z.string().min(1).optional(),
        historyBackfillLimit: z.number().int().positive().multipleOf(25).optional(),
      })
      .prefault({}),
    conversation: z
      .object({
        enabled: z.boolean().default(false),
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
  })
  .refine(
    (document) =>
      document.conversation.scheduling.maximumWaitMs >= document.conversation.scheduling.debounceMs,
    { message: "conversation.scheduling.maximumWaitMs must be at least debounceMs" },
  );

type ConfigurationDocument = z.infer<typeof configurationDocumentSchema>;

/** The document shape with every deployment override and default resolved. */
export type AppConfig = {
  /** The Ambient home this deployment runs from; chat mandates live under it. */
  readonly home: string;
  readonly database: { readonly url: string };
  readonly whatsapp: {
    readonly accountId: string;
    readonly dataDirectory: string;
    readonly historyBackfillLimit?: number | undefined;
  };
  readonly conversation: ConfigurationDocument["conversation"];
  readonly logging: { readonly level: string };
  readonly models: ModelsDocument;
  readonly master?: { readonly chatId: string } | undefined;
};

/**
 * Read and validate the structured configuration document once at the process
 * boundary. The document lives in the Ambient home (`~/.ambient/config.yaml`;
 * AMBIENT_HOME moves the home, AMBIENT_CONFIG points at an explicit document —
 * the proof rig pins the repository's JSON document this way). YAML is a
 * superset of JSON, so one parser covers both. Environment variables are
 * limited to secrets, the paths above, and the deployment overrides applied
 * below. Secret values never live in the document.
 */
export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const home = ambientHome(environment);
  const path = environment.AMBIENT_CONFIG ?? join(home, "config.yaml");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read configuration file "${path}"`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`configuration file "${path}" is not valid YAML`, { cause: error });
  }
  const document = configurationDocumentSchema.parse(parsed);

  const dataDirectory =
    environment.WHATSAPP_DATA_DIR ?? document.whatsapp.dataDirectory ?? join(home, "state");
  return {
    home,
    database: {
      url:
        environment.AMBIENT_DATABASE_URL ??
        document.database.url ??
        `file:${join(resolve(dataDirectory), "ambient.db")}`,
    },
    whatsapp: {
      accountId: document.account,
      dataDirectory,
      historyBackfillLimit: document.whatsapp.historyBackfillLimit,
    },
    conversation: document.conversation,
    logging: { level: environment.WA_LOG_LEVEL ?? document.logging.level },
    models: { providers: document.providers, roles: document.roles },
    master: document.master,
  };
}
