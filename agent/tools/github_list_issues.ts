import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "List issues in a GitHub repo (open by default). Useful for triage and standup-style " +
    "'what's outstanding' requests. Excludes pull requests, which GitHub's API otherwise " +
    "mixes into this same endpoint.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    state: z.enum(["open", "closed", "all"]).optional().describe("Defaults to 'open'."),
    labels: z.array(z.string()).optional().describe("Filter to issues carrying all of these labels."),
    per_page: z.number().int().min(1).max(50).optional().describe("Defaults to 20, max 50."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: input.state ?? "open",
      labels: input.labels?.join(","),
      per_page: input.per_page ?? 20,
    });
    return data
      .filter((issue) => !("pull_request" in issue && issue.pull_request))
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      }));
  },
});
