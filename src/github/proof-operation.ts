import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import {
  gitHubProofInputSchema,
  gitHubProofResultSchema,
  proofBody,
  proofMarker,
  proofTitle,
  type GitHubProofInput,
  type GitHubProofIssue,
  type GitHubProofResult,
} from "./proof-contract.js";
import {
  isUncertainGitHubMutationError,
  type GitHubIssueRecord,
  type GitHubProofHost,
} from "../host/github-proof-host.js";

const publicIssue = (issue: GitHubIssueRecord): GitHubProofIssue => ({
  number: issue.number,
  url: issue.url,
  title: issue.title,
  state: issue.state,
});

const RECONCILIATION_TIMEOUT_MS = 10_000;

/**
 * Reconciliation is a bounded integrity read, not a retry of the mutation.
 * If the workflow signal caused the original request's uncertain outcome, a
 * fresh timeout still gives GitHub one chance to reveal observed state.
 */
const reconciliationSignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS);
  if (!signal || signal.aborted) return timeout;
  return AbortSignal.any([signal, timeout]);
};

const assertObservedIssue = (
  issue: GitHubIssueRecord,
  input: GitHubProofInput,
  expectedState: "open" | "closed",
): void => {
  if (issue.title !== proofTitle(input.operationId)) {
    throw new Error(`Observed GitHub issue ${issue.number} has the wrong proof title`);
  }
  if (!issue.body.includes(`<!-- ${proofMarker(input.operationId)} -->`)) {
    throw new Error(`Observed GitHub issue ${issue.number} does not carry the proof marker`);
  }
  if (issue.state !== expectedState) {
    throw new Error(`Observed GitHub issue ${issue.number} is ${issue.state}, expected ${expectedState}`);
  }
};

export const executeGitHubProof = async (
  rawInput: GitHubProofInput,
  host: GitHubProofHost,
  signal?: AbortSignal,
): Promise<GitHubProofResult> => {
  const input = v.parse(gitHubProofInputSchema, rawInput);
  const marker = proofMarker(input.operationId);
  let issue: GitHubIssueRecord;
  let creation: "confirmed" | "reconciled" = "confirmed";

  try {
    issue = await host.createIssue({
      repository: input.repository,
      operationId: input.operationId,
      title: proofTitle(input.operationId),
      body: proofBody(input.operationId),
      signal,
    });
  } catch (error) {
    if (!isUncertainGitHubMutationError(error)) throw error;
    let matches: readonly GitHubIssueRecord[];
    try {
      matches = await host.findIssuesByMarker(
        input.repository,
        input.operationId,
        marker,
        reconciliationSignal(signal),
      );
    } catch {
      return v.parse(gitHubProofResultSchema, {
        status: "uncertain",
        ...input,
        phase: "create",
        reason: "GitHub create outcome remained uncertain because marker reconciliation could not complete",
      });
    }
    if (matches.length === 0) {
      return v.parse(gitHubProofResultSchema, {
        status: "uncertain",
        ...input,
        phase: "create",
        reason: "GitHub create outcome remained uncertain after marker reconciliation",
      });
    }
    if (matches.length !== 1) {
      throw new Error(`GitHub proof marker matched ${matches.length} issues; refusing to guess`);
    }
    issue = matches[0]!;
    creation = "reconciled";
  }

  const observedOpen = await host.getIssue(input.repository, issue.number, signal);
  assertObservedIssue(observedOpen, input, "open");

  let closure: "confirmed" | "reconciled" = "confirmed";
  try {
    await host.closeIssue(input.repository, observedOpen.number, signal);
  } catch (error) {
    if (!isUncertainGitHubMutationError(error)) throw error;
    let reconciled: GitHubIssueRecord;
    try {
      reconciled = await host.getIssue(
        input.repository,
        observedOpen.number,
        reconciliationSignal(signal),
      );
    } catch {
      return v.parse(gitHubProofResultSchema, {
        status: "uncertain",
        ...input,
        phase: "close",
        reason: "GitHub close outcome remained uncertain because observed-state reconciliation could not complete",
        issue: publicIssue(observedOpen),
      });
    }
    assertObservedIssue(reconciled, input, reconciled.state);
    if (reconciled.state !== "closed") {
      return v.parse(gitHubProofResultSchema, {
        status: "uncertain",
        ...input,
        phase: "close",
        reason: "GitHub close outcome remained uncertain after observed-state reconciliation",
        issue: publicIssue(reconciled),
      });
    }
    closure = "reconciled";
    return v.parse(gitHubProofResultSchema, {
      status: "completed",
      ...input,
      creation,
      closure,
      issue: publicIssue(reconciled),
    });
  }

  const observedClosed = await host.getIssue(input.repository, observedOpen.number, signal);
  assertObservedIssue(observedClosed, input, "closed");
  return v.parse(gitHubProofResultSchema, {
    status: "completed",
    ...input,
    creation,
    closure,
    issue: publicIssue(observedClosed),
  });
};

export interface GitHubProofOperation {
  readonly tool: ReturnType<typeof defineTool>;
  result(): GitHubProofResult;
}

export const createGitHubProofOperation = (
  input: GitHubProofInput,
  host: GitHubProofHost,
): GitHubProofOperation => {
  let attempted = false;
  let receipt: GitHubProofResult | undefined;
  let failure: unknown;
  const tool = defineTool({
    name: "run_disposable_github_issue_proof",
    description:
      "Create, observe, close, and re-observe one disposable issue in the repository bound by the workflow.",
    input: v.object({}),
    output: gitHubProofResultSchema,
    run: async ({ signal }) => {
      if (attempted) throw new Error("The disposable GitHub proof was already attempted in this workflow run");
      attempted = true;
      try {
        receipt = await executeGitHubProof(input, host, signal);
        return receipt;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  });

  return {
    tool,
    result: () => {
      if (failure !== undefined) throw failure;
      if (!receipt) throw new Error("The GitHub specialist did not run the scoped proof tool");
      return receipt;
    },
  };
};
