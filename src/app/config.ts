function historyBackfillLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed % 25 !== 0) {
    throw new Error("WHATSAPP_BACKFILL_LIMIT must be a positive multiple of 25");
  }
  return parsed;
}

export interface AppConfig {
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
  return {
    whatsapp: {
      accountId: environment.WHATSAPP_ACCOUNT_ID ?? "main",
      dataDirectory: environment.WHATSAPP_DATA_DIR ?? "./data",
      historyBackfillLimit: historyBackfillLimit(environment.WHATSAPP_BACKFILL_LIMIT),
    },
    logging: {
      level: environment.WA_LOG_LEVEL ?? "warn",
    },
  };
}
