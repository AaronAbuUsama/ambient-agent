import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

export default defineTool({
  description: "List pull requests in a GitHub repo (open by default).",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to 'open'."),
    per_page: z.number().int().min(1).max(50).optional().describe("Defaults to 20, max 50."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: input.state ?? "open",
      per_page: input.per_page ?? 20,
    });
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft ?? false,
      url: pr.html_url,
      author: pr.user?.login,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      createdAt: pr.created_at,
    }));
  },
});
