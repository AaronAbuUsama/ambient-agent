import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Create a new GitHub issue. Defaults to the GITHUB_REPO repo when owner/repo are omitted. " +
    "Use this for bug reports, feature requests, or anything raised in chat that should be tracked.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    title: z.string().min(1).describe("Issue title — short and specific."),
    body: z.string().optional().describe("Issue body in GitHub-flavored markdown."),
    labels: z.array(z.string()).optional().describe("Label names to apply, if any already exist."),
    assignees: z.array(z.string()).optional().describe("GitHub usernames to assign."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.issues.create({
      owner,
      repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
      assignees: input.assignees,
    });
    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      state: data.state,
    };
  },
});
