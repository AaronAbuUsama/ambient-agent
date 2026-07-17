import type { IssueRepository, RepositoryRef } from "./issue-repository.ts";
import type { IssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";

const parseRepository = (value: string): RepositoryRef =>
  parseGitHubRepository(value, (invalid) => new Error(`GitHub repository must be owner/repo, got ${invalid}`));

export const repositoryName = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

export interface IssueManagementPolicy {
  authorize(requested?: string): RepositoryRef;
}

export const createIssueManagementPolicy = (
  defaultRepository: string,
  allowedRepositories: readonly string[],
): IssueManagementPolicy => {
  parseRepository(defaultRepository);
  const configured = allowedRepositories.length === 0 ? [defaultRepository] : allowedRepositories;
  const allowed = new Set(configured.map((repository) => repositoryName(parseRepository(repository)).toLowerCase()));
  return {
    authorize: (requested = defaultRepository) => {
      const repository = parseRepository(requested);
      const key = repositoryName(repository).toLowerCase();
      if (!allowed.has(key)) {
        throw new Error(`Refusing ${key}: not in the configured GitHub write allowlist (${[...allowed].join(", ")})`);
      }
      return repository;
    },
  };
};

export interface IssueManagementRuntime {
  readonly repository: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly policy: IssueManagementPolicy;
}

const runtimeSlot = createFlueGlobal<IssueManagementRuntime>(
  "issue-management-runtime",
  "Issue Management runtime is not configured",
);

export const configureIssueManagementRuntime = (runtime: IssueManagementRuntime): void => runtimeSlot.set(runtime);
export const getIssueManagementRuntime = (): IssueManagementRuntime => runtimeSlot.get();
