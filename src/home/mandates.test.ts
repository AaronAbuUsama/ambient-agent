import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMandates } from "./mandates";

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ambient-mandates-"));
  try {
    await mkdir(join(home, "chats"));
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function chat(home: string, slug: string, mandate?: string): Promise<void> {
  await mkdir(join(home, "chats", slug), { recursive: true });
  if (mandate !== undefined) {
    await writeFile(join(home, "chats", slug, "mandate.yaml"), mandate);
  }
}

test("the minimum mandate is the chatId line alone: active, listening", async () => {
  await withHome(async (home) => {
    await chat(home, "family", "chatId: 123@g.us\n");
    const scan = scanMandates(home);
    expect(scan.broken).toEqual([]);
    expect(scan.active).toEqual([{ slug: "family", chatId: "123@g.us", mode: "listening" }]);
  });
});

test("a full mandate carries mode, instructions, and the memory brief", async () => {
  await withHome(async (home) => {
    await chat(
      home,
      "bug-reports",
      [
        "chatId: 456@g.us",
        "mode: responding",
        "instructions: Be concise.",
        "memoryBrief: Issues are the unit of memory.",
      ].join("\n"),
    );
    const scan = scanMandates(home);
    expect(scan.active).toEqual([
      {
        slug: "bug-reports",
        chatId: "456@g.us",
        mode: "responding",
        instructions: "Be concise.",
        memoryBrief: "Issues are the unit of memory.",
      },
    ]);
  });
});

test("fail-closed: missing file, invalid YAML, bad mode, unknown key, bad slug", async () => {
  await withHome(async (home) => {
    await chat(home, "no-file");
    await chat(home, "torn", "{chatId: ");
    await chat(home, "bad-mode", "chatId: 1@g.us\nmode: shouting\n");
    await chat(home, "typo-key", "chatId: 2@g.us\ninstrutcions: oops\n");
    await chat(home, "Bad_Slug!", "chatId: 3@g.us\n");
    const scan = scanMandates(home);
    expect(scan.active).toEqual([]);
    const problems = new Map(scan.broken.map((chat) => [chat.slug, chat.problem]));
    expect(problems.get("no-file")).toContain("missing");
    expect(problems.get("torn")).toContain("not valid YAML");
    expect(problems.get("bad-mode")).toContain("mode");
    expect(problems.get("typo-key")).toContain("instrutcions");
    expect(problems.get("Bad_Slug!")).toContain("not a valid slug");
  });
});

test("two folders binding one chat id: no winner, both broken", async () => {
  await withHome(async (home) => {
    await chat(home, "old-name", "chatId: 789@g.us\n");
    await chat(home, "new-name", "chatId: 789@g.us\nmode: responding\n");
    await chat(home, "innocent", "chatId: 1@g.us\n");
    const scan = scanMandates(home);
    expect(scan.active.map(({ slug }) => slug)).toEqual(["innocent"]);
    const problems = new Map(scan.broken.map((chat) => [chat.slug, chat.problem]));
    expect(problems.get("old-name")).toContain("new-name");
    expect(problems.get("new-name")).toContain("old-name");
  });
});

test("agent grants: bare grant allows as-is, a grant may carry narrowing", async () => {
  await withHome(async (home) => {
    await chat(
      home,
      "tst",
      [
        "chatId: 2@g.us",
        "mode: responding",
        "agents:",
        "  github-issues:",
        "  code-agent:",
        "    tools:",
        "      github_issues:",
        "        repositories:",
        "          - owner/sandbox",
      ].join("\n"),
    );
    const scan = scanMandates(home);
    expect(scan.broken).toEqual([]);
    expect(scan.active[0]?.agents).toEqual({
      "github-issues": {},
      "code-agent": { tools: { github_issues: { repositories: ["owner/sandbox"] } } },
    });
  });
});

test("agent grants fail closed: bad agent name, unknown grant key", async () => {
  await withHome(async (home) => {
    await chat(home, "bad-name", "chatId: 3@g.us\nagents:\n  Bad_Name:\n");
    await chat(home, "bad-key", "chatId: 4@g.us\nagents:\n  fine:\n    repos: nope\n");
    const scan = scanMandates(home);
    expect(scan.active).toEqual([]);
    expect(scan.broken.map(({ slug }) => slug).sort()).toEqual(["bad-key", "bad-name"]);
  });
});

test("no chats directory means nothing active and nothing broken", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-mandates-empty-"));
  try {
    expect(scanMandates(home)).toEqual({ active: [], broken: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
