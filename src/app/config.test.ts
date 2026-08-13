import { expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "./config";

const models = {
  providers: {
    local: {
      adapter: "openai-compatible",
      baseUrl: "http://127.0.0.1:9999/v1",
      credential: "none",
    },
  },
  roles: {
    conversation: { provider: "local", model: "test-model", maxOutputTokens: 512 },
  },
};

async function withConfigFile(
  content: string,
  work: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ambient-config-"));
  const path = join(directory, "ambient.config.json");
  await writeFile(path, content);
  try {
    await work(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the committed rig document supplies the deployment defaults", () => {
  const config = loadAppConfig({
    AMBIENT_CONFIG: "./ambient.config.json",
    AMBIENT_HOME: "/tmp/ambient-test-home",
  });
  expect(config.whatsapp.accountId).toBe("main");
  expect(config.whatsapp.historyBackfillLimit).toBeUndefined();
  expect(config.database.url).toMatch(/ambient-test-home\/state\/ambient\.db$/);
  expect(config.conversation.scheduling).toEqual({
    debounceMs: 750,
    maximumWaitMs: 5_000,
    leaseMs: 120_000,
    maximumItemsPerRun: 50,
  });
  expect(config.conversation.enabled).toBe(false);
  expect(config.conversation.speakers).toEqual([]);
  expect(config.models.roles.conversation).toEqual({
    provider: "qwen",
    model: "qwen3.6-flash",
    thinking: "off",
    maxOutputTokens: 4096,
  });
  expect(config.models.providers.qwen).toMatchObject({
    adapter: "openai-compatible",
    credential: { env: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"] },
  });
  expect(config.models.roles.worker).toBeUndefined();
  expect(config.models.roles.evaluator).toMatchObject({ provider: "vibe" });
  expect(config.master).toBeUndefined();
});

test("the home's config.yaml is the default document", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-home-"));
  try {
    await writeFile(
      join(home, "config.yaml"),
      [
        "account: main",
        "master:",
        '  chatId: "999@s.whatsapp.net"',
        "providers:",
        "  local:",
        "    adapter: openai-compatible",
        "    baseUrl: http://127.0.0.1:9999/v1",
        "    credential: none",
        "roles:",
        "  conversation: { provider: local, model: test-model }",
      ].join("\n"),
    );
    const config = loadAppConfig({ AMBIENT_HOME: home });
    expect(config.whatsapp.accountId).toBe("main");
    expect(config.whatsapp.dataDirectory).toBe(join(home, "state"));
    expect(config.database.url).toBe(`file:${join(home, "state", "ambient.db")}`);
    expect(config.master).toEqual({ chatId: "999@s.whatsapp.net" });
    expect(config.models.roles.conversation?.model).toBe("test-model");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a configuration document owns every structured section", async () => {
  await withConfigFile(
    JSON.stringify({
      account: "second",
      master: { chatId: "9715@s.whatsapp.net" },
      database: { url: "file:/tmp/custom.db" },
      whatsapp: { dataDirectory: "/var/ambient", historyBackfillLimit: 75 },
      conversation: {
        enabled: true,
        instructions: "Be concise.",
        speakers: [
          { conversationId: "1203@g.us", instructions: "You are in the test group." },
          {
            conversationId: "9715@s.whatsapp.net",
            mode: "listening",
            attendFrom: "2026-08-12T00:00:00.000Z",
          },
        ],
        scheduling: {
          debounceMs: 1_000,
          maximumWaitMs: 6_000,
          leaseMs: 90_000,
          maximumItemsPerRun: 25,
        },
      },
      logging: { level: "info" },
      ...models,
    }),
    async (path) => {
      const config = loadAppConfig({ AMBIENT_CONFIG: path });
      expect(config.database.url).toBe("file:/tmp/custom.db");
      expect(config.whatsapp).toEqual({
        accountId: "second",
        dataDirectory: "/var/ambient",
        historyBackfillLimit: 75,
      });
      expect(config.master).toEqual({ chatId: "9715@s.whatsapp.net" });
      expect(config.conversation).toMatchObject({
        enabled: true,
        instructions: "Be concise.",
      });
      expect(config.conversation.speakers).toEqual([
        {
          conversationId: "1203@g.us",
          mode: "responding",
          instructions: "You are in the test group.",
        },
        {
          conversationId: "9715@s.whatsapp.net",
          mode: "listening",
          attendFrom: "2026-08-12T00:00:00.000Z",
        },
      ]);
      expect(config.conversation.scheduling).toEqual({
        debounceMs: 1_000,
        maximumWaitMs: 6_000,
        leaseMs: 90_000,
        maximumItemsPerRun: 25,
      });
      expect(config.logging.level).toBe("info");
      expect(config.models.roles.conversation?.model).toBe("test-model");
    },
  );
});

test("deployment environment overrides win over the document", async () => {
  await withConfigFile(
    JSON.stringify({ database: { url: "file:/tmp/document.db" }, ...models }),
    async (path) => {
      const config = loadAppConfig({
        AMBIENT_CONFIG: path,
        AMBIENT_DATABASE_URL: "file:/tmp/override.db",
        WHATSAPP_DATA_DIR: "/tmp/override-data",
        WA_LOG_LEVEL: "debug",
      });
      expect(config.database.url).toBe("file:/tmp/override.db");
      expect(config.whatsapp.dataDirectory).toBe("/tmp/override-data");
      expect(config.logging.level).toBe("debug");
    },
  );
});

test("an explicitly configured document path must exist", () => {
  expect(() => loadAppConfig({ AMBIENT_CONFIG: "/nonexistent/ambient.config.json" })).toThrow(
    'cannot read configuration file "/nonexistent/ambient.config.json"',
  );
});

test("a home without a config.yaml fails closed with the document path", async () => {
  const home = await mkdtemp(join(tmpdir(), "ambient-home-"));
  try {
    await mkdir(join(home, "state"), { recursive: true });
    expect(() => loadAppConfig({ AMBIENT_HOME: home })).toThrow(
      `cannot read configuration file "${join(home, "config.yaml")}"`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  ["{", "is not valid YAML"],
  [JSON.stringify({ providers: {} }), undefined],
  [JSON.stringify({ whatsapp: { historyBackfillLimit: 30 }, ...models }), undefined],
  [
    JSON.stringify({
      conversation: { scheduling: { debounceMs: 1_000, maximumWaitMs: 500 } },
      ...models,
    }),
    "maximumWaitMs must be at least debounceMs",
  ],
  [JSON.stringify({ conversation: { enabled: "yes" }, ...models }), undefined],
  [JSON.stringify({ conversation: { speakers: [{ conversationId: "" }] }, ...models }), undefined],
  [
    JSON.stringify({
      conversation: { speakers: [{ conversationId: "1203@g.us", mode: "proactive" }] },
      ...models,
    }),
    undefined,
  ],
  [
    JSON.stringify({
      conversation: { speakers: [{ conversationId: "1203@g.us", attendFrom: "yesterday" }] },
      ...models,
    }),
    undefined,
  ],
  [JSON.stringify({ master: { chatId: "" }, ...models }), undefined],
] as const)("invalid configuration documents fail closed (%#)", async (content, message) => {
  await withConfigFile(content, async (path) => {
    const load = () => loadAppConfig({ AMBIENT_CONFIG: path });
    if (message) {
      expect(load).toThrow(message);
    } else {
      expect(load).toThrow();
    }
  });
});
