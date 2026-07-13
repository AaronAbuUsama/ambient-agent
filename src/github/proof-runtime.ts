import * as v from "valibot";

import { repositoryRefSchema, type RepositoryRef } from "./proof-contract.js";
import type { GitHubProofHost } from "../host/github-proof-host.js";

const parseRepository = (value: string): RepositoryRef => {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`GitHub repository must be owner/repo, got ${value}`);
  }
  return v.parse(repositoryRefSchema, { owner: parts[0], repo: parts[1] });
};

export interface GitHubProofSettings {
  readonly token: string;
  readonly defaultRepository: string;
  readonly allowedRepositories: readonly string[];
}

/**
 * Load the established GitHub deployment boundary without involving model
 * credentials. Flue supplies these values from the project environment file
 * in production; the Pi subscription connector remains the sole model-auth
 * path.
 */
export const loadGitHubProofSettings = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHubProofSettings => {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GITHUB_TOKEN is required for the bounded GitHub workflow");

  const defaultRepository = env.GITHUB_REPO?.trim();
  if (!defaultRepository) throw new Error("GITHUB_REPO is required for the bounded GitHub workflow");
  parseRepository(defaultRepository);

  const allowedRepositories = (env.GITHUB_ALLOWED_REPOS ?? "")
    .split(",")
    .map((repository) => repository.trim())
    .filter(Boolean);
  for (const repository of allowedRepositories) parseRepository(repository);

  return { token, defaultRepository, allowedRepositories };
};

export interface GitHubProofPolicy {
  authorize(requested?: string): RepositoryRef;
}

export const createGitHubProofPolicy = (
  defaultRepository: string,
  allowedRepositories: readonly string[],
): GitHubProofPolicy => {
  const defaultRef = parseRepository(defaultRepository);
  const configured = allowedRepositories.length > 0 ? allowedRepositories : [defaultRepository];
  const allowed = new Set(configured.map((repository) => repository.trim().toLowerCase()));

  return {
    authorize: (requested = defaultRepository) => {
      const repository = parseRepository(requested);
      const key = `${repository.owner}/${repository.repo}`.toLowerCase();
      if (!allowed.has(key)) {
        throw new Error(`Refusing ${key}: not in the configured GitHub write allowlist (${[...allowed].join(", ")})`);
      }
      return repository;
    },
  };
};

interface GitHubProofRuntime {
  readonly host: GitHubProofHost;
  readonly policy: GitHubProofPolicy;
}

let configured: GitHubProofRuntime | undefined;

export const configureGitHubProofRuntime = (runtime: GitHubProofRuntime): void => {
  configured = runtime;
};

export const getGitHubProofRuntime = (): GitHubProofRuntime => {
  if (!configured) throw new Error("GitHub proof runtime is not configured");
  return configured;
};
