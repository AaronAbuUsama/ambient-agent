import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveWritableRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Post a comment on a GitHub issue or pull request (GitHub treats PR conversations as " +
    "issue comments, so this works on both).",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    issue_number: z.number().int().positive().describe("The issue or PR number."),
    body: z.string().min(1).describe("Comment body in GitHub-flavored markdown."),
  }),
  async execute(input) {
    const { owner, repo } = resolveWritableRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: input.issue_number,
      body: input.body,
    });
    return { id: data.id, url: data.html_url };
  },
});
