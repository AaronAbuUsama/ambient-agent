import { installPreparedManagedData, type InstallManagedDataResult } from "../../installation/src/installation.ts";
import type { ManagedPathEnvironment, ManagedPaths } from "../../installation/src/paths.ts";
import { GITHUB_APP_REFERENCES, type GitHubAppTriples } from "../../installation/src/schema.ts";

/** Fixture App triples — the real GitHub Apps do not exist yet, so setup/migration ride fakes. */
export const fakeGitHubAppTriples = (seed = 100): GitHubAppTriples =>
  Object.fromEntries(
    GITHUB_APP_REFERENCES.map((reference, index) => [
      reference,
      {
        appId: String(seed + index),
        installationId: String(seed + 1000 + index),
        privateKey: `-----BEGIN RSA PRIVATE KEY-----\nfake-${reference}-key-${seed}\n-----END RSA PRIVATE KEY-----\n`,
      },
    ]),
  ) as GitHubAppTriples;

export interface InstallManagedDataInput extends ManagedPathEnvironment {
  readonly managedChats: readonly string[];
  readonly defaultRepository: string;
  readonly githubApps?: GitHubAppTriples;
  readonly authenticateChatGpt: (paths: ManagedPaths) => Promise<void>;
}

export const installManagedData = async (input: InstallManagedDataInput): Promise<InstallManagedDataResult> =>
  await installPreparedManagedData({
    ...input,
    prepare: async (paths) => {
      await input.authenticateChatGpt(paths);
      return {
        managedChats: input.managedChats,
        defaultRepository: input.defaultRepository,
        githubApps: input.githubApps ?? fakeGitHubAppTriples(),
      };
    },
  });
