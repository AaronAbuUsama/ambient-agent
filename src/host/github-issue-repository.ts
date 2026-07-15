import { Octokit } from "@octokit/rest";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Issue,
  IssueRepository,
  OperationIdentity,
  RepositoryRef,
} from "../capabilities/issue-management/issue-repository.ts";

const operationMarker = ({ id }: OperationIdentity): string => `<!-- ambience-operation:${id} -->`;
const GITHUB_SEARCH_QUERY_LIMIT = 256;
export const githubIssueSearchQuery = (repository: RepositoryRef, query: string): string => {
  const qualifiers = ` in:title,body repo:${repository.owner}/${repository.repo} is:issue`;
  const phraseBudget = GITHUB_SEARCH_QUERY_LIMIT - qualifiers.length - 2;
  if (phraseBudget < 1) throw new Error("The authorized repository leaves no room for a GitHub search phrase.");

  let phrase = "";
  for (const character of query.trim()) {
    const escaped = character === "\\" || character === '"' ? `\\${character}` : character;
    if (phrase.length + escaped.length > phraseBudget) break;
    phrase += escaped;
  }
  return `"${phrase}"${qualifiers}`;
};

const issueRecord = (
  repository: RepositoryRef,
  data: { number: number; html_url: string; title: string; body?: string | null; state: string },
): Issue => ({
  repository,
  number: data.number,
  url: data.html_url,
  title: data.title,
  body: data.body ?? "",
  state: data.state === "closed" ? "closed" : "open",
});

export const createOctokitIssueRepository = (token: string): IssueRepository => {
  const octokit = new Octokit({ auth: token, userAgent: "ambient-agent-issue-management" });
  return {
    search: async ({ repository, query, signal }) => {
      const repositoryUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}`.toLowerCase();
      const response = await octokit.rest.search.issuesAndPullRequests({
        q: githubIssueSearchQuery(repository, query),
        per_page: 10,
        request: { signal },
      });
      return response.data.items
        .filter((item) => item.pull_request === undefined && item.repository_url.toLowerCase() === repositoryUrl)
        .map((item) => issueRecord(repository, item));
    },
    get: async ({ repository, number, signal }) => {
      const response = await octokit.rest.issues.get({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        request: { signal },
      });
      return issueRecord(repository, response.data);
    },
    create: async ({ repository, title, body, operation, signal }) => {
      const response = await octokit.rest.issues.create({
        owner: repository.owner,
        repo: repository.repo,
        title,
        body: `${body}\n\n${operationMarker(operation)}`,
        request: { signal },
      });
      return issueRecord(repository, response.data);
    },
    findCreated: async ({ repository, operation, signal }) => {
      const marker = operationMarker(operation);
      for (const waitMillis of [0, 100, 250, 500, 1_000, 2_000]) {
        if (waitMillis > 0) await delay(waitMillis, undefined, { signal });
        const response = await octokit.rest.issues.listForRepo({
          owner: repository.owner,
          repo: repository.repo,
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: 100,
          request: { signal },
        });
        const matches = response.data
          .filter((item) => item.pull_request === undefined && (item.body ?? "").includes(marker))
          .map((item) => issueRecord(repository, item));
        if (matches.length > 0) return matches;
      }
      return [];
    },
  };
};
