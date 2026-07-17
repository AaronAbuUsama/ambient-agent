import type { ChatGptOAuthAdapter } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
} from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import { migrateManagedChatGptCredentialReference } from "./configuration.ts";
import type { ManagedPaths } from "./paths.ts";

export const createManagedChatGptAuthentication = (paths: ManagedPaths, oauth?: ChatGptOAuthAdapter) =>
  createChatGptAuthentication({
    store: createManagedChatGptCredentialStore({
      path: paths.chatGptOAuthCredential,
      managedRoot: paths.root,
      legacyPath: paths.legacyPiAuthCredential,
      onLegacyMigration: async () => await migrateManagedChatGptCredentialReference(paths.config),
    }),
    oauth,
  });
