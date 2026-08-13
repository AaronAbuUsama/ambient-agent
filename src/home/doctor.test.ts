import { expect, test } from "vite-plus/test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "./doctor";
import { initHome } from "./init";

const configYaml = (credential: string) =>
  [
    "account: main",
    "providers:",
    "  local:",
    "    adapter: openai-compatible",
    "    baseUrl: http://127.0.0.1:9999/v1",
    `    credential: ${credential}`,
    "roles:",
    "  conversation: { provider: local, model: test-model }",
  ].join("\n");

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ambient-doctor-"));
  try {
    await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const found = report.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`no "${name}" check in ${JSON.stringify(report.checks)}`);
  return found;
}

test("an uninitialized home fails the home check and stops at config", async () => {
  await withHome(async (home) => {
    await rm(home, { recursive: true });
    const report = await runDoctor({ AMBIENT_HOME: home });
    expect(report.ok).toBe(false);
    expect(check(report, "home").ok).toBe(false);
    expect(check(report, "home").detail).toContain("ambient init");
    expect(check(report, "config").ok).toBe(false);
  });
});

test("a healthy home with resolvable credentials passes", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), configYaml("{ env: [TEST_KEY] }"));
    const report = await runDoctor({ AMBIENT_HOME: home, TEST_KEY: "set" });
    expect(check(report, "home").ok).toBe(true);
    expect(check(report, "config").ok).toBe(true);
    expect(check(report, "credential local").detail).toBe("TEST_KEY resolved");
    expect(check(report, "master").detail).toContain("not recorded");
    expect(check(report, "state").detail).toContain("no database yet");
    expect(check(report, "whatsapp").detail).toContain("pairs at first start");
    expect(report.ok).toBe(true);
  });
});

test("a missing credential variable fails with the variables to set", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), configYaml("{ env: [ABSENT_KEY] }"));
    const report = await runDoctor({ AMBIENT_HOME: home });
    expect(report.ok).toBe(false);
    expect(check(report, "credential local").detail).toBe("set one of ABSENT_KEY");
  });
});

test("an invalid config.yaml fails closed with a precise diagnostic", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), "providers: {}\n");
    const report = await runDoctor({ AMBIENT_HOME: home });
    expect(report.ok).toBe(false);
    expect(check(report, "config").detail).toContain("roles");
  });
});

test("databases are read when present: speakers by mode and WhatsApp auth", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), configYaml("none"));

    const ambient = createClient({ url: `file:${join(home, "state", "ambient.db")}` });
    await ambient.execute(
      "CREATE TABLE conversation_speakers (conversation_id TEXT PRIMARY KEY, mode TEXT)",
    );
    await ambient.execute(
      "INSERT INTO conversation_speakers VALUES ('a@g.us', 'listening'), ('b@g.us', 'responding')",
    );
    ambient.close();

    const mirror = createClient({ url: `file:${join(home, "state", "whatsapp.db")}` });
    await mirror.execute("CREATE TABLE wa_auth (account TEXT, key TEXT, value TEXT)");
    await mirror.execute("INSERT INTO wa_auth VALUES ('main', 'creds', '{}')");
    mirror.close();

    const report = await runDoctor({ AMBIENT_HOME: home });
    expect(check(report, "state").detail).toContain("1 responding, 1 listening");
    expect(check(report, "whatsapp").detail).toBe("authenticated (account: main)");
    expect(report.ok).toBe(true);
  });
});

test("WhatsApp state without the account's credentials fails", async () => {
  await withHome(async (home) => {
    initHome(home);
    await writeFile(join(home, "config.yaml"), configYaml("none"));
    const mirror = createClient({ url: `file:${join(home, "state", "whatsapp.db")}` });
    await mirror.execute("CREATE TABLE wa_auth (account TEXT, key TEXT, value TEXT)");
    mirror.close();
    const report = await runDoctor({ AMBIENT_HOME: home });
    expect(report.ok).toBe(false);
    expect(check(report, "whatsapp").detail).toContain("no credentials");
  });
});
