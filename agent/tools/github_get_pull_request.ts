import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

const MAX_FILES = 30;

export default defineTool({
  description:
    "Get a pull request's detail: title, body, status, and its changed files (capped) with " +
    "per-file add/delete counts — enough to summarize or scope a review without pulling the raw diff.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    pull_number: z.number().int().positive().describe("The pull request number."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const [{ data: pr }, { data: files }] = await Promise.all([
      octokit.rest.pulls.get({ owner, repo, pull_number: input.pull_number }),
      octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: input.pull_number,
        per_page: MAX_FILES,
      }),
    ]);

    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft ?? false,
      merged: pr.merged,
      body: pr.body ?? "",
      url: pr.html_url,
      author: pr.user?.login,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      files: files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
      filesTruncated: pr.changed_files > files.length,
    };
  },
});
