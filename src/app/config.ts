function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  readonly whatsapp: {
    readonly accountId: string;
    readonly dataDirectory: string;
    readonly historyPrefetchLimit: number;
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
      historyPrefetchLimit: positiveInteger(environment.WHATSAPP_BACKFILL_LIMIT, 20_000),
    },
    logging: {
      level: environment.WA_LOG_LEVEL ?? "warn",
    },
  };
}
