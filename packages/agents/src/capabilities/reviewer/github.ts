import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";

export type ReviewVerdict = "approve" | "request-changes" | "comment";

export interface ReviewerGitHub {
  readonly repos: {
    downloadTarballArchive(input: { owner: string; repo: string; ref: string }): Promise<{ data: unknown }>;
  };
  readonly pulls: {
    get(input: { owner: string; repo: string; pull_number: number; mediaType?: { format: "diff" } }): Promise<{
      data: {
        number: number;
        html_url: string;
        title: string;
        body?: string | null;
        draft?: boolean;
        state: string;
        head: { sha: string };
        base: { sha: string };
      };
    }>;
    listFiles(input: { owner: string; repo: string; pull_number: number; per_page: 100; page: number }): Promise<{
      data: ReadonlyArray<{ filename: string; patch?: string }>;
    }>;
    listReviews(input: { owner: string; repo: string; pull_number: number; per_page: 100; page: number }): Promise<{
      data: ReadonlyArray<{ id: number; html_url: string; commit_id?: string | null; user?: { login?: string } | null }>;
    }>;
    createReview(input: {
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: ReadonlyArray<{ path: string; line: number; side: "RIGHT"; body: string }>;
    }): Promise<{ data: { id: number; html_url: string } }>;
  };
  readonly apps: {
    getAuthenticated(): Promise<{ data: { slug: string } }>;
  };
}

export const reviewEvent = (verdict: ReviewVerdict, checksPassed: boolean) =>
  checksPassed && verdict === "approve"
    ? "APPROVE" as const
    : verdict === "comment" && checksPassed
      ? "COMMENT" as const
      : "REQUEST_CHANGES" as const;

export const reviewerLogin = async (github: ReviewerGitHub): Promise<string> =>
  `${(await github.apps.getAuthenticated()).data.slug}[bot]`.toLowerCase();

export const findReviewForHead = async (
  github: ReviewerGitHub,
  repo: GitHubRepositoryRef,
  pullRequest: number,
  headSha: string,
  login: string,
) => {
  for (let page = 1; ; page += 1) {
    const { data } = await github.pulls.listReviews({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullRequest,
      per_page: 100,
      page,
    });
    const match = data.find((review) => review.commit_id === headSha && review.user?.login?.toLowerCase() === login);
    if (match !== undefined || data.length < 100) return match;
  }
};

export const listChangedFiles = async (github: ReviewerGitHub, repo: GitHubRepositoryRef, pullRequest: number) => {
  const files: Array<{ filename: string; patch?: string }> = [];
  for (let page = 1; ; page += 1) {
    const { data } = await github.pulls.listFiles({ owner: repo.owner, repo: repo.repo, pull_number: pullRequest, per_page: 100, page });
    files.push(...data);
    if (data.length < 100) return files;
  }
};

/** GitHub accepts RIGHT-side inline comments only on lines represented by the diff. */
export const validInlineLocations = (files: readonly { filename: string; patch?: string }[]) => {
  const locations = new Set<string>();
  for (const file of files) {
    let line = 0;
    for (const row of file.patch?.split("\n") ?? []) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
      if (hunk !== null) {
        line = Number(hunk[1]);
      } else if (line > 0 && (row.startsWith("+") || row.startsWith(" "))) {
        locations.add(`${file.filename}:${line}`);
        line += 1;
      } else if (line > 0 && !row.startsWith("-")) {
        line += 1;
      }
    }
  }
  return locations;
};

export const archiveBytes = (data: unknown): Uint8Array => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new Error("downloadTarballArchive did not return archive bytes.");
};
