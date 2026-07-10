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
