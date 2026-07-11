import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveWritableRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Close a GitHub issue, optionally posting a closing comment first. Use 'not_planned' as " +
    "the reason for won't-fix/duplicate/stale closes, 'completed' for everything else.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    issue_number: z.number().int().positive().describe("The issue number to close."),
    comment: z.string().optional().describe("Optional comment to post before closing."),
    reason: z.enum(["completed", "not_planned"]).optional().describe("Defaults to 'completed'."),
  }),
  async execute(input) {
    const { owner, repo } = resolveWritableRepo(input);
    const octokit = getOctokit();

    if (input.comment) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: input.issue_number,
        body: input.comment,
      });
    }

    const { data } = await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: input.issue_number,
      state: "closed",
      state_reason: input.reason ?? "completed",
    });
    return { number: data.number, state: data.state, url: data.html_url };
  },
});
