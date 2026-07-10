import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

export default defineTool({
  description: "Get the full detail of a single GitHub issue by number, including its body.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    issue_number: z.number().int().positive().describe("The issue number, e.g. 42."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: input.issue_number,
    });
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      body: data.body ?? "",
      url: data.html_url,
      author: data.user?.login,
      labels: (data.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
      assignees: (data.assignees ?? []).map((assignee) => assignee.login),
      comments: data.comments,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  },
});
