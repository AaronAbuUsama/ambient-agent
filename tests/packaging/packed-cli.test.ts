import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { managedPaths } from "../../src/managed/paths.ts";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ambient-agent-packed-"));
const packDirectory = join(root, "pack");
const installDirectory = join(root, "install");
const homeDirectory = join(root, "home");
const tokenPath = join(root, "github-token.txt");
const piAuthPath = join(root, "pi-auth.json");
const tarball = join(packDirectory, "ambient-agent-0.1.0.tgz");
const executable = join(
  installDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ambient-agent.cmd" : "ambient-agent",
);
const environment = {
  ...process.env,
  HOME: homeDirectory,
  USERPROFILE: homeDirectory,
  PATH: `${join(installDirectory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
};
const paths = managedPaths({
  platform: process.platform,
  homeDirectory,
  environment,
});

beforeAll(async () => {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
  ]);
  await execute("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: process.cwd(),
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await execute("pnpm", ["add", "--dir", installDirectory, "--ignore-scripts", tarball], {
    cwd: process.cwd(),
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(tokenPath, "packed-github-secret\n", { mode: 0o600 });
  await writeFile(
    piAuthPath,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "packed-access-secret",
        refresh: "packed-refresh-secret",
        expires: 2_000_000_000_000,
      },
    }),
    { mode: 0o600 },
  );
}, 240_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("packed ambient-agent executable", () => {
  it("is a normal executable Node npm bin produced by Vite+", async () => {
    const installedEntry = join(installDirectory, "node_modules", "ambient-agent", "dist", "cli", "main.js");
    expect((await readFile(installedEntry, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(installedEntry)).mode & 0o111).not.toBe(0);
  });

  it("creates and diagnoses a secure installation in a clean temporary home", async () => {
    const args = [
      "init",
      "--chat",
      "120363000@g.us",
      "--repository",
      "owner/repo",
      "--github-token-file",
      tokenPath,
      "--pi-auth-file",
      piAuthPath,
    ];
    const first = await execute(executable, args, { env: environment });
    expect(first.stdout).toContain("Created secure managed installation");

    const status = await execute(executable, ["status", "--json"], { env: environment });
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "configured",
      dataDirectory: paths.root,
    });
    const config = await readFile(paths.config, "utf8");
    expect(config).not.toContain("packed-github-secret");
    expect(config).not.toContain("packed-access-secret");
    if (process.platform !== "win32") {
      expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.githubCredential)).mode & 0o777).toBe(0o600);
    }

    const second = await execute(executable, args, { env: environment });
    expect(second.stdout).toContain("no files changed");

    await writeFile(paths.config, "invalid json", "utf8");
    await chmod(paths.config, 0o600);
    await expect(execute(executable, ["doctor", "--json"], { env: environment })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"state": "damaged"'),
    });
  });
});
