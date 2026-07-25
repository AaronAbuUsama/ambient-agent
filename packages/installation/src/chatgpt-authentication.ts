import type { ChatGptCredentialStore, ChatGptOAuthAdapter } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
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
 * the engine's file store with its 0600 checks, its `pi-auth.json` legacy migration and its
 * per-path write serialisation, untouched. Mirroring afterwards is what keeps the store's answer
 * honest: a token refresh, a fresh login, and `auth --forget` each leave the store agreeing with
 * the file, so a second process reading the same store never serves a revoked or expired token.
 *
 * `read` falls back to the file when the store holds nothing — the state right after a fresh
 * install writes the file behind an already-open source — and seeds the store on the way past.
 */
const storeBackedChatGptCredentialStore = (
  file: ChatGptCredentialStore,
  store: ManagedConfigStore,
): ChatGptCredentialStore => {
  const mirror = (credential: unknown): void => {
    store.writeSecret("chatgpt-oauth", validateChatGptOAuthCredential(credential));
  };
  return {
    read: async (providerId, signal) => {
      const stored = store.readSecret("chatgpt-oauth");
      if (stored !== undefined) return validateChatGptOAuthCredential(stored);
      const fromFile = await file.read(providerId, signal);
      if (fromFile !== undefined) mirror(fromFile);
      return fromFile;
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
    delete: async (providerId, signal) => {
      await file.delete(providerId, signal);
      store.deleteSecret("chatgpt-oauth");
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
          )
        : createLibsqlChatGptCredentialStore(tenantDatabase),
    ...(oauth === undefined ? {} : { oauth }),
  });
};
