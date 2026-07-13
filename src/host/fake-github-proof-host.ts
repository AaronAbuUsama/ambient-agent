import {
  GitHubMutationOutcomeUncertainError,
  type CreateGitHubIssueInput,
  type GitHubIssueRecord,
  type GitHubProofHost,
} from "./github-proof-host.js";
import type { RepositoryRef } from "../github/proof-contract.js";

export type FakeGitHubProofEvent =
  | { kind: "create"; repository: string; operationId: string; outcome: "created"; number: number }
  | { kind: "create"; repository: string; operationId: string; outcome: "unknown" }
  | { kind: "create"; repository: string; operationId: string; outcome: "failed"; error: string }
  | { kind: "get"; repository: string; number: number; state: "open" | "closed" }
  | { kind: "find"; repository: string; operationId: string; matches: number[] }
  | { kind: "close"; repository: string; number: number; outcome: "closed" }
  | { kind: "close"; repository: string; number: number; outcome: "unknown" }
  | { kind: "close"; repository: string; number: number; outcome: "failed"; error: string };

type MutationMode =
  | { kind: "success" }
  | { kind: "timeout"; afterMutation: boolean }
  | { kind: "failure"; error: Error };

const repositoryKey = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

export interface FakeGitHubProofHost extends GitHubProofHost {
  events(): readonly FakeGitHubProofEvent[];
  reset(): void;
  timeoutNextCreate(options: { afterMutation: boolean }): void;
  timeoutNextClose(options: { afterMutation: boolean }): void;
  failNextCreate(error: Error): void;
}

export interface GitHubProofGate {
  wait(operationId: string): Promise<void>;
}

export interface ControllableGitHubProofGate extends GitHubProofGate {
  pending(): Promise<readonly string[]>;
  release(operationId: string): void;
}

export const createControllableGitHubProofGate = (): ControllableGitHubProofGate => {
  const waiters = new Map<string, () => void>();
  return {
    wait: (operationId) =>
      new Promise<void>((resolve, reject) => {
        if (waiters.has(operationId)) {
          reject(new Error(`GitHub proof operation is already waiting: ${operationId}`));
          return;
        }
        waiters.set(operationId, resolve);
      }),
    pending: async () => [...waiters.keys()],
    release: (operationId) => {
      const resolve = waiters.get(operationId);
      if (!resolve) throw new Error(`No GitHub proof operation is waiting: ${operationId}`);
      waiters.delete(operationId);
      resolve();
    },
  };
};

const immediateGate: GitHubProofGate = { wait: async () => undefined };

export const createFakeGitHubProofHost = (
  options: { gate?: GitHubProofGate } = {},
): FakeGitHubProofHost => {
  const recorded: FakeGitHubProofEvent[] = [];
  const issues = new Map<number, GitHubIssueRecord>();
  let nextNumber = 1;
  let createMode: MutationMode = { kind: "success" };
  let closeMode: MutationMode = { kind: "success" };

  const createRecord = ({ repository, title, body }: CreateGitHubIssueInput): GitHubIssueRecord => {
    const number = nextNumber++;
    const record: GitHubIssueRecord = {
      number,
      url: `https://github.com/${repository.owner}/${repository.repo}/issues/${number}`,
      title,
      body,
      state: "open",
    };
    issues.set(number, record);
    return record;
  };

  return {
    createIssue: async (input) => {
      await (options.gate ?? immediateGate).wait(input.operationId);
      const mode = createMode;
      createMode = { kind: "success" };
      if (mode.kind === "failure") {
        recorded.push({
          kind: "create",
          repository: repositoryKey(input.repository),
          operationId: input.operationId,
          outcome: "failed",
          error: mode.error.message,
        });
        throw mode.error;
      }
      if (mode.kind === "timeout") {
        if (mode.afterMutation) createRecord(input);
        recorded.push({
          kind: "create",
          repository: repositoryKey(input.repository),
          operationId: input.operationId,
          outcome: "unknown",
        });
        throw new GitHubMutationOutcomeUncertainError("GitHub create request timed out");
      }

      const record = createRecord(input);
      recorded.push({
        kind: "create",
        repository: repositoryKey(input.repository),
        operationId: input.operationId,
        outcome: "created",
        number: record.number,
      });
      return record;
    },
    getIssue: async (repository, issueNumber) => {
      const issue = issues.get(issueNumber);
      if (!issue) throw new Error(`Fake GitHub issue not found: ${issueNumber}`);
      recorded.push({ kind: "get", repository: repositoryKey(repository), number: issueNumber, state: issue.state });
      return issue;
    },
    findIssuesByMarker: async (repository, operationId, marker) => {
      const matches = [...issues.values()].filter((issue) => issue.body.includes(`<!-- ${marker} -->`));
      recorded.push({
        kind: "find",
        repository: repositoryKey(repository),
        operationId,
        matches: matches.map((issue) => issue.number),
      });
      return matches;
    },
    closeIssue: async (repository, issueNumber) => {
      const issue = issues.get(issueNumber);
      if (!issue) throw new Error(`Fake GitHub issue not found: ${issueNumber}`);
      const mode = closeMode;
      closeMode = { kind: "success" };
      if (mode.kind === "failure") {
        recorded.push({
          kind: "close",
          repository: repositoryKey(repository),
          number: issueNumber,
          outcome: "failed",
          error: mode.error.message,
        });
        throw mode.error;
      }
      if (mode.kind === "timeout") {
        if (mode.afterMutation) issues.set(issueNumber, { ...issue, state: "closed" });
        recorded.push({ kind: "close", repository: repositoryKey(repository), number: issueNumber, outcome: "unknown" });
        throw new GitHubMutationOutcomeUncertainError("GitHub close request timed out");
      }
      const closed = { ...issue, state: "closed" as const };
      issues.set(issueNumber, closed);
      recorded.push({ kind: "close", repository: repositoryKey(repository), number: issueNumber, outcome: "closed" });
      return closed;
    },
    events: () => [...recorded],
    reset: () => {
      recorded.length = 0;
      issues.clear();
      nextNumber = 1;
      createMode = { kind: "success" };
      closeMode = { kind: "success" };
    },
    timeoutNextCreate: ({ afterMutation }) => {
      createMode = { kind: "timeout", afterMutation };
    },
    timeoutNextClose: ({ afterMutation }) => {
      closeMode = { kind: "timeout", afterMutation };
    },
    failNextCreate: (error) => {
      createMode = { kind: "failure", error };
    },
  };
};
