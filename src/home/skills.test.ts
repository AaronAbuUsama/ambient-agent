import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAllSkills, skillsForChat } from "./skills";

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ambient-skills-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function skill(root: string, folder: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(
    join(root, folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: a test skill\n---\n${body}\n`,
  );
}

test("home skills apply everywhere and a chat copy shadows by name", async () => {
  await withHome(async (home) => {
    await skill(join(home, "skills"), "shared-recall", "shared-recall", "home version");
    await skill(join(home, "skills"), "release-notes", "release-notes", "release body");
    await skill(
      join(home, "chats", "tst", "skills"),
      "shared-recall",
      "shared-recall",
      "chat version wins",
    );

    const tst = skillsForChat(home, "tst");
    expect(tst.broken).toEqual([]);
    expect(tst.skills.map(({ name, scope }) => `${name}:${scope}`).sort()).toEqual([
      "release-notes:home",
      "shared-recall:chat",
    ]);
    expect(tst.skills.find(({ name }) => name === "shared-recall")?.content).toBe(
      "chat version wins",
    );

    const elsewhere = skillsForChat(home, "other-chat");
    expect(elsewhere.skills.find(({ name }) => name === "shared-recall")?.content).toBe(
      "home version",
    );
    expect(skillsForChat(home, undefined).skills).toHaveLength(2);
  });
});

test("broken skills are diagnosed and skipped, never loaded", async () => {
  await withHome(async (home) => {
    await skill(join(home, "skills"), "good", "good", "works");
    await mkdir(join(home, "skills", "empty-folder"), { recursive: true });
    await mkdir(join(home, "skills", "no-frontmatter"), { recursive: true });
    await writeFile(join(home, "skills", "no-frontmatter", "SKILL.md"), "just prose\n");
    await mkdir(join(home, "skills", "bad-name"), { recursive: true });
    await writeFile(
      join(home, "skills", "bad-name", "SKILL.md"),
      "---\nname: Bad Name!\ndescription: x\n---\nbody\n",
    );
    await mkdir(join(home, "skills", "no-body"), { recursive: true });
    await writeFile(
      join(home, "skills", "no-body", "SKILL.md"),
      "---\nname: no-body\ndescription: x\n---\n",
    );

    const scan = skillsForChat(home, undefined);
    expect(scan.skills.map(({ name }) => name)).toEqual(["good"]);
    const problems = new Map(scan.broken.map(({ folder, problem }) => [folder, problem]));
    expect(problems.get("empty-folder")).toContain("missing");
    expect(problems.get("no-frontmatter")).toContain("frontmatter");
    expect(problems.get("bad-name")).toContain("kebab-case");
    expect(problems.get("no-body")).toContain("no body");
  });
});

test("scanAllSkills sees every chat's scope with folder provenance", async () => {
  await withHome(async (home) => {
    await skill(join(home, "skills"), "home-one", "home-one", "x");
    await skill(join(home, "chats", "tst", "skills"), "triage", "triage", "x");
    await mkdir(join(home, "chats", "family", "skills", "broken"), { recursive: true });

    const scan = scanAllSkills(home);
    expect(scan.skills.map(({ name }) => name).sort()).toEqual(["home-one", "triage"]);
    expect(scan.broken).toEqual([
      { scope: "chat", folder: "family/broken", problem: "SKILL.md is missing" },
    ]);
  });
});
