import { expect, test } from "vite-plus/test";
import { createGitHubIssues, taskMarker, type GhCommand } from "./issues";

/** Records every argument vector so the tests can assert what `gh` was told. */
function fakeGh(responses: readonly string[]): GhCommand & { calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const command = (args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve(responses[index++] ?? "");
  };
  return Object.assign(command, { calls });
}

test("filing creates the issue and stamps it with its task key", async () => {
  const gh = fakeGh(["[]", "https://github.com/owner/repo/issues/42\n"]);
  const issues = createGitHubIssues({ repository: "owner/repo", gh });

  const filed = await issues.file({ key: "task-1", title: "Crash on save", body: "Steps: ..." });

  expect(filed).toEqual({
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    outcome: "filed",
  });
  const create = gh.calls[1]!;
  expect(create).toContain("create");
  // The repository is the capability's, never the caller's to choose.
  expect(create[create.indexOf("--repo") + 1]).toBe("owner/repo");
  expect(create[create.indexOf("--body") + 1]).toContain(taskMarker("task-1"));
});

test("a retried attempt adopts its own issue instead of filing a duplicate", async () => {
  const gh = fakeGh([
    JSON.stringify([
      { number: 41, html_url: "https://github.com/owner/repo/issues/41", body: "someone else" },
      {
        number: 42,
        html_url: "https://github.com/owner/repo/issues/42",
        body: `Steps: ...\n\n${taskMarker("task-1")}`,
      },
    ]),
  ]);
  const issues = createGitHubIssues({ repository: "owner/repo", gh });

  const again = await issues.file({ key: "task-1", title: "Crash on save", body: "Steps: ..." });

  expect(again).toEqual({
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    outcome: "adopted",
  });
  // Exactly one call: the lookup. Nothing was created.
  expect(gh.calls).toHaveLength(1);
  expect(gh.calls[0]).toContain("api");
});

test("the duplicate guard reads the issue list, never the lagging search index", async () => {
  // A live check proved search misses an issue created seconds earlier, so the
  // guard must not depend on it.
  const gh = fakeGh(["[]", "https://github.com/owner/repo/issues/9\n"]);
  const issues = createGitHubIssues({ repository: "owner/repo", gh });

  await issues.file({ key: "task-9", title: "t", body: "b" });

  const lookup = gh.calls[0]!;
  expect(lookup[0]).toBe("api");
  expect(lookup[1]).toContain("repos/owner/repo/issues");
  expect(lookup.join(" ")).not.toContain("--search");
});

test("a lookup that fails does not block filing", async () => {
  const gh: GhCommand = (args) =>
    args.includes("api")
      ? Promise.reject(new Error("gh: api unavailable"))
      : Promise.resolve("https://github.com/owner/repo/issues/7\n");
  const issues = createGitHubIssues({ repository: "owner/repo", gh });

  expect(await issues.file({ key: "task-2", title: "t", body: "b" })).toMatchObject({
    number: 7,
    outcome: "filed",
  });
});

test("a create that returns no URL fails loudly rather than reporting success", async () => {
  const issues = createGitHubIssues({
    repository: "owner/repo",
    gh: fakeGh(["[]", "something went wrong"]),
  });

  await expect(issues.file({ key: "task-3", title: "t", body: "b" })).rejects.toThrow(
    "no issue URL",
  );
});

test("attached evidence is uploaded and embedded in the body", async () => {
  // repos/<repo> id, auth token, then the create.
  const gh = fakeGh(["[]", "1333510299\n", "gho_token\n", "https://github.com/o/r/issues/7\n"]);
  const uploaded: { filename: string; mimetype: string; size: number; token: string }[] = [];
  const issues = createGitHubIssues({
    repository: "o/r",
    gh,
    upload: async ({ filename, mimetype, bytes, token }) => {
      uploaded.push({ filename, mimetype, size: bytes.length, token });
      return `https://github.com/user-attachments/assets/${filename}`;
    },
  });

  const filed = await issues.file({
    key: "task-7",
    title: "Live Activity loops",
    body: "It re-prompts after confirming.",
    attachments: [
      {
        filename: "evidence-1.jpeg",
        mimetype: "image/jpeg",
        bytes: Buffer.from("pretend jpeg"),
        caption: "the repeated prompt",
      },
    ],
  });

  expect(filed.attached).toEqual({ embedded: 1, failed: 0 });
  expect(uploaded).toEqual([
    { filename: "evidence-1.jpeg", mimetype: "image/jpeg", size: 12, token: "gho_token" },
  ]);
  const body = gh.calls[3]![gh.calls[3]!.indexOf("--body") + 1]!;
  expect(body).toContain("![the repeated prompt](https://github.com/user-attachments/assets/");
  expect(body).toContain(taskMarker("task-7"));
});

test("an upload that fails is admitted in the issue, not silently dropped", async () => {
  const gh = fakeGh(["[]", "1333510299\n", "gho_token\n", "https://github.com/o/r/issues/8\n"]);
  const issues = createGitHubIssues({
    repository: "o/r",
    gh,
    upload: async () => {
      throw new Error("uploads.github.com said no");
    },
  });

  const filed = await issues.file({
    key: "task-8",
    title: "Widget does not open the app",
    body: "Tapping it does nothing.",
    attachments: [{ filename: "evidence-1.jpeg", mimetype: "image/jpeg", bytes: Buffer.from("x") }],
  });

  expect(filed.attached).toEqual({ embedded: 0, failed: 1 });
  const body = gh.calls[3]![gh.calls[3]!.indexOf("--body") + 1]!;
  // A reader must know a picture is missing, or they will never go looking.
  expect(body).toContain("could not be uploaded");
  expect(body).not.toContain("![");
});
