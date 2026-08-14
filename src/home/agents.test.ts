import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgents, type ToolConfigCheck } from "./agents";

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ambient-agents-"));
  try {
    await mkdir(join(home, "agents"));
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function agent(home: string, name: string, definition?: string): Promise<void> {
  await mkdir(join(home, "agents", name), { recursive: true });
  if (definition !== undefined) {
    await writeFile(join(home, "agents", name, "agent.yaml"), definition);
  }
}

const acceptAll: ToolConfigCheck = () => undefined;

const definition = [
  "description: Files well-written GitHub issues.",
  "model: worker",
  "instructions: One issue per distinct problem.",
  "tools:",
  "  github_issues:",
  "    repositories:",
  "      - owner/sandbox",
].join("\n");

test("a definition scans with its tools and a content hash", async () => {
  await withHome(async (home) => {
    await agent(home, "github-issues", definition);
    const scan = scanAgents(home, acceptAll);
    expect(scan.broken).toEqual([]);
    expect(scan.agents).toHaveLength(1);
    const scanned = scan.agents[0]!;
    expect(scanned.name).toBe("github-issues");
    expect(scanned.model).toBe("worker");
    expect(scanned.tools).toEqual({ github_issues: { repositories: ["owner/sandbox"] } });
    expect(scanned.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

test("the registry judges every tool fragment; a problem breaks the agent", async () => {
  await withHome(async (home) => {
    await agent(home, "github-issues", definition);
    const seen: [string, unknown][] = [];
    const scan = scanAgents(home, (toolName, config) => {
      seen.push([toolName, config]);
      return toolName === "github_issues" ? "unknown tool" : undefined;
    });
    expect(seen).toEqual([["github_issues", { repositories: ["owner/sandbox"] }]]);
    expect(scan.agents).toEqual([]);
    expect(scan.broken).toEqual([
      { name: "github-issues", problem: "agent.yaml tools: github_issues: unknown tool" },
    ]);
  });
});

test("fail-closed: missing file, bad YAML, empty tools, unknown key, bad name", async () => {
  await withHome(async (home) => {
    await agent(home, "no-file");
    await agent(home, "bad-yaml", "description: [unclosed");
    await agent(home, "no-tools", "description: d\nmodel: worker\ninstructions: i\ntools: {}\n");
    await agent(home, "extra-key", `${definition}\nrepositories: nope\n`);
    await agent(home, "Bad_Name", definition);
    const scan = scanAgents(home, acceptAll);
    expect(scan.agents).toEqual([]);
    expect(scan.broken.map((entry) => entry.name).sort()).toEqual([
      "Bad_Name",
      "bad-yaml",
      "extra-key",
      "no-file",
      "no-tools",
    ]);
  });
});

test("a home without an agents directory has no agents and no problems", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-agents-empty-"));
  try {
    expect(scanAgents(home, acceptAll)).toEqual({ agents: [], broken: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
