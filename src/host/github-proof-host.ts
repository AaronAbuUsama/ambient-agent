import { Octokit } from "@octokit/rest";

import type { RepositoryRef } from "../github/proof-contract.js";

export interface GitHubIssueRecord {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
}

export interface CreateGitHubIssueInput {
  readonly repository: RepositoryRef;
  readonly operationId: string;
  readonly title: string;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface GitHubProofHost {
  createIssue(input: CreateGitHubIssueInput): Promise<GitHubIssueRecord>;
  getIssue(repository: RepositoryRef, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssueRecord>;
  findIssuesByMarker(
    repository: RepositoryRef,
    operationId: string,
    marker: string,
    signal?: AbortSignal,
  ): Promise<readonly GitHubIssueRecord[]>;
  closeIssue(repository: RepositoryRef, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssueRecord>;
}

export class GitHubMutationOutcomeUncertainError extends Error {
  override readonly name = "GitHubMutationOutcomeUncertainError";
}

export const isUncertainGitHubMutationError = (error: unknown): boolean => {
  const uncertainCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_ABORTED",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof GitHubMutationOutcomeUncertainError) return true;
    if (candidate instanceof Error && (candidate.name === "AbortError" || candidate.name === "TimeoutError")) {
      return true;
    }
    const code = Reflect.get(candidate, "code");
    if (typeof code === "string" && uncertainCodes.has(code)) return true;
    pending.push(Reflect.get(candidate, "cause"));
  }
  return false;
};

const issueRecord = (data: {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
}): GitHubIssueRecord => ({
  number: data.number,
  url: data.html_url,
  title: data.title,
  body: data.body ?? "",
  state: data.state === "closed" ? "closed" : "open",
});

export const createOctokitGitHubProofHost = (token: string): GitHubProofHost => {
  const octokit = new Octokit({ auth: token, userAgent: "whatsappd-github-agent-ambience-proof" });

  return {
    createIssue: async ({ repository, title, body, signal }) => {
      const response = await octokit.rest.issues.create({
        owner: repository.owner,
        repo: repository.repo,
        title,
        body,
        request: { signal },
      });
      return issueRecord(response.data);
    },
    getIssue: async (repository, issueNumber, signal) => {
      const response = await octokit.rest.issues.get({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: issueNumber,
        request: { signal },
      });
      return issueRecord(response.data);
    },
    findIssuesByMarker: async (repository, _operationId, marker, signal) => {
      const response = await octokit.rest.issues.listForRepo({
        owner: repository.owner,
        repo: repository.repo,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 100,
        request: { signal },
      });
      return response.data
        .filter((issue) => !("pull_request" in issue) && (issue.body ?? "").includes(`<!-- ${marker} -->`))
        .map(issueRecord);
    },
    closeIssue: async (repository, issueNumber, signal) => {
      const response = await octokit.rest.issues.update({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: issueNumber,
        state: "closed",
        state_reason: "completed",
        request: { signal },
      });
      return issueRecord(response.data);
    },
  };
};
