import {
  IssueMutationOutcomeUncertainError,
  type Issue,
  type IssueDraft,
  type IssueRepository,
  type RepositoryRef,
} from "../capabilities/issue-management/issue-repository.ts";
import { repositoryName } from "../capabilities/issue-management/runtime.ts";

export type FakeIssueRepositoryEvent =
  | { kind: "search"; repository: string; query: string; matches: number[] }
  | { kind: "get"; repository: string; number: number }
  | { kind: "create"; repository: string; operationId: string; outcome: "created"; number: number }
  | { kind: "create"; repository: string; operationId: string; outcome: "unknown" }
  | { kind: "create"; repository: string; operationId: string; outcome: "failed"; error: string }
  | { kind: "find-operation"; repository: string; operationId: string; matches: number[] };

type MutationMode =
  | { kind: "success" }
  | { kind: "timeout"; afterMutation: boolean }
  | { kind: "failure"; error: Error };

export interface FakeIssueRepository extends IssueRepository {
  events(): readonly FakeIssueRepositoryEvent[];
  reset(): void;
  resetEvents(): void;
  seed(input: Omit<IssueDraft, "kind"> & { readonly kind?: "bug" | "feature" }): Issue;
  timeoutNextCreate(options: { readonly afterMutation: boolean }): void;
  failNextCreate(error: Error): void;
}

export const createFakeIssueRepository = (): FakeIssueRepository => {
  const events: FakeIssueRepositoryEvent[] = [];
  const issues = new Map<string, Map<number, Issue>>();
  let nextNumber = 1;
  let mode: MutationMode = { kind: "success" };

  const records = (repository: RepositoryRef): Map<number, Issue> => {
    const key = repositoryName(repository).toLowerCase();
    const existing = issues.get(key);
    if (existing !== undefined) return existing;
    const created = new Map<number, Issue>();
    issues.set(key, created);
    return created;
  };
  const seed = (input: Omit<IssueDraft, "kind"> & { readonly kind?: "bug" | "feature" }): Issue => {
    const number = nextNumber++;
    const issue: Issue = {
      repository: input.repository,
      number,
      url: `https://github.com/${repositoryName(input.repository)}/issues/${number}`,
      title: input.title,
      body: input.body,
      state: "open",
    };
    records(input.repository).set(number, issue);
    return issue;
  };

  return {
    search: async ({ repository, query }) => {
      const normalized = query.trim().toLowerCase();
      const matches = [...records(repository).values()].filter((issue) =>
        `${issue.title}\n${issue.body}`.toLowerCase().includes(normalized),
      );
      events.push({
        kind: "search",
        repository: repositoryName(repository),
        query,
        matches: matches.map((issue) => issue.number),
      });
      return matches;
    },
    get: async ({ repository, number }) => {
      const issue = records(repository).get(number);
      if (issue === undefined) throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
      events.push({ kind: "get", repository: repositoryName(repository), number });
      return issue;
    },
    create: async ({ repository, kind: _kind, title, body, operation }) => {
      const current = mode;
      mode = { kind: "success" };
      if (current.kind === "failure") {
        events.push({
          kind: "create",
          repository: repositoryName(repository),
          operationId: operation.id,
          outcome: "failed",
          error: current.error.message,
        });
        throw current.error;
      }
      if (current.kind === "timeout") {
        if (current.afterMutation) {
          seed({ repository, title, body: `${body}\n\n<!-- ambience-operation:${operation.id} -->` });
        }
        events.push({
          kind: "create",
          repository: repositoryName(repository),
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub create request timed out");
      }
      const issue = seed({ repository, title, body: `${body}\n\n<!-- ambience-operation:${operation.id} -->` });
      events.push({
        kind: "create",
        repository: repositoryName(repository),
        operationId: operation.id,
        outcome: "created",
        number: issue.number,
      });
      return issue;
    },
    findCreated: async ({ repository, operation }) => {
      const marker = `<!-- ambience-operation:${operation.id} -->`;
      const matches = [...records(repository).values()].filter((issue) => issue.body.includes(marker));
      events.push({
        kind: "find-operation",
        repository: repositoryName(repository),
        operationId: operation.id,
        matches: matches.map((issue) => issue.number),
      });
      return matches;
    },
    events: () => [...events],
    reset: () => {
      events.length = 0;
      issues.clear();
      nextNumber = 1;
      mode = { kind: "success" };
    },
    resetEvents: () => {
      events.length = 0;
    },
    seed,
    timeoutNextCreate: ({ afterMutation }) => {
      mode = { kind: "timeout", afterMutation };
    },
    failNextCreate: (error) => {
      mode = { kind: "failure", error };
    },
  };
};
