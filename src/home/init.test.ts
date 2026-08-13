import { expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambientHome, initHome } from "./init";

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ambient-home-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("initHome creates the tree and seeds config.yaml and README.md", async () => {
  await withHome(async (home) => {
    const created = initHome(home);
    expect(created).toContain("chats/");
    expect(created).toContain("skills/");
    expect(created).toContain(`${join("state", "logs")}/`);
    expect(created).toContain("config.yaml");
    expect(created).toContain("README.md");
    expect(existsSync(join(home, "state", "logs"))).toBe(true);
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toContain("account: main");
  });
});

test("initHome is idempotent and never overwrites an edited config", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), "account: edited\n");
    const second = initHome(home);
    expect(second).toEqual([]);
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toBe("account: edited\n");
  });
});

test("ambientHome prefers AMBIENT_HOME over the default", () => {
  expect(ambientHome({ AMBIENT_HOME: "/tmp/rig-home" })).toBe("/tmp/rig-home");
  expect(ambientHome({})).toContain(".ambient");
});
