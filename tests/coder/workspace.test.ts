import { describe, expect, it } from "vite-plus/test";

import {
  coderResult,
  diffSnapshots,
  isEmptyDiff,
  parseHashListing,
} from "../../packages/agents/src/capabilities/coder/workspace.ts";

describe("parseHashListing", () => {
  it("reads sha256sum-style lines and strips the leading ./", () => {
    const snapshot = parseHashListing(["abc123  ./src/a.ts", "def456  ./src/b.ts", "", "  "].join("\n"));
    expect([...snapshot]).toEqual([
      ["src/a.ts", "abc123"],
      ["src/b.ts", "def456"],
    ]);
  });

  it("tolerates a binary marker (*) and extra whitespace", () => {
    const snapshot = parseHashListing("aaa *bin/tool\nbbb   spaced/path.md\n");
    expect(snapshot.get("bin/tool")).toBe("aaa");
    expect(snapshot.get("spaced/path.md")).toBe("bbb");
  });
});

describe("diffSnapshots", () => {
  it("reports added, modified, and deleted paths, each sorted", () => {
    const before = parseHashListing("h1  keep.ts\nh2  change.ts\nh3  gone.ts");
    const after = parseHashListing("h1  keep.ts\nh2x change.ts\nh4  added.ts");
    const diff = diffSnapshots(before, after);
    expect(diff.changed).toEqual(["added.ts", "change.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("is empty when nothing moved (the no-op case)", () => {
    const snap = parseHashListing("h1  a.ts\nh2  b.ts");
    expect(isEmptyDiff(diffSnapshots(snap, snap))).toBe(true);
  });
});

describe("coderResult — the green gate", () => {
  const base = { branch: "agent/coder/issue-7", summary: "s" };

  it("green + a freshly opened PR → opened-pr, non-blocked, testsPassed", () => {
    const result = coderResult({ ...base, hasChanges: true, testsPassed: true, prCreated: true, prUrl: "u", prNumber: 3 });
    expect(result.outcome).toBe("opened-pr");
    expect(result.testsPassed).toBe(true);
    expect(result).toMatchObject({ prUrl: "u", prNumber: 3, branch: "agent/coder/issue-7" });
  });

  it("green + a PR already open → updated-pr (relaunch pushed more commits)", () => {
    expect(coderResult({ ...base, hasChanges: true, testsPassed: true, prCreated: false }).outcome).toBe("updated-pr");
  });

  it("red after N attempts → blocked (the draft PR path), never presented as done", () => {
    const result = coderResult({ ...base, hasChanges: true, testsPassed: false, prCreated: true });
    expect(result.outcome).toBe("blocked");
    expect(result.testsPassed).toBe(false);
  });

  it("no change → no-op regardless of the suite colour", () => {
    expect(coderResult({ ...base, hasChanges: false, testsPassed: true, prCreated: false }).outcome).toBe("no-op");
  });
});
