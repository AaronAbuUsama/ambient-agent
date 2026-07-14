import {
  defineAgent,
  defineWorkflow,
  getRun,
  instrument,
  type FlueExecutionContext,
  type FlueExecutionInterceptor,
  type FlueExecutionOperation,
  type FlueInstrumentation,
} from "@flue/runtime";
import * as v from "valibot";

import {
  workflowCompletedInputSchema,
  workflowFailedInputSchema,
  workflowUncertainInputSchema,
  type WorkflowCompletedInput,
  type WorkflowFailedInput,
  type WorkflowUncertainInput,
} from "../ambience/events.js";
import { createGitHubProofOperation } from "../github/proof-operation.js";
import {
  gitHubProofInputSchema,
  gitHubProofResultSchema,
  type GitHubProofInput,
  type RepositoryRef,
} from "../github/proof-contract.js";
import { getGitHubProofRuntime } from "../github/proof-runtime.js";
import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";

export const GITHUB_PROOF_WORKFLOW_NAME = "github-proof";

export type GitHubProofResultInput = WorkflowCompletedInput | WorkflowUncertainInput | WorkflowFailedInput;
export type GitHubProofResultSink = (chatId: string, input: GitHubProofResultInput) => Promise<void>;

let configuredResultSink: GitHubProofResultSink = async () => {
  throw new Error("GitHub proof result sink is not configured");
};

export const configureGitHubProofResultSink = (sink: GitHubProofResultSink): void => {
  configuredResultSink = sink;
};

export class GitHubProofWorkflowError extends Error {
  override readonly name = "GitHubProofWorkflowError";

  constructor(
    message: string,
    readonly input: GitHubProofInput,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const specialist = defineAgent(() => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  instructions: [
    "You are the bounded GitHub proof specialist for one authorized repository.",
    "Use only the prompt-scoped proof tool. Call it exactly once.",
    "Do not invent GitHub identifiers or claim success without its observed-state receipt.",
  ].join("\n"),
}));

const repositoryName = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

const deliverTerminalResult = async (runId: string, result: unknown): Promise<void> => {
  const output = v.parse(gitHubProofResultSchema, result);
  if (output.status === "completed") {
    await configuredResultSink(
      output.chatId,
      v.parse(workflowCompletedInputSchema, {
        type: "workflow.completed",
        chatId: output.chatId,
        workflow: GITHUB_PROOF_WORKFLOW_NAME,
        runId,
        operationId: output.operationId,
        output,
      }),
    );
    return;
  }

  await configuredResultSink(
    output.chatId,
    v.parse(workflowUncertainInputSchema, {
      type: "workflow.uncertain",
      chatId: output.chatId,
      workflow: GITHUB_PROOF_WORKFLOW_NAME,
      runId,
      operationId: output.operationId,
      output,
    }),
  );
};

const deliverTerminalFailure = async (runId: string, error: GitHubProofWorkflowError): Promise<void> => {
  await configuredResultSink(
    error.input.chatId,
    v.parse(workflowFailedInputSchema, {
      type: "workflow.failed",
      chatId: error.input.chatId,
      workflow: GITHUB_PROOF_WORKFLOW_NAME,
      runId,
      operationId: error.input.operationId,
      repository: error.input.repository,
      error: { message: error.message },
    }),
  );
};

export const gitHubProofResultInterceptor: FlueExecutionInterceptor = async function interceptGitHubProofResult<T>(
  operation: FlueExecutionOperation,
  _context: FlueExecutionContext,
  next: () => Promise<T>,
): Promise<T> {
  if (
    operation.type !== "workflow" ||
    operation.workflowName !== GITHUB_PROOF_WORKFLOW_NAME ||
    operation.phase !== "start"
  ) {
    return next();
  }

  let result: T;
  try {
    result = await next();
  } catch (error) {
    if (error instanceof GitHubProofWorkflowError) await deliverTerminalFailure(operation.runId, error);
    throw error;
  }
  await deliverTerminalResult(operation.runId, result);
  return result;
};

const resultDeliveryInstrumentation: FlueInstrumentation = {
  key: Symbol("github-proof-result-delivery"),
  observe: () => undefined,
  interceptor: gitHubProofResultInterceptor,
  dispose: () => undefined,
};

let resultDeliveryInstalled = false;

const installGitHubProofResultDelivery = (): void => {
  if (resultDeliveryInstalled) return;
  instrument(resultDeliveryInstrumentation);
  resultDeliveryInstalled = true;
};

export const installGitHubProofResultDispatch = (dispatch: GitHubProofResultSink): void => {
  configureGitHubProofResultSink(async (chatId, input) => {
    const run = await getRun(input.runId);
    const expectedStatus = input.type === "workflow.failed" ? "errored" : "completed";
    if (run?.status !== expectedStatus) {
      throw new Error(`GitHub proof workflow ${input.runId} is not durably ${expectedStatus}`);
    }
    await dispatch(chatId, input);
  });
  installGitHubProofResultDelivery();
};

export default defineWorkflow({
  agent: specialist,
  input: gitHubProofInputSchema,
  output: gitHubProofResultSchema,
  run: async ({ harness, input }) => {
    try {
      const runtime = getGitHubProofRuntime();
      const authorized = runtime.policy.authorize(repositoryName(input.repository));
      const operation = createGitHubProofOperation({ ...input, repository: authorized }, runtime.host);
      const session = await harness.sessions.create("github-proof-specialist");
      await session.prompt(
        [
          `Run the bounded disposable GitHub issue proof for ${repositoryName(authorized)}.`,
          `The application operation identity is ${input.operationId}.`,
          "Call run_disposable_github_issue_proof exactly once, inspect its structured receipt, then finish privately.",
        ].join("\n"),
        { tools: [operation.tool], thinkingLevel: "low" },
      );
      return operation.result();
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.length > 0 ? cause.message : "GitHub proof workflow failed";
      throw new GitHubProofWorkflowError(message, input, { cause });
    }
  },
});
