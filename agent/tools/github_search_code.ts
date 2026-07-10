import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit } from "../lib/github.ts";

export default defineTool({
  description:
    "Search code on GitHub with the code search query syntax (e.g. 'useEffect language:ts'). " +
    "Scoped to owner/repo when given, else to GITHUB_REPO unless the query already contains a " +
    "'repo:' qualifier — pass a bare query with an explicit 'repo:' (or 'org:') qualifier to " +
    "search outside the default repo.",
  inputSchema: z.object({
    q: z.string().min(1).describe("GitHub code search query."),
    owner: z.string().optional().describe("Scope to this repo owner/org (paired with `repo`)."),
    repo: z.string().optional().describe("Scope to this repo (paired with `owner`)."),
    per_page: z.number().int().min(1).max(50).optional().describe("Defaults to 10, max 50."),
  }),
  async execute(input) {
    let q = input.q;
    if (input.owner && input.repo) {
      q += ` repo:${input.owner}/${input.repo}`;
    } else if (!/\brepo:|(^|\s)org:/i.test(q)) {
      const fallback = process.env.GITHUB_REPO;
      if (fallback) q += ` repo:${fallback}`;
    }

    const octokit = getOctokit();
    const { data } = await octokit.rest.search.code({ q, per_page: input.per_page ?? 10 });
    return {
      totalCount: data.total_count,
      items: data.items.map((item) => ({
        path: item.path,
        repository: item.repository.full_name,
        url: item.html_url,
        sha: item.sha,
      })),
    };
  },
});
