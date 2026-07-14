import { randomUUID } from "node:crypto";

import { defineTool, invoke, type WorkflowInvocationReceipt } from "@flue/runtime";
import * as v from "valibot";

import { type GitHubProofInput } from "../../github/proof-contract.js";
import { getGitHubProofRuntime, type GitHubProofPolicy } from "../../github/proof-runtime.js";
import gitHubProofWorkflow from "../../workflows/github-proof.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

const startGitHubProofOutputSchema = v.object({
  runId: nonEmptyString,
  status: v.literal("started"),
});

export type InvokeGitHubProof = (input: GitHubProofInput) => Promise<WorkflowInvocationReceipt>;

const invokeGitHubProof: InvokeGitHubProof = (input) => invoke(gitHubProofWorkflow, { input });

export const createStartGitHubProofTool = (
  chatId: string,
  invokeProof: InvokeGitHubProof = invokeGitHubProof,
  createOperationId: () => string = randomUUID,
  policy: GitHubProofPolicy = getGitHubProofRuntime().policy,
) =>
  defineTool({
    name: "start_github_proof",
    description:
      "Start one bounded disposable-issue proof in an authorized GitHub repository and return its run ID after invocation.",
    input: v.object({
      repository: v.optional(nonEmptyString),
    }),
    output: startGitHubProofOutputSchema,
    run: async ({ input }) => {
      const repository = policy.authorize(input.repository);
      const receipt = await invokeProof({
        chatId,
        operationId: createOperationId(),
        repository,
      });
      return { runId: receipt.runId, status: "started" as const };
    },
  });
