import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";

import { createFlueAgentHarness } from "./harness.ts";

const harness = createFlueAgentHarness({ agentName: "ambience" });
const window = (text: string): string => `WhatsApp Window for the current managed chat:\nAlice: ${text}`;

describeEval(
  "Issue Management deterministic contract",
  { harness, skipIf: () => process.env.AMBIENCE_EVAL_LIVE_MODEL === "true" },
  (it) => {
    it("creates one complete report after duplicate search", async ({ run }) => {
      const result = await run({
        message: window("CREATE_COMPLETE_ISSUE"),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      const create = calls.filter((call) => call.name === "github_create_issue");
      expect(create).toHaveLength(1);
      expect(create[0]).toMatchObject({
        status: "ok",
        arguments: {
          kind: "bug",
          title: "The scheduler loses a queued job",
        },
        result: { status: "created", issue: { number: 1 } },
      });
      expect(result.output.githubEvents.map((event) => (event as { kind?: string }).kind)).toEqual([
        "search",
        "create",
      ]);
      expect(result.output.githubOperations).toContainEqual(
        expect.objectContaining({ status: "completed", issueNumber: 1 }),
      );
    });

    it("creates one complete feature request with its audience and motivation", async ({ run }) => {
      const result = await run({
        message: window("CREATE_COMPLETE_FEATURE"),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const create = toolCalls(result).filter((call) => call.name === "github_create_issue");
      expect(create).toHaveLength(1);
      expect(create[0]).toMatchObject({
        status: "ok",
        arguments: {
          kind: "feature",
          title: "Show queue depth in status",
          body: "Operators need queue depth in status to diagnose backpressure.",
        },
        result: { status: "created", issue: { number: 1 } },
      });
      expect(result.output.githubEvents.map((event) => (event as { kind?: string }).kind)).toEqual([
        "search",
        "create",
      ]);
    });

    it("asks one focused question when the report is incomplete", async ({ run }) => {
      const result = await run({
        message: window("INCOMPLETE_ISSUE"),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(calls.filter((call) => call.name.startsWith("github_"))).toHaveLength(0);
      expect(calls.filter((call) => call.name === "say")).toEqual([
        expect.objectContaining({
          status: "ok",
          arguments: { text: "What did you expect to happen, and what happened instead?" },
        }),
      ]);
      expect(result.output.githubEvents).toEqual([]);
    });

    it("redirects an existing report without a create mutation", async ({ run }) => {
      const result = await run({
        message: window("DUPLICATE_ISSUE"),
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          githubIssues: [{ title: "The scheduler loses a queued job", body: "Already tracked." }],
        },
      });
      const create = toolCalls(result).filter((call) => call.name === "github_create_issue");
      expect(create).toHaveLength(1);
      expect(create[0]).toMatchObject({ status: "ok", result: { status: "duplicate" } });
      expect(result.output.githubEvents.map((event) => (event as { kind?: string }).kind)).toEqual(["search"]);
      expect(result.output.githubOperations).toEqual([]);
    });
  },
);
