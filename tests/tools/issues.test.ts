import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssues = {
  create: vi.fn(),
  listForRepo: vi.fn(),
  get: vi.fn(),
  createComment: vi.fn(),
  update: vi.fn(),
};

vi.mock("../../agent/lib/github.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/lib/github.ts")>();
  return {
    ...actual,
    getOctokit: () => ({ rest: { issues: mockIssues } }) as never,
  };
});

// None of these tools read `ctx` — an empty stand-in keeps call sites terse.
const dummyCtx = {} as ToolContext;

describe("github_create_issue", () => {
  beforeEach(() => {
    mockIssues.create.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
  });

  it("creates an issue against the resolved repo and returns a summary", async () => {
    mockIssues.create.mockResolvedValue({
      data: { number: 42, html_url: "https://github.com/acme/widgets/issues/42", title: "Bug", state: "open" },
    });
    const { default: tool } = await import("../../agent/tools/github_create_issue.ts");

    const result = await tool.execute(
      { title: "Bug", body: "It's broken", labels: ["bug"], assignees: ["octocat"] },
      dummyCtx,
    );

    expect(mockIssues.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      title: "Bug",
      body: "It's broken",
      labels: ["bug"],
      assignees: ["octocat"],
    });
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
      title: "Bug",
      state: "open",
    });
  });

  it("refuses an explicit owner/repo that is not on the write allow-list", async () => {
    // GITHUB_REPO=acme/widgets is the only writable repo. A prompt-injected
    // "open an issue in other/repo" must be rejected before any API call.
    const { default: tool } = await import("../../agent/tools/github_create_issue.ts");
    await expect(tool.execute({ owner: "other", repo: "repo", title: "x" }, dummyCtx)).rejects.toThrow(
      /not in the write allow-list/,
    );
    expect(mockIssues.create).not.toHaveBeenCalled();
  });

  it("honors an explicit owner/repo when it is on the allow-list", async () => {
    process.env.GITHUB_ALLOWED_REPOS = "acme/widgets,other/repo";
    mockIssues.create.mockResolvedValue({
      data: { number: 1, html_url: "https://github.com/other/repo/issues/1", title: "x", state: "open" },
    });
    const { default: tool } = await import("../../agent/tools/github_create_issue.ts");

    await tool.execute({ owner: "other", repo: "repo", title: "x" }, dummyCtx);

    expect(mockIssues.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "other", repo: "repo" }),
    );
  });
});

describe("github_list_issues", () => {
  beforeEach(() => {
    mockIssues.listForRepo.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("defaults to open state and filters out pull requests", async () => {
    mockIssues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 1,
          title: "Real issue",
          state: "open",
          html_url: "u1",
          labels: [{ name: "bug" }],
          assignees: [{ login: "octocat" }],
        },
        {
          number: 2,
          title: "A pull request",
          state: "open",
          html_url: "u2",
          labels: [],
          assignees: [],
          pull_request: { url: "x" },
        },
      ],
    });
    const { default: tool } = await import("../../agent/tools/github_list_issues.ts");

    const result = await tool.execute({}, dummyCtx);

    expect(mockIssues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", state: "open", per_page: 20 }),
    );
    expect(result).toEqual([
      { number: 1, title: "Real issue", state: "open", url: "u1", labels: ["bug"], assignees: ["octocat"] },
    ]);
  });

  it("passes state, labels, and per_page through", async () => {
    mockIssues.listForRepo.mockResolvedValue({ data: [] });
    const { default: tool } = await import("../../agent/tools/github_list_issues.ts");

    await tool.execute({ state: "all", labels: ["bug", "p1"], per_page: 5 }, dummyCtx);

    expect(mockIssues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ state: "all", labels: "bug,p1", per_page: 5 }),
    );
  });
});

describe("github_get_issue", () => {
  beforeEach(() => {
    mockIssues.get.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("returns full issue detail", async () => {
    mockIssues.get.mockResolvedValue({
      data: {
        number: 7,
        title: "Crash on start",
        state: "open",
        body: "steps to repro",
        html_url: "u7",
        user: { login: "reporter" },
        labels: [{ name: "bug" }],
        assignees: [{ login: "octocat" }],
        comments: 3,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    });
    const { default: tool } = await import("../../agent/tools/github_get_issue.ts");

    const result = await tool.execute({ issue_number: 7 }, dummyCtx);

    expect(mockIssues.get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", issue_number: 7 });
    expect(result).toEqual({
      number: 7,
      title: "Crash on start",
      state: "open",
      body: "steps to repro",
      url: "u7",
      author: "reporter",
      labels: ["bug"],
      assignees: ["octocat"],
      comments: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });
});

describe("github_comment_on_issue", () => {
  beforeEach(() => {
    mockIssues.createComment.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("posts a comment and returns its id/url", async () => {
    mockIssues.createComment.mockResolvedValue({ data: { id: 99, html_url: "u99" } });
    const { default: tool } = await import("../../agent/tools/github_comment_on_issue.ts");

    const result = await tool.execute({ issue_number: 7, body: "thanks!" }, dummyCtx);

    expect(mockIssues.createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      body: "thanks!",
    });
    expect(result).toEqual({ id: 99, url: "u99" });
  });
});

describe("github_close_issue", () => {
  beforeEach(() => {
    mockIssues.createComment.mockReset();
    mockIssues.update.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("closes without a comment when none is given", async () => {
    mockIssues.update.mockResolvedValue({ data: { number: 7, state: "closed", html_url: "u7" } });
    const { default: tool } = await import("../../agent/tools/github_close_issue.ts");

    const result = await tool.execute({ issue_number: 7 }, dummyCtx);

    expect(mockIssues.createComment).not.toHaveBeenCalled();
    expect(mockIssues.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      state: "closed",
      state_reason: "completed",
    });
    expect(result).toEqual({ number: 7, state: "closed", url: "u7" });
  });

  it("posts the comment before closing when one is given", async () => {
    mockIssues.createComment.mockResolvedValue({ data: { id: 1, html_url: "c1" } });
    mockIssues.update.mockResolvedValue({ data: { number: 7, state: "closed", html_url: "u7" } });
    const { default: tool } = await import("../../agent/tools/github_close_issue.ts");

    await tool.execute({ issue_number: 7, comment: "fixed in main", reason: "completed" }, dummyCtx);

    const commentOrder = mockIssues.createComment.mock.invocationCallOrder[0]!;
    const updateOrder = mockIssues.update.mock.invocationCallOrder[0]!;
    expect(commentOrder).toBeLessThan(updateOrder);
    expect(mockIssues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: "fixed in main" }),
    );
  });

  it("supports the not_planned reason", async () => {
    mockIssues.update.mockResolvedValue({ data: { number: 7, state: "closed", html_url: "u7" } });
    const { default: tool } = await import("../../agent/tools/github_close_issue.ts");

    await tool.execute({ issue_number: 7, reason: "not_planned" }, dummyCtx);

    expect(mockIssues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state_reason: "not_planned" }),
    );
  });
});
