import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

export const reviewerJobInputSchema = v.object({
  repository: nonEmpty,
  pullRequest: v.pipe(v.number(), v.integer(), v.minValue(1)),
  expectedHeadSha: nonEmpty,
});

export type ReviewerJobInput = v.InferOutput<typeof reviewerJobInputSchema>;

export const reviewFindingSchema = v.object({
  path: nonEmpty,
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: nonEmpty,
});

export const reviewerResultSchema = v.object({
  status: v.picklist(["approved", "changes-requested", "commented", "blocked", "failed"]),
  reviewUrl: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  headSha: v.optional(v.string()),
  verdict: v.optional(v.string()),
  summary: v.string(),
});

export type ReviewerResult = v.InferOutput<typeof reviewerResultSchema>;
