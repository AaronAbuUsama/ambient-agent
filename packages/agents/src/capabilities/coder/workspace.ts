import type { CoderResult } from "./schemas.ts";

/**
 * Which files the model touched, git-free. The tarball seed has no `.git`, so the
 * commit-out step can't ask git what changed; instead we hash every tracked file
 * before and after the model works and diff the two snapshots. Portable across
 * `local()` and a remote sandbox (both expose `find`/hashing), and deterministic —
 * the testable core of "Git Data API out".
 *
 * A snapshot maps a workspace-relative path to a content hash. `parseHashListing`
 * reads the `<hash>␠␠<path>` lines a `sha256sum`-style command emits.
 */
export type WorkspaceSnapshot = ReadonlyMap<string, string>;

export const parseHashListing = (listing: string): WorkspaceSnapshot => {
  const snapshot = new Map<string, string>();
  for (const raw of listing.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    // `sha256sum` prints "<hash>  <path>" (two spaces); tolerate one-or-more.
    const match = /^(\S+)\s+(?:[*]?)(.+)$/u.exec(line);
    if (match === null) continue;
    const path = match[2]!.replace(/^\.\//u, "");
    snapshot.set(path, match[1]!);
  }
  return snapshot;
};

export interface WorkspaceDiff {
  /** Added or modified paths — their current bytes go into new blobs. */
  readonly changed: readonly string[];
  /** Paths present before but gone now — tree entries with `sha:null`. */
  readonly deleted: readonly string[];
}

export const diffSnapshots = (before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff => {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path);
  }
  const deleted: string[] = [];
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  return { changed: changed.sort(), deleted: deleted.sort() };
};

export const isEmptyDiff = (diff: WorkspaceDiff): boolean => diff.changed.length === 0 && diff.deleted.length === 0;

/**
 * The green-gate decision (§8 DoD), pure so it is unit-tested without a sandbox:
 *
 * - No change after a green run → `no-op` (nothing to commit; no PR).
 * - Green + a freshly opened PR → `opened-pr`; green + a PR already open → `updated-pr`
 *   (relaunch pushed more commits). Non-draft either way.
 * - Still red after N attempts → a **draft** PR and `blocked`, the failure in `summary`.
 *   Red work is never presented as done (the caller opens the PR `draft: !testsPassed`).
 */
export const coderResult = (input: {
  hasChanges: boolean;
  testsPassed: boolean;
  prCreated: boolean;
  prUrl?: string;
  prNumber?: number;
  branch: string;
  summary: string;
}): CoderResult => {
  const base = {
    branch: input.branch,
    summary: input.summary,
    testsPassed: input.testsPassed,
    ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
    ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
  };
  if (!input.hasChanges) return { ...base, outcome: "no-op" };
  if (!input.testsPassed) return { ...base, outcome: "blocked" };
  return { ...base, outcome: input.prCreated ? "opened-pr" : "updated-pr" };
};
