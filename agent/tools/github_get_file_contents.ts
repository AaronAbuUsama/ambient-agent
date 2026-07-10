import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

// Keep the model's context budget sane — big generated files or lockfiles
// should not blow out a WhatsApp turn. Point the requester at the file's URL
// for anything larger.
const MAX_CONTENT_CHARS = 20_000;

export default defineTool({
  description:
    "Read a file's contents (or list a directory) from a GitHub repo at a given ref. Use this " +
    "before reviewing or commenting on specific code rather than guessing at file contents.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    path: z.string().min(1).describe("File or directory path relative to the repo root."),
    ref: z.string().optional().describe("Branch, tag, or commit SHA. Defaults to the repo's default branch."),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: input.path,
      ref: input.ref,
    });

    if (Array.isArray(data)) {
      return {
        type: "directory" as const,
        path: input.path,
        entries: data.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
        })),
      };
    }

    if (data.type !== "file" || typeof data.content !== "string") {
      throw new Error(`${input.path} is not a regular file (got "${data.type}").`);
    }

    const full = Buffer.from(data.content, "base64").toString("utf8");
    const truncated = full.length > MAX_CONTENT_CHARS;
    return {
      type: "file" as const,
      path: data.path,
      sha: data.sha,
      size: data.size,
      content: truncated ? full.slice(0, MAX_CONTENT_CHARS) : full,
      truncated,
    };
  },
});
