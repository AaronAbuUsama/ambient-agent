import { dirname } from "node:path";

import type { ChatGptCredentialStore, ChatGptOAuthAdapter } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
  assertManagedCredentialDirectory,
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
  validateChatGptOAuthCredential,
} from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import { migrateManagedChatGptCredentialReference } from "./configuration.ts";
import type { ManagedConfigurationSource } from "./configuration-source.ts";
import type { ManagedConfigStore } from "./managed-config-store.ts";
import {
  createLibsqlChatGptCredentialStore,
  tenantCredentialDatabaseFromEnvironment,
  type TenantCredentialEnvironment,
} from "./tenant-credentials.ts";

/**
 * Resolve the ChatGPT credential through the seam (#366): **reads** come from the managed secret
 * store, **writes** go to the file first and are then mirrored into the store.
 *
 * The file stays authoritative (EMC — #367 is what flips that), so every mutating path still runs
 * the engine's file store with its 0600 checks, its `pi-auth.json` legacy migration and its per-path
 * write serialisation, untouched. Mirroring afterwards keeps the store's answer honest, so a second
 * process reading the same store never serves an expired token. The store row is only ever as good
 * as the file: `openManagedConfigurationSource` deletes the row when the file cannot be read, so a
 * deleted or corrupted `chatgpt-oauth.json` is reported `missing`/`malformed`, never `ready`.
 *
 * `read` falls back to the file when the store holds nothing — right after a fresh install writes the
 * file behind an already-open source, and on a legacy install whose credential is still in
 * `pi-auth.json` (the file store's `read` is what migrates it) — and seeds the store on the way past.
 *
 * The mirror is a cache write, so it must never fail the operation it is caching: a login that has
 * already fsynced the file has *succeeded*, whatever the database then says.
 */
export const storeBackedChatGptCredentialStore = (
  file: ChatGptCredentialStore,
  store: ManagedConfigStore,
  managedRoot: string | undefined,
  credentialDirectory: string,
): ChatGptCredentialStore => {
  const mirror = (credential: unknown): void => {
    try {
      store.writeSecret("chatgpt-oauth", validateChatGptOAuthCredential(credential));
    } catch (cause) {
      // Forget rather than keep a row we could not refresh: `read` then falls through to the file,
      // so the worst case is a re-seed on the next read, never a stale or revoked token.
      try {
        store.deleteSecret("chatgpt-oauth");
      } catch {
        // Nothing further to do — the file is authoritative and already committed.
      }
      console.warn("[chatgpt] the managed credential store could not be refreshed; reading from the file.", cause);
    }
  };
  return {
    read: async (providerId, signal) => {
      const stored = store.readSecret("chatgpt-oauth");
      if (stored === undefined) {
        const fromFile = await file.read(providerId, signal);
        if (fromFile !== undefined) mirror(fromFile);
        return fromFile;
      }
      // The file read this replaces asserted the credentials directory had not been swapped for a
      // symlink or moved outside the managed root. Serving the store copy must not silently drop
      // that check — it is the credential-substitution guard, not a property of where we read from.
      if (managedRoot !== undefined) await assertManagedCredentialDirectory(credentialDirectory, managedRoot);
      return validateChatGptOAuthCredential(stored);
    },
    modify: async (providerId, change, signal) => {
      const next = await file.modify(providerId, change, signal);
      if (next !== undefined) mirror(next);
      return next;
    },
    replace: async (providerId, credential, signal) => {
      await file.replace(providerId, credential, signal);
      mirror(credential);
    },
    // Forget FIRST. This is the revocation path: if removing the file throws part-way, a store that
    // still held the credential would keep serving what the owner just tried to revoke.
    delete: async (providerId, signal) => {
      store.deleteSecret("chatgpt-oauth");
      await file.delete(providerId, signal);
    },
  };
};

export const createManagedChatGptAuthentication = (
  source: ManagedConfigurationSource,
  oauth?: ChatGptOAuthAdapter,
  environment: TenantCredentialEnvironment = process.env,
) => {
  const { paths } = source;
  const tenantDatabase = tenantCredentialDatabaseFromEnvironment(environment);
  return createChatGptAuthentication({
    // The libSQL tenant backend is its own credential authority and has no managed files to seed
    // from, so it is left alone here; #368 deletes it outright.
    store:
      tenantDatabase === undefined
        ? storeBackedChatGptCredentialStore(
            createManagedChatGptCredentialStore({
              path: paths.chatGptOAuthCredential,
              managedRoot: paths.root,
              legacyPath: paths.legacyPiAuthCredential,
              onLegacyMigration: async () => await migrateManagedChatGptCredentialReference(paths.config),
            }),
            source.store,
            paths.root,
            dirname(paths.chatGptOAuthCredential),
          )
        : createLibsqlChatGptCredentialStore(tenantDatabase),
    ...(oauth === undefined ? {} : { oauth }),
  });
};
