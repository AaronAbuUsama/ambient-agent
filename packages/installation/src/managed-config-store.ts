import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

import { atomicWriteManagedConfig } from "./configuration.ts";
import { ManagedConfigSchema, type ManagedConfig } from "./schema.ts";

/**
 * The single-row, DB-backed managed-configuration store (#179). It lives in `application.sqlite`
 * alongside every other application table and holds the full validated {@link ManagedConfig} as the
 * live source the runtime reloads its AUTHORIZATION KNOBS from (managedChats, allowedRepositories,
 * reviewRepositories) without a restart. `config.json` on disk stays the durable source of truth —
 * the store is re-seeded from it at every boot; a live authorization change writes both.
 *
 * Every read re-parses through {@link ManagedConfigSchema}, so a hand-edited or partially-written row
 * is refused loudly rather than reloaded silently — the same fail-closed posture as boot config.
 */
export interface ManagedConfigStore {
  /** The current live configuration, re-validated against {@link ManagedConfigSchema}. Throws if unset or malformed. */
  current(): ManagedConfig;
  /** Overwrite the single row with a validated configuration (boot re-seed, or a committed live change). */
  replace(config: ManagedConfig): void;
  close(): void;
}

interface ConfigRow {
  config_json: string;
}

export const createManagedConfigStore = (databasePath: string): ManagedConfigStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_configuration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  const selectRow = database.prepare("SELECT config_json FROM managed_configuration WHERE id = 1");
  const upsertRow = database.prepare(`
    INSERT INTO managed_configuration (id, config_json, updated_at) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `);
  return {
    current: () => {
      const row = selectRow.get() as ConfigRow | undefined;
      if (row === undefined) throw new Error("The managed configuration store has no configuration row.");
      return v.parse(ManagedConfigSchema, JSON.parse(row.config_json));
    },
    replace: (config) => {
      const validated = v.parse(ManagedConfigSchema, config);
      upsertRow.run(JSON.stringify(validated), new Date().toISOString());
    },
    close: () => database.close(),
  };
};

/** The subset of authorization knobs a live reload may change (#179); every other field is restart-only. */
export interface ManagedAuthorizationKnobs {
  readonly managedChats?: readonly string[];
  readonly allowedRepositories?: readonly string[];
  readonly reviewRepositories?: readonly string[];
}

/**
 * Commit a live authorization change (#179): merge the requested knobs over the current configuration,
 * re-validate the WHOLE thing through {@link ManagedConfigSchema} (so every cross-field invariant —
 * defaultRepository ∈ allowedRepositories, reviewRepositories ⊆ allowedRepositories, etc. — still
 * holds), then persist to `config.json` (durable across restarts) and the DB store (the live reload
 * source). Pure file + DB I/O — it never opens a WhatsApp client, so it is safe to run against a live
 * box, unlike the interactive `ambient-agent config` command. The runtime still has to be told to
 * reload afterwards (e.g. SIGHUP); this only writes the new authoritative values.
 */
export const writeManagedAuthorization = async (
  configPath: string,
  store: ManagedConfigStore,
  knobs: ManagedAuthorizationKnobs,
  write: (path: string, value: unknown) => Promise<void> = atomicWriteManagedConfig,
): Promise<ManagedConfig> => {
  const current = store.current();
  const next = {
    ...current,
    ...(knobs.managedChats === undefined ? {} : { managedChats: [...knobs.managedChats] }),
    github: {
      ...current.github,
      ...(knobs.allowedRepositories === undefined ? {} : { allowedRepositories: [...knobs.allowedRepositories] }),
      ...(knobs.reviewRepositories === undefined ? {} : { reviewRepositories: [...knobs.reviewRepositories] }),
    },
  };
  const validated = v.parse(ManagedConfigSchema, next);
  await write(configPath, validated);
  store.replace(validated);
  return validated;
};
