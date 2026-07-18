import { describe, expect, it, vi } from "vite-plus/test";

import { createOpenPullRequestTool } from "../../packages/agents/src/capabilities/coder/tool.ts";
import type { CoderGitHub } from "../../packages/agents/src/capabilities/coder/github.ts";
import { parseHashListing, type OpenPrRecord } from "../../packages/agents/src/capabilities/coder/workspace.ts";

const REPO = { owner: "acme", repo: "widgets" };
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

/** A `before`/`after` pair where the model changed one tracked file. */
const before = parseHashListing("h1  src/a.ts\nh2  src/keep.ts");
const after = parseHashListing("h1x src/a.ts\nh2  src/keep.ts");

/** A full Git-Data + pulls mock. `branchExists` / `openPr` drive the two idempotency legs. */
const makeGitHub = (opts: { branchExists: boolean; openPr?: { number: number; html_url: string; draft: boolean } }) => {
  const getRef = vi.fn(async () => {
    if (opts.branchExists) return { data: { object: { sha: "existing-head" } } };
    throw notFound();
  });
  const createRef = vi.fn(async () => ({ data: { ref: "refs/heads/agent/coder/issue-42" } }));
  const list = vi.fn(async () => ({ data: opts.openPr === undefined ? [] : [opts.openPr] }));
  const create = vi.fn(async () => ({ data: { number: 100, html_url: "https://x/pr/100" } }));
  const gh = {
    git: {
      getRef,
      createRef,
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "base-tree" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "blob-sha" } })),
      createTree: vi.fn(async () => ({ data: { sha: "new-tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "new-commit" } })),
      updateRef: vi.fn(async () => ({ data: {} })),
    },
    pulls: { list, create },
  } as unknown as CoderGitHub;
  return { gh, getRef, createRef, list, create };
};

const buildTool = (gh: CoderGitHub, record: { pr?: OpenPrRecord }, snapshotAfter = async () => after) =>
  createOpenPullRequestTool({
    github: gh,
    repo: REPO,
    branch: "agent/coder/issue-42",
    base: "main",
    baseSha: "base-sha",
    issue: 42,
    issueTitle: "Do the thing",
    before,
    snapshotAfter,
    readFile: async () => new TextEncoder().encode("changed bytes"),
    record,
  });

describe("open_pull_request handler — the model's one safe write (#172)", () => {
  it("draft-iff-not-green: passes the model's `draft` straight through to PR creation", async () => {
    for (const draft of [true, false]) {
      const record: { pr?: OpenPrRecord } = {};
      const { gh, create } = makeGitHub({ branchExists: false });
      const result = (await buildTool(gh, record).run({
        input: { title: "t", body: "rich body", draft },
      })) as { opened: boolean; draft?: boolean };

      expect(result.opened).toBe(true);
      expect(result.draft).toBe(draft);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ body: "rich body", draft }));
      expect(record.pr?.draft).toBe(draft);
    }
  });

  it("idempotent relaunch: reuses the existing branch and open PR, opening no duplicate", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, createRef, create } = makeGitHub({
      branchExists: true,
      openPr: { number: 9, html_url: "https://x/pr/9", draft: false },
    });

    const result = (await buildTool(gh, record).run({
      input: { title: "t", body: "b", draft: false },
    })) as { opened: boolean; number?: number };

    expect(result.opened).toBe(true);
    expect(result.number).toBe(9); // the already-open PR, not a fresh one
    expect(createRef).not.toHaveBeenCalled(); // branch reused
    expect(create).not.toHaveBeenCalled(); // PR reused
    expect(record.pr).toEqual({ url: "https://x/pr/9", number: 9, created: false, draft: false });
  });

  it("commits the diffed change set via the Git Data API before opening the PR", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh } = makeGitHub({ branchExists: false });
    await buildTool(gh, record).run({ input: { title: "t", body: "b", draft: false } });
    expect(gh.git.createCommit).toHaveBeenCalledOnce();
    expect(gh.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: "blob-sha" }] }),
    );
  });

  it("no committable change: opens nothing and leaves the record empty (→ conductor blocks)", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, getRef, create } = makeGitHub({ branchExists: false });
    const result = (await buildTool(gh, record, async () => before).run({
      input: { title: "t", body: "b", draft: false },
    })) as { opened: boolean; message?: string };

    expect(result.opened).toBe(false);
    expect(result.message).toContain("No file changes");
    expect(record.pr).toBeUndefined();
    expect(getRef).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
