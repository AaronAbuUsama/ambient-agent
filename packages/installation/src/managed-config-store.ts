import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

import {
  BraintrustCredentialSchema,
  ChatGptOAuthCredentialSchema,
  ControlPlaneCredentialSchema,
  E2BCredentialSchema,
  GitHubAppCredentialSchema,
  ManagedConfigSchema,
  ModelApiKeyCredentialSchema,
  type ManagedConfig,
} from "./schema.ts";

/**
 * Every secret the runtime reads today, one entry per credential file (#365). The value is the
 * SAME schema the file reader validates against, so a secret in the store is refused for exactly
 * the reasons the file would be refused — no second, looser definition of "valid".
 *
 * This is the expand half of expand → migrate → contract: the store can hold these, the files stay
 * authoritative, and no reader has moved (#366 moves readers, #367 migrates and deletes the files).
 * The keys are the durable secret-kind names; #366 and #381 quote this table rather than re-listing.
 */
export const MANAGED_SECRET_SCHEMAS = {
  // credentials/github-{coder,reviewer,planner}.json — one App identity each (#135).
  "github-app:coder": GitHubAppCredentialSchema,
  "github-app:reviewer": GitHubAppCredentialSchema,
  "github-app:planner": GitHubAppCredentialSchema,
  "chatgpt-oauth": ChatGptOAuthCredentialSchema, // credentials/chatgpt-oauth.json
  "model-api-key": ModelApiKeyCredentialSchema, // credentials/model-api-key.json (#250)
  e2b: E2BCredentialSchema, // credentials/e2b.json (#252)
  braintrust: BraintrustCredentialSchema, // credentials/braintrust.json (#252)
  "control-plane": ControlPlaneCredentialSchema, // credentials/control-plane.json (#364)
} as const;

export type ManagedSecretKind = keyof typeof MANAGED_SECRET_SCHEMAS;

export const MANAGED_SECRET_KINDS = Object.keys(MANAGED_SECRET_SCHEMAS) as readonly ManagedSecretKind[];

/** The validated value of one secret kind — the file reader's output type, per kind. */
export type ManagedSecret<TKind extends ManagedSecretKind> = v.InferOutput<(typeof MANAGED_SECRET_SCHEMAS)[TKind]>;

export const isManagedSecretKind = (kind: string): kind is ManagedSecretKind =>
  Object.hasOwn(MANAGED_SECRET_SCHEMAS, kind);

/**
 * Validate without ever putting the value in the failure. `v.parse` throws a `ValiError` whose
 * message and issues carry the received input, which for a secret would leak it into any log line
 * that formats the error (SEC-WO). Every secret path goes through here instead.
 */
const parseSecret = <TKind extends ManagedSecretKind>(kind: TKind, value: unknown): ManagedSecret<TKind> => {
  const result = v.safeParse(MANAGED_SECRET_SCHEMAS[kind], value);
  if (!result.success) throw new Error(`The ${kind} secret is malformed.`);
  return result.output as ManagedSecret<TKind>;
};

/**
 * `JSON.parse` is the other value-carrying thrower: V8's `SyntaxError` quotes a window of the source
 * it choked on, so a row corrupted anywhere near the secret bytes would put them in the message. The
 * same refusal as a schema failure, and for the same reason.
 */
const parseSecretRow = <TKind extends ManagedSecretKind>(kind: TKind, json: string): ManagedSecret<TKind> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Error(`The ${kind} secret is malformed.`);
  }
  return parseSecret(kind, decoded);
};

/**
 * The single-row, DB-backed managed-configuration store (#179). It holds the full validated
 * {@link ManagedConfig} as the re-validated live snapshot the runtime reloads its AUTHORIZATION KNOBS
 * from (managedChats, allowedRepositories, reviewRepositories) without a restart. `config.json` on disk
 * stays the durable source of truth — the real `ambient-agent config` command commits there; the store
 * is re-seeded from it at boot and refreshed from it on every reload.
 *
 * Every read re-parses through {@link ManagedConfigSchema}, so a hand-edited or partially-written row
 * is refused loudly rather than reloaded silently — the same fail-closed posture as boot config.
 */
export interface ManagedConfigStore {
  /** The current live configuration, re-validated against {@link ManagedConfigSchema}. Throws if unset or malformed. */
  current(): ManagedConfig;
  /** Overwrite the single row with a validated configuration (boot re-seed, or a committed live change). */
  replace(config: ManagedConfig): void;
  /**
   * The stored secret of this kind, re-validated against the same schema its file reader uses.
   * `undefined` means never written; a stored row that no longer validates throws rather than
   * being handed back. Neither the value nor any part of it appears in the failure.
   */
  readSecret<TKind extends ManagedSecretKind>(kind: TKind): ManagedSecret<TKind> | undefined;
  /**
   * Validate, then replace this kind's row. The value is validated before the transaction opens, so a
   * refused secret never reaches the file; the write itself is one upsert in one transaction, so a
   * half-written secret is never observable — including when a later kind's write fails mid-rotation.
   */
  writeSecret<TKind extends ManagedSecretKind>(kind: TKind, secret: ManagedSecret<TKind>): void;
  /**
   * Which kinds have a stored value — names only, never values. The one read a write-only surface
   * (SEC-WO) can make: #381 renders "set / not set" from this without the secret leaving the box.
   */
  storedSecretKinds(): readonly ManagedSecretKind[];
  /**
   * Forget this kind's row. Idempotent. A store-backed reader that never forgets would keep serving
   * a credential the owner has revoked (`ambient-agent auth --forget` deletes the file), so the
   * seam's delete path needs this to stay truthful (#366).
   */
  deleteSecret(kind: ManagedSecretKind): void;
  close(): void;
}

interface ConfigRow {
  config_json: string;
}

interface SecretRow {
  secret_json: string;
}

export const createManagedConfigStore = (databasePath: string): ManagedConfigStore => {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
    // Owner-only, the same mode every credential file carries — this file now holds secrets, and the
    // live rig's store was found at 0644 before #365. Created at 0600 rather than chmod'd afterwards,
    // so a fresh database is never briefly world-readable; the chmod then also tightens a database an
    // earlier, config-only build left behind.
    closeSync(openSync(databasePath, "a", 0o600));
    chmodSync(databasePath, 0o600);
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_configuration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  // The secrets half (#365). Same file as the configuration — this is the managed configuration
  // store expanded, not a second store — and still deliberately NOT the migration-governed
  // application database, whose schema rejects unknown tables.
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_secret (
      kind TEXT PRIMARY KEY,
      secret_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  const selectRow = database.prepare("SELECT config_json FROM managed_configuration WHERE id = 1");
  const selectSecret = database.prepare("SELECT secret_json FROM managed_secret WHERE kind = ?");
  const selectSecretKinds = database.prepare("SELECT kind FROM managed_secret ORDER BY kind");
  const deleteSecretRow = database.prepare("DELETE FROM managed_secret WHERE kind = ?");
  const upsertSecret = database.prepare(`
    INSERT INTO managed_secret (kind, secret_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (kind) DO UPDATE SET secret_json = excluded.secret_json, updated_at = excluded.updated_at
  `);
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
    readSecret: (kind) => {
      if (!isManagedSecretKind(kind)) throw new Error(`There is no managed secret kind ${String(kind)}.`);
      const row = selectSecret.get(kind) as SecretRow | undefined;
      if (row === undefined) return undefined;
      return parseSecretRow(kind, row.secret_json);
    },
    writeSecret: (kind, secret) => {
      if (!isManagedSecretKind(kind)) throw new Error(`There is no managed secret kind ${String(kind)}.`);
      // Validated before the transaction opens, so a refused secret never reaches the file at all.
      const serialized = JSON.stringify(parseSecret(kind, secret));
      database.exec("BEGIN IMMEDIATE");
      try {
        upsertSecret.run(kind, serialized, new Date().toISOString());
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    deleteSecret: (kind) => {
      if (!isManagedSecretKind(kind)) throw new Error(`There is no managed secret kind ${String(kind)}.`);
      deleteSecretRow.run(kind);
    },
    // `writeSecret` cannot create a row of an unknown kind, so the filter only ever drops a row left
    // by a kind that has since been renamed — which #367 must migrate rather than orphan.
    storedSecretKinds: () =>
      (selectSecretKinds.all() as { kind: string }[])
        .map((row) => row.kind)
        .filter(isManagedSecretKind),
    close: () => database.close(),
  };
};
