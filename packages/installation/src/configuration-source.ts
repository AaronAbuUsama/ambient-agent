import { existsSync } from "node:fs";

import { readManagedConfig, readManagedSecretFile } from "./configuration.ts";
import {
  createManagedConfigStore,
  MANAGED_SECRET_KINDS,
  type ManagedConfigStore,
  type ManagedSecret,
  type ManagedSecretKind,
} from "./managed-config-store.ts";
import type { ManagedPaths } from "./paths.ts";
import type { GitHubAppCredential, ManagedConfig } from "./schema.ts";

/**
 * **The single resolution seam** (#366). Every production reader of managed configuration and of
 * every managed secret goes through one of these; nothing outside this module resolves a credential
 * file path any more. `#367` (first-boot migration, delete the files), `#368` (drop the libSQL
 * tenant-credential backend) and `#376` (per-role provider selection) all build on this interface.
 *
 * ## What it is
 *
 * A {@link ManagedConfigStore} opened over {@link ManagedPaths.managedConfigDatabase}, **seeded from
 * the files** at open. The files stay authoritative — this is the *migrate* half of
 * expand → migrate → contract, so a seeded store behaves exactly like reading the files did, and
 * #367 is what flips authority.
 *
 * ## What a failure looks like
 *
 * Seeding records, per kind, whatever the FILE reader threw — `ENOENT`, "not a supported private
 * JSON file", "malformed" — and {@link ManagedConfigurationSource.secret} **rethrows that exact
 * error**. So a missing or malformed value still fails boot as loudly and with the same `code` and
 * wording as before the swap, and a caller that discriminates on `ENOENT` (the control plane minting
 * a first-boot token) still can. A file failure also **deletes that kind's row**, so a credential
 * whose file has gone missing or bad stops resolving everywhere — through `secret`, through
 * {@link ManagedConfigurationSource.store} directly, and in `storedSecretKinds`. Nothing a previous
 * boot managed to seed can paper over the file, which is what keeps the file authoritative (EMC).
 *
 * A file failure never throws at open: an installation that does not use a secret (no `e2b.json` on a
 * `local` sandbox, no `model-api-key.json` on a subscription install) must still boot, exactly as
 * today — the failure surfaces at the read, in the caller that actually needs the value. A failure of
 * the *store* is the opposite and throws at open, because "the database is unavailable" must never be
 * reported to an operator as "your credential is missing or malformed; paste a fresh one".
 *
 * ## SEC-WO
 *
 * Reads hand back validated values; nothing here formats a secret into a message. The store's own
 * `parseSecret`/`parseSecretRow` (#365) and the file decoder both refuse with hand-written text.
 */
export interface ManagedConfigurationSource {
  readonly paths: ManagedPaths;
  /** The re-validated live configuration. Throws whatever reading `config.json` threw at open. */
  config(): ManagedConfig;
  /** Re-read `config.json`, refresh the store from it, and return the re-validated snapshot (SIGHUP). */
  refreshConfig(): Promise<ManagedConfig>;
  /** This kind's value, or a throw identical to the one its file reader produced at open. */
  secret<TKind extends ManagedSecretKind>(kind: TKind): ManagedSecret<TKind>;
  /** Names only, never values — the tier-4 readback, and what #381 renders "set / not set" from. */
  storedSecretKinds(): readonly ManagedSecretKind[];
  /** The underlying store, for the write-through paths that must also keep the store truthful. */
  readonly store: ManagedConfigStore;
  close(): void;
}

/**
 * Which file seeds which kind. The kinds themselves are {@link MANAGED_SECRET_KINDS} (#365) — this
 * is only the path each one is seeded from, and #367 is where it stops being read.
 */
export const managedSecretPaths = (paths: ManagedPaths): Readonly<Record<ManagedSecretKind, string>> => ({
  "github-app:coder": paths.githubAppCredentials.coder,
  "github-app:reviewer": paths.githubAppCredentials.reviewer,
  "github-app:planner": paths.githubAppCredentials.planner,
  "chatgpt-oauth": paths.chatGptOAuthCredential,
  "model-api-key": paths.modelApiKeyCredential,
  e2b: paths.e2bCredential,
  braintrust: paths.braintrustCredential,
  "control-plane": paths.controlPlaneCredential,
});

/**
 * Open the seam and seed it from the files.
 *
 * An installation that does not exist yet gets an in-memory store: creating
 * `~/.ambient-agent/managed-config.sqlite` would materialise the data directory, which
 * `inspectManagedData` would then classify `incomplete` and `ambient-agent init` would refuse to
 * install into — the same trap the control plane's token minting already avoids. Behaviour is
 * otherwise identical: no files, so every read throws `ENOENT` exactly as it did.
 */
export const openManagedConfigurationSource = async (
  paths: ManagedPaths,
  options: {
    /**
     * Keep the store in memory. First-run setup is the caller: it prepares a *staging* directory
     * that is promoted into place, and a database left there would be promoted with it. There is
     * no installation to resolve through yet, so an ephemeral store reads through to the files —
     * exactly the pre-#366 behaviour — while the writes still go through the one seam.
     */
    readonly ephemeral?: boolean;
  } = {},
): Promise<ManagedConfigurationSource> => {
  const persistent = options.ephemeral !== true && existsSync(paths.root);
  const store = createManagedConfigStore(persistent ? paths.managedConfigDatabase : ":memory:");
  const secretPaths = managedSecretPaths(paths);
  const failures = new Map<ManagedSecretKind, unknown>();
  let configFailure: unknown;

  try {
    store.replace(await readManagedConfig(paths.config));
  } catch (cause) {
    configFailure = cause;
  }

  for (const kind of MANAGED_SECRET_KINDS) {
    let secret: ManagedSecret<ManagedSecretKind>;
    try {
      secret = await readManagedSecretFile(secretPaths[kind], kind);
    } catch (cause) {
      // Only a FILE failure is deferred to the reader. The row from a previous boot goes with it:
      // the file is authoritative (EMC), so a credential whose file has been deleted or corrupted
      // must stop resolving everywhere — including through `store` directly, which the ChatGPT
      // credential store reads, and through `storedSecretKinds()`, which the tier-4 readback and
      // #381's "set / not set" render from.
      failures.set(kind, cause);
      store.deleteSecret(kind);
      continue;
    }
    // Deliberately OUTSIDE the catch. The value is already validated against the very schema
    // `writeSecret` re-checks, so the only thing left to fail here is the database — and recording a
    // `SQLITE_BUSY` as this kind's failure would tell the operator to paste a fresh credential to fix
    // a credential that is perfectly fine. An infrastructure failure is loud, at open, and once.
    store.writeSecret(kind, secret);
  }

  return {
    paths,
    store,
    config: () => {
      if (configFailure !== undefined) throw configFailure;
      return store.current();
    },
    // A failed reload throws, but leaves the last good configuration in place — the runtime keeps
    // serving it, exactly as it did before this seam (`reloadAuthorizationOnSignal` logs and carries
    // on). Only a failed *initial* seed poisons `config()`, because there is nothing good to serve.
    refreshConfig: async () => {
      const next = await readManagedConfig(paths.config);
      store.replace(next);
      configFailure = undefined;
      return store.current();
    },
    // `has`, not `!== undefined`: a recorded failure must win even if what was thrown was itself
    // `undefined`, so the precedence is structural rather than incidental.
    secret: (kind) => {
      if (failures.has(kind)) throw failures.get(kind);
      const stored = store.readSecret(kind);
      // The seed leaves every kind either stored or recorded as failed, so this is only reachable
      // when another process deleted the row after this source was opened.
      if (stored === undefined) {
        throw new Error(`No ${kind} secret is stored; ${secretPaths[kind]} was not readable at start.`);
      }
      return stored;
    },
    storedSecretKinds: () => store.storedSecretKinds(),
    close: () => store.close(),
  };
};

/**
 * Open the seam, hand it to `use`, and close it however that ends. Every caller that only needs a
 * value and is done — the CLI's one-shot commands — should use this rather than `open`/`close`,
 * because the interesting paths here all throw, and a `close()` written as a plain statement after
 * the read is skipped by exactly the failure that matters. The handle is on a database the running
 * runtime holds open, so leaking one is lock contention, not just an fd.
 */
export const withManagedConfigurationSource = async <T>(
  paths: ManagedPaths,
  use: (source: ManagedConfigurationSource) => T | Promise<T>,
): Promise<T> => {
  const source = await openManagedConfigurationSource(paths);
  try {
    return await use(source);
  } finally {
    source.close();
  }
};

/**
 * Read a Specialist's (Coder/Reviewer) GitHub App credential through the seam, or throw a clear,
 * actionable error (#247, #251, moved here by #366). A missing or mispasted App credential must fail
 * the runtime loudly at start rather than silently mounting a dead capability — the
 * configured-but-inert failure the one-box plan bans for the Speaker, and which used to boot green
 * with a dead Coder.
 */
export const readProvisionedGitHubAppCredential = (
  source: ManagedConfigurationSource,
  role: "coder" | "reviewer",
): GitHubAppCredential => {
  try {
    return source.secret(`github-app:${role}`);
  } catch (cause) {
    throw new Error(
      `The ${role} GitHub App credential at ${source.paths.githubAppCredentials[role]} is missing or malformed; the ${role} cannot start. Run ambient-agent config --github-app ${role} and paste a fresh triple.`,
      { cause },
    );
  }
};
