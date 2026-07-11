import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveWritableRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Leave a real GitHub review on a pull request: a general comment, an approval, or a " +
    "change request, optionally anchored to specific lines. `body` is required for " +
    "REQUEST_CHANGES (GitHub itself rejects a change request with no explanation).",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    pull_number: z.number().int().positive().describe("The pull request number."),
    event: z
      .enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
      .describe("The review verdict. Use COMMENT for feedback that isn't a merge verdict."),
    body: z.string().optional().describe("The review's summary text. Required for REQUEST_CHANGES."),
    comments: z
      .array(
        z.object({
          path: z.string().describe("File path relative to the repo root."),
          line: z.number().int().positive().describe("Line number in the file's new version."),
          body: z.string().min(1),
        }),
      )
      .optional()
      .describe("Inline comments anchored to specific file/line locations."),
  }),
  async execute(input) {
    if (input.event === "REQUEST_CHANGES" && !input.body) {
      throw new Error("`body` is required when event is REQUEST_CHANGES.");
    }
    const { owner, repo } = resolveWritableRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: input.pull_number,
      event: input.event,
      body: input.body,
      comments: input.comments,
    });
    return { id: data.id, state: data.state, url: data.html_url ?? undefined };
  },
});
