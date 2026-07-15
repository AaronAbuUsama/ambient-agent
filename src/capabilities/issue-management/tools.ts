import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import {
  isUncertainIssueMutationError,
  MAX_PUBLIC_COMMENT_BODY_LENGTH,
  MAX_PUBLIC_ISSUE_BODY_LENGTH,
  type Issue,
  type IssueComment,
  type IssueDiscussion,
  type IssueRepository,
  type IssueRepositoryOptions,
  type IssueStateChangeReason,
  type IssueSummary,
  type IssueUpdate,
} from "./issue-repository.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import {
  getIssueManagementRuntime,
  repositoryName,
  type IssueManagementPolicy,
  type IssueManagementRuntime,
} from "./runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const repositoryInput = v.optional(nonEmptyString);
const issueNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const stateSchema = v.union([v.literal("open"), v.literal("closed")]);
const summarySchema = v.object({
  repository: v.object({ owner: nonEmptyString, repo: nonEmptyString }),
  number: issueNumber,
  url: v.pipe(v.string(), v.url()),
  title: nonEmptyString,
  state: stateSchema,
});
const milestoneSchema = v.object({
  number: issueNumber,
  title: nonEmptyString,
  state: stateSchema,
});
const issueSchema = v.intersect([
  summarySchema,
  v.object({
    body: v.string(),
    stateReason: v.nullable(
      v.union([v.literal("completed"), v.literal("not_planned"), v.literal("duplicate"), v.literal("reopened")]),
    ),
    labels: v.array(nonEmptyString),
    assignees: v.array(nonEmptyString),
    milestone: v.nullable(milestoneSchema),
  }),
]);
const optionsSchema = v.object({
  labels: v.array(nonEmptyString),
  assignees: v.array(nonEmptyString),
  milestones: v.array(milestoneSchema),
});
const commentSchema = v.object({
  repository: v.object({ owner: nonEmptyString, repo: nonEmptyString }),
  number: issueNumber,
  id: issueNumber,
  url: v.pipe(v.string(), v.url()),
  body: v.string(),
  author: v.nullable(v.string()),
  createdAt: nonEmptyString,
  updatedAt: nonEmptyString,
});
const discussionSchema = v.object({ issue: issueSchema, comments: v.array(commentSchema) });
const createOutputSchema = v.union([
  v.object({ status: v.literal("duplicate"), issues: v.array(summarySchema) }),
  v.object({
    status: v.union([v.literal("created"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    issue: issueSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    issue: v.optional(issueSchema),
  }),
]);
const updateOutputSchema = v.union([
  v.object({
    status: v.union([v.literal("updated"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    issue: issueSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    issue: v.optional(issueSchema),
  }),
]);
const commentMutationOutputSchema = v.union([
  v.object({
    status: v.union([v.literal("created"), v.literal("updated"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    comment: commentSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    comment: v.optional(commentSchema),
  }),
]);
const deleteCommentOutputSchema = v.union([
  v.object({
    status: v.union([v.literal("deleted"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    commentId: issueNumber,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    commentId: issueNumber,
  }),
]);
const stateMutationOutputSchema = v.union([
  v.object({
    status: v.union([v.literal("changed"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    issue: issueSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    issue: v.optional(issueSchema),
  }),
]);

const publicSummary = (issue: IssueSummary): IssueSummary => ({
  repository: issue.repository,
  number: issue.number,
  url: issue.url,
  title: issue.title,
  state: issue.state,
});

const publicIssue = (issue: Issue): Issue => ({
  ...publicSummary(issue),
  body: issue.body,
  stateReason: issue.stateReason,
  labels: [...issue.labels],
  assignees: [...issue.assignees],
  milestone: issue.milestone,
});
const publicComment = (comment: IssueComment): IssueComment => ({ ...comment });
const publicDiscussion = (discussion: IssueDiscussion): IssueDiscussion => ({
  issue: publicIssue(discussion.issue),
  comments: discussion.comments.map(publicComment),
});
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const normalizedTitle = (title: string): string => title.trim().replaceAll(/\s+/g, " ").toLowerCase();

const RECONCILIATION_TIMEOUT_MS = 10_000;
const reconciliationSignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS);
  if (signal === undefined || signal.aborted) return timeout;
  return AbortSignal.any([signal, timeout]);
};

export interface IssueManagementToolOptions extends IssueManagementRuntime {
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
}

const createIssue = async (input: {
  readonly repository: ReturnType<IssueManagementPolicy["authorize"]>;
  readonly kind: "bug" | "feature";
  readonly title: string;
  readonly body: string;
  readonly provider: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}): Promise<v.InferOutput<typeof createOutputSchema>> => {
  const related = await input.provider.search({
    repository: input.repository,
    query: input.title,
    signal: input.signal,
  });
  const duplicates = related.filter((issue) => normalizedTitle(issue.title) === normalizedTitle(input.title));
  if (duplicates.length > 0) {
    return { status: "duplicate", issues: duplicates.map(publicSummary) };
  }

  const operationId = input.createOperationId();
  const operation = { id: operationId };
  input.operations.begin({
    operationId,
    kind: "create-issue",
    repository: repositoryName(input.repository),
    target: { kind: input.kind, title: input.title, body: input.body },
    startedAt: input.now().toISOString(),
  });
  const settleCreated = (issue: Issue, status: "created" | "reconciled"): v.InferOutput<typeof createOutputSchema> => {
    try {
      input.operations.complete(operationId, issue.number, input.now().toISOString());
      return { status, operationId, issue: publicIssue(issue) };
    } catch (cause) {
      try {
        const current = input.operations.get(operationId);
        if (current?.status === "completed") return { status, operationId, issue: publicIssue(issue) };
        const reason = `GitHub issue ${issue.number} exists, but its Operation Identity completion could not be persisted: ${errorMessage(cause)}`;
        if (current?.status === "attempting") {
          input.operations.uncertain(operationId, reason, input.now().toISOString());
          return { status: "uncertain", operationId, reason, issue: publicIssue(issue) };
        }
      } catch (ledgerCause) {
        throw new Error(
          `GitHub issue ${issue.number} exists, but its Operation Identity state could not be recorded. Do not repeat creation.`,
          { cause: ledgerCause },
        );
      }
      throw new Error(
        `GitHub issue ${issue.number} exists with an unresolved Operation Identity state. Do not repeat creation.`,
        { cause },
      );
    }
  };

  let issue: Issue;
  try {
    issue = await input.provider.create({
      repository: input.repository,
      kind: input.kind,
      title: input.title,
      body: input.body,
      operation,
      signal: input.signal,
    });
  } catch (cause) {
    if (!isUncertainIssueMutationError(cause)) {
      input.operations.fail(operationId, errorMessage(cause), input.now().toISOString());
      throw cause;
    }
    try {
      const observed = await input.provider.findCreated({
        repository: input.repository,
        operation,
        signal: reconciliationSignal(input.signal),
      });
      if (observed.length === 1) {
        return settleCreated(observed[0]!, "reconciled");
      }
      const reason =
        observed.length === 0
          ? "GitHub create outcome remained uncertain after Operation Identity observation"
          : `Operation Identity matched ${observed.length} GitHub issues; refusing to guess`;
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    } catch {
      const reason =
        "GitHub create outcome remained uncertain because Operation Identity observation could not complete";
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    }
  }
  return settleCreated(issue, "created");
};

const canonicalValues = (requested: readonly string[], existing: readonly string[], kind: string): string[] => {
  const byKey = new Map(existing.map((value) => [value.toLowerCase(), value]));
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const value of requested) {
    const match = byKey.get(value.toLowerCase());
    if (match === undefined) throw new Error(`GitHub ${kind} "${value}" does not exist in the authorized repository.`);
    const key = match.toLowerCase();
    if (!seen.has(key)) canonical.push(match);
    seen.add(key);
  }
  return canonical;
};

const validatedUpdate = (requested: IssueUpdate, options?: IssueRepositoryOptions): IssueUpdate => {
  if (Object.keys(requested).length === 0) throw new Error("At least one issue field must be supplied for update.");
  const changes: IssueUpdate = {
    ...(requested.title === undefined ? {} : { title: requested.title }),
    ...(requested.body === undefined ? {} : { body: requested.body }),
    ...(requested.labels === undefined
      ? {}
      : { labels: canonicalValues(requested.labels, options?.labels ?? [], "label") }),
    ...(requested.assignees === undefined
      ? {}
      : { assignees: canonicalValues(requested.assignees, options?.assignees ?? [], "assignee") }),
    ...(requested.milestone === undefined ? {} : { milestone: requested.milestone }),
  };
  if (requested.milestone !== undefined && requested.milestone !== null) {
    const milestone = options?.milestones.find((candidate) => candidate.number === requested.milestone);
    if (milestone === undefined) {
      throw new Error(`GitHub milestone #${requested.milestone} does not exist in the authorized repository.`);
    }
  }
  return changes;
};

const sameValues = (left: readonly string[], right: readonly string[]): boolean => {
  const normalize = (values: readonly string[]) => [...values].map((value) => value.toLowerCase()).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const matchesUpdate = (issue: Issue, changes: IssueUpdate): boolean =>
  (changes.title === undefined || issue.title === changes.title) &&
  (changes.body === undefined || issue.body === changes.body) &&
  (changes.labels === undefined || sameValues(issue.labels, changes.labels)) &&
  (changes.assignees === undefined || sameValues(issue.assignees, changes.assignees)) &&
  (changes.milestone === undefined ||
    issue.milestone?.number === changes.milestone ||
    (issue.milestone === null && changes.milestone === null));

const updateIssue = async (input: {
  readonly repository: ReturnType<IssueManagementPolicy["authorize"]>;
  readonly number: number;
  readonly changes: IssueUpdate;
  readonly provider: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}): Promise<v.InferOutput<typeof updateOutputSchema>> => {
  await input.provider.get({ repository: input.repository, number: input.number, signal: input.signal });
  const needsOptions =
    input.changes.labels !== undefined ||
    input.changes.assignees !== undefined ||
    input.changes.milestone !== undefined;
  const options = needsOptions
    ? await input.provider.options({ repository: input.repository, signal: input.signal })
    : undefined;
  const changes = validatedUpdate(input.changes, options);
  const operationId = input.createOperationId();
  const operation = { id: operationId };
  input.operations.begin({
    operationId,
    kind: "update-issue",
    repository: repositoryName(input.repository),
    issueNumber: input.number,
    target: { ...changes } as Record<string, unknown>,
    startedAt: input.now().toISOString(),
  });
  const settleUpdated = (issue: Issue, status: "updated" | "reconciled"): v.InferOutput<typeof updateOutputSchema> => {
    try {
      input.operations.complete(operationId, issue.number, input.now().toISOString());
      return { status, operationId, issue: publicIssue(issue) };
    } catch (cause) {
      try {
        const current = input.operations.get(operationId);
        if (current?.status === "completed") return { status, operationId, issue: publicIssue(issue) };
        const reason = `GitHub issue ${issue.number} reflects the update, but its Operation Identity completion could not be persisted: ${errorMessage(cause)}`;
        if (current?.status === "attempting") {
          input.operations.uncertain(operationId, reason, input.now().toISOString());
          return { status: "uncertain", operationId, reason, issue: publicIssue(issue) };
        }
      } catch (ledgerCause) {
        throw new Error(
          `GitHub issue ${issue.number} may reflect the update, but its Operation Identity state could not be recorded. Do not repeat the mutation.`,
          { cause: ledgerCause },
        );
      }
      throw new Error(
        `GitHub issue ${issue.number} may reflect the update with an unresolved Operation Identity state. Do not repeat the mutation.`,
        { cause },
      );
    }
  };

  let issue: Issue;
  try {
    issue = await input.provider.update({
      repository: input.repository,
      number: input.number,
      changes,
      operation,
      signal: input.signal,
    });
  } catch (cause) {
    if (!isUncertainIssueMutationError(cause)) {
      input.operations.fail(operationId, errorMessage(cause), input.now().toISOString());
      throw cause;
    }
    let observed: Issue;
    try {
      observed = await input.provider.get({
        repository: input.repository,
        number: input.number,
        signal: reconciliationSignal(input.signal),
      });
    } catch {
      const reason =
        "GitHub update outcome remained uncertain because exact issue-state observation could not complete";
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    }
    if (matchesUpdate(observed, changes)) return settleUpdated(observed, "reconciled");
    const reason = "GitHub update outcome remained uncertain after exact issue-state observation";
    input.operations.uncertain(operationId, reason, input.now().toISOString());
    return { status: "uncertain", operationId, reason, issue: publicIssue(observed) };
  }
  return settleUpdated(issue, "updated");
};

type LifecycleResult<T> =
  | { readonly status: "applied" | "reconciled"; readonly operationId: string; readonly value: T }
  | { readonly status: "uncertain"; readonly operationId: string; readonly reason: string; readonly value?: T };

const lifecycleMutation = async <T>(input: {
  readonly repository: ReturnType<IssueManagementPolicy["authorize"]>;
  readonly number: number;
  readonly kind: "create-comment" | "update-comment" | "delete-comment" | "set-issue-state";
  readonly target: Readonly<Record<string, unknown>>;
  readonly provider: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  readonly mutate: (operationId: string) => Promise<T>;
  readonly reconcile: (operationId: string) => Promise<T | undefined>;
}): Promise<LifecycleResult<T>> => {
  const operationId = input.createOperationId();
  input.operations.begin({
    operationId,
    kind: input.kind,
    repository: repositoryName(input.repository),
    issueNumber: input.number,
    target: input.target,
    startedAt: input.now().toISOString(),
  });

  const settle = (value: T, status: "applied" | "reconciled"): LifecycleResult<T> => {
    try {
      input.operations.complete(operationId, input.number, input.now().toISOString());
      return { status, operationId, value };
    } catch (cause) {
      try {
        const current = input.operations.get(operationId);
        if (current?.status === "completed") return { status, operationId, value };
        const reason = `GitHub reflects the ${input.kind} mutation, but its Operation Identity completion could not be persisted: ${errorMessage(cause)}`;
        if (current?.status === "attempting") {
          input.operations.uncertain(operationId, reason, input.now().toISOString());
          return { status: "uncertain", operationId, reason, value };
        }
      } catch (ledgerCause) {
        throw new Error(
          `GitHub may reflect the ${input.kind} mutation, but its Operation Identity state could not be recorded. Do not repeat it.`,
          { cause: ledgerCause },
        );
      }
      throw new Error(`GitHub may reflect the ${input.kind} mutation. Do not repeat it.`, { cause });
    }
  };

  let applied: T;
  try {
    applied = await input.mutate(operationId);
  } catch (cause) {
    if (!isUncertainIssueMutationError(cause)) {
      input.operations.fail(operationId, errorMessage(cause), input.now().toISOString());
      throw cause;
    }
    let observed: T | undefined;
    try {
      observed = await input.reconcile(operationId);
    } catch {
      // A bounded observation failure cannot turn an unknown write into a safe retry.
    }
    if (observed !== undefined) return settle(observed, "reconciled");
    const reason = `GitHub ${input.kind} outcome remained uncertain after one bounded observation`;
    input.operations.uncertain(operationId, reason, input.now().toISOString());
    return { status: "uncertain", operationId, reason };
  }
  return settle(applied, "applied");
};

const requiredComment = (discussion: IssueDiscussion, commentId: number): IssueComment => {
  const comment = discussion.comments.find((candidate) => candidate.id === commentId);
  if (comment === undefined) {
    throw new Error(`GitHub issue #${discussion.issue.number} has no comment ${commentId}.`);
  }
  return comment;
};

export const createIssueManagementTools = (
  options: IssueManagementToolOptions = getIssueManagementRuntime(),
): ToolDefinition[] => {
  const createOperationId = options.createOperationId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return [
    defineTool({
      name: "github_search_issues",
      description: "Search issues in one authorized GitHub repository before reading or creating work.",
      input: v.object({ repository: repositoryInput, query: nonEmptyString }),
      output: v.object({ issues: v.array(summarySchema) }),
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        const issues = await options.repository.search({ repository, query: input.query, signal });
        return { issues: issues.map(publicSummary) };
      },
    }),
    defineTool({
      name: "github_read_issue",
      description: "Read one issue from an authorized GitHub repository.",
      input: v.object({ repository: repositoryInput, number: issueNumber }),
      output: issueSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        return publicIssue(await options.repository.get({ repository, number: input.number, signal }));
      },
    }),
    defineTool({
      name: "github_list_issue_options",
      description: "List existing labels, assignable users, and milestones in one authorized GitHub repository.",
      input: v.object({ repository: repositoryInput }),
      output: optionsSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        const available = await options.repository.options({ repository, signal });
        return {
          labels: [...available.labels],
          assignees: [...available.assignees],
          milestones: available.milestones.map((milestone) => ({ ...milestone })),
        };
      },
    }),
    defineTool({
      name: "github_create_issue",
      description:
        "Search for duplicates, then create one complete bug or feature issue in an authorized GitHub repository.",
      input: v.object({
        repository: repositoryInput,
        kind: v.union([v.literal("bug"), v.literal("feature")]),
        title: v.pipe(nonEmptyString, v.maxLength(256)),
        body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH)),
      }),
      output: createOutputSchema,
      run: async ({ input, signal }) =>
        await createIssue({
          repository: options.policy.authorize(input.repository),
          kind: input.kind,
          title: input.title,
          body: input.body,
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
        }),
    }),
    defineTool({
      name: "github_update_issue",
      description:
        "Read one issue, validate existing repository metadata, then update its title, body, labels, assignees, or milestone.",
      input: v.object({
        repository: repositoryInput,
        number: issueNumber,
        title: v.optional(v.pipe(nonEmptyString, v.maxLength(256))),
        body: v.optional(v.pipe(v.string(), v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH))),
        labels: v.optional(v.array(nonEmptyString)),
        assignees: v.optional(v.array(nonEmptyString)),
        milestone: v.optional(v.nullable(issueNumber)),
      }),
      output: updateOutputSchema,
      run: async ({ input, signal }) =>
        await updateIssue({
          repository: options.policy.authorize(input.repository),
          number: input.number,
          changes: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
            ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
          },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
        }),
    }),
    defineTool({
      name: "github_read_issue_discussion",
      description:
        "Read one issue and every current discussion comment before choosing a discussion or lifecycle mutation.",
      input: v.object({ repository: repositoryInput, number: issueNumber }),
      output: discussionSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        return publicDiscussion(await options.repository.discussion({ repository, number: input.number, signal }));
      },
    }),
    defineTool({
      name: "github_create_issue_comment",
      description: "Read the complete issue discussion, then create one comment with durable Operation Identity.",
      input: v.object({
        repository: repositoryInput,
        number: issueNumber,
        body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_COMMENT_BODY_LENGTH)),
      }),
      output: commentMutationOutputSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        await options.repository.discussion({ repository, number: input.number, signal });
        const result = await lifecycleMutation({
          repository,
          number: input.number,
          kind: "create-comment",
          target: { body: input.body },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
          mutate: async (operationId) =>
            await options.repository.createComment({
              repository,
              number: input.number,
              body: input.body,
              operation: { id: operationId },
              signal,
            }),
          reconcile: async (operationId) => {
            const matches = await options.repository.findCommentByOperation({
              repository,
              number: input.number,
              operation: { id: operationId },
              signal: reconciliationSignal(signal),
            });
            return matches.length === 1 ? matches[0] : undefined;
          },
        });
        if (result.status === "uncertain") {
          return {
            status: "uncertain" as const,
            operationId: result.operationId,
            reason: result.reason,
            ...(result.value === undefined ? {} : { comment: publicComment(result.value) }),
          };
        }
        return {
          status: result.status === "applied" ? ("created" as const) : ("reconciled" as const),
          operationId: result.operationId,
          comment: publicComment(result.value),
        };
      },
    }),
    defineTool({
      name: "github_update_issue_comment",
      description: "Read the complete issue discussion, then update one exact comment with durable Operation Identity.",
      input: v.object({
        repository: repositoryInput,
        number: issueNumber,
        commentId: issueNumber,
        body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_COMMENT_BODY_LENGTH)),
      }),
      output: commentMutationOutputSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        requiredComment(
          await options.repository.discussion({ repository, number: input.number, signal }),
          input.commentId,
        );
        const result = await lifecycleMutation({
          repository,
          number: input.number,
          kind: "update-comment",
          target: { commentId: input.commentId, body: input.body },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
          mutate: async (operationId) =>
            await options.repository.updateComment({
              repository,
              number: input.number,
              commentId: input.commentId,
              body: input.body,
              operation: { id: operationId },
              signal,
            }),
          reconcile: async (operationId) => {
            const matches = await options.repository.findCommentByOperation({
              repository,
              number: input.number,
              operation: { id: operationId },
              signal: reconciliationSignal(signal),
            });
            return matches.length === 1 && matches[0]?.id === input.commentId && matches[0].body === input.body
              ? matches[0]
              : undefined;
          },
        });
        if (result.status === "uncertain") {
          return {
            status: "uncertain" as const,
            operationId: result.operationId,
            reason: result.reason,
            ...(result.value === undefined ? {} : { comment: publicComment(result.value) }),
          };
        }
        return {
          status: result.status === "applied" ? ("updated" as const) : ("reconciled" as const),
          operationId: result.operationId,
          comment: publicComment(result.value),
        };
      },
    }),
    defineTool({
      name: "github_delete_issue_comment",
      description: "Read the complete issue discussion, then delete one exact comment. This never deletes the issue.",
      input: v.object({ repository: repositoryInput, number: issueNumber, commentId: issueNumber }),
      output: deleteCommentOutputSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        requiredComment(
          await options.repository.discussion({ repository, number: input.number, signal }),
          input.commentId,
        );
        const result = await lifecycleMutation({
          repository,
          number: input.number,
          kind: "delete-comment",
          target: { commentId: input.commentId },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
          mutate: async (operationId) => {
            await options.repository.deleteComment({
              repository,
              number: input.number,
              commentId: input.commentId,
              operation: { id: operationId },
              signal,
            });
            return input.commentId;
          },
          reconcile: async () => {
            await options.repository.discussion({
              repository,
              number: input.number,
              signal: reconciliationSignal(signal),
            });
            // GitHub deletes the provider record that could carry an operation marker. Even when
            // absence is observed, causation cannot be attributed mechanically, so remain Uncertain.
            return undefined;
          },
        });
        if (result.status === "uncertain") {
          return {
            status: "uncertain" as const,
            operationId: result.operationId,
            reason: result.reason,
            commentId: input.commentId,
          };
        }
        return {
          status: result.status === "applied" ? ("deleted" as const) : ("reconciled" as const),
          operationId: result.operationId,
          commentId: result.value,
        };
      },
    }),
    defineTool({
      name: "github_set_issue_state",
      description: "Read the complete discussion, then close with a meaningful reason or reopen the issue.",
      input: v.object({
        repository: repositoryInput,
        number: issueNumber,
        state: stateSchema,
        reason: v.union([
          v.literal("completed"),
          v.literal("not_planned"),
          v.literal("duplicate"),
          v.literal("reopened"),
        ]),
      }),
      output: stateMutationOutputSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        if ((input.state === "open") !== (input.reason === "reopened")) {
          throw new Error(
            "Open issues require reason reopened; closed issues require completed, not_planned, or duplicate.",
          );
        }
        const discussion = await options.repository.discussion({ repository, number: input.number, signal });
        if (discussion.issue.state === input.state) {
          throw new Error(`GitHub issue #${input.number} already has state ${input.state}.`);
        }
        const reason: IssueStateChangeReason = input.reason;
        const result = await lifecycleMutation({
          repository,
          number: input.number,
          kind: "set-issue-state",
          target: { state: input.state, reason },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
          mutate: async (operationId) =>
            await options.repository.setState({
              repository,
              number: input.number,
              state: input.state,
              reason,
              operation: { id: operationId },
              signal,
            }),
          reconcile: async () => {
            await options.repository.discussion({
              repository,
              number: input.number,
              signal: reconciliationSignal(signal),
            });
            // GitHub state changes have no atomic provider identity channel. Exact state may be
            // observed, but causation cannot be attributed mechanically, so remain Uncertain.
            return undefined;
          },
        });
        if (result.status === "uncertain") {
          return {
            status: "uncertain" as const,
            operationId: result.operationId,
            reason: result.reason,
            ...(result.value === undefined ? {} : { issue: publicIssue(result.value) }),
          };
        }
        return {
          status: result.status === "applied" ? ("changed" as const) : ("reconciled" as const),
          operationId: result.operationId,
          issue: publicIssue(result.value),
        };
      },
    }),
  ];
};
