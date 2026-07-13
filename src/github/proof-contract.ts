import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const repositoryRefSchema = v.object({
  owner: nonEmptyString,
  repo: nonEmptyString,
});

export type RepositoryRef = v.InferOutput<typeof repositoryRefSchema>;

export const gitHubProofInputSchema = v.object({
  chatId: nonEmptyString,
  operationId: nonEmptyString,
  repository: repositoryRefSchema,
});

export type GitHubProofInput = v.InferOutput<typeof gitHubProofInputSchema>;

export const gitHubProofIssueSchema = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  url: v.pipe(v.string(), v.url()),
  title: nonEmptyString,
  state: v.union([v.literal("open"), v.literal("closed")]),
});

export type GitHubProofIssue = v.InferOutput<typeof gitHubProofIssueSchema>;

export const gitHubProofCompletedSchema = v.object({
  status: v.literal("completed"),
  chatId: nonEmptyString,
  operationId: nonEmptyString,
  repository: repositoryRefSchema,
  creation: v.union([v.literal("confirmed"), v.literal("reconciled")]),
  closure: v.union([v.literal("confirmed"), v.literal("reconciled")]),
  issue: v.intersect([gitHubProofIssueSchema, v.object({ state: v.literal("closed") })]),
});

export const gitHubProofUncertainSchema = v.object({
  status: v.literal("uncertain"),
  chatId: nonEmptyString,
  operationId: nonEmptyString,
  repository: repositoryRefSchema,
  phase: v.union([v.literal("create"), v.literal("close")]),
  reason: nonEmptyString,
  issue: v.optional(gitHubProofIssueSchema),
});

export const gitHubProofResultSchema = v.union([
  gitHubProofCompletedSchema,
  gitHubProofUncertainSchema,
]);

export type GitHubProofResult = v.InferOutput<typeof gitHubProofResultSchema>;

export const proofMarker = (operationId: string): string => `ambience-proof:${operationId}`;
export const proofTitle = (operationId: string): string => `[Ambience proof] ${operationId}`;
export const proofBody = (operationId: string): string =>
  [
    "Disposable issue created by the bounded Ambience GitHub workflow proof.",
    "It should be observed and closed by the same workflow run.",
    "",
    `<!-- ${proofMarker(operationId)} -->`,
  ].join("\n");
