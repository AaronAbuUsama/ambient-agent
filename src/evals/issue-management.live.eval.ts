import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";

import { createFlueAgentHarness } from "./harness.ts";

const harness = createFlueAgentHarness({ agentName: "ambience" });
const window = (text: string): string => `WhatsApp Window for the current managed chat:\nAlice: ${text}`;
const issueSkillCalls = (calls: ReturnType<typeof toolCalls>) =>
  calls.filter((call) => call.name === "activate_skill" && JSON.stringify(call.arguments).includes("issue-management"));

describeEval(
  "Issue Management live model",
  { harness, skipIf: () => process.env.AMBIENCE_EVAL_LIVE_MODEL !== "true" },
  (it) => {
    it("files one complete bug report", async ({ run }) => {
      const result = await run({
        message: window(
          "Please file this bug. After restart, a queued scheduler job disappears instead of running. I can reproduce it by queueing a job, stopping the process, and starting it again; the expected result is that the queued job runs.",
        ),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      const creates = calls.filter((call) => call.name === "github_create_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({ status: "ok", result: { status: "created" } });
      expect(creates[0]?.arguments).toMatchObject({ kind: "bug" });
      const report = JSON.stringify(creates[0]?.arguments).toLowerCase();
      expect(report).toContain("restart");
      expect(report).toContain("queue");
      expect(report).toContain("expected");
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        1,
      );
      expect(result.output.githubOperations).toContainEqual(expect.objectContaining({ status: "completed" }));
    });

    it("files one complete feature request with audience and motivation", async ({ run }) => {
      const result = await run({
        message: window(
          "Please request a feature: show queue depth in the status command. Operators need it so they can diagnose backpressure before jobs start timing out.",
        ),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      const creates = calls.filter((call) => call.name === "github_create_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({ status: "ok", result: { status: "created" } });
      expect(creates[0]?.arguments).toMatchObject({ kind: "feature" });
      const request = JSON.stringify(creates[0]?.arguments).toLowerCase();
      expect(request).toContain("queue depth");
      expect(request).toContain("operator");
      expect(request).toMatch(/diagnos|backpressure/);
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        1,
      );
      expect(result.output.githubOperations).toContainEqual(expect.objectContaining({ status: "completed" }));
    });

    it("asks one focused question for an incomplete report before any GitHub mutation", async ({ run }) => {
      const result = await run({
        message: window("Please file a bug: the scheduler is broken."),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      expect(calls.filter((call) => call.name === "github_create_issue")).toHaveLength(0);
      expect(calls.filter((call) => call.name === "say")).toHaveLength(1);
      expect(result.output.githubEvents).toEqual([]);
    });

    it("finds related work and does not duplicate it", async ({ run }) => {
      const title = "Queued scheduler job disappears after restart";
      const result = await run({
        message: window(
          `Please check whether this is already tracked and do not create a duplicate: ${title}. The queued job should run after restart.`,
        ),
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          githubIssues: [{ title, body: "Existing report with reproduction details." }],
        },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      expect(result.output.githubEvents.some((event) => (event as { kind?: string }).kind === "search")).toBe(true);
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        0,
      );
    });
  },
);
