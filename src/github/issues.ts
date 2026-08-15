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
    readonly attachments?: readonly IssueAttachment[];
  }): Promise<FiledIssue>;
}

/**
 * One piece of evidence to embed in the issue body.
 *
 * Bytes, not a ref: this module knows nothing about WhatsApp or a media store,
 * and whoever resolved the ref already proved it belongs where it came from.
 */
export interface IssueAttachment {
  readonly filename: string;
  readonly mimetype: string;
  readonly bytes: Buffer;
  /** Rendered as the image's alt text, so the issue reads as a report. */
  readonly caption?: string;
}

export interface FiledIssue {
  readonly number: number;
  readonly url: string;
  /** `filed` created it; `adopted` found this key's existing issue. */
  readonly outcome: "filed" | "adopted";
  /** How much evidence actually made it into the body. */
  readonly attached?: { readonly embedded: number; readonly failed: number };
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

/** Uploads one file and returns the URL to embed; swapped in tests. */
export interface AssetUpload {
  (input: {
    readonly repositoryId: string;
    readonly filename: string;
    readonly mimetype: string;
    readonly bytes: Buffer;
    readonly token: string;
  }): Promise<string>;
}

/**
 * GitHub publishes no API for issue attachments.
 *
 * This is the endpoint its own web client uses when you drag a file into a
 * comment, and it accepts a `gh` token. Verified end to end: it returns 201
 * with a `user-attachments/assets/<uuid>` URL, and GitHub rewrites that URL
 * into a signed asset when it renders the body — images and video alike. The
 * asset is not fetchable until it is referenced, so the upload and the issue
 * write belong to one operation.
 *
 * ponytail: undocumented, so it can vanish without notice. The failure is
 * visible (a filed issue reporting fewer embedded attachments than it was
 * given), and the supported fallback is a release asset per repository.
 */
const uploadAsset: AssetUpload = async ({ repositoryId, filename, mimetype, bytes, token }) => {
  const query = new URLSearchParams({
    name: filename,
    content_type: mimetype,
    repository_id: repositoryId,
  });
  const endpoint = `https://uploads.github.com/user-attachments/assets?${query.toString()}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": mimetype,
    },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) throw new Error(`attachment upload failed with ${response.status}`);
  const payload = uploadedAssetSchema.parse(await response.json());
  return payload.url;
};

const uploadedAssetSchema = z.object({ url: z.string().min(1) });

export function createGitHubIssues(options: {
  /** `owner/name`. Fixed for the life of this capability. */
  readonly repository: string;
  readonly gh?: GhCommand;
  readonly upload?: AssetUpload;
}): IssueFiling {
  const gh = options.gh ?? ghCli;
  const upload = options.upload ?? uploadAsset;
  const repository = options.repository;

  /**
   * Embed what can be embedded, and say so when something could not be.
   *
   * A report that quietly drops its screenshot is worse than one that admits
   * the screenshot is missing — the reader would never know to go looking.
   */
  const embed = async (
    attachments: readonly IssueAttachment[],
  ): Promise<{ readonly markdown: string; readonly embedded: number; readonly failed: number }> => {
    if (attachments.length === 0) return { markdown: "", embedded: 0, failed: 0 };

    const [repositoryId, token] = await Promise.all([
      gh(["api", `repos/${repository}`, "-q", ".id"]).then((value) => value.trim()),
      gh(["auth", "token"]).then((value) => value.trim()),
    ]);

    const lines: string[] = [];
    let failed = 0;
    for (const attachment of attachments) {
      try {
        const url = await upload({
          repositoryId,
          filename: attachment.filename,
          mimetype: attachment.mimetype,
          bytes: attachment.bytes,
          token,
        });
        lines.push(`![${attachment.caption ?? attachment.filename}](${url})`);
      } catch {
        failed += 1;
      }
    }

    const notice =
      failed > 0 ? `\n\n_${failed} attachment(s) from the report could not be uploaded._` : "";
    // "Attached", not "Evidence": the writer often has its own Evidence
    // section, and two identical headings in one issue reads as a mistake.
    const markdown =
      lines.length > 0 ? `\n\n## Attached from the report\n\n${lines.join("\n\n")}` : "";
    return { markdown: `${markdown}${notice}`, embedded: lines.length, failed };
  };

  return {
    async file({ key, title, body, attachments = [] }) {
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

      // Upload before creating: an asset is only fetchable once some content
      // references it, so the body must carry the link from the start.
      const evidence = await embed(attachments);

      const created = await gh([
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        title,
        "--body",
        `${body}${evidence.markdown}\n\n${marker}`,
      ]);
      const match = createdUrlPattern.exec(created);
      if (!match?.[1]) throw new Error("gh issue create returned no issue URL");
      return {
        number: Number(match[1]),
        url: match[0],
        outcome: "filed",
        ...(attachments.length > 0
          ? { attached: { embedded: evidence.embedded, failed: evidence.failed } }
          : {}),
      };
    },
  };
}
