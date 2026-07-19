import type { SandboxFactory } from "@flue/runtime";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { ReviewerGitHub } from "./github.ts";

export interface ReviewerRuntime {
  readonly github: ReviewerGitHub;
  readonly sandbox: SandboxFactory;
  readonly workspacesRoot: string;
}

const runtimeSlot = createFlueGlobal<ReviewerRuntime>(
  "reviewer-runtime",
  "Reviewer runtime is not configured (the reviewer GitHub App and sandbox binding are unset).",
);

export const configureReviewerRuntime = (runtime: ReviewerRuntime): void => runtimeSlot.set(runtime);
export const getReviewerRuntime = (): ReviewerRuntime => runtimeSlot.get();
