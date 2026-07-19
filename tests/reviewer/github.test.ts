import { describe, expect, it, vi } from "vite-plus/test";

import { findReviewForHead, reviewEvent, reviewerLogin, type ReviewerGitHub } from "../../packages/agents/src/capabilities/reviewer/github.ts";

describe("Reviewer GitHub contract", () => {
  it("maps verdicts and never approves a red repository exercise", () => {
    expect(reviewEvent("approve", true)).toBe("APPROVE");
    expect(reviewEvent("comment", true)).toBe("COMMENT");
    expect(reviewEvent("approve", false)).toBe("REQUEST_CHANGES");
  });

  it("uses the configured App identity and PR+head SHA as the natural key", async () => {
    const github = {
      apps: { getAuthenticated: vi.fn(async () => ({ data: { slug: "reviewer" } })) },
      pulls: {
        listReviews: vi.fn(async () => ({ data: [
          { id: 1, html_url: "old", commit_id: "old", user: { login: "reviewer[bot]" } },
          { id: 2, html_url: "live", commit_id: "head", user: { login: "Reviewer[bot]" } },
        ] })),
      },
    } as unknown as ReviewerGitHub;
    const login = await reviewerLogin(github);
    expect(login).toBe("reviewer[bot]");
    await expect(findReviewForHead(github, { owner: "acme", repo: "widgets" }, 42, "head", login))
      .resolves.toMatchObject({ id: 2, html_url: "live" });
  });
});
