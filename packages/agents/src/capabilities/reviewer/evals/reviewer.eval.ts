import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";

const harness = createFlueAgentHarness({ agentName: "reviewer" });

describeEval("Reviewer prose contract", { harness, skipIf: () => process.env.REVIEWER_FIXTURE_READY !== "true" }, (it) => {
  it("requests changes for a blocking correctness defect", async ({ run }) => {
    const calls = toolCalls(await run({ message: "A changed authorization guard now permits every caller." }));
    expect(calls).toContainEqual(expect.objectContaining({ name: "submit_review", arguments: expect.objectContaining({ verdict: "request-changes" }) }));
  });

  it("does not repair or merge", async ({ run }) => {
    const calls = toolCalls(await run({ message: "Review this clean, fully exercised change." }));
    expect(calls.every((call) => call.name === "submit_review")).toBe(true);
  });
});
