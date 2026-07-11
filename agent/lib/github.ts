/**
 * Shared Octokit client + repo resolution for the `agent/tools/github_*.ts`
 * tools. Kept out of `tools/` itself: `lib/` is import-only and never
 * discovered as a tool (see https://eve.dev/docs/reference/project-layout).
 */
import { Octokit } from "@octokit/rest";

let client: Octokit | undefined;

/**
 * Lazily construct (and memoize) the Octokit client from `GITHUB_TOKEN`.
 * Lazy on purpose: importing this module must not throw before a tool
 * actually runs (e.g. during `eve build` discovery, or in tests that mock
 * this function outright).
 */
export function getOctokit(): Octokit {
  if (client) return client;
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it to your environment (see .env.example) before using GitHub tools.",
    );
  }
  client = new Octokit({ auth, userAgent: "whatsappd-github-agent" });
  return client;
}

/** Testing seam — clears the memoized client so tests can inject a fresh mock. */
export function resetOctokitForTests(): void {
  client = undefined;
}

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface RepoInput {
  readonly owner?: string;
  readonly repo?: string;
}

/**
 * Resolve `{ owner, repo }` from explicit tool input, falling back to
 * `GITHUB_REPO` ("owner/repo") when either is omitted. Explicit input always
 * wins per-field, so "review PR #3 in acme/widgets" works even with a
 * different default repo configured.
 */
export function resolveRepo(input: RepoInput): RepoRef {
  if (input.owner && input.repo) return { owner: input.owner, repo: input.repo };

  const fallback = process.env.GITHUB_REPO;
  if (!fallback) {
    throw new Error(
      "No repo specified and GITHUB_REPO is not set. Pass owner/repo explicitly or set GITHUB_REPO=owner/repo.",
    );
  }
  const [fallbackOwner, fallbackRepo] = fallback.split("/");
  if (!fallbackOwner || !fallbackRepo) {
    throw new Error(`GITHUB_REPO must be "owner/repo", got "${fallback}".`);
  }
  return { owner: input.owner ?? fallbackOwner, repo: input.repo ?? fallbackRepo };
}

/**
 * The repos this agent is permitted to WRITE to. Defaults to `GITHUB_REPO`;
 * override with `GITHUB_ALLOWED_REPOS` (comma-separated "owner/repo"). Keys are
 * lower-cased for case-insensitive matching (GitHub owners/repos are).
 *
 * Why this exists: the WhatsApp gate authorizes by *group membership*, and tool
 * inputs come from model output derived from untrusted chat text. Without an
 * allow-list, a prompt-injected "open an issue in someone-else/their-repo" would
 * turn the bot's `GITHUB_TOKEN` into a write primitive against any repository
 * the token can reach. Reads stay unrestricted (lower blast radius, and
 * "review PR in acme/widgets" is a legitimate ask); mutations do not.
 */
export function allowedWriteRepos(): ReadonlySet<string> {
  const raw = process.env.GITHUB_ALLOWED_REPOS?.trim() || process.env.GITHUB_REPO?.trim() || "";
  const set = new Set<string>();
  for (const entry of raw.split(",")) {
    const key = entry.trim().toLowerCase();
    if (key) set.add(key);
  }
  return set;
}

/**
 * Resolve owner/repo like {@link resolveRepo}, then enforce the write
 * allow-list. Every tool that MUTATES GitHub state must resolve through this,
 * never through {@link resolveRepo} directly.
 */
export function resolveWritableRepo(input: RepoInput): RepoRef {
  const ref = resolveRepo(input);
  const allowed = allowedWriteRepos();
  if (allowed.size === 0) {
    throw new Error(
      "No writable repos configured. Set GITHUB_REPO (or GITHUB_ALLOWED_REPOS=owner/repo,owner/repo) " +
        "to authorize which repositories this bot may modify.",
    );
  }
  if (!allowed.has(`${ref.owner}/${ref.repo}`.toLowerCase())) {
    throw new Error(
      `Refusing to write to ${ref.owner}/${ref.repo}: not in the write allow-list (${[...allowed].join(", ")}). ` +
        "Add it to GITHUB_ALLOWED_REPOS to permit writes.",
    );
  }
  return ref;
}
