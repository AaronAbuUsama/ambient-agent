import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { GitHubAppCredential } from "./schema.ts";

type OctokitRequestOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>["request"];

/**
 * Build an Octokit that authenticates as a GitHub App installation. `@octokit/auth-app`'s
 * `createAppAuth` mints and auto-refreshes the 1-hour installation access token in memory,
 * so every Specialist reuses one credential file → its own visible `<slug>[bot]` identity.
 *
 * Issue management never learns about App auth: it receives the Octokit this returns
 * (ADR 0012's "adapter added without changing the Issue Management interface").
 */
export const githubAppClient = (
  credential: Pick<GitHubAppCredential, "appId" | "installationId" | "privateKey">,
  request?: OctokitRequestOptions,
): Octokit =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(credential.appId),
      installationId: Number(credential.installationId),
      privateKey: credential.privateKey,
    },
    userAgent: "ambient-agent-issue-management",
    request,
  });
