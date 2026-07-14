import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { inspectManagedData, installManagedData } from "../../src/managed/installation.ts";
import { managedPaths } from "../../src/managed/paths.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-agent-test-"));
  roots.push(parent);
  const dataDirectory = join(parent, "managed");
  const githubToken = "github-secret-token";
  const piAuth = {
    "openai-codex": {
      type: "oauth" as const,
      access: "pi-access-secret",
      refresh: "pi-refresh-secret",
      expires: 2_000_000_000_000,
    },
  };
  return { parent, dataDirectory, githubToken, piAuth };
};

describe("managed installation", () => {
  it("creates the complete skeleton with private permissions and secret references", async () => {
    const input = {
      ...(await fixture()),
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    };
    const previousUmask = process.umask(0o777);
    const result = await installManagedData(input).finally(() => process.umask(previousUmask));
    const paths = managedPaths(input);

    expect(result.created).toBe(true);
    expect(result.inspection.state).toBe("configured");
    expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
    for (const path of [paths.credentials, paths.whatsapp, paths.logs]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      paths.config,
      paths.githubCredential,
      paths.piAuthCredential,
      paths.applicationDatabase,
      paths.flueDatabase,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }

    const config = await readFile(paths.config, "utf8");
    expect(config).toContain('"credential": "github"');
    expect(config).toContain('"credential": "pi-auth"');
    expect(config).not.toContain(input.githubToken);
    expect(config).not.toContain(input.piAuth["openai-codex"].access);
    expect(await readFile(paths.githubCredential, "utf8")).toContain(input.githubToken);
  });

  it("is idempotent and never silently replaces credentials", async () => {
    const base = {
      ...(await fixture()),
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    };
    await installManagedData(base);
    const paths = managedPaths(base);
    const original = await readFile(paths.githubCredential, "utf8");

    const second = await installManagedData({ ...base, githubToken: "replacement-secret" });

    expect(second.created).toBe(false);
    expect(await readFile(paths.githubCredential, "utf8")).toBe(original);
    expect(original).not.toContain("replacement-secret");
  });

  it("distinguishes an absent install from a damaged install", async () => {
    const base = await fixture();
    expect((await inspectManagedData(base)).state).toBe("unconfigured");

    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    await writeFile(managedPaths(base).config, "not json", "utf8");

    const damaged = await inspectManagedData(base);
    expect(damaged.state).toBe("damaged");
    expect(damaged.diagnostics.map((item) => item.code)).toContain("json.invalid");
  });

  it("reports actionable permission failures without exposing credential contents", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const credential = managedPaths(base).githubCredential;
    await chmod(credential, 0o644);

    const inspection = await inspectManagedData(base);
    const output = JSON.stringify(inspection);
    expect(inspection.state).toBe("damaged");
    expect(output).toContain("chmod 600");
    expect(output).not.toContain(base.githubToken);
    expect(output).not.toContain(base.piAuth["openai-codex"].access);
  });

  it("diagnoses invalid credential references without printing secrets", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const configPath = managedPaths(base).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      model: { credential: string };
    };
    config.model.credential = "../../unexpected";
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    const inspection = await inspectManagedData(base);
    expect(inspection.diagnostics.map((item) => item.code)).toContain("credential.reference");
    expect(JSON.stringify(inspection)).not.toContain(base.githubToken);
  });

  it("reports invalid schema field paths without reporting their values", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as { managedChats: string[] };
    config.managedChats = [];
    await writeFile(paths.config, JSON.stringify(config), { mode: 0o600 });
    await writeFile(
      paths.githubCredential,
      JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: 123456789 }),
      { mode: 0o600 },
    );
    await writeFile(
      paths.piAuthCredential,
      JSON.stringify({
        "openai-codex": { type: "oauth", access: 987654321, refresh: "hidden-refresh", expires: 0 },
      }),
      { mode: 0o600 },
    );

    const output = JSON.stringify(await inspectManagedData(base));
    expect(output).toContain("managedChats");
    expect(output).toContain("token");
    expect(output).toContain("openai-codex.access");
    expect(output).not.toContain("123456789");
    expect(output).not.toContain("987654321");
    expect(output).not.toContain("hidden-refresh");
  });

  it("never follows a managed JSON symlink while diagnosing it", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const configPath = managedPaths(base).config;
    const outside = join(base.parent, "outside-secret.json");
    await writeFile(outside, JSON.stringify({ secret: "must-never-be-read" }), { mode: 0o600 });
    await rm(configPath);
    await symlink(outside, configPath);

    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("damaged");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("path.not-file");
    expect(JSON.stringify(inspection)).not.toContain("must-never-be-read");
  });

  it("classifies a dangling root symlink as damaged instead of unconfigured", async () => {
    const base = await fixture();
    await symlink(join(base.parent, "missing-target"), base.dataDirectory);
    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("damaged");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("path.not-directory");
  });

  it("recovers an old setup lock even when its PID has been reused", async () => {
    const base = await fixture();
    const lock = join(base.parent, ".managed.setup.lock");
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z", token: "stale-owner" }),
      { mode: 0o600 },
    );

    const input = {
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    };
    const attempts = await Promise.allSettled([installManagedData(input), installManagedData(input)]);
    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect(await inspectManagedData(base)).toMatchObject({ state: "configured" });
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on Windows until private ACL enforcement exists", async () => {
    const base = await fixture();
    await expect(
      installManagedData({
        ...base,
        platform: "win32",
        managedChats: ["120363000@g.us"],
        defaultRepository: "owner/repo",
      }),
    ).rejects.toThrow("fails closed");
    await expect(inspectManagedData({ ...base, platform: "win32" })).resolves.toMatchObject({
      state: "unconfigured",
      diagnostics: [{ code: "platform.unsupported" }],
    });
  });
});
