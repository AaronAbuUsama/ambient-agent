import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

/**
 * Filing one issue into ONE repository, and nothing else.
 *
 * The repository is fixed when this capability is built, so a model can never
 * choose where an issue lands — the same rule that keeps a speaker from
 * sending to an arbitrary chat. Callers see titles, bodies, and receipts; the
 * `gh` CLI, its argument vectors, and its JSON never leave this module.
 */
export interface IssueFiling {
  /**
   * Files the issue, or adopts the one this key already filed.
   *
   * GitHub has no idempotency key, so the effect carries its own: the key is
   * written into the issue body and searched for before creating. A retried
   * attempt therefore finds its own issue instead of filing a duplicate.
   */
  file(input: {
    readonly key: string;
    readonly title: string;
    readonly body: string;
  }): Promise<FiledIssue>;
}

export interface FiledIssue {
  readonly number: number;
  readonly url: string;
  /** `filed` created it; `adopted` found this key's existing issue. */
  readonly outcome: "filed" | "adopted";
}

/** The marker that makes an issue traceable to the assignment that caused it. */
export function taskMarker(key: string): string {
  return `Ambient-Task: ${key}`;
}

const listedIssueSchema = z.array(
  z.object({
    number: z.number().int(),
    html_url: z.string().min(1),
    body: z.string().nullable().default(null),
  }),
);
const createdUrlPattern = /https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/;

/**
 * How many recent issues the duplicate guard reads.
 *
 * ponytail: one page. The guard exists for the crash window between filing an
 * issue and retaining its receipt, and a retry lands within seconds — the
 * issue it is looking for is always among the newest. Page if a repository
 * ever files more than this between an attempt and its retry.
 */
const GUARD_PAGE_SIZE = 100;

/** How the module talks to `gh`; swapped in tests, never exported to callers. */
export interface GhCommand {
  (args: readonly string[]): Promise<string>;
}

const ghCli: GhCommand = async (args) => {
  const { stdout } = await run("gh", [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

export function createGitHubIssues(options: {
  /** `owner/name`. Fixed for the life of this capability. */
  readonly repository: string;
  readonly gh?: GhCommand;
}): IssueFiling {
  const gh = options.gh ?? ghCli;
  const repository = options.repository;

  return {
    async file({ key, title, body }) {
      const marker = taskMarker(key);

      // Look first: a previous attempt may have created the issue and died
      // before its receipt was retained.
      //
      // This reads the issue LIST, not the search index — the index is
      // eventually consistent and a live check proved the cost: a retry
      // seconds after filing found nothing and filed a duplicate, the exact
      // failure the retired bug-filing agent was retired for.
      //
      // The list endpoint is faster but NOT synchronous: measured against a
      // real repository, a new issue became visible between 1s and 2s after
      // creation. So this guard covers a realistic retry — a lease expires in
      // minutes — and never a sub-second one. GitHub is not the authority on
      // whether we already filed; the assignment's retained receipt is, and
      // the host checks that before calling here at all.
      const listed = await gh([
        "api",
        `repos/${repository}/issues?state=all&per_page=${GUARD_PAGE_SIZE}`,
      ]).catch(() => "[]");
      const found = listedIssueSchema.safeParse(JSON.parse(listed || "[]"));
      const mine = found.success
        ? found.data.find((issue) => issue.body?.includes(marker))
        : undefined;
      if (mine) return { number: mine.number, url: mine.html_url, outcome: "adopted" };

      const created = await gh([
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        title,
        "--body",
        `${body}\n\n${marker}`,
      ]);
      const match = createdUrlPattern.exec(created);
      if (!match?.[1]) throw new Error("gh issue create returned no issue URL");
      return { number: Number(match[1]), url: match[0], outcome: "filed" };
    },
  };
}
